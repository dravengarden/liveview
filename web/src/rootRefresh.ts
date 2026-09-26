/** The server reports the manifest root as `<merkle-root>` or
 *  `<merkle-root>.<epoch>`; the epoch moves whenever background audio baking
 *  lands, which during a large backfill can happen every few seconds. A deploy
 *  (new Merkle root) must refresh immediately, but an epoch-only move is
 *  coalesced so the ~MB `/api/dag` refetch and apply don't run on every poll. */
export const EPOCH_REFRESH_INTERVAL_MS = 5 * 60_000;

function merklePart(root: string): string {
  const dot = root.indexOf(".");
  return dot === -1 ? root : root.slice(0, dot);
}

/** Whether a root poll should trigger a replica/shelf refresh. */
export function rootRefreshDue(
  server: string,
  applied: string | null,
  lastRefreshAt: number,
  now: number,
): boolean {
  if (server === applied) return false;
  if (applied === null || merklePart(server) !== merklePart(applied)) return true;
  return now - lastRefreshAt >= EPOCH_REFRESH_INTERVAL_MS;
}
