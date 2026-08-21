import { idbRequest, withTxn } from "./idb.ts";
import {
  emptyWorklist,
  META_WORKLIST,
  STORE_META,
  type MetaRecord,
  type Worklist,
} from "./schema.ts";

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
  const rec: MetaRecord = { key: META_WORKLIST, value: worklist };
  await withTxn([STORE_META], "readwrite", async (txn) => {
    await idbRequest(txn.objectStore(STORE_META).put(rec));
  });
}

export async function enqueueFetch(hash: string, url: string): Promise<void> {
  const wl = await getWorklist();
  if (wl.fetch.some((item) => item.hash === hash)) return;
  wl.fetch.push({ hash, url });
  await setWorklist(wl);
}

export async function enqueueEvict(hash: string): Promise<void> {
  const wl = await getWorklist();
  if (!wl.evict.includes(hash)) wl.evict.push(hash);
  wl.fetch = wl.fetch.filter((item) => item.hash !== hash);
  await setWorklist(wl);
}

export async function removeFetch(hash: string): Promise<void> {
  const wl = await getWorklist();
  const next = wl.fetch.filter((item) => item.hash !== hash);
  if (next.length === wl.fetch.length) return;
  await setWorklist({ fetch: next, evict: wl.evict });
}

export async function removeEvict(hash: string): Promise<void> {
  const wl = await getWorklist();
  const next = wl.evict.filter((item) => item !== hash);
  if (next.length === wl.evict.length) return;
  await setWorklist({ fetch: wl.fetch, evict: next });
}
