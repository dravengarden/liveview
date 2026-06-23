// lv-sync facade — the web app's single door to the Rust offline core (WASM).
//
// The Rust `Engine` (Merkle + content-addressed resolve/sync/gc) is compiled to
// WASM and vendored under `_lvsync/`; this module supplies its platform IO —
// an IndexedDB blob store + `fetch` — and turns the app's *URL-shaped* reads into
// content-addressed `resolve`s. The whole point: once a resource is resolved
// while online it lives in IndexedDB by hash, so the SAME read offline returns
// the cached bytes with ZERO network. Network is only ever used to ACQUIRE a
// resource that isn't cached yet. (Native iOS/Mac use the native Rust build via
// Tauri IPC instead — this file is the web/PWA half.)
//
// Identity note: a manifest resource `hash` is a content key (rustfs / source
// blake3), not necessarily blake3 of the SERVED bytes (rendered html), so the
// WASM engine runs with verify OFF and trusts the store key — see wasm.rs.

import init, { LvSync } from "./_lvsync/lv_sync.js";
import wasmUrl from "./_lvsync/lv_sync_bg.wasm?url";

/** One resource in the corpus manifest (mirrors `lv_sync::Resource`). */
interface Resource {
  path: string;
  hash: string;
  kind: string;
  bytes: number;
  url: string;
}
interface Manifest {
  root: string;
  resources: Resource[];
}

// ── IndexedDB blob store (hash → bytes) ──────────────────────────────────────
// One object store keyed by content hash. Immutable values, so no versioning of
// entries is needed; the DB itself is bumped only if the schema changes.

const DB_NAME = "lvsync";
const STORE = "blobs";

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** The IO object the WASM bridges to — `{ get, put, has, keys, remove, fetch }`. */
const io = {
  async get(hash: string): Promise<Uint8Array | null> {
    const v = await tx<unknown>("readonly", (s) => s.get(hash));
    if (v == null) return null;
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return null;
  },
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    // Copy off the WASM heap: the view is backed by WASM linear memory which can
    // move/detach; IndexedDB must own a standalone buffer.
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    await tx<IDBValidKey>("readwrite", (s) => s.put(owned, hash));
  },
  async has(hash: string): Promise<boolean> {
    const k = await tx<IDBValidKey | undefined>("readonly", (s) => s.getKey(hash));
    return k !== undefined;
  },
  async keys(): Promise<string[]> {
    const ks = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    return ks.map(String);
  },
  async remove(hash: string): Promise<void> {
    await tx<undefined>("readwrite", (s) => s.delete(hash));
  },
  async fetch(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

// ── Init + URL routing ───────────────────────────────────────────────────────

interface Core {
  sync: LvSync;
  manifest: Manifest;
  urlToPath: Map<string, string>;
  resByPath: Map<string, Resource>;
}

let corePromise: Promise<Core> | null = null;

/** Initialise the core once (idempotent): load the wasm + fetch the manifest. */
export function lvReady(): Promise<Core> {
  if (!corePromise) {
    corePromise = (async () => {
      await init(wasmUrl);
      const res = await fetch("/api/dag");
      if (!res.ok) throw new Error(`/api/dag: ${res.status}`);
      const json = await res.text();
      const manifest = JSON.parse(json) as Manifest;
      const urlToPath = new Map<string, string>();
      const resByPath = new Map<string, Resource>();
      for (const r of manifest.resources) {
        urlToPath.set(r.url, r.path);
        resByPath.set(r.path, r);
      }
      return { sync: new LvSync(io, json), manifest, urlToPath, resByPath };
    })();
  }
  return corePromise;
}

/** True for URLs the core can resolve (i.e. present in the manifest). */
export async function lvKnows(url: string): Promise<boolean> {
  const core = await lvReady();
  return core.urlToPath.has(url);
}

/**
 * Resolve a manifest URL → bytes, store-first (offline-safe). Throws `"offline"`
 * if the resource is uncached and unreachable, or if the URL isn't in the
 * manifest (caller should fall back to a plain `fetch`).
 */
export async function lvResolve(url: string): Promise<Uint8Array> {
  const core = await lvReady();
  const path = core.urlToPath.get(url);
  if (path === undefined) throw new Error(`lvsync: ${url} not in manifest`);
  const out: unknown = await core.sync.resolve(path);
  return out as Uint8Array;
}

const MIME: Record<string, string> = {
  audio: "audio/mpeg",
  text: "text/html",
  spoken: "application/json",
  units: "application/json",
  marks: "application/json",
};

/** Resolve a URL and wrap it in an object URL (caller revokes when done). */
export async function lvBlobUrl(url: string, mime?: string): Promise<string> {
  const core = await lvReady();
  const bytes = await lvResolve(url);
  const kind = core.urlToPath.has(url)
    ? core.resByPath.get(core.urlToPath.get(url)!)?.kind
    : undefined;
  const type = mime ?? (kind ? MIME[kind] : undefined) ?? "application/octet-stream";
  // Copy into a plain ArrayBuffer: the WASM-returned view may be typed over
  // SharedArrayBuffer, which Blob's lib.dom types reject.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return URL.createObjectURL(new Blob([buf], { type }));
}

/** Byte-weighted offline fraction in [0,1] (how much of the corpus is cached). */
export async function lvOfflineFraction(): Promise<number> {
  const core = await lvReady();
  return (await core.sync.offline_fraction()) as number;
}

/** Eager: pull the whole manifest into the store. Resolves to bytes cached. */
export async function lvSyncAll(): Promise<number> {
  const core = await lvReady();
  return (await core.sync.sync_all()) as number;
}

/** GC orphans (hashes no longer in the manifest). Resolves to the count. */
export async function lvGc(): Promise<number> {
  const core = await lvReady();
  return (await core.sync.gc()) as number;
}
