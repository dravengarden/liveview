import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mark } from "@/types";
import { activeMarkIndex, resolveReadAlongIndex } from "./mark-index.ts";

const marks: Mark[] = [
  { idx: 0, start_ms: 1_000, end_ms: 2_000 },
  { idx: 1, start_ms: 2_250, end_ms: 3_000 },
];

test("active mark holds through generated silence", () => {
  assert.equal(activeMarkIndex(marks, 1_500), 0);
  assert.equal(activeMarkIndex(marks, 2_100), 0);
  assert.equal(activeMarkIndex(marks, 2_500), 1);
});

test("reader marks recover a missing engine index", () => {
  assert.equal(resolveReadAlongIndex(marks, 2_500, -1), 1);
});

test("engine index remains the fallback until reader marks arrive", () => {
  assert.equal(resolveReadAlongIndex([], 2_500, 4), 4);
  assert.equal(resolveReadAlongIndex(marks, 500, 4), 4);
});
