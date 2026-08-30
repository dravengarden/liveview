import assert from "node:assert/strict";
import { test } from "node:test";
import { getMedia, ingestDag, parseMediaResource } from "./audioMediaIndex.ts";

test("parseMediaResource maps audio and marks paths", () => {
  assert.deepEqual(
    parseMediaResource({
      hash: "audio-hash",
      kind: "audio",
      path: "book/audio/en/part/01.md#audio",
      bytes: 123456,
    }),
    {
      key: "book|en|part/01.md",
      kind: "audio",
      hash: "audio-hash",
      bytes: 123456,
    },
  );
  assert.deepEqual(
    parseMediaResource({
      hash: "marks-hash",
      kind: "marks",
      path: "book/audio/zh/01.md#marks",
    }),
    { key: "book|zh|01.md", kind: "marks", hash: "marks-hash" },
  );
});

test("parseMediaResource rejects unrelated or malformed entries", () => {
  assert.equal(
    parseMediaResource({ hash: "x", kind: "text", path: "book/text/en/01.md" }),
    undefined,
  );
  assert.equal(
    parseMediaResource({ hash: "x", kind: "audio", path: "too/short" }),
    undefined,
  );
});

test("parseMediaResource ignores invalid byte lengths", () => {
  assert.deepEqual(
    parseMediaResource({
      hash: "audio-hash",
      kind: "audio",
      path: "book/audio/en/01.md#audio",
      bytes: 0,
    }),
    { key: "book|en|01.md", kind: "audio", hash: "audio-hash" },
  );
});

test("a new audio hash never inherits the previous body's byte length", () => {
  const path = "hash-change/audio/en/01.md#audio";
  ingestDag([{ hash: "first", kind: "audio", path, bytes: 100 }]);
  assert.deepEqual(getMedia("hash-change", "en", "01.md"), {
    audioHash: "first",
    audioBytes: 100,
  });

  ingestDag([{ hash: "second", kind: "audio", path }]);
  assert.deepEqual(getMedia("hash-change", "en", "01.md"), {
    audioHash: "second",
  });
});
