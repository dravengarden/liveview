import {
  AGG_ALL,
  AGG_AUDIO,
  AGG_ARTWORK,
  AGG_TEXT,
  type AggKind,
  type AggRecord,
  type BlobRecord,
  emptyAgg,
  STORE_AGG,
  aggKindOf,
  type ReplicaStats,
} from "./schema.ts";
import { idbRequest, openReplicaDb, withTxn } from "./idb.ts";

const AGG_KINDS: AggKind[] = [AGG_ALL, AGG_AUDIO, AGG_TEXT, AGG_ARTWORK];

export async function readAgg(kind: string): Promise<AggRecord> {
  return withTxn([STORE_AGG], "readonly", async (txn) => {
    return await loadAgg(txn, kind);
  });
}

export async function replicaStats(): Promise<ReplicaStats> {
  const all = await readAgg(AGG_ALL);
  const audio = await readAgg(AGG_AUDIO);
  return {
    cached: all.cachedCount,
    total: all.totalCount,
    cachedBytes: all.cachedBytes,
    totalBytes: all.totalBytes,
    audioCached: audio.cachedCount,
    audioBytes: audio.cachedBytes,
    audioPinnedBytes: audio.pinnedBytes,
  };
}

/** Non-audio Downloads numerator/denominator (text + artwork). */
export async function contentReplicaStats(): Promise<{
  cached: number;
  total: number;
  cachedBytes: number;
  totalBytes: number;
}> {
  const text = await readAgg(AGG_TEXT);
  const art = await readAgg(AGG_ARTWORK);
  return {
    cached: text.cachedCount + art.cachedCount,
    total: text.totalCount + art.totalCount,
    cachedBytes: text.cachedBytes + art.cachedBytes,
    totalBytes: text.totalBytes + art.totalBytes,
  };
}

export async function loadAgg(
  txn: IDBTransaction,
  kind: string,
): Promise<AggRecord> {
  const store = txn.objectStore(STORE_AGG);
  const row = await idbRequest(store.get(kind) as IDBRequest<AggRecord | undefined>);
  return row ?? emptyAgg(kind);
}

async function putAgg(txn: IDBTransaction, row: AggRecord): Promise<void> {
  await idbRequest(txn.objectStore(STORE_AGG).put(row));
}

function cachedWeight(rec: BlobRecord | undefined): {
  count: number;
  bytes: number;
  pinnedBytes: number;
} {
  if (!rec || rec.present !== 1) {
    return { count: 0, bytes: 0, pinnedBytes: 0 };
  }
  return {
    count: 1,
    bytes: rec.bytes,
    pinnedBytes: rec.pinned === 1 ? rec.bytes : 0,
  };
}

/** Update cached* in the same txn as the put/delete/present flip. */
export async function applyCachedDelta(
  txn: IDBTransaction,
  oldRec: BlobRecord | undefined,
  newRec: BlobRecord | undefined,
): Promise<void> {
  const subtract = cachedWeight(oldRec);
  const add = cachedWeight(newRec);
  if (
    subtract.count === add.count &&
    subtract.bytes === add.bytes &&
    subtract.pinnedBytes === add.pinnedBytes &&
    (oldRec?.kind === newRec?.kind || (!oldRec && !newRec))
  ) {
    return;
  }

  const all = await loadAgg(txn, AGG_ALL);
  all.cachedCount += add.count - subtract.count;
  all.cachedBytes += add.bytes - subtract.bytes;
  all.pinnedBytes += add.pinnedBytes - subtract.pinnedBytes;
  await putAgg(txn, all);

  if (oldRec && newRec && aggKindOf(oldRec.kind) === aggKindOf(newRec.kind)) {
    const row = await loadAgg(txn, aggKindOf(newRec.kind));
    row.cachedCount += add.count - subtract.count;
    row.cachedBytes += add.bytes - subtract.bytes;
    row.pinnedBytes += add.pinnedBytes - subtract.pinnedBytes;
    await putAgg(txn, row);
    return;
  }
  if (oldRec) {
    const row = await loadAgg(txn, aggKindOf(oldRec.kind));
    row.cachedCount -= subtract.count;
    row.cachedBytes -= subtract.bytes;
    row.pinnedBytes -= subtract.pinnedBytes;
    await putAgg(txn, row);
  }
  if (newRec) {
    const row = await loadAgg(txn, aggKindOf(newRec.kind));
    row.cachedCount += add.count;
    row.cachedBytes += add.bytes;
    row.pinnedBytes += add.pinnedBytes;
    await putAgg(txn, row);
  }
}

/** Totals come from the DAG, never from puts. */
export async function rewriteTotals(
  txn: IDBTransaction,
  resources: readonly { kind: string; bytes: number }[],
): Promise<void> {
  const next: Record<AggKind, { count: number; bytes: number }> = {
    [AGG_ALL]: { count: 0, bytes: 0 },
    [AGG_AUDIO]: { count: 0, bytes: 0 },
    [AGG_TEXT]: { count: 0, bytes: 0 },
    [AGG_ARTWORK]: { count: 0, bytes: 0 },
  };
  for (const resource of resources) {
    const cat = aggKindOf(resource.kind);
    next[cat].count += 1;
    next[cat].bytes += resource.bytes;
    next[AGG_ALL].count += 1;
    next[AGG_ALL].bytes += resource.bytes;
  }
  for (const kind of AGG_KINDS) {
    const row = await loadAgg(txn, kind);
    row.totalCount = next[kind].count;
    row.totalBytes = next[kind].bytes;
    await putAgg(txn, row);
  }
}

export async function ensureAggRows(): Promise<void> {
  await openReplicaDb();
  await withTxn([STORE_AGG], "readwrite", async (txn) => {
    for (const kind of AGG_KINDS) {
      const row = await loadAgg(txn, kind);
      await putAgg(txn, row);
    }
  });
}
