import assert from "node:assert/strict";
import { test } from "node:test";
import { EPOCH_REFRESH_INTERVAL_MS, rootRefreshDue } from "./rootRefresh.ts";

test("an unchanged root never refreshes", () => {
  assert.equal(rootRefreshDue("abc.3", "abc.3", 0, 1e12), false);
});

test("a new Merkle root or a first observation refreshes immediately", () => {
  assert.equal(rootRefreshDue("def.4", "abc.3", 1e12, 1e12), true);
  assert.equal(rootRefreshDue("def", "abc", 1e12, 1e12), true);
  assert.equal(rootRefreshDue("abc.3", null, 1e12, 1e12), true);
});

test("an epoch-only move is coalesced", () => {
  const t = 1e12;
  assert.equal(rootRefreshDue("abc.4", "abc.3", t, t + 1_000), false);
  assert.equal(rootRefreshDue("abc.4", "abc", t, t + 1_000), false);
  assert.equal(rootRefreshDue("abc.4", "abc.3", t, t + EPOCH_REFRESH_INTERVAL_MS), true);
});
