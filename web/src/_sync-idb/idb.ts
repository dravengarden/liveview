// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/sync-idb (shared-utils
// `state-sync-engine` branch); the `@shared-utils/sync` import is rewritten to
// the sibling vendored _sync. Edit there + re-vendor. See _sync-idb/mod.ts.
//
// IndexedDB-backed LocalPersistence for the @shared-utils state tiers — the
// browser backend for instant-load + offline caching. Generic over the stored
// shape `S`, so it backs BOTH tiers with one impl: a `replicatedStore`'s durable
// outbox (`S = ClientSnapshot<T>`) and a `mirroredStore`'s value mirror
// (`S = T`). One DB, one object store, one record (structured-clone, no manual
// JSON) per key. Async by nature; ALL errors degrade gracefully (a
// blocked/absent/quota'd store behaves as "nothing stored") so persistence can
// never break the app.
//
// IndexedDB is an event-based API with no promise interface, so wrapping its
// requests in `new Promise` is unavoidable here.
// oxlint-disable promise/avoid-new

import type { LocalPersistence } from "../_sync/mod.ts";

export interface IdbOpts {
  /** Database name. Default "shared-utils-sync". */
  dbName?: string;
  /** Object-store name. Default "clients". */
  storeName?: string;
}

/** A `LocalPersistence<S>` storing one record of shape `S` under `key`
 *  (`ClientSnapshot<T>` for a replicated client, or a raw `T` value for a
 *  mirrored store). */
export function idbPersistence<S>(key: string, opts: IdbOpts = {}): LocalPersistence<S> {
  const dbName = opts.dbName ?? "shared-utils-sync";
  const storeName = opts.storeName ?? "clients";
  let dbPromise: Promise<IDBDatabase> | undefined = undefined;

  const open = (): Promise<IDBDatabase> => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.addEventListener("upgradeneeded", () => {
        if (!req.result.objectStoreNames.contains(storeName)) {
          req.result.createObjectStore(storeName);
        }
      });
      req.addEventListener("success", () => {
        resolve(req.result);
      });
      req.addEventListener("error", () => {
        reject(req.error ?? new Error("indexedDB open failed"));
      });
    });
    return dbPromise;
  };

  const run = async <R>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> => {
    const db = await open();
    return new Promise<R>((resolve, reject) => {
      const r = make(db.transaction(storeName, mode).objectStore(storeName));
      r.addEventListener("success", () => {
        resolve(r.result);
      });
      r.addEventListener("error", () => {
        reject(r.error ?? new Error("indexedDB request failed"));
      });
    });
  };

  return {
    load: async (): Promise<S | null> => {
      try {
        const v = await run<S | undefined>(
          "readonly",
          (s) => s.get(key) as IDBRequest<S | undefined>,
        );
        return v ?? null;
      } catch {
        return null; // blocked / absent / corrupt → "nothing stored"
      }
    },
    save: async (value): Promise<void> => {
      try {
        await run<IDBValidKey>("readwrite", (s) => s.put(value, key));
      } catch {
        // degrade gracefully — persistence must never break the app
      }
    },
  };
}
