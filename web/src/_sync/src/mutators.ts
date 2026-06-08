// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/sync (shared-utils
// `state-sync-engine` branch). Edit there + re-vendor. See _sync/mod.ts.
// Mutators: named, PURE, deterministic state transitions. Determinism is the
// whole game — a mutator that reads Date.now()/Math.random() or mutates its
// input breaks replay convergence (the rebase replays it on a different base).
// Keep them `(state, args) => nextState` with structural updates, no side effects.

import type { Mutation } from "./types.ts";

/** A pure transition over `T` given JSON-plain `args`. */
export type Mutator<T, A> = (state: T, args: A) => T;

/** A name→mutator map. Heterogeneous `args` types are preserved by inference;
 *  the `never` arg bound (contravariant) lets any concrete `Mutator<T, A>` be a
 *  member while still letting `ArgsOf` recover each one's real arg type. */
export type Mutators<T> = Readonly<Record<string, Mutator<T, never>>>;

/** Recover a mutator's arg type from a map, for the typed `mutate(name, args)`. */
export type ArgsOf<T, M extends Mutators<T>, K extends keyof M> = M[K] extends Mutator<T, infer A> ? A
  : never;

/** Apply a named mutation, type-erased — the internal call site shared by the
 *  client (replay) and the arbiter (authoritative apply). Takes the `{name, args}`
 *  shape (a full `Mutation` satisfies it) so the optimistic queue can be replayed
 *  directly. Throws on an unknown name so a bad/forged mutation fails loudly
 *  instead of silently no-op'ing. */
export function applyMutation<T>(mutators: Mutators<T>, state: T, m: Pick<Mutation, "name" | "args">): T {
  const fn = mutators[m.name];
  if (fn === undefined) {
    throw new Error(`sync: unknown mutator "${m.name}"`);
  }
  return (fn as (s: T, a: unknown) => T)(state, m.args);
}
