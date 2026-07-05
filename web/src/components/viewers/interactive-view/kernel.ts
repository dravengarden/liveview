// The reactive kernel — the single source of mutable state (Pluto-style
// signals). Widgets `set` a signal; `derived` signals recompute via the total
// evaluator (`expr.ts`) whenever their inputs change; blocks `get` and subscribe.
//
// The Rust checker guarantees the signal/derived graph is a DAG, so a bounded
// number of re-evaluation passes converges (no scheduler, no cycle handling
// needed). We recompute all derived cells to a fixpoint on every `set` — the
// catalog is small, so this is cheap and always terminates.

import { useSyncExternalStore } from "react";
import type { Document } from "./types";
import { evalDerived, isUnavailable, parseExpr, UNAVAILABLE, type Ast, type EvalDataset, type EvalEnv } from "./expr";

interface DerivedCell {
  name: string;
  ast: Ast | null;
}

export class Kernel {
  private readonly values = new Map<string, unknown>();
  private readonly initials = new Map<string, unknown>();
  private readonly derived: DerivedCell[] = [];
  private readonly datasets: Record<string, EvalDataset> = {};
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(doc: Document) {
    // Datasets: inline `values` load eagerly; a `source`-backed dataset is
    // unavailable in Phase 1 (rows: null) — every dependent derived becomes
    // UNAVAILABLE, exactly the resilience contract (§9).
    const data = doc.data ?? {};
    for (const name of Object.keys(data)) {
      const d = data[name];
      if (!d) continue;
      const rows = Array.isArray(d.values) ? (d.values as Record<string, unknown>[]) : null;
      this.datasets[name] = { columns: d.columns, rows };
    }

    const signals = doc.signals ?? {};
    for (const name of Object.keys(signals)) {
      const sig = signals[name];
      if (!sig) continue;
      if (typeof sig.derived === "string") {
        this.derived.push({ name, ast: parseExpr(sig.derived) });
        this.values.set(name, UNAVAILABLE);
        continue;
      }
      // A widget/selection signal: seed from `init` (or a type-appropriate
      // empty). The initial is remembered for `button` reset.
      const init = sig.init === undefined ? emptyFor(sig.type) : sig.init;
      this.values.set(name, init);
      this.initials.set(name, init);
    }
    this.recompute();
  }

  /** Current value of a signal (UNAVAILABLE for an unresolved derived cell). */
  get = (name: string): unknown => {
    return this.values.has(name) ? this.values.get(name) : UNAVAILABLE;
  };

  /** Write a widget/selection signal, then recompute derived cells + notify. */
  set = (name: string, value: unknown): void => {
    this.values.set(name, value);
    this.recompute();
    this.bump();
  };

  /** Snap the named signals back to their `init` (a `button`'s reset action). */
  reset = (names: string[]): void => {
    for (const name of names) {
      if (this.initials.has(name)) this.values.set(name, this.initials.get(name));
    }
    this.recompute();
    this.bump();
  };

  /** The evaluator env — a snapshot of every signal value + dataset. */
  env(): EvalEnv {
    const sig: Record<string, unknown> = {};
    for (const [k, v] of this.values) sig[k] = v;
    return { signals: sig, datasets: this.datasets };
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const cb of this.listeners) cb();
  }

  // Re-evaluate every derived cell to a fixpoint (≤ N passes for N cells, since
  // the graph is a DAG). Uses the current env; a cell that reads a not-yet-final
  // dependency settles on the next pass.
  private recompute(): void {
    const maxPasses = this.derived.length + 1;
    for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false;
      const env = this.env();
      for (const cell of this.derived) {
        const next = cell.ast === null ? UNAVAILABLE : evalDerived(cell.ast, env);
        const prev = this.values.get(cell.name);
        if (!sameScalar(prev, next)) {
          this.values.set(cell.name, next);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
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

/** Subscribe a component to kernel changes; returns the current version so React
 *  re-renders (and re-reads `kernel.get`) whenever any signal changes. */
export function useKernelVersion(kernel: Kernel): number {
  return useSyncExternalStore(kernel.subscribe, kernel.getVersion, kernel.getVersion);
}
