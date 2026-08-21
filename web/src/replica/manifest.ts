import { applyCachedDelta, rewriteTotals } from "./agg.ts";
import { forEachCursor, idbRequest, withTxn } from "./idb.ts";
import { enqueueEvict } from "./worklist.ts";
import {
  type BlobRecord,
  type Manifest,
  MANIFEST_PROTOCOL_VERSION,
  META_PROTOCOL_VERSION,
  META_ROOT,
  type MetaRecord,
  type PathRecord,
  type PinnedFlag,
  type PresentFlag,
  protocolError,
  protocolTooNew,
  type Resource,
  STORE_AGG,
  STORE_BLOBS,
  STORE_META,
  STORE_PATHS,
} from "./schema.ts";

const pathIndex = new Map<string, PathRecord>();
const hashUrls = new Map<string, string>();

export function pathByHashUrl(hash: string): string | undefined {
  return hashUrls.get(hash);
}

export function pathRecord(path: string): PathRecord | undefined {
  return pathIndex.get(path);
}

export function allPathRecords(): PathRecord[] {
  return [...pathIndex.values()];
}

export function resetPathIndex(): void {
  pathIndex.clear();
  hashUrls.clear();
}

export function rejectNewerProtocol(version: number): void {
  if (protocolTooNew(version)) throw protocolError(version);
}

export function parseRoot(json: string): { protocol_version: number; root: string } {
  const raw: unknown = JSON.parse(json);
  if (!raw || typeof raw !== "object") throw new Error("root parse: not an object");
  const rec = raw as Record<string, unknown>;
  const protocol_version = typeof rec["protocol_version"] === "number"
    ? rec["protocol_version"]
    : MANIFEST_PROTOCOL_VERSION;
  rejectNewerProtocol(protocol_version);
  if (typeof rec["root"] !== "string") throw new Error("root parse: missing root");
  return { protocol_version, root: rec["root"] };
}

export function parseManifest(json: string): Manifest {
  const raw: unknown = JSON.parse(json);
  if (!raw || typeof raw !== "object") {
    throw new Error("manifest parse: not an object");
  }
  const rec = raw as Record<string, unknown>;
  const protocol_version = typeof rec["protocol_version"] === "number"
    ? rec["protocol_version"]
    : MANIFEST_PROTOCOL_VERSION;
  rejectNewerProtocol(protocol_version);
  if (typeof rec["root"] !== "string") {
    throw new Error("manifest parse: missing root");
  }
  const resourcesIn = rec["resources"];
  if (!Array.isArray(resourcesIn)) {
    throw new Error("manifest parse: missing resources");
  }
  const resources: Resource[] = [];
  for (const item of resourcesIn) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r["path"] !== "string" ||
      typeof r["hash"] !== "string" ||
      typeof r["kind"] !== "string" ||
      typeof r["url"] !== "string"
    ) {
      continue;
    }
    const bytes = typeof r["bytes"] === "number" ? r["bytes"] : 0;
    resources.push({
      path: r["path"],
      hash: r["hash"],
      kind: r["kind"],
      bytes,
      url: r["url"],
    });
  }
  return { protocol_version, root: rec["root"], resources };
}

function flagMax(old: number, incoming: number): PresentFlag | PinnedFlag {
  return (old > incoming ? old : incoming) as PresentFlag | PinnedFlag;
}

/**
 * Merge a DAG snapshot. `present`/`pinned` are max(old, incoming) so a later
 * apply with default 0 cannot hide a blob that is already local.
 */
export async function applyDag(manifest: Manifest): Promise<void> {
  rejectNewerProtocol(manifest.protocol_version);
  const incomingHashes = new Set(manifest.resources.map((r) => r.hash));
  const droppedAudio: string[] = [];

  await withTxn(
    [STORE_BLOBS, STORE_PATHS, STORE_AGG, STORE_META],
    "readwrite",
    async (txn) => {
      const blobs = txn.objectStore(STORE_BLOBS);
      const paths = txn.objectStore(STORE_PATHS);
      const meta = txn.objectStore(STORE_META);

      const existing = new Map<string, BlobRecord>();
      await forEachCursor<BlobRecord>(blobs, null, (value) => {
        existing.set(value.hash, value);
      });

      await idbRequest(paths.clear());
      pathIndex.clear();
      hashUrls.clear();

      const seen = new Set<string>();
      const now = Date.now();
      for (const resource of manifest.resources) {
        const rec: PathRecord = {
          path: resource.path,
          hash: resource.hash,
          kind: resource.kind,
          bytes: resource.bytes,
          url: resource.url,
        };
        await idbRequest(paths.put(rec));
        pathIndex.set(resource.path, rec);
        if (!hashUrls.has(resource.hash)) {
          hashUrls.set(resource.hash, resource.url);
        }

        if (seen.has(resource.hash)) continue;
        seen.add(resource.hash);

        const old = existing.get(resource.hash);
        const incomingPresent = 0 as PresentFlag;
        const incomingPinned = 0 as PinnedFlag;
        const next: BlobRecord = old
          ? {
            hash: resource.hash,
            kind: resource.kind,
            bytes: resource.bytes,
            pinned: flagMax(old.pinned, incomingPinned) as PinnedFlag,
            mtime: old.mtime,
            present: flagMax(old.present, incomingPresent) as PresentFlag,
            ...(old.data !== undefined ? { data: old.data } : {}),
          }
          : {
            hash: resource.hash,
            kind: resource.kind,
            bytes: resource.bytes,
            pinned: incomingPinned,
            mtime: now,
            present: incomingPresent,
          };
        await idbRequest(blobs.put(next));
        await applyCachedDelta(txn, old, next);
      }

      for (const [hash, old] of existing) {
        if (incomingHashes.has(hash)) continue;
        await idbRequest(blobs.delete(hash));
        await applyCachedDelta(txn, old, undefined);
        if (old.kind === "audio") droppedAudio.push(hash);
      }

      await rewriteTotals(txn, manifest.resources);
      await idbRequest(
        meta.put({
          key: META_ROOT,
          value: manifest.root,
        } satisfies MetaRecord),
      );
      await idbRequest(
        meta.put({
          key: META_PROTOCOL_VERSION,
          value: manifest.protocol_version,
        } satisfies MetaRecord),
      );
    },
  );

  for (const hash of droppedAudio) await enqueueEvict(hash);
}

export async function hydratePathIndex(): Promise<void> {
  pathIndex.clear();
  hashUrls.clear();
  await withTxn([STORE_PATHS], "readonly", async (txn) => {
    await forEachCursor<PathRecord>(txn.objectStore(STORE_PATHS), null, (value) => {
      pathIndex.set(value.path, value);
      if (!hashUrls.has(value.hash)) hashUrls.set(value.hash, value.url);
    });
  });
}

export async function readRoot(): Promise<string | null> {
  return withTxn([STORE_META], "readonly", async (txn) => {
    const rec = await idbRequest(
      txn.objectStore(STORE_META).get(META_ROOT) as IDBRequest<
        MetaRecord | undefined
      >,
    );
    return typeof rec?.value === "string" ? rec.value : null;
  });
}
