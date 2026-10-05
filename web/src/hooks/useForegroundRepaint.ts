import { useEffect } from "react";

// Repaint the reading scrollers when the app returns from the background. iOS
// WKWebView frees a backgrounded scroller's rasterized content to reclaim
// memory, so on resume the read-along / text column shows BLANK or HALF-painted
// (the content is still in the DOM, just not rasterized) until something forces
// a repaint.
//
// We force it with a SYNCHRONOUS display reflow: hide → read layout → show →
// read layout. It's fully synchronous, so no intermediate frame ever paints
// (no visible blink) and it leaves NO lingering style. Deliberately NOT a
// `transform: translateZ(0)` nudge — that promotes the scroller to a COMPOSITED
// layer, which iOS rasterizes in TILES (only the visible top tile paints → the
// rest stays blank, the "half shown" bug); and if the rAF that removes it is
// deferred during the foreground transition, the tiled layer sticks. A plain
// reflow re-rasterizes in the normal path. Run once now + once next frame (the
// first can fire before the webview has fully foregrounded). Covers both readers
// + the shelf (every `[data-lv-scroller]`); `pageshow` covers a bfcache restore.
export function useForegroundRepaint(): void {
  useEffect(() => {
    const reflow = (el: HTMLElement): void => {
      const top = el.scrollTop;
      el.style.display = "none";
      void el.offsetHeight;
      el.style.display = "";
      void el.offsetHeight;
      if (el.scrollTop !== top) el.scrollTop = top;
    };
    const repaint = (): void => {
      if (document.visibilityState !== "visible") return;
      const els = document.querySelectorAll<HTMLElement>("[data-lv-scroller]");
      els.forEach(reflow);
      requestAnimationFrame(() => els.forEach(reflow));
    };
    document.addEventListener("visibilitychange", repaint);
    window.addEventListener("pageshow", repaint);
    return () => {
      document.removeEventListener("visibilitychange", repaint);
      window.removeEventListener("pageshow", repaint);
    };
  }, []);
}
