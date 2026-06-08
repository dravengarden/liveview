import { persisted, useStore } from "@/_store/mod.ts";

// How the bookshelf is ordered. A UI preference, persisted device-LOCAL like the
// other UI prefs (theme / font / margin / font-size): a `persisted` store over
// localStorage. Cross-tab sync is free (`persisted` mirrors the `storage` event
// by default). Read by the shelf (Landing) and written by Settings. Not synced
// to the server — only reading/playback progress is.
//
//   updated — most-recently added/edited content first (the default)
//   read    — most-recently opened (reading/listening) first
//   added   — most-recently first appeared on the shelf
//   name    — by title, A→Z (locale-aware)

export type ShelfSort = "updated" | "read" | "added" | "name";

const KEY = "lv:shelf-sort";
const DEFAULT: ShelfSort = "updated";
const VALID: ShelfSort[] = ["updated", "read", "added", "name"];

// Coerce a stored value to a valid sort — a corrupt/legacy blob snaps to default
// rather than rendering an unknown order. `persisted`'s deserialize sees the raw
// localStorage string; ours stores a bare enum string (not JSON), so the
// serialize/deserialize pair is identity-with-validation.
const shelfSortStore = persisted<ShelfSort>(KEY, DEFAULT, {
  serialize: (v) => v,
  deserialize: (raw) => (VALID.includes(raw as ShelfSort) ? (raw as ShelfSort) : DEFAULT),
});

export function useShelfSort(): ShelfSort {
  return useStore(shelfSortStore);
}

export function setShelfSort(sort: ShelfSort): void {
  shelfSortStore.set(sort);
}
