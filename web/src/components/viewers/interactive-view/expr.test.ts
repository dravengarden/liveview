import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evalDatasetExpr,
  evalDerived,
  type EvalEnv,
  isoInstant,
  MAX_EXPR_DEPTH,
  parseExpr,
  UNAVAILABLE,
} from "./expr.ts";

function env(rows: Record<string, unknown>[]): EvalEnv {
  return {
    signals: { k: 2 },
    datasets: {
      d: { columns: { x: "number", code: "string", day: "temporal" }, rows },
    },
  };
}

function dataset(src: string, e: EvalEnv) {
  const ast = parseExpr(src);
  assert.notEqual(ast, null, src);
  return evalDatasetExpr(ast!, e);
}

function scalar(src: string, e: EvalEnv) {
  const ast = parseExpr(src);
  assert.notEqual(ast, null, src);
  return evalDerived(ast!, e);
}

test("with stores absent cells as null, never the UNAVAILABLE symbol", () => {
  const out = dataset(
    "with(d, 'inv', 1 / x, 'miss', k / 0, 'twice', x * k)",
    env([{ x: 0 }, { x: 4 }]),
  );
  assert.deepEqual(out.rows, [
    { x: 0, inv: null, miss: null, twice: 0 },
    { x: 4, inv: 0.25, miss: null, twice: 8 },
  ]);
  for (const row of out.rows ?? []) {
    for (const v of Object.values(row)) assert.notEqual(typeof v, "symbol");
  }
  // Reading a null cell back is still absent: aggregates skip it.
  assert.equal(scalar("mean(with(d, 'inv', 1 / x).inv)", env([{ x: 0 }, { x: 4 }])), 0.25);
});

test("with does not mutate the input rows", () => {
  const rows = [{ x: 1 }];
  dataset("with(d, 'y', x + 1)", env(rows));
  assert.deepEqual(rows, [{ x: 1 }]);
});

test("strings order lexicographically, not through Date.parse", () => {
  // Date.parse reads "10" and "2" as dates (October / February 2001), which
  // used to order "10" after "2".
  const out = dataset(
    "filter(d, code < '2')",
    env([{ code: "10" }, { code: "3" }, { code: "apple" }, { code: "1" }]),
  );
  assert.deepEqual(out.rows?.map((r) => r["code"]), ["10", "1"]);
});

test("strict ISO-8601 temporals order chronologically", () => {
  const out = dataset(
    "filter(d, day >= '2024-01-01T02:00+01:00')",
    env([
      { day: "2024-01-01T00:30Z" },
      { day: "2024-01-01T01:00Z" },
      { day: "2023-12-31" },
      { day: "2024-02-01" },
    ]),
  );
  assert.deepEqual(out.rows?.map((r) => r["day"]), [
    "2024-01-01T01:00Z",
    "2024-02-01",
  ]);
});

// Shared with `iso_instant_accepts_only_strict_iso_8601` in expr.rs — keep
// aligned.
test("isoInstant accepts only strict ISO-8601", () => {
  const good: [string, number][] = [
    ["1970-01-01", 0],
    ["2024-03-01", 1_709_251_200_000],
    ["2024-03-01T12:30", 1_709_296_200_000],
    ["2024-03-01 12:30:15", 1_709_296_215_000],
    ["2024-03-01T12:30:15.5Z", 1_709_296_215_500],
    ["2024-03-01T12:30+02:00", 1_709_289_000_000],
    ["2024-03-01T12:30-0130", 1_709_301_600_000],
    ["2024-02-29", 1_709_164_800_000],
    ["0099-01-01", -59_042_995_200_000],
  ];
  for (const [s, ms] of good) assert.equal(isoInstant(s), ms, s);
  for (
    const bad of [
      "",
      "2024",
      "2024-1-01",
      "2024-13-01",
      "2023-02-29",
      "2024-04-31",
      "2024-03-01T",
      "2024-03-01T24:00",
      "2024-03-01T12:60",
      "2024-03-01Z",
      "2024-03-01T12:30:15.",
      "2024-03-01T12:30 ",
      "March 1, 2024",
      "Q1",
      "apple",
    ]
  ) {
    assert.equal(isoInstant(bad), null, bad);
  }
});

test("expression nesting is bounded like the checker", () => {
  assert.equal(MAX_EXPR_DEPTH, 64);
  assert.notEqual(parseExpr(`${"(".repeat(60)}1${")".repeat(60)}`), null);
  assert.equal(parseExpr(`${"(".repeat(70)}1${")".repeat(70)}`), null);
  assert.equal(parseExpr(`${"-".repeat(70)}1`), null);
  assert.notEqual(parseExpr(`1${" + 1".repeat(60)}`), null);
  assert.equal(parseExpr(`1${" + 1".repeat(100_000)}`), null);
});

test("lexer rejects non-finite numbers and non-ASCII whitespace", () => {
  assert.equal(parseExpr("1e999 + 1"), null);
  assert.notEqual(parseExpr("1e308 + 1"), null);
  assert.notEqual(parseExpr("k +\t1\r\n"), null);
  assert.equal(parseExpr("k + 1"), null);
  assert.equal(parseExpr("k　+ 1"), null);
  assert.equal(parseExpr("k\f+ 1"), null);
});

test("min/max aggregate large columns without spreading", () => {
  const rows = Array.from({ length: 200_000 }, (_, i) => ({ x: i - 7 }));
  assert.equal(scalar("min(d.x)", env(rows)), -7);
  assert.equal(scalar("max(d.x)", env(rows)), 199_992);
  assert.equal(scalar("min(d.x)", env([])), UNAVAILABLE);
});
