import { useEffect } from "react";
import { fetchServerRoot, replicaAppliedRoot } from "@/replica/mod.ts";
import { onChapterReady } from "@/syncStore";
import { rootRefreshDue } from "@/rootRefresh";
import {
  isLiveSocketConnected,
  onLiveSocketReconnect,
  pollTickDue,
} from "@/liveSocket";

// Live shelf refresh (fallback path): a newly-deployed book changes the Merkle
// deploy root, so check /api/root (tiny, plain no-store fetch) at startup, on
// foreground, after a socket reconnect or an audio bake, and on a visible-page
// interval: every tick while the socket is down, only as a slow safety net
// while it is up. The baseline is the root the replica last
// APPLIED, not the server's first answer: a deploy that landed while the app
// was closed must still refresh the replica manifest (chapters are served
// store-first by hash) and the shelf. Runs on every platform. The PRIMARY live
// path is the server's WS `TreeUpdate` broadcast (App's handleTreeUpdate).
export function useShelfRootRefresh(refreshShelf: () => Promise<void>): void {
  useEffect(() => {
    // Fallback baseline when the replica has no applied root (disabled/empty).
    let lastRoot: string | null = null;
    let lastRefreshAt = 0;
    let lastCheckAt = 0;
    let cancelled = false;
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      lastCheckAt = Date.now();
      try {
        const root = await fetchServerRoot();
        if (cancelled || !root) return;
        const applied = (await replicaAppliedRoot()) ?? lastRoot;
        if (!rootRefreshDue(root, applied, lastRefreshAt, Date.now())) return;
        await refreshShelf();
        lastRefreshAt = Date.now();
        lastRoot = root;
      } catch {
        // offline / transient — retry on the next tick or foreground.
      } finally {
        checking = false;
      }
    };
    void check();
    // Hidden pages skip the tick: background audio keeps the native WebView's
    // timers alive, and a refresh there would refetch `/api/dag` mid-playback.
    // The visibilitychange handler below catches up on return.
    const tickMs = 20_000;
    const id = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        pollTickDue(isLiveSocketConnected(), lastCheckAt, Date.now())
      ) void check();
    }, tickMs);
    const checkIfVisible = (): void => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", checkIfVisible);
    // A bake advances the root's epoch (refresh stays coalesced by
    // rootRefreshDue); a backfill bakes every few seconds, so space these
    // probes by one tick. A reconnect may have missed a TreeUpdate.
    const offChapterReady = onChapterReady(() => {
      if (Date.now() - lastCheckAt >= tickMs) checkIfVisible();
    });
    const offReconnect = onLiveSocketReconnect(checkIfVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", checkIfVisible);
      offChapterReady();
      offReconnect();
    };
  }, [refreshShelf]);
}
