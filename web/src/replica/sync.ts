import { deleteBlob, getBlobRecord, hasBlob, putBlob } from "./blobs.ts";
import { enqueueCacheFromUrl } from "./media-bridge.ts";
import { allPathRecords } from "./manifest.ts";
import { currentReplicaPolicy } from "./policy.ts";
import {
  getWorklist,
  removeEvict,
  removeFetch,
  setWorklist,
} from "./worklist.ts";
import {
  isAudioKind,
  TEXT_ART_CONCURRENCY,
  type PathRecord,
} from "./schema.ts";
import {
  joinRemoteUrl,
  runWithTimeBudget,
  spawnReplicaWorker,
  type ReplicaWorkerFillItem,
} from "./worker.ts";

let remoteBase = "";
let origins: string[] = [];
let worker: Worker | null = null;
let workerFailed = false;

export function setReplicaRemote(base: string, remoteOrigins: readonly string[] = []): void {
  remoteBase = base;
  origins = [...remoteOrigins];
}

export function replicaRemoteBase(): string {
  return remoteBase;
}

export function absoluteReplicaUrl(pathOrUrl: string): string {
  return joinRemoteUrl(remoteBase, pathOrUrl);
}

async function poolMap<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const n = Math.min(limit, items.length);
  if (n === 0) return;
  const runners = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i];
      i += 1;
      if (item === undefined) continue;
      await fn(item);
    }
  });
  await Promise.all(runners);
}

async function fillOne(item: ReplicaWorkerFillItem): Promise<void> {
  const url = joinRemoteUrl(remoteBase, item.url);
  if (isAudioKind(item.kind)) {
    enqueueCacheFromUrl(item.hash, url);
    await removeFetch(item.hash);
    return;
  }
  if (await hasBlob(item.hash)) {
    await removeFetch(item.hash);
    return;
  }
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
  await removeFetch(item.hash);
}

async function fillOnMainThread(items: ReplicaWorkerFillItem[]): Promise<void> {
  await runWithTimeBudget(items, fillOne);
}

function ensureWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  worker = spawnReplicaWorker({ remoteBase, origins });
  if (!worker) {
    workerFailed = true;
    return null;
  }
  worker.addEventListener("message", (event: MessageEvent<{
    type?: string;
    hash?: string;
    url?: string;
    items?: ReplicaWorkerFillItem[];
  }>) => {
    const msg = event.data;
    if (msg?.type === "media" && msg.hash && msg.url) {
      enqueueCacheFromUrl(msg.hash, msg.url);
      void removeFetch(msg.hash);
      return;
    }
    if (msg?.type === "filled" && msg.hash) {
      void removeFetch(msg.hash);
      return;
    }
    if (msg?.type === "fallback") {
      workerFailed = true;
      try {
        worker?.terminate();
      } catch {
        // already dead
      }
      worker = null;
      void fillOnMainThread(msg.items ?? []);
    }
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

export async function pullMissingTextArt(): Promise<void> {
  const items = await missingTextArt();
  if (items.length === 0) return;
  const w = ensureWorker();
  if (w) {
    w.postMessage({ type: "fill", items } satisfies {
      type: "fill";
      items: ReplicaWorkerFillItem[];
    });
    return;
  }
  await poolMap(items, TEXT_ART_CONCURRENCY, fillOne);
}

export async function replayWorklist(): Promise<void> {
  const wl = await getWorklist();
  for (const hash of wl.evict) {
    await deleteBlob(hash);
    await removeEvict(hash);
  }
  const pending = (await getWorklist()).fetch;
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
  await setWorklist({ fetch: pending, evict: [] });
  const w = ensureWorker();
  if (w) {
    w.postMessage({ type: "fill", items });
    return;
  }
  const policy = currentReplicaPolicy();
  if (policy.mode === "lazy") return;
  await fillOnMainThread(items);
}

function pathByKind(hash: string): PathRecord | undefined {
  return allPathRecords().find((rec) => rec.hash === hash);
}
