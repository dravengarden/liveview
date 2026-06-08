// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/sync (shared-utils
// `state-sync-engine` branch). Edit there + re-vendor. See _sync/mod.ts.
// Arbiter: the source of truth. Deliberately a "serializer" — it linearizes
// incoming mutations, version-stamps, and echoes a patch. No optimistic state,
// no rebase. This reference impl is for TS-backed services + the convergence
// fuzz; a Rust service (cowboy's daemon) implements the SAME contract natively
// (dedupe by MutationId, version++, emit a snapshot patch) — reusing its
// existing broadcast + cmid dedupe. That's why the heavy/correctness-critical
// engine is the CLIENT, not this.

import { hashValue } from "./hash.ts";
import { applyMutation, type Mutators } from "./mutators.ts";
import { snapshotPatch } from "./patch/snapshot.ts";
import type { CommitRecord, Mutation, MutationId, Patch, SyncState, Version } from "./types.ts";

export interface Arbiter<T> {
  /** The authoritative state (for a new client's `initial`, or resync). */
  current(): SyncState<T>;
  /** Apply a mutation authoritatively and return the patch to broadcast, or
   *  `null` if it's a duplicate (already applied — idempotent). */
  receive(m: Mutation): Patch<T> | null;
  /** An absolute snapshot patch confirming every applied mutation — what a
   *  client gets on (re)connect to converge from any version + clear its pending.
   *  This is how a lossy broadcast recovers: a dropped patch is healed by the
   *  next resync. */
  resync(): Patch<T>;
}

export interface ArbiterOpts<T> {
  mutators: Mutators<T>;
  /** The authoritative value to start from. Pass the LAST PERSISTED snapshot to
   *  resume across a restart (see `version`); pass the genesis value on first
   *  boot. */
  initial: T;
  /** The version `initial` is at. Defaults to 0 (genesis). When resuming from a
   *  persisted snapshot, pass the persisted version so the arbiter's clock stays
   *  MONOTONIC across restart — otherwise a client that cached version N would
   *  reject the post-restart patches (toVersion < N) and diverge. */
  initialVersion?: Version;
  /** Bound on remembered mutation ids for dedupe. A client never re-sends a
   *  CONFIRMED mutation (it's dropped from pending), so only in-flight duplicate
   *  *deliveries* need to be caught — a window well past the in-flight set is
   *  enough. 0 = unbounded (simplest; fine for small/short-lived states).
   *  (A durable per-client high-water-mark cursor is the v0.2 upgrade for
   *  non-idempotent mutators across restart — see design.md.) */
  dedupeWindow?: number;
  /** Fired after each ACCEPTED mutation — the persistence + logging seam. Do the
   *  pg write / op-log append fire-and-forget here; the arbiter never awaits it,
   *  so I/O never blocks the hot path. Not called for a deduped (duplicate)
   *  delivery. See [`CommitRecord`]. */
  onCommit?: (record: CommitRecord<T>) => void;
}

export function createArbiter<T>(opts: ArbiterOpts<T>): Arbiter<T> {
  const { mutators, onCommit } = opts;
  const window = opts.dedupeWindow ?? 0;
  let state: SyncState<T> = { version: opts.initialVersion ?? 0, value: opts.initial };
  // Insertion-ordered dedupe set; trimmed to `window` when bounded.
  const seen = new Set<MutationId>();

  return {
    current: (): SyncState<T> => state,

    receive(m: Mutation): Patch<T> | null {
      if (seen.has(m.id)) {
        return null; // idempotent — duplicate delivery/retry
      }
      seen.add(m.id);
      if (window > 0 && seen.size > window) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }
      const value = applyMutation(mutators, state.value, m);
      state = { version: state.version + 1, value };
      const patch = snapshotPatch(state.version, value, [m.id]);
      // Persistence + logging seam: app writes pg / appends the op-log here.
      // valueHash is already computed by snapshotPatch — reuse it.
      onCommit?.({ version: state.version, value, valueHash: patch.valueHash ?? hashValue(value), mutation: m });
      return patch;
    },

    resync: (): Patch<T> => snapshotPatch(state.version, state.value, [...seen]),
  };
}
