// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/sync (shared-utils
// `state-sync-engine` branch); the `@shared-utils/store` import is rewritten to
// the sibling vendored _store. Edit there + re-vendor. See _sync/mod.ts.
//
// Mirrored store — the STATE-BASED (CvRDT) tier of the authority spectrum: a
// local-first reactive value mirrored to a PASSIVE remote (a dumb key-value the
// server just stores + returns). No mutation log, no arbiter — conflict is
// resolved by a `reconcile(local, remote)` MERGE over whole values
// (last-writer-wins by default).
//
// This is the right tier when there is no concurrent multi-writer convergence to
// guarantee — per-account settings / progress that one device edits at a time
// (liveview: audio position/rate/sleep, reading progress, book prefs). For
// concurrent multi-writer state that must converge operationally, use
// `replicatedStore` (the OP-based tier) — the read side (`get`/`subscribe`) is
// identical, so the same `useStore` renders either and a state can be promoted
// from one tier to the other without touching the components.

import type { Store } from "../../_store/mod.ts";
import type { LocalPersistence, RemoteBackend } from "./types.ts";

export type SyncStatus = "connecting" | "live" | "offline";

/** A `Store<T>` whose value is mirrored to a passive remote. Write with `set`
 *  (the state-based dual of `replicatedStore.mutate`). `hydrate` then `connect`
 *  on startup; `flush` on `pagehide`. */
export interface MirroredStore<T> extends Store<T> {
  /** Load the local mirror (this device's last value) for an instant first paint.
   *  Call once BEFORE `connect`. No-op without a `local` backend or stored value. */
  hydrate(): Promise<void>;
  /** Pull the remote, `reconcile` it with the current value, and (if the backend
   *  supports it) subscribe to live remote changes. Idempotent. */
  connect(): void;
  /** Force any debounced local + remote writes out NOW (call on `pagehide`). */
  flush(): Promise<void>;
  /** Stop the live remote subscription started by `connect`. */
  disconnect(): void;
  readonly status: SyncStatus;
}

export interface MirroredOpts<T> {
  initial: T;
  remote: RemoteBackend<T>;
  /** Merge the remote value into local on connect / live update. Default:
   *  remote-wins (`(_local, remote) => remote`). Provide a domain merge for
   *  smarter resolution — e.g. liveview's "adopt the server's audio position only
   *  if it is >8s ahead on the same chapter". MUST be pure. */
  reconcile?: (local: T, remote: T) => T;
  /** Instant offline mirror of the whole value (localStorage/IDB adapter). */
  local?: LocalPersistence<T>;
  /** Remote-write pacing. `debounceMs`: save `ms` after writes settle (reading
   *  progress). `throttleMs`: save at most once per `ms`, trailing (audio
   *  position). Neither: save on every `set`. */
  push?: { debounceMs?: number; throttleMs?: number };
  /** Debounce (ms) for the local mirror save. Default 250. */
  localDebounceMs?: number;
  /** Surface a remote load/save rejection (default: swallow — the local mirror
   *  keeps the app fully usable offline). */
  onError?: (error: unknown) => void;
}

export function mirroredStore<T>(opts: MirroredOpts<T>): MirroredStore<T> {
  const { initial, remote, local } = opts;
  const reconcile = opts.reconcile ?? ((_local: T, r: T): T => r);
  const localDebounceMs = opts.localDebounceMs ?? 250;
  const onError = opts.onError ?? ((): void => {});

  const listeners = new Set<() => void>();
  let value: T = initial;
  let status: SyncStatus = "connecting";
  let unsubscribeRemote: (() => void) | undefined = undefined;

  const emit = (): void => {
    for (const l of listeners) {
      l();
    }
  };
  const setValue = (next: T): void => {
    if (Object.is(next, value)) {
      return;
    }
    value = next;
    emit();
  };

  // Fire-and-forget an async save; a rejection only reaches `onError` (the local
  // mirror keeps the app usable, so a failed remote write must never throw).
  const fireSave = (save: () => Promise<void>): void => {
    void (async (): Promise<void> => {
      try {
        await save();
      } catch (error) {
        onError(error);
      }
    })();
  };

  // --- Remote write pacing (debounce | throttle | immediate) -----------------
  let remoteTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let remoteDirty = false;
  const fireRemoteTimer = (): void => {
    remoteTimer = undefined;
    if (remoteDirty) {
      remoteDirty = false;
      fireSave(() => remote.save(value));
    }
  };
  const scheduleRemote = (): void => {
    remoteDirty = true;
    const debounceMs = opts.push?.debounceMs;
    const throttleMs = opts.push?.throttleMs;
    if (debounceMs !== undefined) {
      if (remoteTimer !== undefined) {
        clearTimeout(remoteTimer);
      }
      remoteTimer = setTimeout(fireRemoteTimer, debounceMs);
      return;
    }
    if (throttleMs !== undefined) {
      // Trailing throttle: first write opens a window; the latest value lands when
      // it closes; writes during the window only re-mark dirty.
      remoteTimer ??= setTimeout(fireRemoteTimer, throttleMs);
      return;
    }
    remoteDirty = false;
    fireSave(() => remote.save(value));
  };

  // --- Local mirror save (debounced) -----------------------------------------
  let localTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let localDirty = false;
  const scheduleLocal = (): void => {
    if (local === undefined) {
      return;
    }
    const backend = local;
    localDirty = true;
    if (localTimer !== undefined) {
      clearTimeout(localTimer);
    }
    localTimer = setTimeout(() => {
      localTimer = undefined;
      localDirty = false;
      fireSave(() => backend.save(value));
    }, localDebounceMs);
  };

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
      emit();
      scheduleLocal();
      scheduleRemote();
    },

    async hydrate(): Promise<void> {
      if (local === undefined) {
        return;
      }
      const cached = await local.load();
      if (cached !== null) {
        setValue(cached); // this device's own last value — adopt directly, no merge
      }
    },

    connect(): void {
      status = "connecting";
      void (async (): Promise<void> => {
        try {
          const r = await remote.load();
          if (r !== null) {
            setValue(reconcile(value, r));
          }
          status = "live";
          unsubscribeRemote ??= remote.subscribe?.((incoming) => {
            setValue(reconcile(value, incoming));
          });
        } catch (error) {
          status = "offline";
          onError(error);
        }
      })();
    },

    disconnect(): void {
      unsubscribeRemote?.();
      unsubscribeRemote = undefined;
    },

    async flush(): Promise<void> {
      if (remoteTimer !== undefined) {
        clearTimeout(remoteTimer);
        remoteTimer = undefined;
      }
      if (remoteDirty) {
        remoteDirty = false;
        try {
          await remote.save(value);
        } catch (error) {
          onError(error);
        }
      }
      if (local !== undefined) {
        if (localTimer !== undefined) {
          clearTimeout(localTimer);
          localTimer = undefined;
        }
        if (localDirty) {
          localDirty = false;
          try {
            await local.save(value);
          } catch (error) {
            onError(error);
          }
        }
      }
    },

    get status(): SyncStatus {
      return status;
    },
  };
}
