// Per-book "save offline" flags (localStorage). Toggling a book on triggers an
// audio prefetch (prefetch.ts → the SW cache); the flag persists so the choice
// sticks across sessions. Text is always cached on open (Lane A); this is the
// opt-in for the heavy audio (Lane B).

import { useSyncExternalStore } from "react";

const PREFIX = "lv-offline-";
const KEY = (slug: string): string => `${PREFIX}${slug}`;

const subs = new Set<() => void>();

function readAll(): Set<string> {
  const out = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && localStorage.getItem(k) === "1") {
        out.add(k.slice(PREFIX.length));
      }
    }
  } catch {
    // private mode / disabled storage
  }
  return out;
}

let snapshot: Set<string> = readAll();
const emit = (): void => {
  snapshot = readAll();
  for (const s of subs) s();
};

export function isSavedOffline(slug: string): boolean {
  return snapshot.has(slug);
}

export function setSavedOffline(slug: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY(slug), "1");
    else localStorage.removeItem(KEY(slug));
  } catch {
    // ignore
  }
  emit();
}

/** Reactive set of slugs the user chose to keep offline. */
export function useSavedOffline(): Set<string> {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}
