import { readAgg } from "./agg.ts";
import { deleteBlob, getBlobRecord, hasBlob, putBlob } from "./blobs.ts";
import { forEachCursor, withTxn } from "./idb.ts";
import {
  enqueueCacheDelete,
  enqueueCacheFromUrl,
  isCacheQueued,
} from "./media-bridge.ts";
import { allPathRecords, pathRecordForHash } from "./manifest.ts";
import { currentReplicaPolicy, persistBodyForKind } from "./policy.ts";
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
  type PathRecord,
  STORE_BLOBS,
} from "./schema.ts";
import {
  joinRemoteUrl,
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

async function fillOne(item: ReplicaWorkerFillItem): Promise<void> {
  const url = joinRemoteUrl(remoteBase, item.url);
  if (isAudioKind(item.kind)) {
    if (await hasBlob(item.hash)) return;
    enqueueCacheFromUrl(item.hash, url, item.bytes);
    return;
  }
  if (!persistBodyForKind(item.kind)) return;
  if (await hasBlob(item.hash)) return;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return;
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
  await fillOnMainThread(items);
  await removeFetches(await hashesDone(items));
}

type WorkerOut = {
  type?: string;
  hash?: string;
  url?: string;
  bytes?: number;
  items?: ReplicaWorkerFillItem[];
};

async function onWorkerMessage(msg: WorkerOut | undefined): Promise<void> {
  if (msg?.type === "media" && msg.hash && msg.url) {
    enqueueCacheFromUrl(msg.hash, msg.url, msg.bytes);
    await removeFetch(msg.hash);
    return;
  }
  if (msg?.type === "filled" && msg.hash) {
    await removeFetch(msg.hash);
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
    void onWorkerMessage(event.data);
  });
  worker.addEventListener("error", () => {
    workerFailed = true;
    worker = null;
  });
  return worker;
}

export async function missingTextArt(): Promise<ReplicaWorkerFillItem[]> {
  const out: ReplicaWorkerFillItem[] = [];
  const seen = new Set<string>();
  for (const rec of allPathRecords()) {
    if (isAudioKind(rec.kind) || seen.has(rec.hash)) continue;
    if (!persistBodyForKind(rec.kind)) continue;
    seen.add(rec.hash);
    const row = await getBlobRecord(rec.hash);
    if (row?.present === 1 && row.data) continue;
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

export async function pullMissingTextArt(): Promise<void> {
  const items = await missingTextArt();
  if (items.length === 0) return;
  const w = ensureWorker();
  if (w) {
    w.postMessage(
      { type: "fill", items } satisfies {
        type: "fill";
        items: ReplicaWorkerFillItem[];
      },
    );
    return;
  }
  await fillOnMainThreadAndDrain(items);
}

export async function replayWorklist(): Promise<void> {
  await withWorklistLock(async () => {
    const wl = await getWorklist();
    const keepEvict: string[] = [];
    for (const hash of wl.evict) {
      const existed = await getBlobRecord(hash);
      await deleteBlob(hash);
      const posted = enqueueCacheDelete(hash);
      if (posted) continue;
      if (existed && !isAudioKind(existed.kind)) continue;
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
      const rec = pathByKind(item.hash);
      items.push({
        hash: item.hash,
        url: item.url,
        kind: rec?.kind ?? "text",
        bytes: rec?.bytes ?? 0,
      });
    }
    const w = ensureWorker();
    if (w) {
      w.postMessage({ type: "fill", items });
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

function pathByKind(hash: string): PathRecord | undefined {
  return allPathRecords().find((rec) => rec.hash === hash);
}
