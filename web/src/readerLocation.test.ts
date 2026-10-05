import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHash } from "./readerLocation.ts";

test("reader hash encodes the path so separators never collide", () => {
  assert.equal(buildHash(null, "zh", "audio"), "");
  assert.equal(buildHash("book/01.md", null, null), "#book%2F01.md");
  assert.equal(
    buildHash("book/Q&A lang=x.md", "zh-Hans", "audio"),
    "#book%2FQ%26A%20lang%3Dx.md&lang=zh-Hans&rendition=audio",
  );
});
