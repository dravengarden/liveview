import { ingestDag } from "../audioMediaIndex.ts";
import { contentReplicaStats } from "./agg.ts";
import { getBlob, putBlob } from "./blobs.ts";
import { idbRequest, withTxn } from "./idb.ts";
import {
  applyDag,
  normalizeReplicaUrl,
  parseManifest,
  parseRoot,
  pathRecordByUrl,
  pathRecordForHash,
  allPathRecords,
  readRoot,
} from "./manifest.ts";
import { persistBodyForKind } from "./policy.ts";
import {
  isArtworkKind,
  isAudioKind,
  META_URL_PREFIX,
  REPLICA_CONNECT_MS,
  REPLICA_DAG_MS,
  STORE_META,
  type MetaRecord,
  type PathRecord,
} from "./schema.ts";
import { replicaRemoteBase } from "./sync.ts";
import { joinRemoteUrl } from "./worker.ts";

export interface ReplicaContentFetchOpts {
  cacheFirst?: boolean;
  fresh?: boolean;
  /** Skip network entirely (net === "none" / known offline). */
  offline?: boolean;
  /** Override the default 1.5s connect budget. */
  connectMs?: number;
}

export interface ReplicaAudioResource {
  hash: string;
  kind: "audio" | "marks";
  url: string;
  path: string;
}

let offlineProbe = (): boolean =>
  typeof navigator !== "undefined" && navigator.onLine === false;

export function setReplicaOfflineProbe(probe: () => boolean): void {
  offlineProbe = probe;
}

export function replicaIsOffline(): boolean {
  return offlineProbe();
}

function connectBudget(opts?: ReplicaContentFetchOpts): number {
  if (opts?.offline === true || replicaIsOffline()) return 0;
  if (opts?.connectMs !== undefined) return opts.connectMs;
  return REPLICA_CONNECT_MS;
}

function offline504(): Response {
  return new Response(null, { status: 504, statusText: "offline" });
}

function urlCacheKey(norm: string): string {
  return `${META_URL_PREFIX}${norm}`;
}

async function getUrlCache(norm: string): Promise<ArrayBuffer | undefined> {
  return withTxn([STORE_META], "readonly", async (txn) => {
    const rec = await idbRequest(
      txn.objectStore(STORE_META).get(urlCacheKey(norm)) as IDBRequest<
        MetaRecord | undefined
      >,
    );
    return rec?.value instanceof ArrayBuffer ? rec.value : undefined;
  });
}

async function putUrlCache(norm: string, data: ArrayBuffer): Promise<void> {
  const rec: MetaRecord = { key: urlCacheKey(norm), value: data };
  await withTxn([STORE_META], "readwrite", async (txn) => {
    await idbRequest(txn.objectStore(STORE_META).put(rec));
  });
}

async function fetchAbsolute(
  url: string,
  budgetMs: number,
): Promise<Response> {
  if (budgetMs <= 0) throw new Error("offline");
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), budgetMs);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function absoluteUrl(pathOrUrl: string): string {
  return joinRemoteUrl(replicaRemoteBase(), pathOrUrl);
}

const artworkObjectUrls = new Map<string, string>();

function artworkCacheKey(kind: string, slug: string): string {
  return `${kind}:${slug}`;
}

export function slugFromArtworkUrl(url: string): string | undefined {
  const norm = normalizeReplicaUrl(url);
  const q = norm.indexOf("?");
  if (q < 0) return undefined;
  return new URLSearchParams(norm.slice(q + 1)).get("book") ?? undefined;
}

function rememberArtworkUrl(
  kind: string,
  slug: string,
  data: ArrayBuffer,
): string | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return undefined;
  }
  const key = artworkCacheKey(kind, slug);
  const prev = artworkObjectUrls.get(key);
  if (prev) {
    try {
      URL.revokeObjectURL(prev);
    } catch {
      // already revoked
    }
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)]));
  artworkObjectUrls.set(key, url);
  return url;
}

function noteArtwork(rec: PathRecord, data: ArrayBuffer): void {
  if (!isArtworkKind(rec.kind)) return;
  const slug = slugFromArtworkUrl(rec.url);
  if (!slug) return;
  rememberArtworkUrl(rec.kind, slug, data);
}

export function artworkBlobSrc(
  kind: string,
  slug: string,
): string | undefined {
  return artworkObjectUrls.get(artworkCacheKey(kind, slug));
}

export function resetArtworkObjectUrls(): void {
  for (const url of artworkObjectUrls.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  artworkObjectUrls.clear();
}

/** IDB-backed blob: URL when the artwork body is local. */
export async function materializeArtworkSrc(
  kind: string,
  slug: string,
): Promise<string | undefined> {
  const cached = artworkBlobSrc(kind, slug);
  if (cached) return cached;
  const rec = pathRecordByUrl(`/api/${kind}?book=${slug}`) ??
    pathRecordByUrl(`/api/${kind}?book=${encodeURIComponent(slug)}`);
  if (!rec) return undefined;
  const data = await getBlob(rec.hash);
  if (!data) return undefined;
  return rememberArtworkUrl(kind, slug, data);
}

async function resolveManifest(
  rec: PathRecord,
  opts?: ReplicaContentFetchOpts,
): Promise<Response> {
  const local = await getBlob(rec.hash);
  if (local) {
    noteArtwork(rec, local);
    return new Response(local, { status: 200 });
  }
  const budget = connectBudget(opts);
  if (budget <= 0) return offline504();
  try {
    const response = await fetchAbsolute(absoluteUrl(rec.url), budget);
    if (!response.ok) return offline504();
    const buffer = await response.arrayBuffer();
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
    return new Response(buffer, { status: 200 });
  } catch {
    return offline504();
  }
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
  const budget = connectBudget(opts);
  if (budget > 0) {
    try {
      const response = await fetchAbsolute(absoluteUrl(norm), budget);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        await putUrlCache(norm, buffer);
        return new Response(buffer, { status: 200 });
      }
    } catch {
      // fall through to last-good cache
    }
  }
  const fallback = await getUrlCache(norm);
  if (fallback) return new Response(fallback, { status: 200 });
  return offline504();
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
  const rec = pathRecordByUrl(norm) ?? blobRecord(norm);
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

/** `/api/dag` only when `/api/root` changed. Ingests audioMediaIndex on apply. */
export async function refreshReplicaManifest(): Promise<string> {
  const current = (await readRoot()) ?? "";
  if (replicaIsOffline()) return current;
  let nextRoot = current;
  try {
    const rootResp = await fetchAbsolute(
      absoluteUrl("/api/root"),
      REPLICA_CONNECT_MS,
    );
    if (rootResp.ok) {
      nextRoot = parseRoot(await rootResp.text()).root;
    }
  } catch {
    // Fall through to DAG on first boot so a missing /api/root still heals.
    if (current) return current;
  }
  if (current && nextRoot === current) return current;
  try {
    const dagResp = await fetchAbsolute(absoluteUrl("/api/dag"), REPLICA_DAG_MS);
    if (!dagResp.ok) return current;
    const manifest = parseManifest(await dagResp.text());
    await applyDag(manifest);
    ingestDag(manifest.resources);
    return manifest.root;
  } catch {
    return current;
  }
}
