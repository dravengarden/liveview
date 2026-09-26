// Pure numeric helpers shared by the chart and widget renderers. Everything is
// total: a dataset cell may be any JSON value (or, from an older evaluator, a
// Symbol), and none of these throw on it.

/** The histogram bucket cap — `MAX_HISTOGRAM_BINS` in the checker
 *  (src/check/interactive_view.rs). */
export const MAX_HISTOGRAM_BINS = 100;

/** A dataset cell as a number: a number verbatim, a numeric string parsed, and
 *  anything else — null/undefined, booleans, objects, Symbols (on which
 *  `Number()` throws) — NaN. Callers filter with `Number.isFinite`. */
export function cellNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

/** `[min, max]` of `values` without spreading (`Math.min(...values)` throws a
 *  RangeError on a large column), or null when empty. */
export function numericExtent(values: readonly number[]): [number, number] | null {
  if (values.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** A histogram bucket count: the author's `bins` (default 10) as an integer in
 *  `1..=MAX_HISTOGRAM_BINS`. The checker rejects out-of-range values; this keeps
 *  the renderer total for unchecked content. */
export function clampBins(bins: number | undefined): number {
  const n = bins === undefined || !Number.isFinite(bins) ? 10 : Math.floor(bins);
  return Math.min(MAX_HISTOGRAM_BINS, Math.max(1, n));
}

/** Clamp `n` into the optional `[min, max]` bounds. */
export function clampNumber(n: number, min?: number, max?: number): number {
  let out = n;
  if (min !== undefined) out = Math.max(min, out);
  if (max !== undefined) out = Math.min(max, out);
  return out;
}

/** A number-input draft as a committable number, or null while it is still an
 *  incomplete edit (empty, a lone `-`, `1e`, …) that must not overwrite the
 *  signal. */
export function parseNumberDraft(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
