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
import { evalDerived, isUnavailable, parseExpr, UNAVAILABLE, type Ast, type EvalDataset, type EvalEnv } from "./expr";

/** The read/write surface the blocks + widgets use. A fresh `Kernel` object is
 *  produced on every state change (so passing it as a prop re-renders readers);
 *  `set`/`reset` dispatch React state updates. */
export interface Kernel {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  reset(names: string[]): void;
}

interface DerivedCell {
  name: string;
  ast: Ast | null;
}

// The static shape of a document: datasets, the derived-cell ASTs, and the
// initial values of the base (widget/selection) signals. Parsed once per doc.
interface Spec {
  datasets: Record<string, EvalDataset>;
  derived: DerivedCell[];
  initialBase: Record<string, unknown>;
}

function buildSpec(doc: Document): Spec {
  const datasets: Record<string, EvalDataset> = {};
  const data = doc.data ?? {};
  for (const name of Object.keys(data)) {
    const d = data[name];
    if (!d) continue;
    // Inline `values` load eagerly; a `source`-backed dataset is unavailable in
    // Phase 1 (rows: null) — every dependent derived becomes UNAVAILABLE, which
    // is exactly the resilience contract (§9).
    const rows = Array.isArray(d.values) ? (d.values as Record<string, unknown>[]) : null;
    datasets[name] = { columns: d.columns, rows };
  }

  const derived: DerivedCell[] = [];
  const initialBase: Record<string, unknown> = {};
  const signals = doc.signals ?? {};
  for (const name of Object.keys(signals)) {
    const sig = signals[name];
    if (!sig) continue;
    if (typeof sig.derived === "string") {
      derived.push({ name, ast: parseExpr(sig.derived) });
      continue;
    }
    // A widget/selection signal: seed from `init` (or a type-appropriate empty,
    // so widgets are controlled from the first render). The initial is what a
    // `button` reset snaps back to.
    initialBase[name] = sig.init === undefined ? emptyFor(sig.type) : sig.init;
  }
  return { datasets, derived, initialBase };
}

// Merge base signals with the derived cells recomputed to a fixpoint (≤ N passes
// for N cells, since the graph is a DAG). Each pass reads a snapshot of the
// previous pass's values; a cell reading a not-yet-final dependency settles on
// the next pass. Pure — same inputs, same output (memoized on `[spec, base]`).
function computeValues(spec: Spec, base: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = { ...base };
  for (const cell of spec.derived) values[cell.name] = UNAVAILABLE;

  const maxPasses = spec.derived.length + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const env: EvalEnv = { signals: { ...values }, datasets: spec.datasets };
    for (const cell of spec.derived) {
      const next = cell.ast === null ? UNAVAILABLE : evalDerived(cell.ast, env);
      if (!sameScalar(values[cell.name], next)) {
        values[cell.name] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return values;
}

/** Build the reactive kernel for a document. React owns the base-signal state;
 *  derived values are recomputed from it. Call ONCE per mounted document — the
 *  caller keys the subtree on `content`, so a content change remounts and this
 *  re-seeds cleanly from the new `init`s (no in-render reset). */
export function useKernel(doc: Document): Kernel {
  const spec = useMemo(() => buildSpec(doc), [doc]);
  const [base, setBase] = useState<Record<string, unknown>>(() => spec.initialBase);
  const values = useMemo(() => computeValues(spec, base), [spec, base]);

  // A NEW kernel object whenever `values` changes: passed down as a prop, its
  // changed identity re-renders every reader, which then reads the fresh value.
  return useMemo<Kernel>(
    () => ({
      get: (name) => (Object.hasOwn(values, name) ? values[name] : UNAVAILABLE),
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
    [values, spec],
  );
}

function sameScalar(a: unknown, b: unknown): boolean {
  if (isUnavailable(a) && isUnavailable(b)) return true;
  return Object.is(a, b);
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
