import { applyCachedDelta, rewriteTotals } from "./agg.ts";
import { forEachCursor, idbRequest, withTxn } from "./idb.ts";
import {
  mutateWorklistInTxn,
  mutateWorklistUnlocked,
  withWorklistLock,
} from "./worklist.ts";
import { enqueueCacheDelete } from "./media-bridge.ts";
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
  isAudioKind,
} from "./schema.ts";

let pathIndex = new Map<string, PathRecord>();
let hashUrls = new Map<string, string>();

export function pathByHashUrl(hash: string): string | undefined {
  return hashUrls.get(hash);
}

export function pathRecord(path: string): PathRecord | undefined {
  return pathIndex.get(path);
}

export function pathRecordForHash(hash: string): PathRecord | undefined {
  for (const rec of pathIndex.values()) {
    if (rec.hash === hash) return rec;
  }
  return undefined;
}

export function allPathRecords(): PathRecord[] {
  return [...pathIndex.values()];
}

export function resetPathIndex(): void {
  pathIndex = new Map();
  hashUrls = new Map();
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

function mergeBlob(old: BlobRecord, resource: Resource): BlobRecord {
  const next: BlobRecord = {
    hash: resource.hash,
    kind: resource.kind,
    bytes: resource.bytes,
    pinned: flagMax(old.pinned, 0) as PinnedFlag,
    mtime: old.mtime,
    present: flagMax(old.present, 0) as PresentFlag,
  };
  if (old.data !== undefined) next.data = old.data;
  return next;
}

/**
 * Merge a DAG snapshot. `present`/`pinned` are max(old, incoming) so a later
 * apply with default 0 cannot hide a blob that is already local.
 */
export async function applyDag(manifest: Manifest): Promise<void> {
  rejectNewerProtocol(manifest.protocol_version);
  const byHash = new Map<string, Resource>();
  for (const resource of manifest.resources) {
    if (!byHash.has(resource.hash)) byHash.set(resource.hash, resource);
  }
  const droppedAudio: string[] = [];
  const nextPaths = new Map<string, PathRecord>();
  const nextUrls = new Map<string, string>();

  await withWorklistLock(async () => {
    await withTxn(
      [STORE_BLOBS, STORE_PATHS, STORE_AGG, STORE_META],
      "readwrite",
      async (txn) => {
        const blobs = txn.objectStore(STORE_BLOBS);
        const paths = txn.objectStore(STORE_PATHS);
        const meta = txn.objectStore(STORE_META);
        const seen = new Set<string>();
        const now = Date.now();

        await forEachCursor<BlobRecord>(blobs, null, async (value, cursor) => {
          const resource = byHash.get(value.hash);
          if (!resource) {
            if (isAudioKind(value.kind)) droppedAudio.push(value.hash);
            await applyCachedDelta(txn, value, undefined);
            cursor.delete();
            return true;
          }
          seen.add(value.hash);
          const next = mergeBlob(value, resource);
          await idbRequest(blobs.put(next));
          await applyCachedDelta(txn, value, next);
          return true;
        });

        for (const [hash, resource] of byHash) {
          if (seen.has(hash)) continue;
          const next: BlobRecord = {
            hash,
            kind: resource.kind,
            bytes: resource.bytes,
            pinned: 0,
            mtime: now,
            present: 0,
          };
          await idbRequest(blobs.put(next));
          await applyCachedDelta(txn, undefined, next);
        }

        await idbRequest(paths.clear());
        for (const resource of manifest.resources) {
          const rec: PathRecord = {
            path: resource.path,
            hash: resource.hash,
            kind: resource.kind,
            bytes: resource.bytes,
            url: resource.url,
          };
          await idbRequest(paths.put(rec));
          nextPaths.set(resource.path, rec);
          if (!nextUrls.has(resource.hash)) {
            nextUrls.set(resource.hash, resource.url);
          }
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
        await mutateWorklistInTxn(txn, (wl) => {
          for (const hash of droppedAudio) {
            if (!wl.evict.includes(hash)) wl.evict.push(hash);
            wl.fetch = wl.fetch.filter((item) => item.hash !== hash);
          }
        });
      },
    );

    pathIndex = nextPaths;
    hashUrls = nextUrls;

    const posted: string[] = [];
    for (const hash of droppedAudio) {
      if (enqueueCacheDelete(hash)) posted.push(hash);
    }
    if (posted.length > 0) {
      const done = new Set(posted);
      await mutateWorklistUnlocked((wl) => {
        wl.evict = wl.evict.filter((hash) => !done.has(hash));
      });
    }
  });
}

export async function hydratePathIndex(): Promise<void> {
  const nextPaths = new Map<string, PathRecord>();
  const nextUrls = new Map<string, string>();
  await withTxn([STORE_PATHS], "readonly", async (txn) => {
    await forEachCursor<PathRecord>(txn.objectStore(STORE_PATHS), null, (value) => {
      nextPaths.set(value.path, value);
      if (!nextUrls.has(value.hash)) nextUrls.set(value.hash, value.url);
    });
  });
  pathIndex = nextPaths;
  hashUrls = nextUrls;
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
