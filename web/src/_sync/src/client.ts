// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/sync (shared-utils
// `state-sync-engine` branch). Edit there + re-vendor. See _sync/mod.ts.
// Client engine: optimistic local apply + rebase-on-patch (the Replicache model,
// scoped to one synced value). The view a caller renders is always
//   base (last confirmed authoritative state)  +  replay(pending mutations)
// so a local mutation shows instantly, and every arbiter patch re-derives the
// view from the new authoritative base with the still-unconfirmed mutations
// replayed on top — converging on the arbiter's order with no lost update and
// no ghost (a confirmed mutation is dropped from pending exactly once).

import { hashValue } from "./hash.ts";
import { applyMutation, type ArgsOf, type Mutators } from "./mutators.ts";
import type {
  ClientId,
  ClientSnapshot,
  LocalPersistence,
  Mutation,
  MutationId,
  Patch,
  SyncState,
  Version,
} from "./types.ts";

/** Recursively freeze a value so a mutator that MUTATES its input (the cardinal
 *  sin — it breaks replay convergence) throws in dev instead of silently
 *  corrupting state. O(value); gate behind `freezeForDev`, off in prod. */
function deepFreeze<V>(value: V): V {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const k of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[k]);
  }
  return value;
}

export interface Client<T, M extends Mutators<T>> {
  /** The value to render: confirmed base + replayed pending. */
  view(): T;
  /** The confirmed (arbiter) version this client has applied up to. */
  version(): Version;
  /** Outstanding optimistic mutations not yet confirmed by the arbiter. */
  pending(): readonly Mutation[];
  /** Apply a mutator locally (instant) and return the Mutation to send to the
   *  arbiter. Re-send the SAME object on retry — its id makes the arbiter
   *  idempotent. Pass an explicit `id` when the mutation id must equal an
   *  externally-meaningful key — e.g. an optimistic row's `cmid`, so the same
   *  cmid landing in this state's value confirms (drops) exactly this pending
   *  row with no duplicate. Defaults to the client's `newId`. */
  mutate<K extends keyof M & string>(name: K, args: ArgsOf<T, M, K>, id?: MutationId): Mutation<ArgsOf<T, M, K>>;
  /** Drop pending mutations confirmed OUT-OF-BAND — i.e. acknowledged by a signal
   *  OTHER than this state's patch (e.g. an optimistic "submit" whose row was
   *  confirmed by a separate event stream, not by the value landing in this
   *  state). Same monotonic-fact semantics as a patch's `confirmed`, but with no
   *  base/version change. A no-op for ids not pending. */
  confirm(ids: readonly MutationId[]): void;
  /** Move a pending mutation to the TAIL of the pending queue, so it replays
   *  last and renders at the very end. The retry-to-end gesture (WeChat-style):
   *  clicking retry re-anchors that row after everything, and N retries land in
   *  click order. Same id ⇒ still idempotent (no duplicate). Local-only: it
   *  reorders the optimistic view, never the converged base. No-op if `id` isn't
   *  pending or is already last. */
  bump(id: MutationId): void;
  /** Fold an arbiter patch into the base, drop confirmed pending, rebase the
   *  rest. Stale/duplicate patches are a no-op.
   *
   *  `opts.force` adopts the patch's value as the new base REGARDLESS of version
   *  — for a reconnect RESYNC, where the arbiter's current snapshot is ground
   *  truth even if its version is lower than what this client cached (e.g. the
   *  service restarted and its version clock reset). Pending is preserved +
   *  replayed on the forced base. Without `force`, only a strictly-newer version
   *  advances the base (live-stream ordering). */
  applyPatch(patch: Patch<T>, opts?: { force?: boolean }): void;
  /** Restore base + pending from the configured `LocalPersistence` (instant first
   *  paint on reload + a durable outbox for unconfirmed optimistic mutations).
   *  Call once before connecting; a no-op if no persistence is configured or
   *  nothing is stored. The restored pending should then be re-sent (see the
   *  reconnect resend) — its ids keep the arbiter idempotent. */
  hydrate(): Promise<void>;
  /** Persist the current snapshot NOW, bypassing the save debounce — call on
   *  `pagehide`/`beforeunload` so an in-flight change isn't lost. No-op without
   *  persistence. */
  flush(): Promise<void>;
}

export interface ClientOpts<T, M extends Mutators<T>> {
  clientId: ClientId;
  mutators: M;
  /** The arbiter's current state at connect (version 0 + initial value, or a
   *  resync snapshot). */
  initial: SyncState<T>;
  onChange?: (view: T) => void;
  /** Mutation-id factory (default `clientId:counter`). Inject for deterministic
   *  tests. Must be globally unique across clients. */
  newId?: () => MutationId;
  /** Called when an applied patch's `valueHash` disagrees with this client's own
   *  value at that version (no pending) — i.e. a divergence/integrity failure
   *  (corrupt wire round-trip, non-deterministic mutator, …). Default:
   *  `console.error`. Throw here to fail loud in tests. */
  onDiverge?: (detail: { version: Version; expected: string; got: string }) => void;
  /** Dev-only: deep-freeze the confirmed base so a mutator that mutates its
   *  input throws. O(value) per patch; leave off in production. */
  freezeForDev?: boolean;
  /** App-side persistence backend (e.g. @shared-utils/sync-idb). When set, the
   *  client debounce-saves its `ClientSnapshot<T>` ({base, pending} = a durable
   *  outbox) on every change and can `hydrate()` from it. Omit to keep the client
   *  purely in-memory (the default). */
  local?: LocalPersistence<ClientSnapshot<T>>;
  /** Debounce window (ms) for persistence saves. Default 250. */
  saveDebounceMs?: number;
}

export function createClient<T, M extends Mutators<T>>(opts: ClientOpts<T, M>): Client<T, M> {
  const { clientId, mutators, onChange, freezeForDev, local } = opts;
  const saveDebounceMs = opts.saveDebounceMs ?? 250;
  const onDiverge = opts.onDiverge ??
    ((d: { version: Version; expected: string; got: string }): void => {
      console.error(`sync: divergence at v${String(d.version)}: expected ${d.expected}, got ${d.got}`);
    });
  let seq = 0;
  const newId = opts.newId ?? ((): MutationId => `${clientId}:${String(++seq)}`);

  const freeze = (s: SyncState<T>): SyncState<T> =>
    freezeForDev ? { version: s.version, value: deepFreeze(s.value) } : s;

  let base: SyncState<T> = freeze(opts.initial);
  let queue: Mutation[] = [];
  let viewValue: T = base.value;

  // Debounced app-side persistence of {base, pending}. No-op without `local`.
  let saveTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  const snapshot = (): ClientSnapshot<T> => ({ base, pending: [...queue] });
  const scheduleSave = (): void => {
    if (local === undefined) {
      return;
    }
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void local.save(snapshot());
    }, saveDebounceMs);
  };

  const recompute = (): void => {
    let v = base.value;
    for (const m of queue) {
      v = applyMutation(mutators, v, m);
    }
    viewValue = v;
  };

  return {
    view: (): T => viewValue,
    version: (): Version => base.version,
    pending: (): readonly Mutation[] => queue,

    mutate<K extends keyof M & string>(name: K, args: ArgsOf<T, M, K>, id?: MutationId): Mutation<ArgsOf<T, M, K>> {
      const m: Mutation<ArgsOf<T, M, K>> = { id: id ?? newId(), client: clientId, name, args };
      queue.push(m);
      // Incremental: apply on the current view (== replaying just this one on top
      // of the already-replayed queue), equivalent to a full recompute.
      viewValue = applyMutation(mutators, viewValue, m);
      onChange?.(viewValue);
      scheduleSave();
      return m;
    },

    confirm(ids: readonly MutationId[]): void {
      if (ids.length === 0) {
        return;
      }
      const set = new Set<MutationId>(ids);
      const next = queue.filter((m) => !set.has(m.id));
      if (next.length === queue.length) {
        return; // none pending — no-op
      }
      queue = next;
      recompute();
      onChange?.(viewValue);
      scheduleSave();
    },

    bump(id: MutationId): void {
      const i = queue.findIndex((m) => m.id === id);
      if (i === -1 || i === queue.length - 1) {
        return; // not pending or already last
      }
      const m = queue[i];
      if (m === undefined) {
        return;
      }
      queue = [...queue.slice(0, i), ...queue.slice(i + 1), m];
      recompute();
      onChange?.(viewValue);
      scheduleSave();
    },

    applyPatch(patch: Patch<T>, applyOpts?: { force?: boolean }): void {
      let changed = false;
      // CONFIRMATIONS ARE MONOTONIC FACTS — process them from EVERY patch, even a
      // reordered/older/dup one. A patch's value may be stale (an absolute
      // snapshot we already advanced past), but its `confirmed` still tells us a
      // pending mutation is now folded into the truth. Skipping it would leave
      // that mutation in `queue` and replay it on top of a newer base that
      // already includes it → double-count → divergence (caught by the fuzz).
      if (patch.confirmed.length > 0) {
        const confirmed = new Set<MutationId>(patch.confirmed);
        const next = queue.filter((m) => !confirmed.has(m.id));
        if (next.length !== queue.length) {
          queue = next;
          changed = true;
        }
      }
      // VALUE: only a strictly-newer absolute snapshot advances the base; an
      // older/duplicate snapshot's value is ignored (idempotent). (An op-patch
      // would additionally require fromVersion === base.version + gap → resync.)
      if (applyOpts?.force === true || patch.toVersion > base.version) {
        base = freeze({ version: patch.toVersion, value: patch.apply(base.value) });
        changed = true;
      }
      // Machine-checked convergence: once we're AT this patch's version with NO
      // pending, our base IS the authoritative value, so its hash must match the
      // patch's. A mismatch means a corrupt round-trip or a non-deterministic
      // mutator — surface it loudly rather than silently diverge.
      if (
        patch.valueHash !== undefined &&
        queue.length === 0 &&
        base.version === patch.toVersion
      ) {
        const got = hashValue(base.value);
        if (got !== patch.valueHash) {
          onDiverge({ version: patch.toVersion, expected: patch.valueHash, got });
        }
      }
      if (changed) {
        recompute();
        onChange?.(viewValue);
        scheduleSave();
      }
    },

    async hydrate(): Promise<void> {
      if (local === undefined) {
        return;
      }
      const snap = await local.load();
      if (snap === null) {
        return;
      }
      base = freeze(snap.base);
      queue = [...snap.pending];
      recompute();
      onChange?.(viewValue);
    },

    async flush(): Promise<void> {
      if (local === undefined) {
        return;
      }
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      await local.save(snapshot());
    },
  };
}
