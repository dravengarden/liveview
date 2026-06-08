// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/sync (shared-utils
// `state-sync-engine` branch). Edit there + re-vendor. See _sync/mod.ts.
// v1 Patch implementation: a full-snapshot diff. `apply` ignores the previous
// value and returns the absolute value at `toVersion` — so it's idempotent and
// order-independent (a client keeps the highest `toVersion`, making reorder /
// dup / drop trivially convergent). O(state) on the wire; fine while synced
// states are small. A prolly-tree / Merkle op-patch can later implement the same
// `Patch` interface without touching the client/arbiter cores (REQ-3).

import { hashValue } from "../hash.ts";
import type { MutationId, Patch, Version } from "../types.ts";

/** Build a snapshot patch carrying the absolute `value` at `toVersion`. A
 *  snapshot replaces the whole value, so its `fromVersion` is always 0 (absolute
 *  from origin) — the client only consults `toVersion` + `confirmed`. The
 *  `valueHash` is computed here so every snapshot patch is self-verifying. */
export function snapshotPatch<T>(
  toVersion: Version,
  value: T,
  confirmed: readonly MutationId[],
): Patch<T> {
  return {
    fromVersion: 0,
    toVersion,
    confirmed,
    valueHash: hashValue(value),
    apply: (_prev: T): T => value,
  };
}
