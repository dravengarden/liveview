import { applyCachedDelta, readAgg } from "./agg.ts";
import { forgetKnownBodies } from "./blobs.ts";
import { forEachCursor, idbRequest, withTxn } from "./idb.ts";
import { enqueueCacheDelete } from "./media-bridge.ts";
import { currentReplicaPolicy } from "./policy.ts";
import {
  AGG_AUDIO,
  type BlobRecord,
  GC_BATCH,
  INDEX_LRU,
  isAudioKind,
  STORE_AGG,
  STORE_BLOBS,
} from "./schema.ts";

function unpinnedRange(): IDBKeyRange {
  return IDBKeyRange.bound([0, 0], [0, Number.MAX_SAFE_INTEGER]);
}

/** Per-file LRU, pin-exempt, bounded cursor. Quota recovery is image/text only.
 *  Placeholder rows (present=0) hold no body, so deleting them frees nothing and
 *  only loses the DAG metadata; they are skipped. */
export async function evictUnpinnedLru(opts?: {
  limit?: number;
}): Promise<number> {
  const limit = opts?.limit ?? GC_BATCH;
  const pending: BlobRecord[] = [];
  await withTxn(
    [STORE_BLOBS, STORE_AGG],
    "readwrite",
    async (txn) => {
      const store = txn.objectStore(STORE_BLOBS);
      const index = store.index(INDEX_LRU);
      await forEachCursor<BlobRecord>(index, unpinnedRange(), (value, cursor) => {
        if (pending.length >= limit) return false;
        if (value.pinned === 1 || isAudioKind(value.kind)) return true;
        if (value.present !== 1) return true;
        pending.push(value);
        cursor.delete();
        return true;
      });
      for (const rec of pending) {
        await applyCachedDelta(txn, rec, undefined);
      }
    },
  );
  forgetKnownBodies(pending.map((rec) => rec.hash));
  return pending.length;
}

/** User-facing audio cap: per-file LRU, pinned-exempt. Native only deletes
 *  files when TS calls cacheDelete — native never GCs on its own.
 *
 *  Only rows that are actually cached (present=1) count toward the cap. An
 *  evicted row stays as a present=0 placeholder so a later re-download's
 *  cacheProgress can flip it back through setPresent. */
export async function evictUnpinnedAudioToFit(capBytes: number): Promise<number> {
  if (capBytes <= 0) return 0;
  const audio = await readAgg(AGG_AUDIO);
  let over = audio.cachedBytes - capBytes;
  if (over <= 0) return 0;
  const pending: BlobRecord[] = [];
  await withTxn(
    [STORE_BLOBS, STORE_AGG],
    "readwrite",
    async (txn) => {
      const store = txn.objectStore(STORE_BLOBS);
      const index = store.index(INDEX_LRU);
      await forEachCursor<BlobRecord>(index, unpinnedRange(), (value) => {
        if (over <= 0) return false;
        if (value.pinned === 1 || !isAudioKind(value.kind)) return true;
        if (value.present !== 1) return true;
        pending.push(value);
        over -= value.bytes;
        return true;
      });
      for (const rec of pending) {
        const next: BlobRecord = { ...rec, present: 0 };
        await idbRequest(store.put(next));
        await applyCachedDelta(txn, rec, next);
      }
    },
  );
  for (const rec of pending) enqueueCacheDelete(rec.hash);
  return pending.length;
}

let evictTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

/** Coalesce cap eviction across a burst of cacheProgress events. */
export function scheduleEvictUnpinnedAudioToFit(): void {
  if (evictTimer !== undefined) return;
  evictTimer = globalThis.setTimeout(() => {
    evictTimer = undefined;
    void evictUnpinnedAudioToFit(currentReplicaPolicy().capBytes).catch(
      (error: unknown) => {
        console.warn("replica: audio cap eviction failed", error);
      },
    );
  }, 200);
}
