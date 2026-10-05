import { useCallback, useEffect, useRef, useState } from "react";
import { contentFetch } from "./native-sync.ts";
import { cacheReplicaMetadata } from "./replica/mod.ts";
import { remoteUrl } from "./apiBase.ts";
import {
  isLiveSocketConnected,
  onLibraryUpdate,
  onLiveSocketReconnect,
  pollTickDue,
} from "./liveSocket.ts";

import type { UserLibrary } from "./libraryOrganization.ts";
export {
  directoryAncestors,
  directoryPath,
  directoryTree,
} from "./libraryOrganization.ts";
export type LibraryOperation =
  | { op: "create"; id: string; name: string; parent: string | null }
  | { op: "rename"; id: string; name: string }
  | { op: "move_directory"; id: string; parent: string | null }
  | { op: "delete"; id: string }
  | { op: "place"; slug: string; directory: string | null };

/** Metadata reads use the replica; mutations require an acknowledged server revision. */
export function useUserLibrary(): {
  library: UserLibrary | null;
  error: string;
  busy: boolean;
  change: (operations: LibraryOperation[]) => Promise<boolean>;
  undo: (() => Promise<boolean>) | null;
} {
  const [library, setLibrary] = useState<UserLibrary | null>(null);
  const [error, setError] = useState("");
  const [undoRevision, setUndoRevision] = useState<number | null>(null);
  const acknowledgedRevision = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const lastRefreshAt = useRef(0);
  const refresh = useCallback(async () => {
    lastRefreshAt.current = Date.now();
    try {
      const response = await contentFetch("/api/library", { fresh: true });
      if (!response.ok) throw new Error("Library organization unavailable");
      const next: UserLibrary = await response.json();
      if (
        acknowledgedRevision.current !== null &&
        next.revision > acknowledgedRevision.current
      ) setUndoRevision(null);
      acknowledgedRevision.current = Math.max(
        acknowledgedRevision.current ?? 0,
        next.revision,
      );
      setLibrary((previous) =>
        previous && previous.revision >= next.revision ? previous : next
      );
    } catch { /* Keep the last acknowledged tree during an outage. */ }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    globalThis.addEventListener("focus", onFocus);
    // The server pushes `LibraryUpdate` on every organization write, so a
    // connected socket needs only the slow safety-net poll; refetch on a push
    // that is newer than what this client already acknowledged, and after a
    // reconnect that may have missed one.
    const offPush = onLibraryUpdate((revision) => {
      if (revision > (acknowledgedRevision.current ?? -1)) void refresh();
    });
    const offReconnect = onLiveSocketReconnect(onFocus);
    const timer = globalThis.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        pollTickDue(isLiveSocketConnected(), lastRefreshAt.current, Date.now())
      ) void refresh();
    }, 30000);
    return () => {
      globalThis.removeEventListener("focus", onFocus);
      offPush();
      offReconnect();
      globalThis.clearInterval(timer);
    };
  }, [refresh]);
  const mutate = async (
    operations: LibraryOperation[],
    undo_revision?: number,
  ): Promise<boolean> => {
    if (!library || busy) return false;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(remoteUrl("/api/library"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: library.revision,
          operations,
          undo_revision,
        }),
      });
      if (!response.ok) {
        if (response.status === 409) await refresh();
        throw new Error(await response.text());
      }
      const next: UserLibrary = await response.json();
      await cacheReplicaMetadata("/api/library", next);
      if ((acknowledgedRevision.current ?? 0) <= next.revision) {
        acknowledgedRevision.current = next.revision;
        setUndoRevision(undo_revision === undefined ? library.revision : null);
      }
      setLibrary((previous) =>
        previous && previous.revision > next.revision ? previous : next
      );
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    library,
    error,
    busy,
    change: (operations) => mutate(operations),
    undo: undoRevision === null ? null : () => mutate([], undoRevision),
  };
}
