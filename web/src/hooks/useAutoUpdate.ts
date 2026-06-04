import { useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// PWA auto-update.
//
// Why: an installed iOS home-screen PWA does NOT re-navigate when reopened from
// the app switcher — it resumes the frozen in-memory page, so it keeps running
// the bundle it first cold-started with and never picks up a deploy (the service
// worker also caches hashed assets). Result: fixes ship but the installed app
// stays stale until the user manually deletes + re-adds it.
//
// Fix: each time the app regains the foreground, compare the hashed main bundle
// this page is running against the one the server's current index.html points
// at. A mismatch means a newer build is live → hard-refresh into it (drop every
// cache first so the service worker can't re-serve the stale bundle). Deferred
// while audio is playing so a refresh never cuts off listening; it fires the
// moment playback stops.
// ─────────────────────────────────────────────────────────────────────────────

/** Filename of the hashed entry chunk this running page was served with. */
function runningBundle(): string | null {
  const el = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="/assets/index-"]'
  );
  const src = el?.getAttribute("src");
  return src ? (src.split("/").pop() ?? null) : null;
}

/** Filename of the entry chunk the server's current index.html references. */
async function deployedBundle(): Promise<string | null> {
  try {
    // no-store so we read the live index, never a cached copy.
    const res = await fetch("/index.html", { cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/src="([^"]*\/assets\/index-[^"]+\.js)"/);
    return m?.[1] ? (m[1].split("/").pop() ?? null) : null;
  } catch {
    return null;
  }
}

/** Hard-refresh into the new bundle: clear every cache (so the SW can't re-serve
 *  the old one), then reload. Even without the cache wipe a reload would get
 *  fresh code (network-first navigation + content-hashed assets), but the wipe
 *  makes "must force-refresh" unconditional. */
async function hardRefresh(): Promise<void> {
  try {
    if ("caches" in globalThis) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // non-fatal — the reload below still pulls fresh hashed assets.
  }
  globalThis.location.reload();
}

/** Auto-update the installed PWA when a newer bundle is deployed. `playing`
 *  defers the refresh until audio stops so listening is never interrupted. */
export function useAutoUpdate(playing: boolean): void {
  const running = useRef<string | null>(runningBundle());
  const pending = useRef(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      if (document.visibilityState !== "visible") return;
      const latest = await deployedBundle();
      if (cancelled || !latest || !running.current) return;
      if (latest === running.current) return; // already on the latest build
      if (playingRef.current) {
        pending.current = true; // defer — don't cut off playback
        return;
      }
      await hardRefresh();
    };
    const onVisible = (): void => void check();
    document.addEventListener("visibilitychange", onVisible);
    void check(); // also check once on mount
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // A deploy detected mid-playback refreshes the instant playback stops.
  useEffect(() => {
    if (!playing && pending.current) void hardRefresh();
  }, [playing]);
}
