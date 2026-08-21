import { applyCachedDelta } from "./agg.ts";
import { evictUnpinnedLru } from "./gc.ts";
import {
  forEachCursor,
  idbRequest,
  isQuotaExceeded,
  withTxn,
} from "./idb.ts";
import { persistBodyForKind, setPersistFullSizeArtwork } from "./policy.ts";
import {
  type BlobRecord,
  GC_BATCH,
  INDEX_LRU,
  isAudioKind,
  STORE_AGG,
  STORE_BLOBS,
  type PresentFlag,
  type PinnedFlag,
} from "./schema.ts";

async function putOnce(record: BlobRecord): Promise<void> {
  await withTxn([STORE_BLOBS, STORE_AGG], "readwrite", async (txn) => {
    const store = txn.objectStore(STORE_BLOBS);
    const old = await idbRequest(
      store.get(record.hash) as IDBRequest<BlobRecord | undefined>,
    );
    await idbRequest(store.put(record));
    await applyCachedDelta(txn, old, record);
  });
}

function stripBody(record: BlobRecord): BlobRecord {
  if (record.data === undefined) return record;
  const { data: _data, ...rest } = record;
  return rest;
}

/** Audio never stores bodies. Full-size art is optional when quota is tight. */
export function prepareBlobRecord(
  incoming: BlobRecord,
  persistBody = persistBodyForKind(incoming.kind),
): BlobRecord {
  let record = incoming;
  if (isAudioKind(record.kind) || !persistBody) {
    record = stripBody(record);
  }
  if (isAudioKind(record.kind)) {
    // present flips only on cacheProgress; a metadata put must not look cached.
    if (record.data !== undefined) record = stripBody(record);
  } else if (record.data && record.present !== 1) {
    record = { ...record, present: 1 };
  } else if (!record.data && record.present === 1 && !isAudioKind(record.kind)) {
    record = { ...record, present: 0 };
  }
  return record;
}

export async function putBlob(incoming: BlobRecord): Promise<void> {
  const record = prepareBlobRecord(incoming);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await putOnce(record);
      return;
    } catch (error) {
      if (!isQuotaExceeded(error)) throw error;
      const evicted = await evictUnpinnedLru({ limit: GC_BATCH });
      if (evicted === 0) {
        setPersistFullSizeArtwork(false);
        if (record.data !== undefined && persistBodyForKind(record.kind) === false) {
          await putOnce(prepareBlobRecord(stripBody(record), false));
          return;
        }
        throw error;
      }
    }
  }
}

export async function getBlobRecord(
  hash: string,
): Promise<BlobRecord | undefined> {
  return withTxn([STORE_BLOBS], "readonly", async (txn) => {
    return await idbRequest(
      txn.objectStore(STORE_BLOBS).get(hash) as IDBRequest<
        BlobRecord | undefined
      >,
    );
  });
}

export async function getBlob(hash: string): Promise<ArrayBuffer | undefined> {
  const rec = await getBlobRecord(hash);
  return rec?.data;
}

export async function hasBlob(hash: string): Promise<boolean> {
  const rec = await getBlobRecord(hash);
  return rec !== undefined && rec.present === 1;
}

export async function hasBlobRow(hash: string): Promise<boolean> {
  const rec = await getBlobRecord(hash);
  return rec !== undefined;
}

export async function deleteBlob(hash: string): Promise<boolean> {
  return withTxn([STORE_BLOBS, STORE_AGG], "readwrite", async (txn) => {
    const store = txn.objectStore(STORE_BLOBS);
    const old = await idbRequest(
      store.get(hash) as IDBRequest<BlobRecord | undefined>,
    );
    if (!old) return false;
    await idbRequest(store.delete(hash));
    await applyCachedDelta(txn, old, undefined);
    return true;
  });
}

export async function setPresent(
  hash: string,
  present: PresentFlag,
): Promise<void> {
  await withTxn([STORE_BLOBS, STORE_AGG], "readwrite", async (txn) => {
    const store = txn.objectStore(STORE_BLOBS);
    const old = await idbRequest(
      store.get(hash) as IDBRequest<BlobRecord | undefined>,
    );
    if (!old || old.present === present) return;
    const next: BlobRecord = { ...old, present, mtime: Date.now() };
    await idbRequest(store.put(next));
    await applyCachedDelta(txn, old, next);
  });
}

export async function setPinned(
  hash: string,
  pinned: PinnedFlag,
): Promise<void> {
  await withTxn([STORE_BLOBS, STORE_AGG], "readwrite", async (txn) => {
    const store = txn.objectStore(STORE_BLOBS);
    const old = await idbRequest(
      store.get(hash) as IDBRequest<BlobRecord | undefined>,
    );
    if (!old || old.pinned === pinned) return;
    const next: BlobRecord = { ...old, pinned };
    await idbRequest(store.put(next));
    await applyCachedDelta(txn, old, next);
  });
}

export async function touchBlob(hash: string): Promise<void> {
  await withTxn([STORE_BLOBS], "readwrite", async (txn) => {
    const store = txn.objectStore(STORE_BLOBS);
    const old = await idbRequest(
      store.get(hash) as IDBRequest<BlobRecord | undefined>,
    );
    if (!old) return;
    await idbRequest(store.put({ ...old, mtime: Date.now() }));
  });
}

export function unpinnedLruRange(): IDBKeyRange {
  return IDBKeyRange.bound([0, 0], [0, Number.MAX_SAFE_INTEGER]);
}

export async function iterateUnpinnedLru(
  visit: (value: BlobRecord, cursor: IDBCursorWithValue) => boolean | void,
  limit = Infinity,
): Promise<number> {
  return withTxn([STORE_BLOBS], "readonly", async (txn) => {
    const index = txn.objectStore(STORE_BLOBS).index(INDEX_LRU);
    let seen = 0;
    await forEachCursor<BlobRecord>(index, unpinnedLruRange(), (value, cursor) => {
      if (seen >= limit) return false;
      seen += 1;
      return visit(value, cursor);
    });
    return seen;
  });
}
