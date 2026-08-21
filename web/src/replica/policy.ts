import {
  CAP_GB_KEY,
  DEFAULT_CAP_GB,
  META_POLICY,
  STORE_META,
  WIFI_ONLY_KEY,
  type DataMode,
  type MetaRecord,
  type ReplicaFlag,
  type ReplicaPolicy,
  REPLICA_FLAG_KEY,
} from "./schema.ts";
import { idbRequest, withTxn } from "./idb.ts";

let persistFullSizeArtwork = true;
let currentPolicy: ReplicaPolicy | null = null;

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function replicaFlag(): ReplicaFlag {
  const value = readStorage(REPLICA_FLAG_KEY);
  if (value === "idb" || value === "native") return value;
  return "native";
}

export function isAppShell(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

export function defaultMode(): DataMode {
  return isAppShell() ? "eager" : "lazy";
}

export function wifiOnlyPref(): boolean {
  return (readStorage(WIFI_ONLY_KEY) ?? "1") === "1";
}

export function capBytesPref(): number {
  const gb = Number(readStorage(CAP_GB_KEY) ?? String(DEFAULT_CAP_GB)) ||
    DEFAULT_CAP_GB;
  return gb * 1_073_741_824;
}

export function loadPolicy(mode?: DataMode): ReplicaPolicy {
  currentPolicy = {
    mode: mode ?? defaultMode(),
    wifiOnly: wifiOnlyPref(),
    capBytes: capBytesPref(),
    persistFullSizeArtwork,
  };
  return currentPolicy;
}

export function currentReplicaPolicy(): ReplicaPolicy {
  return currentPolicy ?? loadPolicy();
}

export function setPersistFullSizeArtwork(on: boolean): void {
  persistFullSizeArtwork = on;
  if (currentPolicy) currentPolicy.persistFullSizeArtwork = on;
}

export function persistBodyForKind(
  kind: string,
  policy: ReplicaPolicy = currentReplicaPolicy(),
): boolean {
  if (kind === "audio") return false;
  if (kind === "card-backdrop") return true;
  if (
    kind === "cover" || kind === "backdrop" || kind === "asset"
  ) {
    return policy.persistFullSizeArtwork;
  }
  return true;
}

export async function persistPolicy(policy: ReplicaPolicy): Promise<void> {
  currentPolicy = policy;
  persistFullSizeArtwork = policy.persistFullSizeArtwork;
  const rec: MetaRecord = { key: META_POLICY, value: policy };
  await withTxn([STORE_META], "readwrite", async (txn) => {
    await idbRequest(txn.objectStore(STORE_META).put(rec));
  });
}

export async function readPersistedPolicy(): Promise<ReplicaPolicy | null> {
  return withTxn([STORE_META], "readonly", async (txn) => {
    const rec = await idbRequest(
      txn.objectStore(STORE_META).get(META_POLICY) as IDBRequest<
        MetaRecord | undefined
      >,
    );
    if (!rec || typeof rec.value !== "object" || rec.value === null) {
      return null;
    }
    return rec.value as ReplicaPolicy;
  });
}
