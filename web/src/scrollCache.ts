import type { ProgressEntry } from "./types/index.ts";

/** Merge server rows into the local scroll cache without regressing a newer
 *  local position. A row older than this device's last write for that path is
 *  stale: its debounced write may not have landed yet, or it is queued offline
 *  while the read came from the last-good cache. */
export function seedScrollCache(
  ratios: Map<string, number>,
  writtenAt: ReadonlyMap<string, number>,
  rows: readonly ProgressEntry[],
): void {
  for (const r of rows) {
    if ((writtenAt.get(r.path) ?? -Infinity) > r.updated_at) continue;
    ratios.set(r.path, r.scroll);
  }
}
