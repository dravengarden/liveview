// The `derived` expression language as a RUNTIME evaluator — a TS re-implementation
// of `src/interactive_view/expr.rs` (parse + evaluate, not type-check; the Rust
// checker already proved the document type-checks, so here we only need a total
// interpretation). Grammar and precedence mirror the Rust parser exactly.
//
// Three-valued totality (§6): every value is a scalar, a column, a dataset, or
// the sentinel UNAVAILABLE (SQL-NULL-like). Any op over UNAVAILABLE, over a
// dataset whose rows never loaded, or over an empty aggregate yields UNAVAILABLE
// — never a throw, never NaN, never Infinity. This is what lets a derived signal
// stay well-defined when its dataset fails to load.

import type { ColumnType } from "./types";

/** The absent value (SQL NULL). Propagates through every operation. */
export const UNAVAILABLE: unique symbol = Symbol("interactive-view/unavailable");
export type Unavailable = typeof UNAVAILABLE;

export function isUnavailable(v: unknown): v is Unavailable {
  return v === UNAVAILABLE;
}

/** A dataset in the evaluator: the declared schema plus rows, where `rows: null`
 *  means the data is not loaded / unavailable (Phase 1: any `source`-backed
 *  dataset is `null`; inline `values` load eagerly). */
export interface EvalDataset {
  columns: Record<string, ColumnType>;
  rows: Record<string, unknown>[] | null;
}

/** What the evaluator reads: current signal values and dataset tables. */
export interface EvalEnv {
  signals: Record<string, unknown>;
  datasets: Record<string, EvalDataset>;
}

// A vectorized column bound to a dataset. `values: null` == unavailable column.
interface ColVal {
  readonly __col: true;
  readonly values: readonly unknown[] | null;
}
// A dataset value flowing through the expression (mirrors EvalDataset).
interface DsVal {
  readonly __ds: true;
  readonly columns: Record<string, ColumnType>;
  readonly rows: readonly Record<string, unknown>[] | null;
}

function isCol(v: unknown): v is ColVal {
  return typeof v === "object" && v !== null && (v as ColVal).__col === true;
}
function isDs(v: unknown): v is DsVal {
  return typeof v === "object" && v !== null && (v as DsVal).__ds === true;
}
function col(values: readonly unknown[] | null): ColVal {
  return { __col: true, values };
}
function ds(columns: Record<string, ColumnType>, rows: readonly Record<string, unknown>[] | null): DsVal {
  return { __ds: true, columns, rows };
}

// ── AST ──────────────────────────────────────────────────────────────────────

type BinOp = "add" | "sub" | "mul" | "div" | "mod" | "and" | "or" | "eq" | "ne" | "lt" | "le" | "gt" | "ge";
type UnOp = "neg" | "not";

export type Ast =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "ident"; name: string }
  | { kind: "unary"; op: UnOp; expr: Ast }
  | { kind: "bin"; op: BinOp; left: Ast; right: Ast }
  | { kind: "field"; base: Ast; name: string }
  | { kind: "index"; base: Ast; index: Ast }
  | { kind: "call"; name: string; args: Ast[] };

// ── lexer ──────────────────────────────────────────────────────────────────

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "true" }
  | { t: "false" }
  | { t: "op"; v: string }
  | { t: "eof" };

class ParseError extends Error {}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";
  const isAlpha = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  while (i < src.length) {
    const c = src[i] ?? "";
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=" || two === ">=" || two === "<=") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%()[],.<>!".includes(c)) {
      // A `.` immediately before a digit is part of a number, not a field dot.
      if (c === "." && isDigit(src[i + 1] ?? "")) {
        // fall through to number scan below
      } else {
        out.push({ t: "op", v: c });
        i += 1;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      const start = i;
      while (i < src.length && src[i] !== quote) i += 1;
      if (i >= src.length) throw new ParseError("unterminated string literal");
      out.push({ t: "str", v: src.slice(start, i) });
      i += 1;
      continue;
    }
    if (isDigit(c) || c === ".") {
      const start = i;
      while (i < src.length) {
        const d = src[i] ?? "";
        if (isDigit(d) || d === "." || d === "e" || d === "E") i += 1;
        else break;
      }
      const n = Number(src.slice(start, i));
      if (!Number.isFinite(n)) throw new ParseError(`bad number \`${src.slice(start, i)}\``);
      out.push({ t: "num", v: n });
      continue;
    }
    if (isAlpha(c)) {
      const start = i;
      while (i < src.length) {
        const d = src[i] ?? "";
        if (isAlpha(d) || isDigit(d)) i += 1;
        else break;
      }
      const id = src.slice(start, i);
      if (id === "true") out.push({ t: "true" });
      else if (id === "false") out.push({ t: "false" });
      else out.push({ t: "ident", v: id });
      continue;
    }
    throw new ParseError(`unexpected character \`${c}\``);
  }
  out.push({ t: "eof" });
  return out;
}

// ── parser (precedence-climbing, mirrors expr.rs) ────────────────────────────

/** The deepest expression nesting (parenthesised groups, unary chains, and
 *  operator chains all count) — `MAX_EXPR_DEPTH` in expr.rs. Bounding the AST
 *  depth keeps the recursive evaluator far from the JS stack limit. */
export const MAX_EXPR_DEPTH = 64;

class Parser {
  private pos = 0;
  // Parser recursion depth (a parenthesised group nests the parser without
  // adding AST depth) and each node's AST depth (a leaf is 1).
  private nesting = 0;
  private readonly depths = new WeakMap<Ast, number>();
  constructor(private readonly toks: Tok[]) {}

  private enter(): void {
    this.nesting += 1;
    if (this.nesting > MAX_EXPR_DEPTH) throw new ParseError("expression nests too deeply");
  }
  private leave(): void {
    this.nesting -= 1;
  }
  /** Record `node`'s depth over `children`, rejecting one past the limit. */
  private node<T extends Ast>(node: T, ...children: Ast[]): T {
    let deepest = 0;
    for (const c of children) deepest = Math.max(deepest, this.depths.get(c) ?? 1);
    if (deepest + 1 > MAX_EXPR_DEPTH) throw new ParseError("expression nests too deeply");
    this.depths.set(node, deepest + 1);
    return node;
  }
  private group(): Ast {
    this.enter();
    const e = this.parseOr();
    this.leave();
    return e;
  }

  private peek(): Tok {
    return this.toks[this.pos] ?? { t: "eof" };
  }
  private next(): Tok {
    const t = this.peek();
    this.pos += 1;
    return t;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.t === "op" && t.v === v;
  }
  private eat(v: string): void {
    if (!this.isOp(v)) throw new ParseError(`expected \`${v}\``);
    this.pos += 1;
  }

  parse(): Ast {
    const e = this.group();
    if (this.peek().t !== "eof") throw new ParseError("unexpected trailing input");
    return e;
  }
  private bin(op: BinOp, left: Ast, right: Ast): Ast {
    return this.node({ kind: "bin", op, left, right }, left, right);
  }
  private parseOr(): Ast {
    let lhs = this.parseAnd();
    while (this.isOp("||")) {
      this.next();
      lhs = this.bin("or", lhs, this.parseAnd());
    }
    return lhs;
  }
  private parseAnd(): Ast {
    let lhs = this.parseCmp();
    while (this.isOp("&&")) {
      this.next();
      lhs = this.bin("and", lhs, this.parseCmp());
    }
    return lhs;
  }
  private parseCmp(): Ast {
    let lhs = this.parseAdd();
    for (;;) {
      const t = this.peek();
      const op = t.t === "op" ? cmpOp(t.v) : null;
      if (!op) break;
      this.next();
      lhs = this.bin(op, lhs, this.parseAdd());
    }
    return lhs;
  }
  private parseAdd(): Ast {
    let lhs = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op" || (t.v !== "+" && t.v !== "-")) break;
      this.next();
      lhs = this.bin(t.v === "+" ? "add" : "sub", lhs, this.parseMul());
    }
    return lhs;
  }
  private parseMul(): Ast {
    let lhs = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op" || (t.v !== "*" && t.v !== "/" && t.v !== "%")) break;
      this.next();
      const op = t.v === "*" ? "mul" : t.v === "/" ? "div" : "mod";
      lhs = this.bin(op, lhs, this.parseUnary());
    }
    return lhs;
  }
  private parseUnary(): Ast {
    const op: UnOp | null = this.isOp("-") ? "neg" : this.isOp("!") ? "not" : null;
    if (op === null) return this.parsePostfix();
    this.next();
    this.enter();
    const expr = this.parseUnary();
    this.leave();
    return this.node({ kind: "unary", op, expr }, expr);
  }
  private parsePostfix(): Ast {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const t = this.next();
        if (t.t !== "ident") throw new ParseError("expected field name after `.`");
        e = this.node({ kind: "field", base: e, name: t.v }, e);
      } else if (this.isOp("[")) {
        this.next();
        const index = this.group();
        this.eat("]");
        e = this.node({ kind: "index", base: e, index }, e, index);
      } else {
        break;
      }
    }
    return e;
  }
  private parsePrimary(): Ast {
    const t = this.next();
    if (t.t === "num") return { kind: "num", value: t.v };
    if (t.t === "str") return { kind: "str", value: t.v };
    if (t.t === "true") return { kind: "bool", value: true };
    if (t.t === "false") return { kind: "bool", value: false };
    if (t.t === "op" && t.v === "(") {
      const e = this.group();
      this.eat(")");
      return e;
    }
    if (t.t === "ident") {
      if (this.isOp("(")) {
        this.next();
        const args: Ast[] = [];
        if (!this.isOp(")")) {
          for (;;) {
            args.push(this.group());
            if (this.isOp(",")) this.next();
            else break;
          }
        }
        this.eat(")");
        return this.node({ kind: "call", name: t.v, args }, ...args);
      }
      return { kind: "ident", name: t.v };
    }
    throw new ParseError("unexpected token");
  }
}

function cmpOp(v: string): BinOp | null {
  switch (v) {
    case "==":
      return "eq";
    case "!=":
      return "ne";
    case "<":
      return "lt";
    case "<=":
      return "le";
    case ">":
      return "gt";
    case ">=":
      return "ge";
    default:
      return null;
  }
}

/** Parse an expression; returns `null` on any lex/parse error (total — a
 *  malformed `derived` never throws into React). */
export function parseExpr(src: string): Ast | null {
  try {
    return new Parser(lex(src)).parse();
  } catch {
    return null;
  }
}

// ── evaluator ────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | Unavailable {
  return typeof v === "number" && Number.isFinite(v) ? v : UNAVAILABLE;
}
function toBool(v: unknown): boolean | Unavailable {
  return typeof v === "boolean" ? v : UNAVAILABLE;
}
function finite(n: number): number | Unavailable {
  return Number.isFinite(n) ? n : UNAVAILABLE;
}

// Element-wise lift over a scalar or a column.
function lift1(x: unknown, f: (e: unknown) => unknown): unknown {
  if (isCol(x)) return x.values === null ? col(null) : col(x.values.map(f));
  return f(x);
}
function lift2(a: unknown, b: unknown, f: (ea: unknown, eb: unknown) => unknown): unknown {
  const ac = isCol(a);
  const bc = isCol(b);
  if (!ac && !bc) return f(a, b);
  const av = ac ? a.values : null;
  const bv = bc ? b.values : null;
  if ((ac && av === null) || (bc && bv === null)) return col(null);
  const len = ac ? (av as readonly unknown[]).length : (bv as readonly unknown[]).length;
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    const ea = ac ? (av as readonly unknown[])[i] : a;
    const eb = bc ? (bv as readonly unknown[])[i] : b;
    out.push(f(ea, eb));
  }
  return col(out);
}

function arith(op: BinOp, ea: unknown, eb: unknown): number | Unavailable {
  const x = toNum(ea);
  const y = toNum(eb);
  if (isUnavailable(x) || isUnavailable(y)) return UNAVAILABLE;
  switch (op) {
    case "add":
      return finite(x + y);
    case "sub":
      return finite(x - y);
    case "mul":
      return finite(x * y);
    case "div":
      return y === 0 ? UNAVAILABLE : finite(x / y);
    case "mod":
      return y === 0 ? UNAVAILABLE : finite(x % y);
    default:
      return UNAVAILABLE;
  }
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?)?$/;

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// Days since 1970-01-01 of a proleptic-Gregorian civil date (Hinnant); avoids
// `Date.UTC`'s two-digit-year remapping.
function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** A strict ISO-8601 temporal value as UTC epoch milliseconds, else `null`:
 *  `YYYY-MM-DD`, optionally `T`/space `HH:MM[:SS[.fff…]]` and a `Z` / `±HH:MM`
 *  / `±HHMM` offset (no offset reads as UTC). Calendar-invalid dates are
 *  rejected. The same grammar as `iso_instant` in expr.rs, independent of the
 *  engine's lenient `Date.parse`. */
export function isoInstant(s: string): number | null {
  const m = ISO_INSTANT.exec(s);
  if (!m) return null;
  const n = (i: number): number => Number(m[i] ?? "0");
  const [y, mo, d, h, mi, sec] = [n(1), n(2), n(3), n(4), n(5), n(6)];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || sec > 59) return null;
  let ms = daysFromCivil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000;
  if (m[7] !== undefined) ms += Number(`0.${m[7]}`) * 1000;
  if (m[9] !== undefined) {
    const oh = n(10);
    const om = n(11);
    if (oh > 23 || om > 59) return null;
    ms -= (m[9] === "+" ? 1 : -1) * (oh * 3_600_000 + om * 60_000);
  }
  return ms;
}

// A total scalar ordering, matching the checker's typing (expr.rs): numbers
// numerically; two strict ISO-8601 temporals chronologically; any other
// strings lexicographically (so arbitrary strings order transitively and never
// through the engine's lenient `Date.parse`). Returns UNAVAILABLE for
// incomparable/absent operands.
function order(ea: unknown, eb: unknown): number | Unavailable {
  if (isUnavailable(ea) || isUnavailable(eb)) return UNAVAILABLE;
  if (typeof ea === "number" && typeof eb === "number") return ea < eb ? -1 : ea > eb ? 1 : 0;
  if (typeof ea !== "string" || typeof eb !== "string") return UNAVAILABLE;
  const ta = isoInstant(ea);
  const tb = isoInstant(eb);
  if (ta !== null && tb !== null) return ta < tb ? -1 : ta > tb ? 1 : 0;
  return ea < eb ? -1 : ea > eb ? 1 : 0;
}

function equal(ea: unknown, eb: unknown): boolean | Unavailable {
  if (isUnavailable(ea) || isUnavailable(eb)) return UNAVAILABLE;
  if (typeof ea === "number" && typeof eb === "number") return ea === eb;
  if (typeof ea === "boolean" && typeof eb === "boolean") return ea === eb;
  return String(ea) === String(eb);
}

function evalNode(ast: Ast, env: EvalEnv, scope: DsVal | null): unknown {
  switch (ast.kind) {
    case "num":
      return ast.value;
    case "str":
      return ast.value;
    case "bool":
      return ast.value;
    case "ident":
      return evalIdent(ast.name, env, scope);
    case "unary": {
      const x = evalNode(ast.expr, env, scope);
      if (ast.op === "neg") {
        return lift1(x, (e) => {
          const n = toNum(e);
          return isUnavailable(n) ? UNAVAILABLE : finite(-n);
        });
      }
      return lift1(x, (e) => {
        const b = toBool(e);
        return isUnavailable(b) ? UNAVAILABLE : !b;
      });
    }
    case "bin":
      return evalBin(ast, env, scope);
    case "field": {
      const base = evalNode(ast.base, env, scope);
      if (isDs(base)) {
        if (base.rows === null) return UNAVAILABLE;
        const name = ast.name;
        return col(base.rows.map((r) => (Object.hasOwn(r, name) ? (r[name] ?? UNAVAILABLE) : UNAVAILABLE)));
      }
      return UNAVAILABLE;
    }
    case "index": {
      const base = evalNode(ast.base, env, scope);
      const idx = evalNode(ast.index, env, scope);
      if (isUnavailable(base) || isUnavailable(idx)) return UNAVAILABLE;
      if (Array.isArray(base) && typeof idx === "number") {
        const el = (base as unknown[])[idx];
        return el === undefined ? UNAVAILABLE : el;
      }
      return UNAVAILABLE;
    }
    case "call":
      return evalCall(ast.name, ast.args, env, scope);
  }
}

function evalIdent(name: string, env: EvalEnv, scope: DsVal | null): unknown {
  // Inside a `filter` predicate, an unqualified name binds to the dataset's
  // column (SQL-WHERE-style). Vectorized over the current row set.
  if (scope && Object.hasOwn(scope.columns, name)) {
    if (scope.rows === null) return col(null);
    return col(scope.rows.map((r) => (Object.hasOwn(r, name) ? (r[name] ?? UNAVAILABLE) : UNAVAILABLE)));
  }
  if (Object.hasOwn(env.signals, name)) {
    return env.signals[name];
  }
  if (Object.hasOwn(env.datasets, name)) {
    const d = env.datasets[name];
    if (d === undefined) return UNAVAILABLE;
    return ds(d.columns, d.rows);
  }
  return UNAVAILABLE;
}

function evalBin(ast: { op: BinOp; left: Ast; right: Ast }, env: EvalEnv, scope: DsVal | null): unknown {
  const a = evalNode(ast.left, env, scope);
  const b = evalNode(ast.right, env, scope);
  switch (ast.op) {
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "mod":
      return lift2(a, b, (ea, eb) => arith(ast.op, ea, eb));
    case "and":
      return lift2(a, b, (ea, eb) => {
        const x = toBool(ea);
        const y = toBool(eb);
        return isUnavailable(x) || isUnavailable(y) ? UNAVAILABLE : x && y;
      });
    case "or":
      return lift2(a, b, (ea, eb) => {
        const x = toBool(ea);
        const y = toBool(eb);
        return isUnavailable(x) || isUnavailable(y) ? UNAVAILABLE : x || y;
      });
    case "eq":
      return lift2(a, b, (ea, eb) => equal(ea, eb));
    case "ne":
      return lift2(a, b, (ea, eb) => {
        const e = equal(ea, eb);
        return isUnavailable(e) ? UNAVAILABLE : !e;
      });
    case "lt":
    case "le":
    case "gt":
    case "ge":
      return lift2(a, b, (ea, eb) => {
        const o = order(ea, eb);
        if (isUnavailable(o)) return UNAVAILABLE;
        switch (ast.op) {
          case "lt":
            return o < 0;
          case "le":
            return o <= 0;
          case "gt":
            return o > 0;
          default:
            return o >= 0;
        }
      });
  }
}

// Extract the finite numbers from a column, dropping UNAVAILABLE/non-numeric
// cells (SQL aggregates ignore NULLs). `null` == the column itself is absent.
function columnNumbers(v: unknown): number[] | null {
  if (!isCol(v) || v.values === null) return null;
  const out: number[] = [];
  for (const e of v.values) {
    if (typeof e === "number" && Number.isFinite(e)) out.push(e);
  }
  return out;
}

// A value as a dataset cell: scalars verbatim; UNAVAILABLE, a non-finite
// number, or any non-scalar (a column/dataset that can't be a cell) → null.
function cell(v: unknown): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  return null;
}

// The `ColumnType` a `with`-computed column reports, inferred from its values —
// used only for the chart's axis-kind hint (the checker already proved the real
// type; this is the total runtime echo). A column of numbers → "number", etc.
function inferColType(v: unknown): ColumnType {
  const sample = isCol(v)
    ? (v.values ?? []).find((e) => !isUnavailable(e) && e != null)
    : v;
  if (typeof sample === "number") return "number";
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "string") return "string";
  return "number";
}

function evalCall(name: string, args: Ast[], env: EvalEnv, scope: DsVal | null): unknown {
  const arg = (i: number): Ast | undefined => args[i];
  switch (name) {
    case "filter": {
      const dsv = evalNode(arg(0) ?? { kind: "num", value: 0 }, env, scope);
      if (!isDs(dsv)) return UNAVAILABLE;
      if (dsv.rows === null) return dsv;
      const predAst = arg(1);
      if (!predAst) return ds(dsv.columns, null);
      const pred = evalNode(predAst, env, dsv);
      if (isCol(pred)) {
        if (pred.values === null) return ds(dsv.columns, null);
        const pv = pred.values;
        return ds(
          dsv.columns,
          dsv.rows.filter((_r, i) => pv[i] === true),
        );
      }
      if (typeof pred === "boolean") return ds(dsv.columns, pred ? dsv.rows : []);
      return ds(dsv.columns, null);
    }
    case "with": {
      // with(ds, 'name', expr, …) — append computed columns. Each expr is
      // evaluated with the (progressively augmented) dataset in scope, so it can
      // combine columns with signals (`upper = mid + k*sigma`) and reference
      // columns added earlier in the same call. A scalar result broadcasts to
      // every row; a column result maps per row.
      //
      // Rows hold plain JSON-like cells: an absent result is stored as `null`
      // (never the UNAVAILABLE symbol, which charts/tables would have to
      // special-case and `Number(symbol)` throws on). Reading the column back
      // maps `null` to UNAVAILABLE again. Each row is copied once up front and
      // the copies (owned by this call) are filled in place per column.
      const dsv = evalNode(arg(0) ?? { kind: "num", value: 0 }, env, scope);
      if (!isDs(dsv)) return UNAVAILABLE;
      if (dsv.rows === null) return dsv;
      const columns: Record<string, ColumnType> = { ...dsv.columns };
      const rows: Record<string, unknown>[] = dsv.rows.map((r) => ({ ...r }));
      for (let i = 1; i + 1 < args.length; i += 2) {
        const nameAst = args[i];
        const exprAst = args[i + 1];
        if (!nameAst || nameAst.kind !== "str" || !exprAst) return UNAVAILABLE;
        const name = nameAst.value;
        const val = evalNode(exprAst, env, ds(columns, rows));
        if (isCol(val)) {
          const vv = val.values;
          for (let idx = 0; idx < rows.length; idx++) {
            (rows[idx] as Record<string, unknown>)[name] = vv === null ? null : cell(vv[idx]);
          }
        } else {
          const c = cell(val);
          for (const r of rows) r[name] = c;
        }
        columns[name] = inferColType(val);
      }
      return ds(columns, rows);
    }
    case "mean":
    case "sum":
    case "std":
    case "min":
    case "max":
    case "median": {
      const nums = columnNumbers(evalNode(arg(0) ?? { kind: "num", value: 0 }, env, scope));
      if (nums === null || nums.length === 0) return UNAVAILABLE;
      return aggregate(name, nums);
    }
    case "count": {
      const v = evalNode(arg(0) ?? { kind: "num", value: 0 }, env, scope);
      if (isCol(v)) return v.values === null ? UNAVAILABLE : v.values.length;
      if (isDs(v)) return v.rows === null ? UNAVAILABLE : v.rows.length;
      return UNAVAILABLE;
    }
    case "sqrt":
    case "abs":
    case "floor":
    case "ceil":
      return lift1(evalNode(arg(0) ?? { kind: "num", value: 0 }, env, scope), (e) => {
        const n = toNum(e);
        if (isUnavailable(n)) return UNAVAILABLE;
        const r = name === "sqrt" ? Math.sqrt(n) : name === "abs" ? Math.abs(n) : name === "floor" ? Math.floor(n) : Math.ceil(n);
        return finite(r);
      });
    case "round": {
      const digitsAst = arg(1);
      let digits = 0;
      if (digitsAst) {
        const d = toNum(evalNode(digitsAst, env, scope));
        if (isUnavailable(d)) return UNAVAILABLE;
        digits = Math.trunc(d);
      }
      const factor = Math.pow(10, digits);
      return lift1(evalNode(arg(0) ?? { kind: "num", value: 0 }, env, scope), (e) => {
        const n = toNum(e);
        return isUnavailable(n) ? UNAVAILABLE : finite(Math.round(n * factor) / factor);
      });
    }
    case "clamp": {
      const x = evalNode(arg(0) ?? { kind: "num", value: 0 }, env, scope);
      const lo = toNum(evalNode(arg(1) ?? { kind: "num", value: 0 }, env, scope));
      const hi = toNum(evalNode(arg(2) ?? { kind: "num", value: 0 }, env, scope));
      if (isUnavailable(lo) || isUnavailable(hi)) return UNAVAILABLE;
      return lift1(x, (e) => {
        const n = toNum(e);
        return isUnavailable(n) ? UNAVAILABLE : finite(Math.min(Math.max(n, lo), hi));
      });
    }
    case "if": {
      const c = evalNode(arg(0) ?? { kind: "bool", value: false }, env, scope);
      const thenAst = arg(1) ?? { kind: "num", value: 0 };
      const elseAst = arg(2) ?? { kind: "num", value: 0 };
      if (isCol(c)) {
        return mergeForIf(c, evalNode(thenAst, env, scope), evalNode(elseAst, env, scope));
      }
      const cb = toBool(c);
      if (isUnavailable(cb)) return UNAVAILABLE;
      return evalNode(cb ? thenAst : elseAst, env, scope);
    }
    default:
      return UNAVAILABLE;
  }
}

// Vectorized `if`: pick per-element from a/b by the boolean column c.
function mergeForIf(c: ColVal, a: unknown, b: unknown): ColVal {
  if (c.values === null) return col(null);
  const av = isCol(a) ? a.values : null;
  const bv = isCol(b) ? b.values : null;
  return col(
    c.values.map((cc, i) => {
      const pick = cc === true;
      if (pick) return isCol(a) ? (av === null ? UNAVAILABLE : av[i]) : a;
      return isCol(b) ? (bv === null ? UNAVAILABLE : bv[i]) : b;
    }),
  );
}

function aggregate(name: string, nums: number[]): number | Unavailable {
  switch (name) {
    case "sum":
      return finite(nums.reduce((a, b) => a + b, 0));
    case "mean":
      return finite(nums.reduce((a, b) => a + b, 0) / nums.length);
    // Loops, not `Math.min(...nums)`: spreading a large column overflows the
    // engine's argument limit.
    case "min": {
      let lo = Infinity;
      for (const n of nums) if (n < lo) lo = n;
      return finite(lo);
    }
    case "max": {
      let hi = -Infinity;
      for (const n of nums) if (n > hi) hi = n;
      return finite(hi);
    }
    case "median": {
      const s = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      const med = s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
      return finite(med);
    }
    case "std": {
      const m = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.reduce((a, b) => a + (b - m) * (b - m), 0) / nums.length;
      return finite(Math.sqrt(variance));
    }
    default:
      return UNAVAILABLE;
  }
}

/** A scalar the reader can display: number, string, boolean, or UNAVAILABLE. */
export type Scalar = number | string | boolean;

/** Evaluate a parsed derived expression to a scalar (the shape a `derived`
 *  signal holds). Columns/datasets/absent operands collapse to UNAVAILABLE. */
export function evalDerived(ast: Ast, env: EvalEnv): Scalar | Unavailable {
  const v = evalNode(ast, env, null);
  if (isUnavailable(v)) return UNAVAILABLE;
  if (typeof v === "number") return Number.isFinite(v) ? v : UNAVAILABLE;
  if (typeof v === "string" || typeof v === "boolean") return v;
  return UNAVAILABLE;
}

/** Evaluate a parsed derived expression to a DATASET (the shape a `derived`
 *  dataset holds — e.g. `filter(sales, region == sel)`). A non-dataset result or
 *  an absent input collapses to an unavailable dataset (`rows: null`), so a chart
 *  reading it shows "no data" rather than crashing (the checker already proved
 *  the expression yields a dataset; this is the total interpretation). */
export function evalDatasetExpr(ast: Ast, env: EvalEnv): EvalDataset {
  const v = evalNode(ast, env, null);
  if (isDs(v)) {
    return { columns: v.columns, rows: v.rows === null ? null : v.rows.slice() };
  }
  return { columns: {}, rows: null };
}
