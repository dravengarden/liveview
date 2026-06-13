import { persisted, useStore } from "@/_store/mod.ts";

// How the bookshelf is grouped. A UI preference, persisted device-LOCAL like the
// other shelf prefs (sort / compact): a `persisted` store over localStorage,
// free cross-tab sync via the `storage` event. Read by the shelf (Landing),
// written by Settings. Not synced to the server.
//
//   none       — one flat masonry (the default)
//   collection — partition the shelf into collapsible per-series sections

export type ShelfGroup = "none" | "collection";

const KEY = "lv:shelf-group";
const DEFAULT: ShelfGroup = "none";
const VALID: ShelfGroup[] = ["none", "collection"];

// Coerce a stored value to a valid grouping — a corrupt/legacy blob snaps to
// default. We store a bare enum string (not JSON), so serialize/deserialize is
// identity-with-validation.
const shelfGroupStore = persisted<ShelfGroup>(KEY, DEFAULT, {
  serialize: (v) => v,
  deserialize: (raw) => (VALID.includes(raw as ShelfGroup) ? (raw as ShelfGroup) : DEFAULT),
});

export function useShelfGroup(): ShelfGroup {
  return useStore(shelfGroupStore);
}

export function setShelfGroup(group: ShelfGroup): void {
  shelfGroupStore.set(group);
}
