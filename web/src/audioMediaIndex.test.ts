import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMediaResource } from "./audioMediaIndex.ts";

test("parseMediaResource maps audio and marks paths", () => {
  assert.deepEqual(
    parseMediaResource({
      hash: "audio-hash",
      kind: "audio",
      path: "book/audio/en/part/01.md#audio",
    }),
    {
      key: "book|en|part/01.md",
      kind: "audio",
      hash: "audio-hash",
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
