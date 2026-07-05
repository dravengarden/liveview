// `{{ signal | filter(args) }}` interpolation for section/callout/metric text.
// Everything here is TOTAL: an UNAVAILABLE (or missing) value renders as an em
// dash "—", never a crash, never "undefined"/"NaN" leaking to the reader.
//
// The accessor before the first `|` is a signal name with an optional interval
// index (`band[0]`) — read straight from the kernel so arrays (multiSelect /
// interval) survive for `join`. Filters (`round`/`join`/`date`) apply left→right.

import { isUnavailable } from "./expr";
import type { Kernel } from "./kernel";

const TOKEN = /\{\{([^}]*)\}\}/g;
const ACCESSOR = /^([A-Za-z_]\w*)(?:\[(\d+)\])?$/;

/** Render a value for display: UNAVAILABLE / missing → "—"; arrays join with
 *  ", "; everything else via String. */
export function renderValue(v: unknown): string {
  if (v === undefined || v === null || isUnavailable(v)) return "—";
  if (Array.isArray(v)) return v.map((e) => renderScalar(e)).join(", ");
  return renderScalar(v);
}

function renderScalar(v: unknown): string {
  if (v === undefined || v === null || isUnavailable(v)) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  return String(v);
}

/** Interpolate a template string against the kernel. */
export function interpolate(template: string, kernel: Kernel): string {
  return template.replace(TOKEN, (_m, inner: string) => renderValue(evalToken(inner, kernel)));
}

/** Evaluate a metric `value` with its optional numeral `format`. When the whole
 *  template is a single token and a format is given, the raw value is formatted
 *  numerically; otherwise it is plain-interpolated. */
export function evalMetric(template: string, format: string | undefined, kernel: Kernel): string {
  if (format) {
    const trimmed = template.trim();
    const matches = [...template.matchAll(TOKEN)];
    const only = matches[0];
    if (matches.length === 1 && only && only[0] === trimmed) {
      return formatNumeral(evalToken(only[1] ?? "", kernel), format);
    }
  }
  return interpolate(template, kernel);
}

// ── token evaluation ──────────────────────────────────────────────────────────

function evalToken(inner: string, kernel: Kernel): unknown {
  const parts = splitTop(inner, "|").map((s) => s.trim());
  const accessor = parts[0] ?? "";
  let value = evalAccessor(accessor, kernel);
  for (let i = 1; i < parts.length; i++) {
    value = applyFilter(parts[i] ?? "", value);
  }
  return value;
}

function evalAccessor(acc: string, kernel: Kernel): unknown {
  const m = ACCESSOR.exec(acc);
  if (!m) return undefined;
  const name = m[1] ?? "";
  const value = kernel.get(name);
  if (m[2] !== undefined) {
    const idx = Number(m[2]);
    return Array.isArray(value) ? (value as unknown[])[idx] : undefined;
  }
  return value;
}

function applyFilter(spec: string, value: unknown): unknown {
  const m = /^([A-Za-z_]\w*)\s*(?:\((.*)\))?$/.exec(spec);
  if (!m) return value;
  const name = m[1] ?? "";
  const args = m[2] === undefined ? [] : parseArgs(m[2]);
  switch (name) {
    case "round": {
      if (isUnavailable(value) || typeof value !== "number") return value;
      const digits = typeof args[0] === "number" ? args[0] : 0;
      const f = Math.pow(10, digits);
      return Math.round(value * f) / f;
    }
    case "join": {
      const sep = typeof args[0] === "string" ? args[0] : ", ";
      if (Array.isArray(value)) return value.map((e) => renderScalar(e)).join(sep);
      return value;
    }
    case "date": {
      const fmt = typeof args[0] === "string" ? args[0] : "YYYY-MM-DD";
      return formatDate(value, fmt);
    }
    default:
      return value;
  }
}

// ── formatters (all total) ────────────────────────────────────────────────────

function formatDate(value: unknown, fmt: string): string {
  if (isUnavailable(value) || value === undefined || value === null) return "—";
  const s = String(value);
  let y = "";
  let mo = "";
  let d = "";
  let h = "00";
  let mi = "00";
  let se = "00";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    y = m[1] ?? "";
    mo = m[2] ?? "";
    d = m[3] ?? "";
    h = m[4] ?? "00";
    mi = m[5] ?? "00";
    se = m[6] ?? "00";
  } else {
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) return "—";
    y = String(dt.getUTCFullYear()).padStart(4, "0");
    mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    d = String(dt.getUTCDate()).padStart(2, "0");
    h = String(dt.getUTCHours()).padStart(2, "0");
    mi = String(dt.getUTCMinutes()).padStart(2, "0");
    se = String(dt.getUTCSeconds()).padStart(2, "0");
  }
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss|YY/g, (tok) => {
    switch (tok) {
      case "YYYY":
        return y;
      case "YY":
        return y.slice(-2);
      case "MM":
        return mo;
      case "DD":
        return d;
      case "HH":
        return h;
      case "mm":
        return mi;
      case "ss":
        return se;
      default:
        return tok;
    }
  });
}

// A tiny numeral.js-style formatter: `0.00`, `0.0%`, `$0,0`, `0d`. Not
// exhaustive — total and covers the v1 demo's patterns; an unknown pattern
// falls back to a plain render.
function formatNumeral(value: unknown, fmt: string): string {
  if (isUnavailable(value) || value === undefined || value === null) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return renderValue(value);

  const percent = fmt.includes("%");
  const currency = fmt.trimStart().startsWith("$");
  let body = fmt.replace(/[%$]/g, "");
  const thousands = body.includes(",");
  // A trailing literal suffix (e.g. the `d` in `0d`).
  const suffixMatch = /([^0#.,\s-]+)$/.exec(body);
  const suffix = suffixMatch ? (suffixMatch[1] ?? "") : "";
  if (suffix) body = body.slice(0, body.length - suffix.length);
  const dot = body.indexOf(".");
  const decimals = dot >= 0 ? body.length - dot - 1 : 0;

  const scaled = percent ? n * 100 : n;
  const fixed = scaled.toFixed(Math.max(0, Math.min(20, decimals)));
  const grouped = thousands ? groupThousands(fixed) : fixed;
  return `${currency ? "$" : ""}${grouped}${percent ? "%" : ""}${suffix}`;
}

function groupThousands(fixed: string): string {
  const neg = fixed.startsWith("-");
  const body = neg ? fixed.slice(1) : fixed;
  const dot = body.indexOf(".");
  const intPart = dot >= 0 ? body.slice(0, dot) : body;
  const rest = dot >= 0 ? body.slice(dot) : "";
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${withSep}${rest}`;
}

// Split `s` on top-level `sep`, ignoring `sep` inside single/double quotes.
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = "";
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Parse a filter's argument list (a single level, quote-aware). A quoted arg is
// a string literal (verbatim, commas kept); a bare arg is a number if numeric,
// else a string.
function parseArgs(inside: string): (string | number)[] {
  const trimmed = inside.trim();
  if (trimmed === "") return [];
  return splitTop(trimmed, ",").map((raw) => {
    const a = raw.trim();
    if ((a.startsWith("'") && a.endsWith("'")) || (a.startsWith('"') && a.endsWith('"'))) {
      return a.slice(1, -1);
    }
    const n = Number(a);
    return Number.isFinite(n) && a !== "" ? n : a;
  });
}
