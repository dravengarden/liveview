// oxlint-disable promise/avoid-new

import {
  INDEX_APM_TS,
  INDEX_BY_KIND,
  INDEX_LRU,
  REPLICA_DB,
  REPLICA_VERSION,
  STORE_AGG,
  STORE_APM,
  STORE_BLOBS,
  STORE_META,
  STORE_PATHS,
} from "./schema.ts";

let dbPromise: Promise<IDBDatabase> | undefined;

function factory(): IDBFactory {
  const idb = globalThis.indexedDB;
  if (!idb) throw new Error("IndexedDB is unavailable");
  return idb;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () =>
      reject(req.error ?? new Error("IndexedDB request failed"))
    );
  });
}

export { request as idbRequest };

function upgrade(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(STORE_BLOBS)) {
    const blobs = database.createObjectStore(STORE_BLOBS, { keyPath: "hash" });
    blobs.createIndex(INDEX_BY_KIND, "kind", { unique: false });
    blobs.createIndex(INDEX_LRU, ["pinned", "mtime"], { unique: false });
  }
  if (!database.objectStoreNames.contains(STORE_PATHS)) {
    database.createObjectStore(STORE_PATHS, { keyPath: "path" });
  }
  if (!database.objectStoreNames.contains(STORE_META)) {
    database.createObjectStore(STORE_META, { keyPath: "key" });
  }
  if (!database.objectStoreNames.contains(STORE_AGG)) {
    database.createObjectStore(STORE_AGG, { keyPath: "kind" });
  }
  if (!database.objectStoreNames.contains(STORE_APM)) {
    const apm = database.createObjectStore(STORE_APM, { keyPath: "event_id" });
    // Oldest-first prune of the 5000-row cap; not a Downloads/UI path.
    apm.createIndex(INDEX_APM_TS, "ts", { unique: false });
  }
}

export function openReplicaDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory().open(REPLICA_DB, REPLICA_VERSION);
    req.addEventListener("upgradeneeded", () => {
      upgrade(req.result);
    });
    req.addEventListener("success", () => {
      const database = req.result;
      database.addEventListener("versionchange", () => {
        database.close();
        dbPromise = undefined;
      });
      resolve(database);
    });
    req.addEventListener("error", () => {
      dbPromise = undefined;
      reject(req.error ?? new Error("IndexedDB open failed"));
    });
    req.addEventListener("blocked", () => {
      dbPromise = undefined;
      reject(new Error("IndexedDB open blocked"));
    });
  });
  return dbPromise;
}

export async function closeReplicaDb(): Promise<void> {
  if (!dbPromise) return;
  try {
    const database = await dbPromise;
    database.close();
  } catch {
    // already closed / never opened
  }
  dbPromise = undefined;
}

export async function deleteReplicaDb(): Promise<void> {
  await closeReplicaDb();
  const req = factory().deleteDatabase(REPLICA_DB);
  await new Promise<void>((resolve, reject) => {
    req.addEventListener("success", () => resolve());
    req.addEventListener("error", () =>
      reject(req.error ?? new Error("IndexedDB delete failed"))
    );
    req.addEventListener("blocked", () => resolve());
  });
}

export async function withTxn<T>(
  storeNames: readonly string[],
  mode: IDBTransactionMode,
  fn: (txn: IDBTransaction) => Promise<T>,
): Promise<T> {
  const database = await openReplicaDb();
  return new Promise<T>((resolve, reject) => {
    const txn = database.transaction(storeNames as string[], mode);
    let result: T;
    let fnDone = false;
    let txnDone = false;
    let settled = false;

    const finishOk = (): void => {
      if (settled || !fnDone || !txnDone) return;
      settled = true;
      resolve(result);
    };
    const finishErr = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    txn.addEventListener("complete", () => {
      txnDone = true;
      finishOk();
    });
    txn.addEventListener("error", () => {
      finishErr(txn.error ?? new Error("IndexedDB transaction failed"));
    });
    txn.addEventListener("abort", () => {
      finishErr(txn.error ?? new Error("IndexedDB transaction aborted"));
    });

    void fn(txn).then(
      (value) => {
        result = value;
        fnDone = true;
        try {
          txn.commit();
        } catch {
          // auto-commit already running
        }
        finishOk();
      },
      (error: unknown) => {
        try {
          txn.abort();
        } catch {
          finishErr(error);
          return;
        }
        finishErr(error);
      },
    );
  });
}

export function isQuotaExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "QuotaExceededError";
}

export function forEachCursor<T>(
  source: IDBObjectStore | IDBIndex,
  range: IDBKeyRange | null,
  visit: (value: T, cursor: IDBCursorWithValue) => boolean | void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = range ? source.openCursor(range) : source.openCursor();
    let n = 0;
    req.addEventListener("success", () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(n);
        return;
      }
      n += 1;
      const keepGoing = visit(cursor.value as T, cursor);
      if (keepGoing === false) {
        resolve(n);
        return;
      }
      cursor.continue();
    });
    req.addEventListener("error", () => {
      reject(req.error ?? new Error("IndexedDB cursor failed"));
    });
  });
}
