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

/**
 * Session-local hint of non-audio hashes whose body is known to be stored, so
 * the eager-fill scan does not re-read every body on each pass. It is only a
 * skip hint: a stale entry (e.g. a body evicted by another context) delays an
 * eager refetch until the next launch, while reads still fall back to network.
 */
const knownBodies = new Set<string>();

export function bodyKnownPresent(hash: string): boolean {
  return knownBodies.has(hash);
}

export function noteBodyPresent(hash: string): void {
  knownBodies.add(hash);
}

export function forgetKnownBodies(hashes: Iterable<string>): void {
  for (const hash of hashes) knownBodies.delete(hash);
}

export function resetKnownBodies(): void {
  knownBodies.clear();
}

async function putOnce(record: BlobRecord): Promise<void> {
  await withTxn([STORE_BLOBS, STORE_AGG], "readwrite", async (txn) => {
    const store = txn.objectStore(STORE_BLOBS);
    const old = await idbRequest(
      store.get(record.hash) as IDBRequest<BlobRecord | undefined>,
    );
    await idbRequest(store.put(record));
    await applyCachedDelta(txn, old, record);
  });
  if (record.present === 1 && record.data !== undefined) {
    knownBodies.add(record.hash);
  } else {
    knownBodies.delete(record.hash);
  }
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
    return record;
  }
  if (record.data && record.present !== 1) {
    return { ...record, present: 1 };
  }
  if (!record.data && record.present === 1) {
    return { ...record, present: 0 };
  }
  return record;
}

const PUT_ATTEMPTS = 4;

export async function putBlob(incoming: BlobRecord): Promise<void> {
  const record = prepareBlobRecord(incoming);
  let lastError: unknown;
  for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
    try {
      await putOnce(record);
      return;
    } catch (error) {
      if (!isQuotaExceeded(error)) throw error;
      lastError = error;
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
  // Every round evicted something yet the put still did not fit. Surface the
  // quota failure instead of reporting a write that never happened.
  throw lastError ?? new Error("putBlob: quota exceeded after eviction");
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
  knownBodies.delete(hash);
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
  await touchBlobs([hash]);
}

/** Refresh LRU recency for several rows in one transaction. */
export async function touchBlobs(hashes: readonly string[]): Promise<void> {
  if (hashes.length === 0) return;
  const now = Date.now();
  await withTxn([STORE_BLOBS], "readwrite", async (txn) => {
    const store = txn.objectStore(STORE_BLOBS);
    for (const hash of hashes) {
      const old = await idbRequest(
        store.get(hash) as IDBRequest<BlobRecord | undefined>,
      );
      if (!old || old.mtime >= now) continue;
      await idbRequest(store.put({ ...old, mtime: now }));
    }
  });
}

/** A store hit refreshes recency at most once per window: the touch rewrites
 *  the row, so rereading a chapter must not turn every read into a write. */
export const TOUCH_MIN_AGE_MS = 10 * 60_000;
const TOUCH_FLUSH_MS = 2_000;
const pendingTouches = new Set<string>();
let touchTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

/** Debounced LRU touch for a local read hit; off the read path. */
export function noteBlobAccess(
  rec: Pick<BlobRecord, "hash" | "mtime">,
  now = Date.now(),
): void {
  if (now - rec.mtime < TOUCH_MIN_AGE_MS) return;
  pendingTouches.add(rec.hash);
  if (touchTimer !== undefined) return;
  touchTimer = globalThis.setTimeout(() => {
    touchTimer = undefined;
    void flushBlobTouches().catch(() => {
      // Recency is advisory; a failed touch only affects eviction order.
    });
  }, TOUCH_FLUSH_MS);
}

export async function flushBlobTouches(): Promise<void> {
  if (touchTimer !== undefined) {
    globalThis.clearTimeout(touchTimer);
    touchTimer = undefined;
  }
  if (pendingTouches.size === 0) return;
  const hashes = [...pendingTouches];
  pendingTouches.clear();
  await touchBlobs(hashes);
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
