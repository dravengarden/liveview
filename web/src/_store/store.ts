// A minimal reactive store: a per-device preference (`persisted`) or a sync
// client (via its `toStore` adapter) implements the same contract. One
// `useStore` hook renders any of them. Framework-agnostic; no React.

/** Read side: a value you can read + subscribe to. `get()` must return a STABLE
 *  reference while unchanged (the useSyncExternalStore requirement). */
export interface ReadableStore<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

/** Read + write. `set` accepts a value or an updater `(prev) => next`. */
export interface Store<T> extends ReadableStore<T> {
  set(next: T | ((prev: T) => T)): void;
}

/** Pluggable string KV backend (default = localStorage). SYNC — meant for small
 *  per-device prefs; for large or async state use the sync engine + sync-idb. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedOpts<T> {
  /** Backend; defaults to `localStorage` (or none, in a non-browser context). */
  storage?: KvStorage;
  serialize?: (value: T) => string;
  deserialize?: (raw: string) => T;
  /** Mirror writes from OTHER tabs via the `storage` event (browser). Default true. */
  crossTab?: boolean;
}

function defaultStorage(): KvStorage | null {
  try {
    // Access can throw in privacy mode / sandboxed iframes.
    return globalThis.localStorage as KvStorage | undefined ?? null;
  } catch {
    return null;
  }
}

/** A persisted, reactive per-device store. Reads the backend on init, writes on
 *  `set`, and (by default) syncs across tabs. Falls back to in-memory when no
 *  storage is available, and to `initial` on any parse error — never throws on a
 *  corrupt value. */
export function persisted<T>(key: string, initial: T, opts: PersistedOpts<T> = {}): Store<T> {
  const storage = opts.storage ?? defaultStorage();
  const serialize = opts.serialize ?? ((v: T): string => JSON.stringify(v));
  const deserialize = opts.deserialize ?? ((s: string): T => JSON.parse(s) as T);
  const listeners = new Set<() => void>();

  const read = (): T => {
    const raw = storage?.getItem(key) ?? null;
    if (raw === null) {
      return initial;
    }
    try {
      return deserialize(raw);
    } catch {
      return initial;
    }
  };

  let value: T = read();
  const emit = (): void => {
    for (const l of listeners) {
      l();
    }
  };

  if ((opts.crossTab ?? true) && typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("storage", (e: StorageEvent) => {
      if (e.key === key) {
        value = read();
        emit();
      }
    });
  }

  return {
    get: (): T => value,
    subscribe: (listener): () => void => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    set: (next): void => {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (Object.is(resolved, value)) {
        return;
      }
      value = resolved;
      storage?.setItem(key, serialize(resolved));
      emit();
    },
  };
}
