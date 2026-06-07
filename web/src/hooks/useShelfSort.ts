import { useSyncExternalStore } from "react";
import { getServerSettings, putServerSetting } from "@/serverSettings";

// How the bookshelf is ordered. A library-wide preference, persisted exactly
// like the other UI prefs (theme / font / margin / language): localStorage is
// the offline cache + first-paint source, and the server (/api/settings) is the
// cross-device truth that's reconciled once on load. A change event keeps the
// useSyncExternalStore subscribers (the shelf + the Settings control) in sync.
//
//   updated — most-recently added/edited content first (the default)
//   read    — most-recently opened (reading/listening) first
//   added   — most-recently first appeared on the shelf
//   name    — by title, A→Z (locale-aware)

export type ShelfSort = "updated" | "read" | "added" | "name";

const KEY = "lv:shelf-sort";
const SETTING_KEY = "ui.shelfSort";
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

// Reconcile to the cross-device server value once per load. getServerSettings()
// is memoized, so this shares the single GET the other hooks already issue. Only
// apply a present + valid value that differs from what we have locally; write
// straight to localStorage (not setShelfSort) so we don't re-PUT what we read.
void getServerSettings().then((s) => {
  const v = s[SETTING_KEY];
  if (VALID.includes(v as ShelfSort) && v !== read()) {
    globalThis.localStorage?.setItem(KEY, v as string);
    globalThis.dispatchEvent?.(new Event(EVENT));
  }
});

export function useShelfSort(): ShelfSort {
  return useSyncExternalStore(subscribe, () => snapshot, () => DEFAULT);
}

export function setShelfSort(sort: ShelfSort): void {
  globalThis.localStorage?.setItem(KEY, sort);
  putServerSetting(SETTING_KEY, sort);
  // dispatchEvent runs listeners synchronously, so `snapshot` is refreshed
  // before this returns — the caller's next render sees the new value.
  globalThis.dispatchEvent?.(new Event(EVENT));
}
