// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/sync (shared-utils
// `state-sync-engine` branch). Edit there + re-vendor. See _sync/mod.ts.
// Wire + core contracts for the local-first sync engine. This is the
// cross-language source of truth: a Rust arbiter (e.g. cowboy's daemon) mirrors
// `Mutation` / `Patch` as serde structs; the TS client + reference arbiter below
// honor the same shapes. Keep every field JSON-plain.

/** Monotonic version assigned by the arbiter — the source-of-truth's clock. */
export type Version = number;

/** Stable id of a terminal/client (mutation namespacing + ack routing). */
export type ClientId = string;

/** Globally-unique id a client mints per mutation: the reconcile + dedupe key.
 *  The same id is reused on retry so the arbiter's dedupe makes retry idempotent. */
export type MutationId = string;

/** A named, deterministic intent to change the value. `args` MUST be JSON-plain. */
export interface Mutation<Args = unknown> {
  readonly id: MutationId;
  readonly client: ClientId;
  readonly name: string;
  readonly args: Args;
}

/** The authoritative value at a version (what the arbiter holds / a client's
 *  confirmed base). */
export interface SyncState<T> {
  readonly version: Version;
  readonly value: T;
}

/** An arbiter→client update. The mutator/rebase core depends ONLY on this
 *  interface, so a future prolly-tree / Merkle diff can implement it without
 *  touching any caller (REQ-3).
 *
 *  - `apply(prev)` produces the new authoritative value. A SNAPSHOT patch ignores
 *    `prev` and returns the absolute value; an OP patch would fold ops into
 *    `prev`. v1 ships snapshot patches (absolute), which makes reorder/dup/drop
 *    trivially convergent — the client just keeps the newest `toVersion`.
 *  - `confirmed` lists the mutation ids now folded into the truth → the client
 *    drops them from its pending queue. */
export interface Patch<T> {
  readonly fromVersion: Version;
  readonly toVersion: Version;
  readonly confirmed: readonly MutationId[];
  /** Content hash of the authoritative value at `toVersion` (see hash.ts). The
   *  client asserts its own value matches once it is at this version with no
   *  pending — a machine-checked convergence/integrity guard (catches a value
   *  that didn't survive the wire/pg round-trip, and gives a future op-patch's
   *  incremental fold a verifier for free). Optional: a patch from a minimal
   *  arbiter (e.g. an early cowboy daemon) may omit it. */
  readonly valueHash?: string;
  apply(prev: T): T;
}

/** What the arbiter emits on every accepted mutation — the single seam for
 *  PERSISTENCE (write `{version, value, valueHash}` to pg) and LOGGING (append
 *  `{version, mutation, valueHash}` to an op-log / VictoriaLogs). The app fills
 *  `onCommit`; the core stays pure + synchronous and never blocks on I/O (do the
 *  write fire-and-forget inside the hook). Storing the DELTA (`mutation`) not the
 *  whole past value is what keeps the log small; `valueHash` lets a reload verify
 *  integrity and lets an AI debugger bisect a divergence by version. */
export interface CommitRecord<T> {
  readonly version: Version;
  readonly value: T;
  readonly valueHash: string;
  readonly mutation: Mutation;
}

/** A serializable snapshot of a CLIENT's local state — the confirmed base + the
 *  still-pending optimistic mutations — for app-side persistence. Restoring it
 *  gives an instant first paint on reload AND survives unconfirmed optimistic
 *  mutations (a durable outbox: they replay + re-send after the reload). All
 *  fields are JSON-plain (pending mutations replay by `name`, so mutator names
 *  are schema — renaming one breaks a persisted snapshot). */
export interface ClientSnapshot<T> {
  readonly base: SyncState<T>;
  readonly pending: readonly Mutation[];
}

/** Pluggable app-side persistence backend (the seam for @shared-utils/sync-idb,
 *  React-Native AsyncStorage, …). Generic over the STORED SHAPE `S`, so it backs
 *  both tiers of the authority spectrum with one implementation:
 *    - the OP-based `replicatedStore` stores `S = ClientSnapshot<T>` (base +
 *      pending = a durable outbox),
 *    - the STATE-based `mirroredStore` stores `S = T` (the whole value, an
 *      instant offline mirror).
 *  The caller calls `save` DEBOUNCED on every change and `load` once on
 *  `hydrate()`; the core never assumes a platform. Async by contract — IndexedDB
 *  and friends are async; a stub in-memory impl satisfies it for tests. */
export interface LocalPersistence<S> {
  load(): Promise<S | null>;
  save(value: S): Promise<void>;
}

/** A PASSIVE remote backend for the state-based `mirroredStore` tier: a dumb
 *  key-value the server just stores + returns (liveview's `settings`/`progress`
 *  tables behind `GET`/`PUT`). Unlike the OP-based arbiter, it does NOT serialize
 *  mutations or assign versions — conflict is resolved client-side by the store's
 *  `reconcile(local, remote)` merge. `subscribe` is optional live invalidation
 *  (e.g. riding a one-way broadcast WebSocket): when the server signals a change,
 *  the store re-reconciles. Everything async; all values JSON-plain. */
export interface RemoteBackend<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  subscribe?(onRemote: (value: T) => void): () => void;
}
