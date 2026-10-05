import { type RefObject, useCallback, useEffect, useRef } from "react";

/** Scroll gestures owned by the app chrome: the bottom bar's jump-to-end and
 *  the iOS status-bar tap-to-top. */
export function useStatusBarScroll(): {
  scrollReaderBottom: () => void;
  statusBarTapRef: RefObject<HTMLDivElement | null>;
} {
  // Tap the BOTTOM nav bar's title to jump the reader to the BOTTOM (the bar sits
  // at the bottom, so down-to-the-end is the spatially natural direction; the
  // scroll-to-top FAB owns the other direction). The reader's scroll container is
  // the one tagged `data-lv-scroller="reader"` (MarkdownViewer / AudiobookPlayer);
  // query it lazily so a chapter remount (which swaps the node) never leaves a
  // stale ref.
  const scrollReaderBottom = useCallback(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-lv-scroller="reader"]',
    );
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);
  // Scroll whichever view is showing back to the top. Every scrollable view
  // tags its container `data-lv-scroller` (the shelf, and the book/audiobook
  // reader), so scrolling them all is safe — the hidden one is a no-op. Drives
  // the status-bar tap target below.
  const scrollAllTop = useCallback(() => {
    for (
      const el of document.querySelectorAll<HTMLElement>("[data-lv-scroller]")
    ) {
      el.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);
  // Wire the status-bar tap target (below) with NATIVE pointer events, not React
  // onClick: iOS WKWebView (standalone PWA / Tauri shell) does NOT reliably
  // deliver a synthetic `click` to a non-interactive div even with the
  // cursor:pointer heuristic — the status-bar tap-to-top silently no-op'd there
  // (the reported "tapping the top does nothing"). A real pointerdown→pointerup
  // tap, slop-gated (the same recogniser the figure lightbox uses, which is
  // verified to fire on iOS), is reliable. Bound to the element via a ref.
  const statusBarTapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = statusBarTapRef.current;
    if (!el) {
      return undefined;
    }
    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let tap = false;
    const travel = (e: PointerEvent): number =>
      Math.hypot(e.clientX - startX, e.clientY - startY);
    const down = (e: PointerEvent): void => {
      startX = e.clientX;
      startY = e.clientY;
      startedAt = e.timeStamp;
      tap = true;
    };
    const move = (e: PointerEvent): void => {
      if (tap && travel(e) > 12) tap = false;
    };
    const up = (e: PointerEvent): void => {
      if (tap && e.timeStamp - startedAt <= 700 && travel(e) <= 12) {
        scrollAllTop();
      }
      tap = false;
    };
    const cancel = (): void => {
      tap = false;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
    };
  }, [scrollAllTop]);
  return { scrollReaderBottom, statusBarTapRef };
}
