import { useEffect, useRef } from "react";

/** Width of the leading-edge strip that belongs to the back gesture. The
 *  spatial drawer leaves this strip alone while it is closed. */
export const EDGE_BACK_WIDTH = 28;
const COMMIT_DISTANCE = 70;
const DECIDE_DISTANCE = 12;

/** A fixed element at modal z-index (lightbox, sheet) owns its own gestures. */
function inOverlay(el: Element | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const s = globalThis.getComputedStyle(n);
    if (s.position === "fixed" && Number(s.zIndex) >= 1250) return true;
  }
  return false;
}

/**
 * iOS-style back swipe for surfaces without a browser one (standalone PWA,
 * native shell): a touch that starts within the leading edge strip and
 * travels right past the commit distance, more horizontally than vertically,
 * calls `onBack`. Listeners are passive, so vertical scrolling is never
 * blocked.
 */
export function useEdgeBackGesture(enabled: boolean, onBack: () => void): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!enabled) return undefined;
    let sx = 0;
    let sy = 0;
    let tracking = false;
    let horizontal = false;
    let decided = false;
    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (!t || t.clientX > EDGE_BACK_WIDTH || inOverlay(e.target as Element)) return;
      sx = t.clientX;
      sy = t.clientY;
      tracking = true;
      decided = false;
      horizontal = false;
    };
    const onMove = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (!tracking || !t) return;
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (!decided && (Math.abs(dx) > DECIDE_DISTANCE || Math.abs(dy) > DECIDE_DISTANCE)) {
        decided = true;
        horizontal = dx > 0 && Math.abs(dx) > Math.abs(dy);
        // A vertical scroll: let it go.
        if (!horizontal) tracking = false;
      }
    };
    const onEnd = (e: TouchEvent): void => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (horizontal && dx > COMMIT_DISTANCE && Math.abs(dx) > Math.abs(dy)) onBackRef.current();
    };
    const opts = { passive: true } as const;
    globalThis.addEventListener("touchstart", onStart, opts);
    globalThis.addEventListener("touchmove", onMove, opts);
    globalThis.addEventListener("touchend", onEnd, opts);
    globalThis.addEventListener("touchcancel", onEnd, opts);
    return () => {
      globalThis.removeEventListener("touchstart", onStart);
      globalThis.removeEventListener("touchmove", onMove);
      globalThis.removeEventListener("touchend", onEnd);
      globalThis.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled]);
}
