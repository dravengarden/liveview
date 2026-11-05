// Contracts the mirrored store is persisted and synchronized through.

/** Device-local persistence for a mirrored store's value (IndexedDB via
 *  _sync-idb, or an in-memory stub in tests). The store calls `save` debounced
 *  on every change and `load` once on `hydrate()`. Async by contract. */
export interface LocalPersistence<S> {
  load(): Promise<S | null>;
  save(value: S): Promise<void>;
}

/** A PASSIVE remote backend for the state-based `mirroredStore` tier: a dumb
 *  key-value the server just stores + returns (liveview's `settings`/`progress`
 *  tables behind `GET`/`PUT`). It does not serialize mutations or assign
 *  versions; conflict is resolved client-side by the store's
 *  `reconcile(local, remote)` merge. `subscribe` is optional live invalidation
 *  (e.g. riding a one-way broadcast WebSocket): when the server signals a change,
 *  the store re-reconciles. Everything async; all values JSON-plain. */
export interface RemoteBackend<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  subscribe?(onRemote: (value: T) => void): () => void;
}
