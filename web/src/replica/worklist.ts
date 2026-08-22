import { idbRequest, withTxn } from "./idb.ts";
import {
  emptyWorklist,
  META_WORKLIST,
  STORE_META,
  type MetaRecord,
  type Worklist,
} from "./schema.ts";

let chain: Promise<unknown> = Promise.resolve();

/** One writer at a time so overlapping get-then-put cannot drop hashes. */
export function withWorklistLock<T>(op: () => Promise<T>): Promise<T> {
  const run = chain.then(op, op);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function normalize(value: unknown): Worklist {
  if (!value || typeof value !== "object") return emptyWorklist();
  const rec = value as { fetch?: unknown; evict?: unknown };
  const fetch = Array.isArray(rec.fetch)
    ? rec.fetch.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as { hash?: unknown; url?: unknown };
      if (typeof row.hash !== "string" || typeof row.url !== "string") {
        return [];
      }
      return [{ hash: row.hash, url: row.url }];
    })
    : [];
  const evict = Array.isArray(rec.evict)
    ? rec.evict.filter((h): h is string => typeof h === "string")
    : [];
  return { fetch, evict };
}

export async function mutateWorklistInTxn(
  txn: IDBTransaction,
  fn: (wl: Worklist) => void,
): Promise<Worklist> {
  const store = txn.objectStore(STORE_META);
  const rec = await idbRequest(
    store.get(META_WORKLIST) as IDBRequest<MetaRecord | undefined>,
  );
  const wl = normalize(rec?.value);
  fn(wl);
  await idbRequest(
    store.put({ key: META_WORKLIST, value: wl } satisfies MetaRecord),
  );
  return wl;
}

export async function mutateWorklistUnlocked(
  fn: (wl: Worklist) => void,
): Promise<Worklist> {
  return withTxn([STORE_META], "readwrite", (txn) => mutateWorklistInTxn(txn, fn));
}

export async function getWorklist(): Promise<Worklist> {
  return withTxn([STORE_META], "readonly", async (txn) => {
    const rec = await idbRequest(
      txn.objectStore(STORE_META).get(META_WORKLIST) as IDBRequest<
        MetaRecord | undefined
      >,
    );
    return normalize(rec?.value);
  });
}

export async function setWorklist(worklist: Worklist): Promise<void> {
  await withWorklistLock(async () => {
    await withTxn([STORE_META], "readwrite", async (txn) => {
      await idbRequest(
        txn.objectStore(STORE_META).put({
          key: META_WORKLIST,
          value: worklist,
        } satisfies MetaRecord),
      );
    });
  });
}

export async function enqueueFetch(hash: string, url: string): Promise<void> {
  await withWorklistLock(async () => {
    await mutateWorklistUnlocked((wl) => {
      if (!wl.fetch.some((item) => item.hash === hash)) {
        wl.fetch.push({ hash, url });
      }
    });
  });
}

export async function enqueueEvict(hash: string): Promise<void> {
  await withWorklistLock(async () => {
    await mutateWorklistUnlocked((wl) => {
      if (!wl.evict.includes(hash)) wl.evict.push(hash);
      wl.fetch = wl.fetch.filter((item) => item.hash !== hash);
    });
  });
}

export async function removeFetch(hash: string): Promise<void> {
  await removeFetches([hash]);
}

export async function removeFetches(hashes: readonly string[]): Promise<void> {
  if (hashes.length === 0) return;
  const drop = new Set(hashes);
  await withWorklistLock(async () => {
    await mutateWorklistUnlocked((wl) => {
      wl.fetch = wl.fetch.filter((item) => !drop.has(item.hash));
    });
  });
}

export async function removeEvict(hash: string): Promise<void> {
  await withWorklistLock(async () => {
    await mutateWorklistUnlocked((wl) => {
      wl.evict = wl.evict.filter((item) => item !== hash);
    });
  });
}
