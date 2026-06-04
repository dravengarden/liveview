import { useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Screen Wake Lock — keep the display awake while reading.
//
// Why: a reader stares at a chapter for minutes without touching the screen, so
// iOS auto-lock dims/locks it mid-paragraph. The Screen Wake Lock API holds the
// display on while `active`. iOS releases the lock whenever the page is hidden
// (screen lock / tab switch / backgrounding), so we re-acquire on
// visibilitychange→visible. Works in iOS/iPadOS standalone home-screen PWAs as
// of 18.4 (WebKit bug 254545); a silent no-op on browsers/OSes without it or
// when denied (e.g. Low Power Mode).
// ─────────────────────────────────────────────────────────────────────────────

export function useWakeLock(active: boolean): void {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return undefined;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      if (cancelled || lockRef.current) return;
      if (document.visibilityState !== "visible") return;
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void sentinel.release().catch(() => {});
          return;
        }
        lockRef.current = sentinel;
        // The lock auto-releases when the page hides; drop our ref so the
        // visibility handler re-acquires on return.
        sentinel.addEventListener("release", () => {
          lockRef.current = null;
        });
      } catch {
        // Unsupported / denied — non-fatal.
      }
    };

    const onVisible = (): void => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      const sentinel = lockRef.current;
      lockRef.current = null;
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, [active]);
}
