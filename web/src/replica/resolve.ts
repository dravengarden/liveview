import { ingestDag } from "../audioMediaIndex.ts";
import { contentReplicaStats } from "./agg.ts";
import { getBlob, getBlobRecord, noteBlobAccess, putBlob } from "./blobs.ts";
import { idbRequest, withTxn } from "./idb.ts";
import {
  allPathRecords,
  applyDag,
  normalizeReplicaUrl,
  onPathIndexAdopted,
  parseManifest,
  parseRoot,
  pathRecordByUrl,
  pathRecordForHash,
  readRoot,
} from "./manifest.ts";
import { persistBodyForKind, replicaUsable } from "./policy.ts";
import {
  type BlobRecord,
  isArtworkKind,
  isAudioKind,
  META_URL_PREFIX,
  type MetaRecord,
  type PathRecord,
  REPLICA_DAG_MS,
  REPLICA_FETCH_MS,
  STORE_META,
} from "./schema.ts";
import { replicaRemoteBase } from "./sync.ts";
import { joinRemoteUrl } from "./worker.ts";

export interface ReplicaContentFetchOpts {
  cacheFirst?: boolean;
  fresh?: boolean;
  /** Skip network entirely (net === "none" / known offline). */
  offline?: boolean;
  /** Override the overall fetch budget. Instant 0 when offline. */
  connectMs?: number;
}

export interface ReplicaAudioResource {
  hash: string;
  kind: "audio" | "marks";
  url: string;
  path: string;
  bytes: number;
}

let offlineProbe = (): boolean =>
  typeof navigator !== "undefined" && navigator.onLine === false;

export function setReplicaOfflineProbe(probe: () => boolean): void {
  offlineProbe = probe;
}

export function replicaIsOffline(): boolean {
  return offlineProbe();
}

/** 0 when net is none; otherwise a body-inclusive budget (not connect-only). */
export function replicaFetchBudgetMs(opts?: ReplicaContentFetchOpts): number {
  if (opts?.offline === true || replicaIsOffline()) return 0;
  if (opts?.connectMs !== undefined) return opts.connectMs;
  return REPLICA_FETCH_MS;
}

function offline504(): Response {
  return new Response(null, { status: 504, statusText: "offline" });
}

function urlCacheKey(norm: string): string {
  return `${META_URL_PREFIX}${norm}`;
}

async function getUrlCache(norm: string): Promise<ArrayBuffer | undefined> {
  if (!replicaUsable()) return undefined;
  try {
    return await withTxn([STORE_META], "readonly", async (txn) => {
      const rec = await idbRequest(
        txn.objectStore(STORE_META).get(urlCacheKey(norm)) as IDBRequest<
          MetaRecord | undefined
        >,
      );
      return rec?.value instanceof ArrayBuffer ? rec.value : undefined;
    });
  } catch {
    // IDB failure is a cache miss, never a rejected read.
    return undefined;
  }
}

async function putUrlCache(norm: string, data: ArrayBuffer): Promise<void> {
  if (!replicaUsable()) return;
  const rec: MetaRecord = { key: urlCacheKey(norm), value: data };
  await withTxn([STORE_META], "readwrite", async (txn) => {
    await idbRequest(txn.objectStore(STORE_META).put(rec));
  });
}

async function fetchAbsolute(
  url: string,
  budgetMs: number,
): Promise<Response> {
  return fetchAbsoluteWith(url, budgetMs);
}

async function fetchAbsoluteWith(
  url: string,
  budgetMs: number,
  headers?: Record<string, string>,
): Promise<Response> {
  if (budgetMs <= 0) throw new Error("offline");
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), budgetMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      ...(headers ? { headers } : {}),
    });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function absoluteUrl(pathOrUrl: string): string {
  return joinRemoteUrl(replicaRemoteBase(), pathOrUrl);
}

type ArtworkEntry = { kind: string; slug: string; hash: string; url: string };
const artworkObjectUrls = new Map<string, ArtworkEntry>();

function artworkCacheKey(kind: string, slug: string): string {
  return `${kind}\0${slug}`;
}

export function slugFromArtworkUrl(url: string): string | undefined {
  const norm = normalizeReplicaUrl(url);
  const q = norm.indexOf("?");
  if (q < 0) return undefined;
  return new URLSearchParams(norm.slice(q + 1)).get("book") ?? undefined;
}

function artworkRecord(kind: string, slug: string): PathRecord | undefined {
  return pathRecordByUrl(`/api/${kind}?book=${slug}`) ??
    pathRecordByUrl(`/api/${kind}?book=${encodeURIComponent(slug)}`);
}

function revokeObjectUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // already revoked
  }
}

function forgetArtworkUrl(key: string): void {
  const prev = artworkObjectUrls.get(key);
  if (!prev) return;
  artworkObjectUrls.delete(key);
  revokeObjectUrl(prev.url);
}

function rememberArtworkUrl(
  kind: string,
  slug: string,
  hash: string,
  data: ArrayBuffer,
): string | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return undefined;
  }
  const key = artworkCacheKey(kind, slug);
  const prev = artworkObjectUrls.get(key);
  if (prev) {
    // Same bytes: an <img> may already be showing this URL; revoking it would
    // blank that image. Only a changed hash replaces (and revokes) the URL.
    if (prev.hash === hash) return prev.url;
    artworkObjectUrls.delete(key);
    revokeObjectUrl(prev.url);
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)]));
  artworkObjectUrls.set(key, { kind, slug, hash, url });
  return url;
}

function noteArtwork(rec: PathRecord, data: ArrayBuffer): void {
  if (!isArtworkKind(rec.kind)) return;
  const slug = slugFromArtworkUrl(rec.url);
  if (!slug) return;
  rememberArtworkUrl(rec.kind, slug, rec.hash, data);
}

export function pruneStaleArtworkObjectUrls(): void {
  for (const [key, entry] of artworkObjectUrls) {
    const rec = artworkRecord(entry.kind, entry.slug);
    if (rec && rec.hash === entry.hash) continue;
    forgetArtworkUrl(key);
  }
}

onPathIndexAdopted(pruneStaleArtworkObjectUrls);

export function artworkBlobSrc(
  kind: string,
  slug: string,
): string | undefined {
  const key = artworkCacheKey(kind, slug);
  const cached = artworkObjectUrls.get(key);
  if (!cached) return undefined;
  const rec = artworkRecord(kind, slug);
  if (!rec || rec.hash !== cached.hash) {
    forgetArtworkUrl(key);
    return undefined;
  }
  return cached.url;
}

export function resetArtworkObjectUrls(): void {
  for (const entry of artworkObjectUrls.values()) {
    revokeObjectUrl(entry.url);
  }
  artworkObjectUrls.clear();
  artworkLoads.clear();
}

/** One IDB read per (kind, slug, hash) at a time; concurrent callers share it. */
const artworkLoads = new Map<string, Promise<string | undefined>>();

/** IDB-backed blob: URL when the artwork body is local. */
export function materializeArtworkSrc(
  kind: string,
  slug: string,
): Promise<string | undefined> {
  const rec = artworkRecord(kind, slug);
  if (!rec) {
    forgetArtworkUrl(artworkCacheKey(kind, slug));
    return Promise.resolve(undefined);
  }
  const cached = artworkBlobSrc(kind, slug);
  if (cached) return Promise.resolve(cached);
  if (!replicaUsable()) return Promise.resolve(undefined);
  const loadKey = `${artworkCacheKey(kind, slug)}\0${rec.hash}`;
  const inFlight = artworkLoads.get(loadKey);
  if (inFlight) return inFlight;
  const load = (async (): Promise<string | undefined> => {
    try {
      const data = await getBlob(rec.hash);
      if (!data) return undefined;
      return rememberArtworkUrl(kind, slug, rec.hash, data);
    } catch {
      return undefined;
    } finally {
      artworkLoads.delete(loadKey);
    }
  })();
  artworkLoads.set(loadKey, load);
  return load;
}

async function localRecord(hash: string): Promise<BlobRecord | undefined> {
  try {
    return await getBlobRecord(hash);
  } catch {
    // IDB failure degrades to the network path instead of rejecting a read.
    return undefined;
  }
}

async function resolveManifest(
  rec: PathRecord,
  opts?: ReplicaContentFetchOpts,
): Promise<Response> {
  const row = await localRecord(rec.hash);
  const local = row?.data;
  if (row && local) {
    noteBlobAccess(row);
    noteArtwork(rec, local);
    return new Response(local, { status: 200 });
  }
  const budget = replicaFetchBudgetMs(opts);
  if (budget <= 0) return offline504();
  let buffer: ArrayBuffer;
  try {
    const response = await fetchAbsolute(absoluteUrl(rec.url), budget);
    // Preserve real client errors so the reader can distinguish a missing path
    // from a transient/offline miss. The retired native proxy collapsed both to
    // 504; the TypeScript replica owns this read path now.
    if (!response.ok) {
      return response.status >= 400 && response.status < 500
        ? response
        : offline504();
    }
    buffer = await response.arrayBuffer();
  } catch {
    return offline504();
  }
  try {
    if (!isAudioKind(rec.kind) && persistBodyForKind(rec.kind)) {
      await putBlob({
        hash: rec.hash,
        kind: rec.kind,
        bytes: rec.bytes || buffer.byteLength,
        pinned: 0,
        mtime: Date.now(),
        present: 1,
        data: buffer,
      });
    }
    noteArtwork(rec, buffer);
  } catch {
    // Quota / IDB must not turn a 200 into "offline".
  }
  return new Response(buffer, { status: 200 });
}

async function resolveKeyed(
  norm: string,
  opts?: ReplicaContentFetchOpts,
): Promise<Response> {
  const cacheFirst = opts?.cacheFirst === true;
  if (cacheFirst) {
    const hit = await getUrlCache(norm);
    if (hit) return new Response(hit, { status: 200 });
  }
  const budget = replicaFetchBudgetMs(opts);
  let clientFailure: Response | undefined;
  if (budget > 0) {
    try {
      const response = await fetchAbsolute(absoluteUrl(norm), budget);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        try {
          await putUrlCache(norm, buffer);
        } catch {
          // Persist is best-effort; the caller still gets the fresh body.
        }
        return new Response(buffer, { status: 200 });
      }
      if (response.status >= 400 && response.status < 500) {
        clientFailure = response;
      }
    } catch {
      // fall through to last-good cache
    }
  }
  const fallback = await getUrlCache(norm);
  if (fallback) return new Response(fallback, { status: 200 });
  return clientFailure ?? offline504();
}

/**
 * Unified read path: manifest resources are hash-addressed; everything else is
 * url-keyed (cache-first when `cf=1`, else network-first-then-cache).
 */
export async function replicaContentFetch(
  url: string,
  opts?: ReplicaContentFetchOpts,
): Promise<Response> {
  const norm = normalizeReplicaUrl(url);
  // Replica disabled (IndexedDB failed at boot): the path index is empty and
  // url-keyed cache reads are skipped, so this degrades to plain network reads.
  const rec = replicaUsable()
    ? pathRecordByUrl(norm) ?? blobRecord(norm)
    : undefined;
  if (rec) return resolveManifest(rec, opts);
  return resolveKeyed(norm, opts);
}

function blobRecord(norm: string): PathRecord | undefined {
  if (!norm.startsWith("/api/blob/")) return undefined;
  const hash = norm.slice("/api/blob/".length).split("?")[0] ?? "";
  return hash ? pathRecordForHash(hash) : undefined;
}

export function replicaAudioIndex(): ReplicaAudioResource[] {
  const out: ReplicaAudioResource[] = [];
  for (const rec of allPathRecords()) {
    if (rec.kind !== "audio" && rec.kind !== "marks") continue;
    out.push({
      hash: rec.hash,
      kind: rec.kind,
      url: rec.url,
      path: rec.path,
      bytes: rec.bytes,
    });
  }
  return out;
}

export async function replicaCacheStats(): Promise<{
  cached: number;
  total: number;
  cachedBytes: number;
  totalBytes: number;
}> {
  return contentReplicaStats();
}

/** The deploy root the replica last applied, or null when none (or when the
 *  replica is unavailable). Never throws. */
export async function replicaAppliedRoot(): Promise<string | null> {
  if (!replicaUsable()) return null;
  try {
    return await readRoot();
  } catch {
    return null;
  }
}

/** The server's current deploy root via a plain no-store fetch (never the
 *  url-keyed replica cache: a stale cached root would mask a deploy). Null when
 *  offline or on any failure. */
export async function fetchServerRoot(): Promise<string | null> {
  const budget = replicaFetchBudgetMs();
  if (budget <= 0) return null;
  try {
    const response = await fetchAbsolute(absoluteUrl("/api/root"), budget);
    if (!response.ok) return null;
    return parseRoot(await response.text()).root;
  } catch {
    return null;
  }
}

let manifestRefresh: Promise<string> | null = null;

/** `/api/dag` only when `/api/root` changed. Ingests audioMediaIndex on apply.
 *  Single-flight: startup, foreground, the root poll, and WS updates may all
 *  ask at once; they share one root probe and at most one DAG download. */
export function refreshReplicaManifest(): Promise<string> {
  manifestRefresh ??= runManifestRefresh().finally(() => {
    manifestRefresh = null;
  });
  return manifestRefresh;
}

async function runManifestRefresh(): Promise<string> {
  if (!replicaUsable()) return "";
  const current = (await replicaAppliedRoot()) ?? "";
  if (replicaIsOffline()) return current;
  const serverRoot = await fetchServerRoot();
  // Fall through to the DAG on first boot so a missing /api/root still heals.
  if (serverRoot === null && current) return current;
  if (current && serverRoot === current) return current;
  try {
    const dagResp = await fetchAbsoluteWith(
      absoluteUrl("/api/dag"),
      REPLICA_DAG_MS,
      // The server's DAG ETag is the quoted deploy root.
      current ? { "If-None-Match": `"${current}"` } : undefined,
    );
    if (dagResp.status === 304 || !dagResp.ok) return current;
    const manifest = parseManifest(await dagResp.text());
    await applyDag(manifest);
    ingestDag(manifest.resources);
    return manifest.root;
  } catch {
    return current;
  }
}
