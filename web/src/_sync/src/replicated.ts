// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/sync (shared-utils
// `state-sync-engine` branch); the `@shared-utils/store` import is rewritten to
// the sibling vendored _store. Edit there + re-vendor. See _sync/mod.ts.
// Replicated store — the OP-BASED (CmRDT) tier of the authority spectrum: the
// reactive-store face of the `createClient` engine. Multiple clients mutate the
// SAME state concurrently; an ACTIVE arbiter (a Rust daemon implementing the
// `Mutation`/`Patch` contract) serializes them and broadcasts patches; each
// client rebases its pending optimistic mutations on every patch (Replicache
// model). Strong convergence, at the cost of needing that arbiter.
//
// This is a THIN wrapper: it adds the `ReadableStore` face (`get`/`subscribe`,
// so `useStore` renders it exactly like a `persisted`/`mirroredStore`) and binds
// the transport seam (`send` upstream + `resend` on reconnect) around the
// unchanged, fuzz-proven client engine. The app owns its transport (often one
// multiplexed socket carrying far more than sync), so the seam is a plain `send`
// callback rather than an owned connection.

import type { ReadableStore } from "../../_store/mod.ts";
import { type Client, type ClientOpts, createClient } from "./client.ts";
import type { ArgsOf, Mutators } from "./mutators.ts";
import type { ClientSnapshot, LocalPersistence, Mutation, MutationId, Patch, Version } from "./types.ts";

export interface ReplicatedStore<T, M extends Mutators<T>> extends ReadableStore<T> {
  /** Apply a mutator locally (instant) and send it upstream. Pass an explicit
   *  `id` to make the mutation id an externally-meaningful key (e.g. an optimistic
   *  row's cmid, for no-duplicate confirmation). */
  mutate<K extends keyof M & string>(name: K, args: ArgsOf<T, M, K>, id?: MutationId): Mutation<ArgsOf<T, M, K>>;
  /** Drop pending mutations confirmed OUT-OF-BAND (acked by a signal other than
   *  this state's patch). */
  confirm(ids: readonly MutationId[]): void;
  /** Move a pending mutation to the tail (retry-to-end gesture). */
  bump(id: MutationId): void;
  /** Fold an arbiter patch in. `force` adopts the patch value across a version
   *  reset (reconnect resync). */
  applyPatch(patch: Patch<T>, opts?: { force?: boolean }): void;
  /** Outstanding optimistic mutations not yet confirmed. */
  pending(): readonly Mutation[];
  /** Confirmed arbiter version this client has applied up to. */
  version(): Version;
  /** Re-send every pending mutation upstream — call on (re)connect. Ids keep the
   *  arbiter idempotent. */
  resend(): void;
  /** Restore base + pending from `local` (instant paint + durable outbox). Call
   *  before connecting. */
  hydrate(): Promise<void>;
  /** Persist the snapshot NOW, bypassing the save debounce (call on `pagehide`). */
  flush(): Promise<void>;
}

export interface ReplicatedOpts<T, M extends Mutators<T>> {
  clientId: string;
  mutators: M;
  initial: T;
  /** Arbiter version of `initial` (default 0). */
  initialVersion?: Version;
  /** Send one mutation upstream on the app's transport — the app maps the
   *  `Mutation` to its wire frame. Called by `mutate` and by `resend`. */
  send: (m: Mutation) => void;
  /** Fired after any view change (mutate / patch / confirm / bump / hydrate) —
   *  the app's commit-to-render hook. */
  onChange?: () => void;
  /** Durable outbox backend (e.g. `idbPersistence<ClientSnapshot<T>>(key)`). */
  local?: LocalPersistence<ClientSnapshot<T>>;
  newId?: () => MutationId;
  freezeForDev?: boolean;
  saveDebounceMs?: number;
  onDiverge?: (detail: { version: Version; expected: string; got: string }) => void;
}

export function replicatedStore<T, M extends Mutators<T>>(opts: ReplicatedOpts<T, M>): ReplicatedStore<T, M> {
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of listeners) {
      l();
    }
    opts.onChange?.();
  };

  // Build ClientOpts conditionally — exactOptionalPropertyTypes forbids passing
  // an explicit `undefined` for an optional property.
  const clientOpts: ClientOpts<T, M> = {
    clientId: opts.clientId,
    mutators: opts.mutators,
    initial: { version: opts.initialVersion ?? 0, value: opts.initial },
    onChange: emit,
  };
  if (opts.local !== undefined) {
    clientOpts.local = opts.local;
  }
  if (opts.newId !== undefined) {
    clientOpts.newId = opts.newId;
  }
  if (opts.freezeForDev !== undefined) {
    clientOpts.freezeForDev = opts.freezeForDev;
  }
  if (opts.saveDebounceMs !== undefined) {
    clientOpts.saveDebounceMs = opts.saveDebounceMs;
  }
  if (opts.onDiverge !== undefined) {
    clientOpts.onDiverge = opts.onDiverge;
  }
  const client: Client<T, M> = createClient<T, M>(clientOpts);

  return {
    get: (): T => client.view(),
    subscribe: (listener): () => void => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    mutate<K extends keyof M & string>(name: K, args: ArgsOf<T, M, K>, id?: MutationId): Mutation<ArgsOf<T, M, K>> {
      const m = client.mutate(name, args, id);
      opts.send(m);
      return m;
    },
    confirm: (ids): void => {
      client.confirm(ids);
    },
    bump: (id): void => {
      client.bump(id);
    },
    applyPatch: (patch, applyOpts): void => {
      client.applyPatch(patch, applyOpts);
    },
    pending: (): readonly Mutation[] => client.pending(),
    version: (): Version => client.version(),
    resend: (): void => {
      for (const m of client.pending()) {
        opts.send(m);
      }
    },
    hydrate: (): Promise<void> => client.hydrate(),
    flush: (): Promise<void> => client.flush(),
  };
}
