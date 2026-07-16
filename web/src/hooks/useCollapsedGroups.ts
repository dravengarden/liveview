import { persisted, useStore } from "@/_store/mod.ts";

// Which shelf groups (series sections) are collapsed. A UI preference, persisted
// device-LOCAL like the other shelf prefs (sort / compact / group): a
// `persisted` store over localStorage, free cross-tab sync via the `storage`
// event. Read + written by the shelf (Landing) as the user folds/unfolds
// sections. Not synced to the server.
//
// Stored as a JSON string array of group names; callers see a Set for cheap
// membership tests. A corrupt/legacy blob reads as the empty set (nothing
// collapsed) rather than throwing.

const KEY = "lv:shelf-collapsed";

const collapsedGroupsStore = persisted<ReadonlySet<string>>(KEY, new Set(), {
  serialize: (v) => JSON.stringify([...v]),
  deserialize: (raw) => {
    try {
      const arr = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  },
});

export function useCollapsedGroups(): Set<string> {
  return new Set(useStore(collapsedGroupsStore));
}

/** Flip a group's collapsed membership (collapsed → expanded and back). */
export function toggleGroupCollapsed(name: string): void {
  const next = new Set(collapsedGroupsStore.get());
  if (next.has(name)) next.delete(name);
  else next.add(name);
  collapsedGroupsStore.set(next);
}

/** Set several groups to the same folded state while preserving groups outside
 * the supplied scope. This lets filtered shelf views provide predictable bulk
 * actions without silently changing series that are currently hidden. */
export function setGroupsCollapsed(
  names: Iterable<string>,
  collapsed: boolean,
): void {
  const next = new Set(collapsedGroupsStore.get());
  for (const name of names) {
    if (collapsed) next.add(name);
    else next.delete(name);
  }
  collapsedGroupsStore.set(next);
}
