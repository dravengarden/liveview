import { replicaStats as readReplicaStats } from "./agg.ts";
import { getBlob, getBlobRecord, hasBlob, putBlob, setPinned } from "./blobs.ts";
import {
  closeReplicaDb,
  deleteReplicaDb,
  forEachCursor,
  idbRequest,
  openReplicaDb,
  withTxn,
} from "./idb.ts";
import { applyDag, hydratePathIndex, pathRecordForHash, resetPathIndex } from "./manifest.ts";
import {
  applyCellularPolicy,
  enqueueCacheFromUrl,
  installMediaBridge,
} from "./media-bridge.ts";
import { legacyIndex } from "../native-host.ts";
import {
  loadPolicy,
  persistPolicy,
  replicaFlag,
} from "./policy.ts";
import { resetArtworkObjectUrls } from "./resolve.ts";
import {
  APM_MAX_ROWS,
  INDEX_APM_TS,
  STORE_APM,
  type ApmRecord,
  type DataMode,
  isAudioKind,
} from "./schema.ts";
import { replayWorklist, replicaRemoteBase, setReplicaRemote } from "./sync.ts";
import { joinRemoteUrl } from "./worker.ts";
import { installReplicaSpike } from "./spike.ts";

export {
  applyDag,
  getBlob,
  hasBlob,
  putBlob,
  replicaFlag,
  joinRemoteUrl,
};
export { parseManifest, parseRoot, rejectNewerProtocol } from "./manifest.ts";
export { replicaWorkerInitMessage } from "./worker.ts";
export { runReplicaSpike, SPIKE_EVAL_JS } from "./spike.ts";
export {
  loadPolicy,
  persistPolicy,
  persistBodyForKind,
  setPersistFullSizeArtwork,
} from "./policy.ts";
export { getWorklist, setWorklist, enqueueFetch, enqueueEvict } from "./worklist.ts";
export { evictUnpinnedLru, evictUnpinnedAudioToFit } from "./gc.ts";
export { prepareBlobRecord, getBlobRecord, setPresent, deleteBlob } from "./blobs.ts";
export { runWithTimeBudget, spawnReplicaWorker } from "./worker.ts";
export { pullMissingTextArt, enqueueMissingAudio, setReplicaRemote } from "./sync.ts";
export {
  artworkBlobSrc,
  materializeArtworkSrc,
  refreshReplicaManifest,
  replicaAudioIndex,
  replicaCacheStats,
  replicaContentFetch,
  replicaFetchBudgetMs,
  replicaIsOffline,
  setReplicaOfflineProbe,
} from "./resolve.ts";
export { contentReplicaStats } from "./agg.ts";
export { currentReplicaPolicy } from "./policy.ts";
export type {
  BlobRecord,
  DataMode,
  Manifest,
  ReplicaFlag,
  ReplicaPolicy,
  ReplicaStats,
  Resource,
  Worklist,
} from "./schema.ts";
export type {
  ReplicaAudioResource,
  ReplicaContentFetchOpts,
} from "./resolve.ts";

export function replicaStats(): ReturnType<typeof readReplicaStats> {
  return readReplicaStats();
}

export async function drainApmEvents(limit: number): Promise<unknown[]> {
  const cap = Math.max(1, Math.min(limit, 500));
  return withTxn([STORE_APM], "readonly", async (txn) => {
    const index = txn.objectStore(STORE_APM).index(INDEX_APM_TS);
    const out: unknown[] = [];
    await forEachCursor<ApmRecord>(index, null, (value) => {
      if (out.length >= cap) return false;
      out.push(value.body);
      return true;
    });
    return out;
  });
}

export async function ackApmEvents(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await withTxn([STORE_APM], "readwrite", async (txn) => {
    const store = txn.objectStore(STORE_APM);
    for (const id of ids) {
      await idbRequest(store.delete(id));
    }
  });
}

async function importLegacyIndex(): Promise<void> {
  const idx = await legacyIndex();
  if (!idx) return;
  const pins = new Set(idx.pins);
  for (const hash of idx.hashes) {
    if (!hash) continue;
    const old = await getBlobRecord(hash);
    const pinned = old?.pinned === 1 || pins.has(hash) ? 1 : 0;
    await putBlob({
      hash,
      kind: "audio",
      bytes: old?.bytes ?? 0,
      pinned,
      mtime: old?.mtime ?? Date.now(),
      present: 1,
    });
  }
}

export async function putApmEvent(event: ApmRecord): Promise<boolean> {
  return withTxn([STORE_APM], "readwrite", async (txn) => {
    const store = txn.objectStore(STORE_APM);
    const existing = await idbRequest(
      store.get(event.event_id) as IDBRequest<ApmRecord | undefined>,
    );
    if (existing) return false;
    await idbRequest(store.put(event));
    let count = 0;
    await forEachCursor<ApmRecord>(store, null, () => {
      count += 1;
    });
    if (count <= APM_MAX_ROWS) return true;
    const extra = count - APM_MAX_ROWS;
    let dropped = 0;
    const index = store.index(INDEX_APM_TS);
    await forEachCursor<ApmRecord>(index, null, (_value, cursor) => {
      if (dropped >= extra) return false;
      cursor.delete();
      dropped += 1;
      return true;
    });
    return true;
  });
}

export async function pinAudio(
  hashes: string[],
  remoteBase = replicaRemoteBase(),
): Promise<void> {
  for (const hash of hashes) {
    const rec = pathRecordForHash(hash);
    if (!rec || !isAudioKind(rec.kind)) continue;
    await setPinned(hash, 1);
    const url = joinRemoteUrl(remoteBase, rec.url);
    enqueueCacheFromUrl(hash, url);
  }
}

let mediaUnsub: (() => void) | null = null;

export async function initReplica(mode?: DataMode, opts?: {
  remoteBase?: string;
  origins?: readonly string[];
}): Promise<void> {
  if (replicaFlag() !== "idb") return;
  await openReplicaDb();
  const policy = loadPolicy(mode);
  await persistPolicy(policy);
  if (opts?.remoteBase) setReplicaRemote(opts.remoteBase, opts.origins ?? []);
  if (!policy.wifiOnly) applyCellularPolicy(true);
  else applyCellularPolicy(false);
  if (!mediaUnsub) mediaUnsub = installMediaBridge();
  await importLegacyIndex();
  await hydratePathIndex();
  await replayWorklist();
}

export async function resetReplica(): Promise<void> {
  resetArtworkObjectUrls();
  resetPathIndex();
  await deleteReplicaDb();
}

export async function shutdownReplica(): Promise<void> {
  mediaUnsub?.();
  mediaUnsub = null;
  await closeReplicaDb();
}

installReplicaSpike();
