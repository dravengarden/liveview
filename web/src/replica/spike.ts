import { replicaStats } from "./agg.ts";
import { putBlob } from "./blobs.ts";
import { openReplicaDb } from "./idb.ts";
import { replicaFlag } from "./policy.ts";
import { refreshReplicaManifest } from "./resolve.ts";
import { pullMissingTextArt } from "./sync.ts";

export interface ReplicaSpikeResult {
  estimate: { usage: number; quota: number } | null;
  persist: boolean | "denied" | "unsupported";
  putMs: number;
  count: number;
}

async function measurePersist(): Promise<boolean | "denied" | "unsupported"> {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage || typeof storage.persist !== "function") return "unsupported";
    return await storage.persist();
  } catch {
    return "denied";
  }
}

async function measureEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    if (!estimate) return null;
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return null;
  }
}

/** Insert a compact card-backdrop batch and return quota/persist timings. */
export async function runReplicaSpike(
  count = 32,
): Promise<ReplicaSpikeResult> {
  await openReplicaDb();
  const payload = new TextEncoder().encode("lv-card-backdrop");
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    await putBlob({
      hash: `spike-card-${i}`,
      kind: "card-backdrop",
      bytes: payload.byteLength,
      pinned: 0,
      mtime: Date.now() + i,
      present: 1,
      data: payload.buffer.slice(0),
    });
  }
  const putMs = performance.now() - start;
  return {
    estimate: await measureEstimate(),
    persist: await measurePersist(),
    putMs,
    count,
  };
}

/**
 * Self-contained source for `lvsim.sh eval` when the SPA has not yet imported
 * this module. Opens `liveview-replica` directly.
 */
export const SPIKE_EVAL_JS = `(() => {
  const count = 32;
  const payload = new TextEncoder().encode("lv-card-backdrop");
  const openDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open("liveview-replica", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("blobs")) {
        const blobs = db.createObjectStore("blobs", { keyPath: "hash" });
        blobs.createIndex("by-kind", "kind");
        blobs.createIndex("lru", ["pinned", "mtime"]);
      }
      if (!db.objectStoreNames.contains("paths")) {
        db.createObjectStore("paths", { keyPath: "path" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("agg")) {
        db.createObjectStore("agg", { keyPath: "kind" });
      }
      if (!db.objectStoreNames.contains("apm")) {
        const apm = db.createObjectStore("apm", { keyPath: "event_id" });
        apm.createIndex("by-ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const put = (db, rec) => new Promise((resolve, reject) => {
    const txn = db.transaction(["blobs"], "readwrite");
    txn.objectStore("blobs").put(rec);
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(txn.error);
  });
  return (async () => {
    const db = await openDb();
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      await put(db, {
        hash: "spike-card-" + i,
        kind: "card-backdrop",
        bytes: payload.byteLength,
        pinned: 0,
        mtime: Date.now() + i,
        present: 1,
        data: payload.buffer.slice(0),
      });
    }
    const putMs = performance.now() - start;
    let persist = "unsupported";
    try {
      if (navigator.storage && navigator.storage.persist) {
        persist = await navigator.storage.persist();
      }
    } catch {
      persist = "denied";
    }
    let estimate = null;
    try {
      const est = await navigator.storage.estimate();
      estimate = { usage: est.usage || 0, quota: est.quota || 0 };
    } catch {}
    return JSON.stringify({ estimate, persist, putMs, count, origin: location.origin });
  })();
})()`;

/** 600-frame gate while fill is in flight; does not wait for fill to finish. */
export async function runReplicaFillGate(): Promise<Record<string, unknown>> {
  const fill = (async () => {
    await refreshReplicaManifest();
    await pullMissingTextArt();
  })();
  let fillError: string | null = null;
  void fill.catch((error: unknown) => {
    fillError = error instanceof Error ? error.message : String(error);
  });

  let frames = 0;
  let maxGap = 0;
  let over50 = 0;
  let last = performance.now();
  while (frames < 600) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    const now = performance.now();
    const gap = now - last;
    last = now;
    frames += 1;
    if (gap > maxGap) maxGap = gap;
    if (gap > 50) over50 += 1;
  }

  let persist: boolean | "denied" | "unsupported" = "unsupported";
  try {
    persist = await measurePersist();
  } catch {
    persist = "denied";
  }

  return {
    origin: globalThis.location?.origin ?? "",
    flag: replicaFlag(),
    frames,
    maxGap,
    over50,
    fillError,
    persist,
    estimate: await measureEstimate(),
    stats: await replicaStats(),
  };
}

export function installReplicaSpike(): void {
  const g = globalThis as Record<string, unknown>;
  g["__lvReplicaSpike"] = runReplicaSpike;
  g["__lvReplicaSpikeEval"] = SPIKE_EVAL_JS;
  g["__lvReplicaFillGate"] = runReplicaFillGate;
}
