import { readAgg } from "./agg.ts";
import {
  bodyKnownPresent,
  deleteBlob,
  getBlobRecord,
  hasBlob,
  noteBodyPresent,
  putBlob,
} from "./blobs.ts";
import { forEachCursor, withTxn } from "./idb.ts";
import {
  enqueueCacheDelete,
  enqueueCacheFromUrl,
  isCacheQueued,
  nativeAudioCacheAvailable,
} from "./media-bridge.ts";
import { allPathRecords, pathRecordForHash } from "./manifest.ts";
import {
  currentReplicaPolicy,
  persistBodyForKind,
  replicaUsable,
  setPersistFullSizeArtwork,
} from "./policy.ts";
import {
  getWorklist,
  mutateWorklistUnlocked,
  removeFetch,
  removeFetches,
  withWorklistLock,
} from "./worklist.ts";
import {
  AGG_AUDIO,
  type BlobRecord,
  INDEX_BY_KIND,
  isAudioKind,
  STORE_BLOBS,
} from "./schema.ts";
import {
  joinRemoteUrl,
  type ReplicaWorkerFill,
  type ReplicaWorkerFillItem,
  runWithTimeBudget,
  spawnReplicaWorker,
} from "./worker.ts";

let remoteBase = "";
let origins: string[] = [];
let worker: Worker | null = null;
let workerFailed = false;

export function setReplicaRemote(
  base: string,
  remoteOrigins: readonly string[] = [],
): void {
  remoteBase = base;
  origins = [...remoteOrigins];
}

export function replicaRemoteBase(): string {
  return remoteBase;
}

export function absoluteReplicaUrl(pathOrUrl: string): string {
  return joinRemoteUrl(remoteBase, pathOrUrl);
}

// ── Eager text/art fill bookkeeping ────────────────────────────────────────
// Callers (Downloads panel poll, foreground, startup) may ask for a pull every
// few seconds. A batch already handed to the worker must not be re-posted, and
// a hash that keeps failing must not be hammered.

/** Hash → time it was handed to the worker. */
const inFlight = new Map<string, number>();
/** A worker message that never arrives must not wedge the pump forever. */
export const IN_FLIGHT_STALE_MS = 120_000;
/** Hash → consecutive failures and earliest retry time. */
const failures = new Map<string, { count: number; retryAt: number }>();
export const FILL_BACKOFF_BASE_MS = 5_000;
export const FILL_BACKOFF_MAX_MS = 10 * 60_000;
/** Hashes posted by replayWorklist; only those live on the persisted worklist. */
const replayPosted = new Set<string>();
let pullRunning: Promise<void> | null = null;

function noteFillFailure(hash: string, now = Date.now()): void {
  const count = (failures.get(hash)?.count ?? 0) + 1;
  const delay = Math.min(
    FILL_BACKOFF_BASE_MS * 2 ** (count - 1),
    FILL_BACKOFF_MAX_MS,
  );
  failures.set(hash, { count, retryAt: now + delay });
}

function noteFillSuccess(hash: string): void {
  failures.delete(hash);
}

function inBackoff(hash: string, now: number): boolean {
  const entry = failures.get(hash);
  return entry !== undefined && entry.retryAt > now;
}

function pruneStaleInFlight(now: number): void {
  for (const [hash, started] of inFlight) {
    if (now - started > IN_FLIGHT_STALE_MS) inFlight.delete(hash);
  }
}

/** Test seam: forget fill bookkeeping between cases. */
export function resetFillState(): void {
  inFlight.clear();
  failures.clear();
  replayPosted.clear();
  pullRunning = null;
}

export function fillInFlightCount(): number {
  return inFlight.size;
}

async function fillOne(item: ReplicaWorkerFillItem): Promise<void> {
  const url = joinRemoteUrl(remoteBase, item.url);
  if (isAudioKind(item.kind)) {
    if (await hasBlob(item.hash)) return;
    enqueueCacheFromUrl(item.hash, url, item.bytes);
    return;
  }
  if (!persistBodyForKind(item.kind)) return;
  if (await hasBlob(item.hash)) return;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      noteFillFailure(item.hash);
      return;
    }
    const buffer = await response.arrayBuffer();
    await putBlob({
      hash: item.hash,
      kind: item.kind,
      bytes: item.bytes || buffer.byteLength,
      pinned: 0,
      mtime: Date.now(),
      present: 1,
      data: buffer,
    });
    noteFillSuccess(item.hash);
  } catch {
    // One bad item must not abort the rest of the batch.
    noteFillFailure(item.hash);
  }
}

async function fillOnMainThread(items: ReplicaWorkerFillItem[]): Promise<void> {
  await runWithTimeBudget(items, fillOne);
}

async function hashesDone(
  items: ReplicaWorkerFillItem[],
): Promise<string[]> {
  const done: string[] = [];
  for (const item of items) {
    if (isAudioKind(item.kind) || !persistBodyForKind(item.kind)) {
      done.push(item.hash);
      continue;
    }
    if (await hasBlob(item.hash)) done.push(item.hash);
  }
  return done;
}

async function fillOnMainThreadAndDrain(
  items: ReplicaWorkerFillItem[],
): Promise<void> {
  try {
    await fillOnMainThread(items);
    await removeFetches(await hashesDone(items));
  } finally {
    for (const item of items) {
      inFlight.delete(item.hash);
      replayPosted.delete(item.hash);
    }
  }
}

type WorkerOut = {
  type?: string;
  hash?: string;
  url?: string;
  bytes?: number;
  items?: ReplicaWorkerFillItem[];
  persistFullSizeArtwork?: boolean;
};

async function dropFromWorklist(hash: string): Promise<void> {
  if (replayPosted.delete(hash)) await removeFetch(hash);
}

async function onWorkerMessage(msg: WorkerOut | undefined): Promise<void> {
  if (msg?.type === "media" && msg.hash && msg.url) {
    enqueueCacheFromUrl(msg.hash, msg.url, msg.bytes);
    await dropFromWorklist(msg.hash);
    return;
  }
  if (msg?.type === "filled" && msg.hash) {
    inFlight.delete(msg.hash);
    noteFillSuccess(msg.hash);
    noteBodyPresent(msg.hash);
    await dropFromWorklist(msg.hash);
    return;
  }
  if (msg?.type === "error" && msg.hash) {
    inFlight.delete(msg.hash);
    noteFillFailure(msg.hash);
    return;
  }
  if (msg?.type === "skipped" && msg.hash) {
    inFlight.delete(msg.hash);
    return;
  }
  if (msg?.type === "policy" && typeof msg.persistFullSizeArtwork === "boolean") {
    setPersistFullSizeArtwork(msg.persistFullSizeArtwork);
    return;
  }
  if (msg?.type !== "fallback") return;
  workerFailed = true;
  try {
    worker?.terminate();
  } catch {
    // already dead
  }
  worker = null;
  await fillOnMainThreadAndDrain(msg.items ?? []);
}

function ensureWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  worker = spawnReplicaWorker({ remoteBase, origins });
  if (!worker) {
    workerFailed = true;
    return null;
  }
  worker.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
    void onWorkerMessage(event.data).catch((error: unknown) => {
      console.warn("replica: worker message handling failed", error);
    });
  });
  worker.addEventListener("error", () => {
    workerFailed = true;
    worker = null;
    // Nothing will report on the posted batch; let the next pull re-plan it.
    inFlight.clear();
  });
  return worker;
}

function fillMessage(items: ReplicaWorkerFillItem[]): ReplicaWorkerFill {
  return {
    type: "fill",
    items,
    persistFullSizeArtwork: currentReplicaPolicy().persistFullSizeArtwork,
  };
}

export async function missingTextArt(): Promise<ReplicaWorkerFillItem[]> {
  const out: ReplicaWorkerFillItem[] = [];
  const seen = new Set<string>();
  for (const rec of allPathRecords()) {
    if (isAudioKind(rec.kind) || seen.has(rec.hash)) continue;
    if (!persistBodyForKind(rec.kind)) continue;
    seen.add(rec.hash);
    // Skip the body read for hashes already confirmed local this session.
    if (bodyKnownPresent(rec.hash)) continue;
    const row = await getBlobRecord(rec.hash);
    if (row?.present === 1 && row.data) {
      noteBodyPresent(rec.hash);
      continue;
    }
    out.push({
      hash: rec.hash,
      url: rec.url,
      kind: rec.kind,
      bytes: rec.bytes,
    });
  }
  return out;
}

async function presentAudioHashes(): Promise<Set<string>> {
  return withTxn([STORE_BLOBS], "readonly", async (txn) => {
    const present = new Set<string>();
    const index = txn.objectStore(STORE_BLOBS).index(INDEX_BY_KIND);
    await forEachCursor<BlobRecord>(
      index,
      IDBKeyRange.only("audio"),
      (value) => {
        if (value.present === 1) present.add(value.hash);
      },
    );
    return present;
  });
}

/** Bound automatic fill to remaining cap (pinned + LRU headroom). One worklist
 *  mutation; cacheFromUrl posts are constant-size and natively 6-wide. */
export async function enqueueMissingAudio(): Promise<void> {
  if (!replicaUsable()) return;
  const cap = currentReplicaPolicy().capBytes;
  const audio = await readAgg(AGG_AUDIO);
  const present = await presentAudioHashes();
  const queued = new Set((await getWorklist()).fetch.map((item) => item.hash));
  let reserved = audio.cachedBytes;
  for (const hash of queued) {
    if (present.has(hash)) continue;
    const rec = pathRecordForHash(hash);
    reserved += rec && rec.bytes > 0 ? rec.bytes : 1;
  }
  let remaining = Math.max(0, cap - reserved);
  const missing: { hash: string; url: string; bytes: number }[] = [];
  const seen = new Set<string>();
  for (const rec of allPathRecords()) {
    if (!isAudioKind(rec.kind) || seen.has(rec.hash)) continue;
    seen.add(rec.hash);
    if (
      present.has(rec.hash) || queued.has(rec.hash) || isCacheQueued(rec.hash)
    ) {
      continue;
    }
    const size = rec.bytes > 0 ? rec.bytes : 1;
    if (remaining < size) continue;
    remaining -= size;
    missing.push({
      hash: rec.hash,
      url: joinRemoteUrl(remoteBase, rec.url),
      bytes: size,
    });
  }
  if (missing.length === 0) return;
  await withWorklistLock(async () => {
    await mutateWorklistUnlocked((wl) => {
      const have = new Set(wl.fetch.map((item) => item.hash));
      for (const item of missing) {
        if (!have.has(item.hash)) {
          wl.fetch.push({ hash: item.hash, url: item.url });
        }
      }
    });
  });
  for (const item of missing) {
    enqueueCacheFromUrl(item.hash, item.url, item.bytes);
  }
}

/**
 * Eager text/art fill. Single-flight, and while a posted batch is still being
 * filled the call is a no-op: the next pull after it drains rescans. Hashes in
 * failure backoff are left for a later pass.
 */
export function pullMissingTextArt(): Promise<void> {
  pullRunning ??= runPull().finally(() => {
    pullRunning = null;
  });
  return pullRunning;
}

async function runPull(): Promise<void> {
  if (!replicaUsable()) return;
  const now = Date.now();
  pruneStaleInFlight(now);
  if (inFlight.size > 0) return;
  const items = (await missingTextArt()).filter((item) =>
    !inBackoff(item.hash, now)
  );
  if (items.length === 0) return;
  const w = ensureWorker();
  if (w) {
    for (const item of items) inFlight.set(item.hash, now);
    w.postMessage(fillMessage(items));
    return;
  }
  for (const item of items) inFlight.set(item.hash, now);
  await fillOnMainThreadAndDrain(items);
}

export async function replayWorklist(): Promise<void> {
  await withWorklistLock(async () => {
    const wl = await getWorklist();
    const keepEvict: string[] = [];
    const nativeStore = nativeAudioCacheAvailable();
    for (const hash of wl.evict) {
      const existed = await getBlobRecord(hash);
      await deleteBlob(hash);
      const posted = enqueueCacheDelete(hash);
      if (posted) continue;
      if (existed && !isAudioKind(existed.kind)) continue;
      // Without a native store (PWA) there is nothing to delete; retaining the
      // hash would grow the worklist forever.
      if (!nativeStore) continue;
      keepEvict.push(hash);
    }
    const pending = wl.fetch;
    await mutateWorklistUnlocked((next) => {
      next.evict = keepEvict;
      next.fetch = pending;
    });
    if (pending.length === 0) return;
    const items: ReplicaWorkerFillItem[] = [];
    for (const item of pending) {
      const rec = pathRecordForHash(item.hash);
      items.push({
        hash: item.hash,
        url: item.url,
        kind: rec?.kind ?? "text",
        bytes: rec?.bytes ?? 0,
      });
    }
    const w = ensureWorker();
    if (w) {
      for (const item of items) replayPosted.add(item.hash);
      w.postMessage(fillMessage(items));
      return;
    }
    const policy = currentReplicaPolicy();
    if (policy.mode === "lazy") return;
    await fillOnMainThread(items);
    const done = new Set(await hashesDone(items));
    await mutateWorklistUnlocked((next) => {
      next.fetch = next.fetch.filter((item) => !done.has(item.hash));
    });
  });
}
