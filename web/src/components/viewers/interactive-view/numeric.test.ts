import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellNumber,
  clampBins,
  clampNumber,
  MAX_HISTOGRAM_BINS,
  numericExtent,
  parseNumberDraft,
} from "./numeric.ts";

test("cellNumber never throws and only reads numbers", () => {
  assert.equal(cellNumber(3.5), 3.5);
  assert.equal(cellNumber("42"), 42);
  for (const v of [Symbol("x"), null, undefined, "", "  ", true, {}, []]) {
    assert.ok(Number.isNaN(cellNumber(v)));
  }
});

test("numericExtent handles large columns", () => {
  const values = Array.from({ length: 300_000 }, (_, i) => (i % 1000) - 5);
  assert.deepEqual(numericExtent(values), [-5, 994]);
  assert.equal(numericExtent([]), null);
});

test("histogram bins clamp to the checker's bound", () => {
  assert.equal(MAX_HISTOGRAM_BINS, 100);
  assert.equal(clampBins(undefined), 10);
  assert.equal(clampBins(8), 8);
  assert.equal(clampBins(0), 1);
  assert.equal(clampBins(4_000_000_000), MAX_HISTOGRAM_BINS);
  assert.equal(clampBins(Number.NaN), 10);
});

test("number drafts commit only finite numbers, clamped", () => {
  for (const partial of ["", " ", "-", "1e", "."]) {
    assert.equal(parseNumberDraft(partial), null, partial);
  }
  assert.equal(parseNumberDraft("-3"), -3);
  assert.equal(parseNumberDraft("2.5"), 2.5);
  assert.equal(clampNumber(-3, 0, 10), 0);
  assert.equal(clampNumber(30, 0, 10), 10);
  assert.equal(clampNumber(-3), -3);
});
