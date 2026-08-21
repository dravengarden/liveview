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
import { contentFetch } from "../native-sync.ts";
import {
  artworkBlobSrc,
  enqueueMissingAudio,
  initReplica,
  materializeArtworkSrc,
  persistPolicy,
  pinAudio,
  replicaContentFetch,
  replicaFetchBudgetMs,
  replicaFlag,
  refreshReplicaManifest,
  resetReplica,
  setReplicaOfflineProbe,
  setReplicaRemote,
} from "./mod.ts";
import { loadPolicy, setPersistFullSizeArtwork } from "./policy.ts";
import { REPLICA_FLAG_KEY } from "./schema.ts";
import { missingTextArt } from "./sync.ts";
import { enqueueFetch, getWorklist, setWorklist } from "./worklist.ts";

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
  setPersistFullSizeArtwork(true);
  setReplicaOfflineProbe(() => false);
  setReplicaRemote("https://example.test");
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

test("worklist mutations serialize overlapping enqueueFetch", async () => {
  await setup();
  await Promise.all([
    enqueueFetch("a", "/a"),
    enqueueFetch("b", "/b"),
    enqueueFetch("c", "/c"),
  ]);
  const wl = await getWorklist();
  assert.equal(wl.fetch.length, 3);
  assert.deepEqual(
    new Set(wl.fetch.map((item) => item.hash)),
    new Set(["a", "b", "c"]),
  );
});

test("applyDag records dropped audio on worklist.evict in the same apply", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r1",
    resources: [
      { path: "a", hash: "aud", kind: "audio", bytes: 8, url: "/aud" },
      { path: "t", hash: "txt", kind: "text", bytes: 1, url: "/txt" },
    ],
  });
  await applyDag({
    protocol_version: 1,
    root: "r2",
    resources: [
      { path: "t", hash: "txt", kind: "text", bytes: 1, url: "/txt" },
    ],
  });
  assert.equal(await getBlobRecord("aud"), undefined);
  const wl = await getWorklist();
  assert.deepEqual(wl.evict, ["aud"]);
});

test("missingTextArt omits kinds that must not persist bodies", async () => {
  await setup();
  setPersistFullSizeArtwork(false);
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [
      { path: "c", hash: "cover", kind: "cover", bytes: 40, url: "/cover" },
      { path: "b", hash: "card", kind: "card-backdrop", bytes: 8, url: "/card" },
      { path: "t", hash: "txt", kind: "text", bytes: 4, url: "/txt" },
    ],
  });
  const missing = await missingTextArt();
  const kinds = new Set(missing.map((item) => item.kind));
  assert.equal(kinds.has("cover"), false);
  assert.equal(kinds.has("card-backdrop"), true);
  assert.equal(kinds.has("text"), true);
});

test("pinAudio skips non-audio hashes", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [
      { path: "a", hash: "aud", kind: "audio", bytes: 8, url: "/api/blob/aud" },
      { path: "c", hash: "cov", kind: "cover", bytes: 4, url: "/api/blob/cov" },
    ],
  });
  await pinAudio(["aud", "cov"], "https://example.test");
  assert.equal((await getBlobRecord("aud"))?.pinned, 1);
  assert.equal((await getBlobRecord("cov"))?.pinned, 0);
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

test("leftover lv.replica=native maps to idb so it cannot strand a device", async () => {
  await setup();
  storage.set(REPLICA_FLAG_KEY, "native");
  assert.equal(replicaFlag(), "idb");
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
    "resolve.ts",
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

function installFetch(
  handler: (url: string) => Promise<Response> | Response,
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    calls.push(url);
    return await handler(url);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

test("replica resolve serves a cache hit without network", async () => {
  await setup();
  const data = buf("chapter");
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [{
      path: "book/text/en/01.md",
      hash: "h1",
      kind: "text",
      bytes: data.byteLength,
      url: "/api/file?path=book/01.md&lang=en&rendition=text",
    }],
  });
  await putBlob({
    hash: "h1",
    kind: "text",
    bytes: data.byteLength,
    pinned: 0,
    mtime: 1,
    present: 1,
    data,
  });
  const fetchMock = installFetch(() => {
    throw new Error("network should not run on cache hit");
  });
  try {
    const res = await replicaContentFetch(
      "/api/file?path=book%2F01.md&lang=en&rendition=text",
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "chapter");
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test("replica resolve miss fetches the absolute URL and puts", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [{
      path: "book/text/en/01.md",
      hash: "h2",
      kind: "text",
      bytes: 4,
      url: "/api/blob/h2",
    }],
  });
  const fetchMock = installFetch((url) => {
    assert.equal(url, "https://example.test/api/blob/h2");
    return new Response("body", { status: 200 });
  });
  try {
    const res = await replicaContentFetch("/api/blob/h2");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "body");
    const stored = await getBlob("h2");
    assert.ok(stored);
    assert.equal(new TextDecoder().decode(stored), "body");
    assert.deepEqual(fetchMock.calls, ["https://example.test/api/blob/h2"]);
  } finally {
    fetchMock.restore();
  }
});

test("url-keyed cacheFirst serves the stored copy without a second fetch", async () => {
  await setup();
  let fetches = 0;
  const fetchMock = installFetch((url) => {
    fetches += 1;
    assert.equal(url, "https://example.test/api/manifest/book");
    return new Response(JSON.stringify({ chapters: [] }), { status: 200 });
  });
  try {
    const first = await replicaContentFetch("/api/manifest/book", {
      cacheFirst: true,
    });
    assert.equal(first.status, 200);
    const second = await replicaContentFetch("/api/manifest/book", {
      cacheFirst: true,
    });
    assert.equal(second.status, 200);
    assert.equal(fetches, 1);
  } finally {
    fetchMock.restore();
  }
});

test("refreshReplicaManifest fetches /api/dag only when /api/root changes", async () => {
  await setup();
  const calls: string[] = [];
  const fetchMock = installFetch((url) => {
    calls.push(url);
    if (url.endsWith("/api/root")) {
      return new Response(JSON.stringify({ protocol_version: 1, root: "r1" }), {
        status: 200,
      });
    }
    if (url.endsWith("/api/dag")) {
      return new Response(JSON.stringify({
        protocol_version: 1,
        root: "r1",
        resources: [{
          path: "book/text/en/01.md",
          hash: "h1",
          kind: "text",
          bytes: 1,
          url: "/api/blob/h1",
        }],
      }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  try {
    const first = await refreshReplicaManifest();
    assert.equal(first, "r1");
    assert.equal(calls.filter((u) => u.endsWith("/api/dag")).length, 1);
    calls.length = 0;
    const second = await refreshReplicaManifest();
    assert.equal(second, "r1");
    assert.equal(calls.some((u) => u.endsWith("/api/dag")), false);
    assert.equal(calls.some((u) => u.endsWith("/api/root")), true);
  } finally {
    fetchMock.restore();
  }
});

test("replica resolve returns 504 offline and does not hang", async () => {
  await setup();
  setReplicaOfflineProbe(() => true);
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [{
      path: "book/text/en/01.md",
      hash: "h3",
      kind: "text",
      bytes: 1,
      url: "/api/blob/h3",
    }],
  });
  const fetchMock = installFetch(() => {
    throw new Error("must not fetch when offline");
  });
  try {
    const res = await replicaContentFetch("/api/blob/h3", { offline: true });
    assert.equal(res.status, 504);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test("cover blob URL helper materializes from a local IDB body", async () => {
  await setup();
  const png = buf("PNG");
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [{
      path: "book/@cover",
      hash: "cov",
      kind: "cover",
      bytes: png.byteLength,
      url: "/api/cover?book=book",
    }],
  });
  await putBlob({
    hash: "cov",
    kind: "cover",
    bytes: png.byteLength,
    pinned: 0,
    mtime: 1,
    present: 1,
    data: png,
  });
  const url = await materializeArtworkSrc("cover", "book");
  assert.ok(url);
  assert.equal(url.startsWith("blob:"), true);
  assert.equal(artworkBlobSrc("cover", "book"), url);
});

test("artwork blob URL is dropped when applyDag changes the hash", async () => {
  await setup();
  const png = buf("PNG1");
  await applyDag({
    protocol_version: 1,
    root: "r1",
    resources: [{
      path: "book/@cover",
      hash: "cov-old",
      kind: "cover",
      bytes: png.byteLength,
      url: "/api/cover?book=book",
    }],
  });
  await putBlob({
    hash: "cov-old",
    kind: "cover",
    bytes: png.byteLength,
    pinned: 0,
    mtime: 1,
    present: 1,
    data: png,
  });
  const url = await materializeArtworkSrc("cover", "book");
  assert.ok(url);
  await applyDag({
    protocol_version: 1,
    root: "r2",
    resources: [{
      path: "book/@cover",
      hash: "cov-new",
      kind: "cover",
      bytes: 4,
      url: "/api/cover?book=book",
    }],
  });
  assert.equal(artworkBlobSrc("cover", "book"), undefined);
});

test("persist failure after a 200 still returns the body", async () => {
  await setup(1);
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [{
      path: "book/text/en/01.md",
      hash: "big",
      kind: "text",
      bytes: 64,
      url: "/api/blob/big",
    }],
  });
  const body = "x".repeat(64);
  const fetchMock = installFetch(() => new Response(body, { status: 200 }));
  try {
    const res = await replicaContentFetch("/api/blob/big");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), body);
  } finally {
    fetchMock.restore();
  }
});

test("replica fetch budget is 0 offline and longer than 1.5s online", async () => {
  await setup();
  assert.equal(replicaFetchBudgetMs({ offline: true }), 0);
  setReplicaOfflineProbe(() => true);
  assert.equal(replicaFetchBudgetMs(), 0);
  setReplicaOfflineProbe(() => false);
  assert.ok(replicaFetchBudgetMs() > 1500);
});

test("contentFetch with TAURI + lv.replica=idb never hits lvsync://resolve", async () => {
  await setup();
  storage.set(REPLICA_FLAG_KEY, "idb");
  Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: () => Promise.resolve() },
  });
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [{
      path: "book/text/en/01.md",
      hash: "h4",
      kind: "text",
      bytes: 3,
      url: "/api/blob/h4",
    }],
  });
  const fetchMock = installFetch((url) => {
    assert.equal(url.includes("lvsync://localhost/resolve"), false);
    assert.equal(url.startsWith("https://example.test/"), true);
    return new Response("ok", { status: 200 });
  });
  try {
    const res = await contentFetch("/api/blob/h4");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(
      fetchMock.calls.some((u) => u.includes("lvsync://localhost/resolve")),
      false,
    );
    assert.deepEqual(fetchMock.calls, ["https://example.test/api/blob/h4"]);
  } finally {
    fetchMock.restore();
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
  }
});

test("native-sync facade never uses deleted scheme content routes", async () => {
  const src = await readFile(new URL("../native-sync.ts", import.meta.url), "utf8");
  assert.equal(src.includes("/resolve?u="), false);
  assert.equal(src.includes("/sync_all"), false);
  assert.equal(src.includes("/audio-index"), false);
  assert.equal(src.includes("lvsync://localhost/stats"), false);
  assert.equal(src.includes("replicaContentFetch"), true);
  assert.equal(src.includes("cacheCount"), false);
});

test("enqueueMissingAudio bounds the worklist to remaining cap in one mutation", async () => {
  await setup();
  await persistPolicy({ ...loadPolicy("eager"), capBytes: 10 });
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [
      { path: "a/1", hash: "a1", kind: "audio", bytes: 6, url: "/api/blob/a1" },
      { path: "a/2", hash: "a2", kind: "audio", bytes: 6, url: "/api/blob/a2" },
      { path: "a/3", hash: "a3", kind: "audio", bytes: 6, url: "/api/blob/a3" },
    ],
  });
  await enqueueMissingAudio();
  const wl = await getWorklist();
  assert.equal(wl.fetch.length, 1);
  assert.equal(wl.fetch[0]?.hash, "a1");
  await enqueueMissingAudio();
  assert.equal((await getWorklist()).fetch.length, 1);
});
