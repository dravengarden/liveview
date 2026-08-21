import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { replicaStats } from "./agg.ts";
import {
  deleteBlob,
  getBlob,
  getBlobRecord,
  hasBlob,
  putBlob,
  setPresent,
} from "./blobs.ts";
import { evictUnpinnedLru } from "./gc.ts";
import { closeReplicaDb, openReplicaDb } from "./idb.ts";
import { applyDag, parseManifest, parseRoot } from "./manifest.ts";
import { installMemoryIndexedDB, type MemoryIdbHandle } from "./memory-idb.ts";
import { initReplica, replicaFlag, resetReplica } from "./mod.ts";
import { REPLICA_FLAG_KEY } from "./schema.ts";
import { getWorklist, setWorklist } from "./worklist.ts";

function buf(text: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(text);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

const storage = new Map<string, string>();

function installLocalStorage(): void {
  const localStorage = {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
    removeItem: (key: string): void => {
      storage.delete(key);
    },
    clear: (): void => {
      storage.clear();
    },
    key: (_index: number): string | null => null,
    get length(): number {
      return storage.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
}

async function setup(quotaBytes?: number): Promise<MemoryIdbHandle> {
  installLocalStorage();
  storage.clear();
  const handle = installMemoryIndexedDB();
  if (quotaBytes !== undefined) handle.setQuotaBytes(quotaBytes);
  await resetReplica();
  await openReplicaDb();
  return handle;
}

test("put/get/has/delete round-trip text bodies", async () => {
  await setup();
  const data = buf("hello");
  await putBlob({
    hash: "t1",
    kind: "text",
    bytes: data.byteLength,
    pinned: 0,
    mtime: 1,
    present: 0,
    data,
  });
  assert.equal(await hasBlob("t1"), true);
  const got = await getBlob("t1");
  assert.ok(got);
  assert.equal(new TextDecoder().decode(got), "hello");
  assert.equal(await deleteBlob("t1"), true);
  assert.equal(await hasBlob("t1"), false);
  assert.equal(await getBlob("t1"), undefined);
});

test("applyDag present is max(old, incoming) and never clobbers 1", async () => {
  await setup();
  const data = buf("kept");
  await putBlob({
    hash: "h1",
    kind: "text",
    bytes: data.byteLength,
    pinned: 0,
    mtime: 10,
    present: 1,
    data,
  });
  await applyDag({
    protocol_version: 1,
    root: "root-a",
    resources: [{
      path: "book/text/en/01.md",
      hash: "h1",
      kind: "text",
      bytes: data.byteLength,
      url: "/api/blob/h1",
    }, {
      path: "book/text/en/02.md",
      hash: "h2",
      kind: "text",
      bytes: 4,
      url: "/api/blob/h2",
    }],
  });
  const kept = await getBlobRecord("h1");
  assert.equal(kept?.present, 1);
  assert.ok(kept?.data);
  const fresh = await getBlobRecord("h2");
  assert.equal(fresh?.present, 0);
  assert.equal(fresh?.data, undefined);

  await putBlob({
    hash: "gone",
    kind: "text",
    bytes: 1,
    pinned: 0,
    mtime: 1,
    present: 1,
    data: buf("x"),
  });
  await applyDag({
    protocol_version: 1,
    root: "root-b",
    resources: [{
      path: "book/text/en/01.md",
      hash: "h1",
      kind: "text",
      bytes: data.byteLength,
      url: "/api/blob/h1",
    }],
  });
  assert.equal(await getBlobRecord("gone"), undefined);
});

test("agg cached* counts only present=1; totals come from the DAG", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [
      { path: "a", hash: "ta", kind: "text", bytes: 10, url: "/ta" },
      { path: "b", hash: "aa", kind: "audio", bytes: 100, url: "/aa" },
      { path: "c", hash: "ca", kind: "card-backdrop", bytes: 20, url: "/ca" },
    ],
  });
  let stats = await replicaStats();
  assert.equal(stats.total, 3);
  assert.equal(stats.totalBytes, 130);
  assert.equal(stats.cached, 0);
  assert.equal(stats.cachedBytes, 0);

  await putBlob({
    hash: "ta",
    kind: "text",
    bytes: 10,
    pinned: 0,
    mtime: 1,
    present: 1,
    data: buf("abcdefghij"),
  });
  stats = await replicaStats();
  assert.equal(stats.cached, 1);
  assert.equal(stats.cachedBytes, 10);
  assert.equal(stats.total, 3);
});

test("audio metadata put does not increment cachedCount until present flips", async () => {
  await setup();
  await putBlob({
    hash: "aud",
    kind: "audio",
    bytes: 4096,
    pinned: 0,
    mtime: 1,
    present: 0,
    data: buf("should-not-store"),
  });
  const row = await getBlobRecord("aud");
  assert.equal(row?.data, undefined);
  assert.equal(row?.present, 0);
  let stats = await replicaStats();
  assert.equal(stats.audioCached, 0);
  assert.equal(stats.cached, 0);

  await setPresent("aud", 1);
  stats = await replicaStats();
  assert.equal(stats.audioCached, 1);
  assert.equal(stats.audioBytes, 4096);
  assert.equal(stats.cached, 1);
});

test("LRU eviction uses openCursor, batch cap, and skips pins", async () => {
  await setup();
  await putBlob({
    hash: "old",
    kind: "text",
    bytes: 2,
    pinned: 0,
    mtime: 1,
    present: 1,
    data: buf("ab"),
  });
  await putBlob({
    hash: "mid",
    kind: "text",
    bytes: 2,
    pinned: 0,
    mtime: 2,
    present: 1,
    data: buf("cd"),
  });
  await putBlob({
    hash: "new",
    kind: "text",
    bytes: 2,
    pinned: 0,
    mtime: 3,
    present: 1,
    data: buf("ef"),
  });
  await putBlob({
    hash: "pin",
    kind: "text",
    bytes: 2,
    pinned: 1,
    mtime: 0,
    present: 1,
    data: buf("zz"),
  });
  const n = await evictUnpinnedLru({ limit: 2 });
  assert.equal(n, 2);
  assert.equal(await getBlobRecord("old"), undefined);
  assert.equal(await getBlobRecord("mid"), undefined);
  assert.ok(await getBlobRecord("new"));
  assert.ok(await getBlobRecord("pin"));
  const stats = await replicaStats();
  assert.equal(stats.cached, 2);
});

test("protocol_version newer than 1 is rejected", async () => {
  await setup();
  await assert.rejects(
    () =>
      applyDag({
        protocol_version: 2,
        root: "x",
        resources: [],
      }),
    /newer than supported 1/,
  );
  assert.throws(
    () => parseRoot(`{"protocol_version":2,"root":"r"}`),
    /newer than supported 1/,
  );
  assert.throws(
    () => parseManifest(`{"protocol_version":2,"root":"r","resources":[]}`),
    /newer than supported 1/,
  );
  const legacy = parseRoot(`{"root":"r"}`);
  assert.equal(legacy.protocol_version, 1);
  const m = parseManifest(`{"root":"r","resources":[]}`);
  assert.equal(m.protocol_version, 1);
});

test("worklist persists and replay evicts queued hashes", async () => {
  await setup();
  await putBlob({
    hash: "evict-me",
    kind: "text",
    bytes: 1,
    pinned: 0,
    mtime: 1,
    present: 1,
    data: buf("x"),
  });
  await setWorklist({
    fetch: [{ hash: "need", url: "/api/blob/need" }],
    evict: ["evict-me"],
  });
  await closeReplicaDb();
  await openReplicaDb();
  const stored = await getWorklist();
  assert.equal(stored.fetch.length, 1);
  assert.deepEqual(stored.evict, ["evict-me"]);

  storage.set(REPLICA_FLAG_KEY, "idb");
  await initReplica("lazy");
  assert.equal(await getBlobRecord("evict-me"), undefined);
  const after = await getWorklist();
  assert.equal(after.evict.length, 0);
  assert.equal(after.fetch.length, 1);
});

test("QuotaExceededError evicts unpinned image/text LRU in bounded batches", async () => {
  await setup(30);
  await putBlob({
    hash: "img-old",
    kind: "cover",
    bytes: 20,
    pinned: 0,
    mtime: 1,
    present: 1,
    data: buf("12345678901234567890"),
  });
  await putBlob({
    hash: "txt-old",
    kind: "text",
    bytes: 8,
    pinned: 0,
    mtime: 2,
    present: 1,
    data: buf("abcdefgh"),
  });
  await putBlob({
    hash: "pin-keep",
    kind: "text",
    bytes: 4,
    pinned: 1,
    mtime: 0,
    present: 1,
    data: buf("KEEP"),
  });
  await putBlob({
    hash: "img-new",
    kind: "card-backdrop",
    bytes: 20,
    pinned: 0,
    mtime: 9,
    present: 1,
    data: buf("12345678901234567890"),
  });
  assert.equal(await getBlobRecord("pin-keep") !== undefined, true);
  assert.ok(await getBlobRecord("img-new"));
  const oldImg = await getBlobRecord("img-old");
  const oldTxt = await getBlobRecord("txt-old");
  assert.equal(oldImg === undefined || oldTxt === undefined, true);
});

test("initReplica no-ops unless lv.replica is idb", async () => {
  await setup();
  storage.delete(REPLICA_FLAG_KEY);
  assert.equal(replicaFlag(), "native");
  await initReplica("eager");
  await putBlob({
    hash: "stay",
    kind: "text",
    bytes: 1,
    pinned: 0,
    mtime: 1,
    present: 1,
    data: buf("s"),
  });
  await setWorklist({ fetch: [], evict: ["stay"] });
  await initReplica("eager");
  assert.ok(await getBlobRecord("stay"));
});

test("replica modules never getAll() blobs", async () => {
  const files = [
    "blobs.ts",
    "manifest.ts",
    "agg.ts",
    "gc.ts",
    "worklist.ts",
    "sync.ts",
    "idb.ts",
    "mod.ts",
  ];
  for (const file of files) {
    const src = await readFile(new URL(file, import.meta.url), "utf8");
    assert.equal(
      /\.getAll\s*\(/.test(src),
      false,
      `${file} must not call getAll on the blob store`,
    );
  }
});
