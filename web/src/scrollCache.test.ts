import { test } from "node:test";
import assert from "node:assert/strict";
import { seedScrollCache } from "./scrollCache.ts";

test("server rows never regress a newer local scroll position", () => {
  const ratios = new Map([["b/01", 0.6]]);
  const writtenAt = new Map([["b/01", 2_000]]);
  seedScrollCache(ratios, writtenAt, [
    { path: "b/01", scroll: 0.1, updated_at: 1_000 },
    { path: "b/02", scroll: 0.3, updated_at: 500 },
  ]);
  assert.equal(ratios.get("b/01"), 0.6);
  assert.equal(ratios.get("b/02"), 0.3);
  // Another device's later write still wins.
  seedScrollCache(ratios, writtenAt, [
    { path: "b/01", scroll: 0.9, updated_at: 3_000 },
  ]);
  assert.equal(ratios.get("b/01"), 0.9);
});
