import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ImageLightboxProps {
  /** Image URL to display. `null` keeps the lightbox closed. */
  src: string | null;
  alt: string;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 6;
// Vertical drag (at 1x) past this many px releases into a dismiss.
const DISMISS_THRESHOLD = 110;
// Pointer travel below this (px) counts as a tap, not a drag.
const TAP_SLOP = 8;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Fullscreen image preview with zoom + pan, driven by pointer events so the
 * same code path serves mouse, touch, and pen:
 *
 *   - wheel / pinch        → zoom toward the cursor / pinch midpoint
 *   - double click / tap   → toggle between fit and DOUBLE_TAP_SCALE
 *   - drag (zoomed in)     → pan
 *   - drag down (at fit)   → swipe-to-dismiss, backdrop fades with distance
 *   - backdrop tap / Esc / ✕ → close
 *
 * The live transform is mutated on refs and written straight to the element's
 * style during a gesture (no React re-render per frame); React state only
 * gates mount/unmount via `src`.
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps): React.JSX.Element | null {
  const overlayRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Live transform, applied imperatively for 60fps gestures.
  const tf = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef({
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: 0,
    pinchDist: 0,
    pinchScale: 1,
    lastTapTime: 0,
  });

  const applyTransform = useCallback((animate = false) => {
    const img = imgRef.current;
    if (!img) return;
    const { scale, x, y } = tf.current;
    img.style.transition = animate ? "transform 0.22s ease" : "none";
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    img.style.cursor = scale > 1 ? "grab" : "zoom-out";
  }, []);

  const setBackdrop = useCallback((dimAlpha: number) => {
    const o = overlayRef.current;
    if (o) o.style.backgroundColor = `rgba(0, 0, 0, ${dimAlpha})`;
  }, []);

  const reset = useCallback(
    (animate = false) => {
      tf.current = { scale: 1, x: 0, y: 0 };
      applyTransform(animate);
      setBackdrop(0.92);
    },
    [applyTransform, setBackdrop],
  );

  // New image → reset view.
  useEffect(() => {
    if (src) reset();
  }, [src, reset]);

  // Lock body scroll + Esc-to-close while open.
  useEffect(() => {
    if (!src) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [src, onClose]);

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  // Zoom by `factor` keeping the viewport point (cx, cy) stationary.
  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number, animate = false) => {
      const img = imgRef.current;
      if (!img) return;
      const prev = tf.current.scale;
      const next = clamp(prev * factor);
      if (next === prev) return;
      const rect = img.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const ratio = next / prev;
      tf.current.x += (cx - centerX) * (1 - ratio);
      tf.current.y += (cy - centerY) * (1 - ratio);
      tf.current.scale = next;
      if (next === MIN_SCALE) {
        tf.current.x = 0;
        tf.current.y = 0;
      }
      applyTransform(animate);
    },
    [applyTransform],
  );

  // Wheel zoom (passive:false so we can preventDefault the page scroll).
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !src) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    return () => img.removeEventListener("wheel", onWheel);
  }, [src, zoomAt]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLImageElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    if (pointers.current.size === 1) {
      st.startX = st.lastX = e.clientX;
      st.startY = st.lastY = e.clientY;
      st.moved = 0;
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        st.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        st.pinchScale = tf.current.scale;
      }
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const st = g.current;

      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        if (a && b && st.pinchDist > 0) {
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          const target = clamp((st.pinchScale * dist) / st.pinchDist);
          zoomAt(target / tf.current.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
        }
        return;
      }

      const dx = e.clientX - st.lastX;
      const dy = e.clientY - st.lastY;
      st.lastX = e.clientX;
      st.lastY = e.clientY;
      st.moved += Math.abs(dx) + Math.abs(dy);

      if (tf.current.scale > 1) {
        // Pan the zoomed image.
        tf.current.x += dx;
        tf.current.y += dy;
        applyTransform();
      } else {
        // Swipe-to-dismiss: follow the finger, fade the backdrop.
        const totalY = e.clientY - st.startY;
        tf.current.y = totalY;
        tf.current.x = (e.clientX - st.startX) * 0.4;
        applyTransform();
        setBackdrop(0.92 * (1 - Math.min(1, Math.abs(totalY) / 400)));
      }
    },
    [zoomAt, applyTransform, setBackdrop],
  );

  const onPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size > 0) return; // still pinching
      const st = g.current;

      // Dismiss when a fit-scale drag travelled far enough.
      if (tf.current.scale <= 1 && Math.abs(tf.current.y) > DISMISS_THRESHOLD) {
        onClose();
        return;
      }

      if (st.moved < TAP_SLOP) {
        // Tap: double-tap toggles zoom; a lone tap on the image is ignored
        // (backdrop taps close — see the overlay handler).
        const now = Date.now();
        if (now - st.lastTapTime < DOUBLE_TAP_MS) {
          st.lastTapTime = 0;
          if (tf.current.scale > 1) reset(true);
          else zoomAt(DOUBLE_TAP_SCALE, e.clientX, e.clientY, true);
        } else {
          st.lastTapTime = now;
        }
        return;
      }

      // A short drag that didn't dismiss → snap back to fit.
      if (tf.current.scale <= 1) reset(true);
    },
    [onClose, reset, zoomAt],
  );

  if (!src) return null;

  return createPortal(
    <div
      ref={overlayRef}
      onClick={(e) => {
        // Clicks landing on the backdrop (not the image) close.
        if (e.target === overlayRef.current) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        backgroundColor: "rgba(0, 0, 0, 0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        touchAction: "none",
        animation: "liveview-lightbox-in 0.18s ease",
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 0px) + 12px)",
          right: "12px",
          width: 44,
          height: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 26,
          lineHeight: 1,
          color: "#fff",
          background: "rgba(0, 0, 0, 0.35)",
          border: "none",
          borderRadius: "50%",
          cursor: "pointer",
          zIndex: 1,
        }}
      >
        ✕
      </button>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          cursor: "zoom-out",
          willChange: "transform",
        }}
      />
    </div>,
    document.body,
  );
}
