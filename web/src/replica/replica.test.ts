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
import {
  disableReplica,
  loadPolicy,
  onPersistFullSizeArtworkChange,
  resetReplicaUsable,
  setPersistFullSizeArtwork,
} from "./policy.ts";
import { REPLICA_FLAG_KEY } from "./schema.ts";
import {
  missingTextArt,
  pullMissingTextArt,
  replayWorklist,
} from "./sync.ts";
import { setNativeAudioCacheProbe } from "./media-bridge.ts";
import {
  flushBlobTouches,
  noteBlobAccess,
  TOUCH_MIN_AGE_MS,
} from "./blobs.ts";
import { evictUnpinnedAudioToFit } from "./gc.ts";
import {
  fetchServerRoot,
  replicaAppliedRoot,
} from "./resolve.ts";
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
  resetReplicaUsable();
  setNativeAudioCacheProbe(() => false);
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
  // A native store exists but the cacheDelete post fails, so it stays queued.
  setNativeAudioCacheProbe(() => true);
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

test("replica resolve preserves a real remote 404", async () => {
  await setup();
  const fetchMock = installFetch(() => new Response(null, { status: 404 }));
  try {
    const res = await replicaContentFetch(
      "/api/file?path=book%2Fmissing.md&lang=en&rendition=text",
    );
    assert.equal(res.status, 404);
    assert.equal(fetchMock.calls.length, 1);
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

function installFetchWithInit(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { calls: { url: string; init?: RequestInit }[]; restore: () => void } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    calls.push(init === undefined ? { url } : { url, init });
    return await handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

function textResource(hash: string, path = `book/text/en/${hash}.md`) {
  return { path, hash, kind: "text", bytes: 2, url: `/api/blob/${hash}` };
}

test("replicaAppliedRoot reports the applied root and fetchServerRoot bypasses the cache", async () => {
  await setup();
  assert.equal(await replicaAppliedRoot(), null);
  await applyDag({ protocol_version: 1, root: "r1", resources: [] });
  assert.equal(await replicaAppliedRoot(), "r1");
  const ok = installFetch(() =>
    new Response(JSON.stringify({ protocol_version: 1, root: "r9" }), {
      status: 200,
    })
  );
  try {
    // Populate the url-keyed cache the old poll used to read through.
    await replicaContentFetch("/api/root");
    assert.equal(await fetchServerRoot(), "r9");
  } finally {
    ok.restore();
  }
  const down = installFetch(() => {
    throw new Error("network down");
  });
  try {
    // A cached "r9" must not be reported as the live server root.
    assert.equal(await fetchServerRoot(), null);
  } finally {
    down.restore();
  }
  disableReplica();
  assert.equal(await replicaAppliedRoot(), null);
});

test("refreshReplicaManifest is single-flight and conditional on the applied root", async () => {
  await setup();
  let serverRoot = "r1";
  const fetchMock = installFetchWithInit((url, init) => {
    if (url.endsWith("/api/root")) {
      return new Response(
        JSON.stringify({ protocol_version: 1, root: serverRoot }),
        { status: 200 },
      );
    }
    if (url.endsWith("/api/dag")) {
      const inm = new Headers(init?.headers).get("If-None-Match");
      if (inm === `"r1"`) return new Response(null, { status: 304 });
      return new Response(JSON.stringify({
        protocol_version: 1,
        root: "r1",
        resources: [textResource("h1")],
      }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  try {
    const [a, b] = await Promise.all([
      refreshReplicaManifest(),
      refreshReplicaManifest(),
    ]);
    assert.equal(a, "r1");
    assert.equal(b, "r1");
    const urls = fetchMock.calls.map((c) => c.url);
    assert.equal(urls.filter((u) => u.endsWith("/api/root")).length, 1);
    assert.equal(urls.filter((u) => u.endsWith("/api/dag")).length, 1);

    fetchMock.calls.length = 0;
    serverRoot = "r2";
    // 304 on the conditional DAG keeps the applied root.
    assert.equal(await refreshReplicaManifest(), "r1");
    const dag = fetchMock.calls.find((c) => c.url.endsWith("/api/dag"));
    assert.equal(new Headers(dag?.init?.headers).get("If-None-Match"), `"r1"`);
  } finally {
    fetchMock.restore();
  }
});

test("audio cap eviction skips placeholders, enforces the cap, and keeps the row", async () => {
  await setup();
  const audio = (hash: string, present: 0 | 1, mtime: number) => ({
    hash,
    kind: "audio",
    bytes: 6,
    pinned: 0 as const,
    mtime,
    present,
  });
  await putBlob(audio("a-placeholder", 0, 1));
  await putBlob(audio("a1", 1, 2));
  await putBlob(audio("a2", 1, 3));
  assert.equal((await replicaStats()).audioBytes, 12);
  const evicted = await evictUnpinnedAudioToFit(6);
  assert.equal(evicted, 1);
  assert.equal((await replicaStats()).audioBytes, 6);
  assert.equal((await getBlobRecord("a-placeholder"))?.present, 0);
  assert.equal((await getBlobRecord("a1"))?.present, 0);
  assert.equal((await getBlobRecord("a2"))?.present, 1);
  // A later re-download still finds the row and counts toward the cap.
  await setPresent("a1", 1);
  assert.equal((await getBlobRecord("a1"))?.present, 1);
  assert.equal((await replicaStats()).audioBytes, 12);
});

test("quota LRU eviction skips present=0 placeholder rows", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [textResource("ph"), textResource("real")],
  });
  await putBlob({
    hash: "real",
    kind: "text",
    bytes: 2,
    pinned: 0,
    mtime: Date.now() + 1000,
    present: 1,
    data: buf("ab"),
  });
  const n = await evictUnpinnedLru({ limit: 1 });
  assert.equal(n, 1);
  assert.ok(await getBlobRecord("ph"));
  assert.equal(await getBlobRecord("real"), undefined);
});

test("QuotaExceededError is recognized when WebKit leaves txn.error null", async () => {
  const handle = await setup(30);
  handle.setWebkitErrorQuirk(true);
  try {
    await putBlob({
      hash: "old",
      kind: "text",
      bytes: 20,
      pinned: 0,
      mtime: 1,
      present: 1,
      data: buf("12345678901234567890"),
    });
    await putBlob({
      hash: "new",
      kind: "text",
      bytes: 20,
      pinned: 0,
      mtime: 2,
      present: 1,
      data: buf("12345678901234567890"),
    });
    assert.ok(await getBlob("new"));
    assert.equal(await getBlobRecord("old"), undefined);
  } finally {
    handle.setWebkitErrorQuirk(false);
  }
});

test("putBlob throws when eviction rounds run out before the write fits", async () => {
  await setup(200);
  for (let i = 0; i < 200; i++) {
    await putBlob({
      hash: `small-${String(i).padStart(3, "0")}`,
      kind: "text",
      bytes: 1,
      pinned: 0,
      mtime: i + 1,
      present: 1,
      data: buf("x"),
    });
  }
  await assert.rejects(
    putBlob({
      hash: "big",
      kind: "text",
      bytes: 150,
      pinned: 0,
      mtime: 1000,
      present: 1,
      data: buf("y".repeat(150)),
    }),
    (error: unknown) => (error as { name?: string }).name === "QuotaExceededError",
  );
  assert.equal(await getBlobRecord("big"), undefined);
});

test("applyDag only rewrites blob rows whose metadata changed", async () => {
  const handle = await setup();
  await applyDag({
    protocol_version: 1,
    root: "r1",
    resources: [textResource("t1"), textResource("t2")],
  });
  for (const hash of ["t1", "t2"]) {
    await putBlob({
      hash,
      kind: "text",
      bytes: 2,
      pinned: 0,
      mtime: 1,
      present: 1,
      data: buf("ok"),
    });
  }
  const before = handle.factory.putCounts.get("blobs") ?? 0;
  await applyDag({
    protocol_version: 1,
    root: "r2",
    resources: [textResource("t1"), textResource("t2"), textResource("t3")],
  });
  assert.equal((handle.factory.putCounts.get("blobs") ?? 0) - before, 1);
  assert.ok(await getBlob("t1"));
});

test("DAG totals count each blob once even when several paths share it", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [
      textResource("shared", "a/text/en/01.md"),
      textResource("shared", "b/text/en/01.md"),
      textResource("solo"),
    ],
  });
  for (const hash of ["shared", "solo"]) {
    await putBlob({
      hash,
      kind: "text",
      bytes: 2,
      pinned: 0,
      mtime: 1,
      present: 1,
      data: buf("ok"),
    });
  }
  const stats = await replicaStats();
  assert.equal(stats.total, 2);
  assert.equal(stats.cached, stats.total);
  assert.equal(stats.totalBytes, 4);
});

test("concurrent artwork materialization shares one URL and never revokes it", async () => {
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
  const origRevoke = URL.revokeObjectURL;
  let revoked = 0;
  URL.revokeObjectURL = (url: string): void => {
    revoked += 1;
    origRevoke(url);
  };
  try {
    const urls = await Promise.all([
      materializeArtworkSrc("cover", "book"),
      materializeArtworkSrc("cover", "book"),
      materializeArtworkSrc("cover", "book"),
    ]);
    assert.ok(urls[0]);
    assert.equal(new Set(urls).size, 1);
    // A store-hit read of the same bytes must not replace the live URL.
    const res = await replicaContentFetch("/api/cover?book=book");
    assert.equal(res.status, 200);
    assert.equal(artworkBlobSrc("cover", "book"), urls[0]);
    assert.equal(revoked, 0);
  } finally {
    URL.revokeObjectURL = origRevoke;
    await flushBlobTouches();
  }
});

test("eager text fill is single-flight and backs off failing hashes", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [textResource("bad"), textResource("good")],
  });
  const fetchMock = installFetch((url) => {
    if (url.endsWith("/api/blob/bad")) return new Response(null, { status: 500 });
    return new Response("ok", { status: 200 });
  });
  try {
    await Promise.all([pullMissingTextArt(), pullMissingTextArt()]);
    assert.equal(fetchMock.calls.length, 2);
    assert.ok(await getBlob("good"));
    fetchMock.calls.length = 0;
    // "bad" is in backoff and "good" is known local: nothing to re-post.
    await pullMissingTextArt();
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test("reads degrade to the network when the replica is disabled or IDB breaks", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [textResource("h1")],
  });
  await putBlob({
    hash: "h1",
    kind: "text",
    bytes: 5,
    pinned: 0,
    mtime: Date.now(),
    present: 1,
    data: buf("LOCAL"),
  });
  disableReplica();
  const net = installFetch(() => new Response("NET", { status: 200 }));
  try {
    const res = await replicaContentFetch("/api/blob/h1");
    assert.equal(await res.text(), "NET");
  } finally {
    net.restore();
  }
  resetReplicaUsable();

  // IndexedDB itself unavailable: init rejects (main.tsx catches it) and reads
  // still settle instead of rejecting.
  await closeReplicaDb();
  const g = globalThis as { indexedDB?: unknown };
  const saved = g.indexedDB;
  g.indexedDB = undefined;
  const down = installFetch(() => {
    throw new Error("network down");
  });
  try {
    storage.set(REPLICA_FLAG_KEY, "idb");
    await assert.rejects(initReplica("lazy"));
    const res = await replicaContentFetch("/api/books");
    assert.equal(res.status, 504);
    assert.equal(await materializeArtworkSrc("cover", "none"), undefined);
  } finally {
    down.restore();
    g.indexedDB = saved;
    await closeReplicaDb();
  }
});

test("store hits refresh LRU recency through a debounced touch", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r",
    resources: [textResource("old")],
  });
  await putBlob({
    hash: "old",
    kind: "text",
    bytes: 2,
    pinned: 0,
    mtime: 1,
    present: 1,
    data: buf("ok"),
  });
  const res = await replicaContentFetch("/api/blob/old");
  assert.equal(res.status, 200);
  await flushBlobTouches();
  const touched = await getBlobRecord("old");
  assert.ok((touched?.mtime ?? 0) > 1);
  assert.ok(await getBlob("old"));
  // A recently touched row is not rewritten again.
  noteBlobAccess({ hash: "old", mtime: Date.now() - TOUCH_MIN_AGE_MS / 2 });
  await flushBlobTouches();
  assert.equal((await getBlobRecord("old"))?.mtime, touched?.mtime);
});

test("full-size artwork policy flips notify listeners once per change", async () => {
  await setup();
  const seen: boolean[] = [];
  const off = onPersistFullSizeArtworkChange((on) => seen.push(on));
  try {
    setPersistFullSizeArtwork(false);
    setPersistFullSizeArtwork(false);
    setPersistFullSizeArtwork(true);
    assert.deepEqual(seen, [false, true]);
  } finally {
    off();
  }
});

test("without a native audio store, evictions are never queued (PWA)", async () => {
  await setup();
  await applyDag({
    protocol_version: 1,
    root: "r1",
    resources: [
      { path: "a", hash: "aud", kind: "audio", bytes: 8, url: "/aud" },
    ],
  });
  await applyDag({ protocol_version: 1, root: "r2", resources: [] });
  assert.deepEqual((await getWorklist()).evict, []);
  // Leftovers from an older build are drained rather than kept forever.
  await setWorklist({ fetch: [], evict: ["stale-audio"] });
  await replayWorklist();
  assert.deepEqual((await getWorklist()).evict, []);
});
