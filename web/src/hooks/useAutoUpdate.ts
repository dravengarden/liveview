import { useEffect } from "react";
import { watchForegroundVersion } from "@/connectionStore";

// ─────────────────────────────────────────────────────────────────────────────
// PWA update detection.
//
// Why: an installed iOS home-screen PWA does NOT re-navigate when reopened from
// the app switcher — it resumes the frozen in-memory page, so it keeps running
// the bundle it first cold-started with and never picks up a deploy (the service
// worker also caches hashed assets). Result: fixes ship but the installed app
// stays stale until the user manually reloads.
//
// Fix: each time the app regains the foreground, probe /version; a changed build
// id raises the blue "new version" banner (see connectionStore). The reconnect
// path in useWebSocket probes the same way, so a deploy that restarts the server
// is caught both ways. Unlike the previous silent hard-refresh this never yanks
// the page out from under the reader/listener — the banner waits for a tap.
// ─────────────────────────────────────────────────────────────────────────────

export function useAutoUpdate(): void {
  useEffect(() => watchForegroundVersion(), []);
}
