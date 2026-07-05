// The reactive kernel — Pluto-style signals, but with REACT owning the mutable
// state. A widget calls `set`; that dispatches a React state update; the whole
// interactive-view subtree re-renders with a FRESH kernel object (new identity)
// carrying the new values, so every block/metric that reads `get` re-reads the
// current value. There is deliberately no external store + manual subscription
// here: that design let a widget's write and a tile's read observe different
// snapshots (a re-render could commit a stale value). By threading the state
// through React (props), the value a component reads during a render is always
// the value committed for that render — reactivity is coherent by construction.
//
// The Rust checker guarantees the signal/derived graph is a DAG, so a bounded
// number of re-evaluation passes converges (no scheduler, no cycle handling).
// We recompute all derived cells to a fixpoint whenever a base signal changes —
// the catalog is small, so this is cheap and always terminates.

import { useMemo, useState } from "react";
import type { Document } from "./types";
import {
  evalDatasetExpr,
  evalDerived,
  isUnavailable,
  parseExpr,
  UNAVAILABLE,
  type Ast,
  type EvalDataset,
  type EvalEnv,
} from "./expr";

/** A chart's click-to-select binding: clicking a datum writes `datum[column]`
 *  into `signal`. Computed from every signal whose source is a `from`. */
export interface Selection {
  signal: string;
  column: string;
}

/** The read/write surface the blocks + widgets use. A fresh `Kernel` object is
 *  produced on every state change (so passing it as a prop re-renders readers);
 *  `set`/`reset` dispatch React state updates. */
export interface Kernel {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  reset(names: string[]): void;
  /** A named dataset's schema + rows (`rows: null` ⇒ unavailable). A `derived`
   *  dataset is recomputed reactively, so a chart reading it cross-filters live
   *  as its input signals change. */
  data(name: string): EvalDataset | null;
  /** The click-to-select binding for a chart `id`, or null if none selects it. */
  selection(chartId: string): Selection | null;
}

interface Cell {
  name: string;
  ast: Ast | null;
}

// The static shape of a document, parsed once per doc: static datasets, the
// derived-dataset + derived-signal ASTs, the initial base-signal values, and the
// chart→selection bindings.
interface Spec {
  staticData: Record<string, EvalDataset>;
  derivedData: Cell[];
  derivedSignals: Cell[];
  initialBase: Record<string, unknown>;
  selections: Record<string, Selection>;
}

interface Computed {
  values: Record<string, unknown>;
  datasets: Record<string, EvalDataset>;
}

function buildSpec(doc: Document): Spec {
  const staticData: Record<string, EvalDataset> = {};
  const derivedData: Cell[] = [];
  const data = doc.data ?? {};
  for (const name of Object.keys(data)) {
    const d = data[name];
    if (!d) continue;
    if (typeof d.derived === "string") {
      derivedData.push({ name, ast: parseExpr(d.derived) });
      continue;
    }
    // Inline `values` load eagerly; a `source`-backed dataset is unavailable
    // here (rows: null) — every dependent becomes unavailable, which is exactly
    // the resilience contract (§9).
    const rows = Array.isArray(d.values) ? (d.values as Record<string, unknown>[]) : null;
    staticData[name] = { columns: d.columns ?? {}, rows };
  }

  const derivedSignals: Cell[] = [];
  const initialBase: Record<string, unknown> = {};
  const selections: Record<string, Selection> = {};
  const signals = doc.signals ?? {};
  for (const name of Object.keys(signals)) {
    const sig = signals[name];
    if (!sig) continue;
    if (typeof sig.derived === "string") {
      derivedSignals.push({ name, ast: parseExpr(sig.derived) });
      continue;
    }
    // A widget/selection signal: seed from `init` (or a type-appropriate empty,
    // so widgets are controlled from the first render). The initial is what a
    // `button` reset snaps back to. A `from` signal also registers its chart
    // binding, so the target chart becomes clickable.
    initialBase[name] = sig.init === undefined ? emptyFor(sig.type) : sig.init;
    if (sig.from) selections[sig.from.chart] = { signal: name, column: sig.from.select };
  }
  return { staticData, derivedData, derivedSignals, initialBase, selections };
}

// Recompute every derived cell (datasets first, then signals) to a fixpoint (≤ N
// passes for N cells, since the checker proved the graph is a DAG). Each pass
// reads a snapshot of the previous pass's values; a cell reading a not-yet-final
// dependency settles on the next pass. Pure — memoized on `[spec, base]`.
function computeValues(spec: Spec, base: Record<string, unknown>): Computed {
  const values: Record<string, unknown> = { ...base };
  for (const cell of spec.derivedSignals) values[cell.name] = UNAVAILABLE;
  const datasets: Record<string, EvalDataset> = { ...spec.staticData };
  for (const cell of spec.derivedData) datasets[cell.name] = { columns: {}, rows: null };

  const maxPasses = spec.derivedSignals.length + spec.derivedData.length + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const env: EvalEnv = { signals: { ...values }, datasets: { ...datasets } };
    for (const cell of spec.derivedData) {
      const next = cell.ast === null ? { columns: {}, rows: null } : evalDatasetExpr(cell.ast, env);
      if (!sameDataset(datasets[cell.name], next)) {
        datasets[cell.name] = next;
        changed = true;
      }
    }
    for (const cell of spec.derivedSignals) {
      const next = cell.ast === null ? UNAVAILABLE : evalDerived(cell.ast, env);
      if (!sameScalar(values[cell.name], next)) {
        values[cell.name] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { values, datasets };
}

/** Build the reactive kernel for a document. React owns the base-signal state;
 *  derived values (signals + datasets) are recomputed from it. Call ONCE per
 *  mounted document — the caller keys the subtree on `content`, so a content
 *  change remounts and this re-seeds cleanly from the new `init`s. */
export function useKernel(doc: Document): Kernel {
  const spec = useMemo(() => buildSpec(doc), [doc]);
  const [base, setBase] = useState<Record<string, unknown>>(() => spec.initialBase);
  const computed = useMemo(() => computeValues(spec, base), [spec, base]);

  // A NEW kernel object whenever `computed` changes: passed down as a prop, its
  // changed identity re-renders every reader, which then reads the fresh value.
  return useMemo<Kernel>(
    () => ({
      get: (name) => (Object.hasOwn(computed.values, name) ? computed.values[name] : UNAVAILABLE),
      data: (name) => computed.datasets[name] ?? null,
      selection: (chartId) => spec.selections[chartId] ?? null,
      set: (name, value) => setBase((b) => ({ ...b, [name]: value })),
      reset: (names) =>
        setBase((b) => {
          const next = { ...b };
          for (const n of names) {
            if (Object.hasOwn(spec.initialBase, n)) next[n] = spec.initialBase[n];
          }
          return next;
        }),
    }),
    [computed, spec],
  );
}

function sameScalar(a: unknown, b: unknown): boolean {
  if (isUnavailable(a) && isUnavailable(b)) return true;
  return Object.is(a, b);
}

// Cheap structural equality for the fixpoint: `filter` reuses the input's row
// object references, so a stable input yields reference-equal rows — comparing
// length + per-row identity converges without deep-equality cost.
function sameDataset(a: EvalDataset | undefined, b: EvalDataset): boolean {
  if (!a) return false;
  if (a.rows === null || b.rows === null) return a.rows === b.rows;
  if (a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.rows.length; i++) {
    if (!Object.is(a.rows[i], b.rows[i])) return false;
  }
  return true;
}

// A type-appropriate empty when a signal declares no `init` — keeps widgets
// controlled from the first render (never an uncontrolled→controlled warning).
function emptyFor(type: string): unknown {
  switch (type) {
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 0;
    case "interval<number>":
      return [0, 0];
    case "interval<temporal>":
      return ["", ""];
    case "array<enum>":
      return [];
    default:
      return "";
  }
}
