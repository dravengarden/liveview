import { useSyncExternalStore } from "react";

// How the bookshelf is ordered. A UI preference, persisted device-LOCAL like the
// other UI prefs (theme / font / margin / font-size): localStorage + a change
// event, via useSyncExternalStore. Read by the shelf (Landing) and written by
// Settings. Not synced to the server — only reading/playback progress is.
//
//   updated — most-recently added/edited content first (the default)
//   read    — most-recently opened (reading/listening) first
//   added   — most-recently first appeared on the shelf
//   name    — by title, A→Z (locale-aware)

export type ShelfSort = "updated" | "read" | "added" | "name";

const KEY = "lv:shelf-sort";
const EVENT = "lv:shelf-sort-change";
const DEFAULT: ShelfSort = "updated";
const VALID: ShelfSort[] = ["updated", "read", "added", "name"];

function read(): ShelfSort {
  const v = globalThis.localStorage?.getItem(KEY);
  return VALID.includes(v as ShelfSort) ? (v as ShelfSort) : DEFAULT;
}

let snapshot: ShelfSort = read();

function subscribe(onChange: () => void): () => void {
  const handler = (): void => {
    snapshot = read();
    onChange();
  };
  globalThis.addEventListener?.(EVENT, handler);
  globalThis.addEventListener?.("storage", handler); // other tabs
  return () => {
    globalThis.removeEventListener?.(EVENT, handler);
    globalThis.removeEventListener?.("storage", handler);
  };
}

export function useShelfSort(): ShelfSort {
  return useSyncExternalStore(subscribe, () => snapshot, () => DEFAULT);
}

export function setShelfSort(sort: ShelfSort): void {
  globalThis.localStorage?.setItem(KEY, sort);
  // dispatchEvent runs listeners synchronously, so `snapshot` is refreshed
  // before this returns — the caller's next render sees the new value.
  globalThis.dispatchEvent?.(new Event(EVENT));
}
