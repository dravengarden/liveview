import { applyCachedDelta } from "./agg.ts";
import { forEachCursor, withTxn } from "./idb.ts";
import {
  type BlobRecord,
  GC_BATCH,
  INDEX_LRU,
  isAudioKind,
  STORE_AGG,
  STORE_BLOBS,
} from "./schema.ts";

type NativeDelete = (hash: string) => boolean;
let nativeDelete: NativeDelete | null = null;

export function setGcNativeDelete(fn: NativeDelete | null): void {
  nativeDelete = fn;
}

function unpinnedRange(): IDBKeyRange {
  return IDBKeyRange.bound([0, 0], [0, Number.MAX_SAFE_INTEGER]);
}

/** Per-file LRU, pin-exempt, bounded cursor. Never scan the blob store. */
export async function evictUnpinnedLru(opts?: {
  limit?: number;
}): Promise<number> {
  const limit = opts?.limit ?? GC_BATCH;
  const nativeHashes: string[] = [];
  const evicted = await withTxn(
    [STORE_BLOBS, STORE_AGG],
    "readwrite",
    async (txn) => {
      const store = txn.objectStore(STORE_BLOBS);
      const index = store.index(INDEX_LRU);
      let n = 0;
      const pending: BlobRecord[] = [];
      await forEachCursor<BlobRecord>(index, unpinnedRange(), (value, cursor) => {
        if (n >= limit) return false;
        // Audio has no IDB body; quota recovery targets image/text rows.
        if (value.pinned === 1 || isAudioKind(value.kind)) return true;
        pending.push(value);
        cursor.delete();
        n += 1;
        return true;
      });
      for (const rec of pending) {
        await applyCachedDelta(txn, rec, undefined);
        if (isAudioKind(rec.kind)) nativeHashes.push(rec.hash);
      }
      return n;
    },
  );
  for (const hash of nativeHashes) nativeDelete?.(hash);
  return evicted;
}
