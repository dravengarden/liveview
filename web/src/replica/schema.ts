/** Manifest protocol this replica can read. Missing on the wire means v1. */
export const MANIFEST_PROTOCOL_VERSION = 1;

export const REPLICA_DB = "liveview-replica";
export const REPLICA_VERSION = 1;

export const STORE_BLOBS = "blobs";
export const STORE_PATHS = "paths";
export const STORE_META = "meta";
export const STORE_AGG = "agg";
export const STORE_APM = "apm";

export const INDEX_BY_KIND = "by-kind";
export const INDEX_LRU = "lru";
export const INDEX_APM_TS = "by-ts";

export const META_ROOT = "root";
export const META_PROTOCOL_VERSION = "protocol_version";
export const META_POLICY = "policy";
export const META_WORKLIST = "worklist";
/** Url-keyed metadata cache (`/api/manifest`, settings, progress, …). */
export const META_URL_PREFIX = "url:";

/** Replica network I/O connect budget. Fail instantly when net === "none". */
export const REPLICA_CONNECT_MS = 1500;
export const REPLICA_DAG_MS = 30_000;

export const AGG_ALL = "all";
export const AGG_AUDIO = "audio";
export const AGG_TEXT = "text";
export const AGG_ARTWORK = "artwork";

export const APM_MAX_ROWS = 5000;

/** Origin-scoped flag; missing or unknown values mean native. */
export const REPLICA_FLAG_KEY = "lv.replica";

export const WIFI_ONLY_KEY = "lv.offline.wifiOnly";
export const CAP_GB_KEY = "lv.offline.maxGB";
export const DEFAULT_CAP_GB = 20;

export const GC_BATCH = 32;
export const TEXT_ART_CONCURRENCY = 24;
export const MAIN_THREAD_BUDGET_MS = 16;

export type ReplicaFlag = "idb" | "native";
export type DataMode = "eager" | "lazy";
export type PresentFlag = 0 | 1;
export type PinnedFlag = 0 | 1;

export type AggKind = typeof AGG_ALL | typeof AGG_AUDIO | typeof AGG_TEXT | typeof AGG_ARTWORK;

/** One content resource — same fields as protocol v1 `Resource`. */
export interface Resource {
  path: string;
  hash: string;
  kind: string;
  bytes: number;
  url: string;
}

export interface Manifest {
  protocol_version: number;
  root: string;
  resources: Resource[];
}

export interface BlobRecord {
  hash: string;
  kind: string;
  bytes: number;
  pinned: PinnedFlag;
  mtime: number;
  present: PresentFlag;
  data?: ArrayBuffer;
}

export interface PathRecord {
  path: string;
  hash: string;
  kind: string;
  bytes: number;
  url: string;
}

export interface AggRecord {
  kind: string;
  cachedCount: number;
  cachedBytes: number;
  totalCount: number;
  totalBytes: number;
  pinnedBytes: number;
}

export interface ReplicaPolicy {
  mode: DataMode;
  wifiOnly: boolean;
  capBytes: number;
  persistFullSizeArtwork: boolean;
}

export interface Worklist {
  fetch: { hash: string; url: string }[];
  evict: string[];
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

export interface ApmRecord {
  event_id: string;
  ts: number;
  body: unknown;
}

export interface ReplicaStats {
  cached: number;
  total: number;
  cachedBytes: number;
  totalBytes: number;
  audioCached: number;
  audioBytes: number;
  audioPinnedBytes: number;
}

export const ARTWORK_KINDS = new Set([
  "cover",
  "backdrop",
  "card-backdrop",
  "asset",
]);

export const TEXT_KINDS = new Set([
  "text",
  "units",
  "spoken",
  "marks",
  "json",
]);

export function isAudioKind(kind: string): boolean {
  return kind === "audio";
}

export function isArtworkKind(kind: string): boolean {
  return ARTWORK_KINDS.has(kind);
}

export function isCompactArtworkKind(kind: string): boolean {
  return kind === "card-backdrop";
}

export function aggKindOf(kind: string): Exclude<AggKind, typeof AGG_ALL> {
  if (isAudioKind(kind)) return AGG_AUDIO;
  if (isArtworkKind(kind)) return AGG_ARTWORK;
  return AGG_TEXT;
}

export function emptyAgg(kind: string): AggRecord {
  return {
    kind,
    cachedCount: 0,
    cachedBytes: 0,
    totalCount: 0,
    totalBytes: 0,
    pinnedBytes: 0,
  };
}

export function emptyWorklist(): Worklist {
  return { fetch: [], evict: [] };
}

export function protocolTooNew(version: number): boolean {
  return version > MANIFEST_PROTOCOL_VERSION;
}

export function protocolError(version: number): Error {
  return new Error(
    `manifest protocol ${version} is newer than supported ${MANIFEST_PROTOCOL_VERSION}`,
  );
}
