import { applyCachedDelta, readAgg } from "./agg.ts";
import { forEachCursor, withTxn } from "./idb.ts";
import { enqueueCacheDelete } from "./media-bridge.ts";
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

/** Per-file LRU, pin-exempt, bounded cursor. Quota recovery is image/text only. */
export async function evictUnpinnedLru(opts?: {
  limit?: number;
}): Promise<number> {
  const limit = opts?.limit ?? GC_BATCH;
  return withTxn(
    [STORE_BLOBS, STORE_AGG],
    "readwrite",
    async (txn) => {
      const store = txn.objectStore(STORE_BLOBS);
      const index = store.index(INDEX_LRU);
      let n = 0;
      const pending: BlobRecord[] = [];
      await forEachCursor<BlobRecord>(index, unpinnedRange(), (value, cursor) => {
        if (n >= limit) return false;
        if (value.pinned === 1 || isAudioKind(value.kind)) return true;
        pending.push(value);
        cursor.delete();
        n += 1;
        return true;
      });
      for (const rec of pending) {
        await applyCachedDelta(txn, rec, undefined);
      }
      return n;
    },
  );
}

/** User-facing audio cap: per-file LRU, pinned-exempt. Native only deletes
 *  files when TS calls cacheDelete — native never GCs on its own. */
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
      await forEachCursor<BlobRecord>(index, unpinnedRange(), (value, cursor) => {
        if (over <= 0) return false;
        if (value.pinned === 1 || !isAudioKind(value.kind)) return true;
        pending.push(value);
        cursor.delete();
        over -= value.bytes;
        return true;
      });
      for (const rec of pending) {
        await applyCachedDelta(txn, rec, undefined);
      }
    },
  );
  for (const rec of pending) enqueueCacheDelete(rec.hash);
  return pending.length;
}
