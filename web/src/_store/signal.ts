// A typed in-process notification: one emitter, any number of subscribers.
// App modules import the signal they depend on instead of agreeing on a
// `window` event name, so the coupling is visible to the type checker and to
// `rg`. Framework-agnostic; no React, no DOM.

export interface Signal<T = void> {
  /** Notify every current subscriber, synchronously, in subscription order. */
  emit(value: T): void;
  /** Subscribe; returns the unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
}

export function createSignal<T = void>(): Signal<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    emit(value) {
      // Iterate a snapshot so a listener may unsubscribe (itself or another)
      // while the signal is being delivered.
      for (const listener of [...listeners]) listener(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
