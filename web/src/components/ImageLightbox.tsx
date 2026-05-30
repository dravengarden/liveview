import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface GalleryImage {
  src: string;
  alt: string;
}

interface ImageLightboxProps {
  /** All zoomable images in the current document, in reading order. */
  images: GalleryImage[];
  /** Index of the open image, or `null` to keep the lightbox closed. */
  index: number | null;
  /** Request a different image (prev/next, swipe, arrow keys). */
  onIndex: (index: number) => void;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 6;
// Vertical drag (at 1x) past this many px releases into a dismiss.
const DISMISS_THRESHOLD = 110;
// Horizontal drag (at 1x) past this many px flips to the prev/next image.
const SWIPE_NAV_THRESHOLD = 70;
// Pointer travel below this (px) counts as a tap, not a drag.
const TAP_SLOP = 8;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Fullscreen image gallery with zoom + pan, driven by pointer events so the
 * same code path serves mouse, touch, and pen:
 *
 *   - wheel / pinch         → zoom toward the cursor / pinch midpoint
 *   - double click / tap    → toggle between fit and DOUBLE_TAP_SCALE
 *   - drag (zoomed in)      → pan
 *   - drag sideways (at fit)→ previous / next image
 *   - drag down (at fit)    → swipe-to-dismiss, backdrop fades with distance
 *   - ← / → arrows          → previous / next image
 *   - backdrop tap / Esc / ✕→ close
 *
 * The live transform is mutated on refs and written straight to the element's
 * style during a gesture (no React re-render per frame); React state only
 * gates which image is shown via `index`.
 */
export function ImageLightbox({
  images,
  index,
  onIndex,
  onClose,
}: ImageLightboxProps): React.JSX.Element | null {
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

  const open = index !== null && index >= 0 && index < images.length;
  const current = open ? images[index] : undefined;
  const src = current?.src ?? null;
  const canPrev = open && index > 0;
  const canNext = open && index < images.length - 1;

  const goPrev = useCallback(() => {
    if (index !== null && index > 0) onIndex(index - 1);
  }, [index, onIndex]);
  const goNext = useCallback(() => {
    if (index !== null && index < images.length - 1) onIndex(index + 1);
  }, [index, images.length, onIndex]);

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

  // New image (open or navigation) → reset the view.
  useEffect(() => {
    if (src) reset();
  }, [src, reset]);

  // Lock body scroll + key shortcuts while open.
  useEffect(() => {
    if (!open) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, goPrev, goNext]);

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

  // Button zoom: step toward the viewport centre (mouse users who don't think
  // to scroll-to-zoom, and a visible affordance on touch).
  const zoomBy = useCallback(
    (factor: number) => {
      zoomAt(factor, window.innerWidth / 2, window.innerHeight / 2, true);
    },
    [zoomAt],
  );

  // Wheel zoom (passive:false so we can preventDefault the page scroll).
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !open) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    return () => img.removeEventListener("wheel", onWheel);
  }, [open, src, zoomAt]);

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
        // At fit: follow the finger on both axes. The release handler decides
        // whether the dominant axis means navigate (horizontal) or dismiss
        // (vertical). Only vertical travel fades the backdrop.
        tf.current.x = e.clientX - st.startX;
        tf.current.y = e.clientY - st.startY;
        applyTransform();
        setBackdrop(0.92 * (1 - Math.min(1, Math.abs(tf.current.y) / 400)));
      }
    },
    [zoomAt, applyTransform, setBackdrop],
  );

  const onPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size > 0) return; // still pinching
      const st = g.current;

      if (tf.current.scale <= 1) {
        const { x, y } = tf.current;
        // Horizontal swipe wins when it dominates → previous / next image.
        if (Math.abs(x) > Math.abs(y) && Math.abs(x) > SWIPE_NAV_THRESHOLD) {
          const moved = x > 0 ? canPrev : canNext;
          if (moved) {
            if (x > 0) goPrev();
            else goNext();
            return; // index change resets the view
          }
          reset(true); // at an end — rubber-band back
          return;
        }
        // Vertical drag far enough → dismiss.
        if (Math.abs(y) > DISMISS_THRESHOLD) {
          onClose();
          return;
        }
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

      // A short drag that didn't dismiss / navigate → snap back to fit.
      if (tf.current.scale <= 1) reset(true);
    },
    [onClose, reset, zoomAt, canPrev, canNext, goPrev, goNext],
  );

  if (!open || !current) return null;

  return createPortal(
    <div
      ref={overlayRef}
      onClick={(e) => {
        // Clicks landing on the backdrop (not the image / controls) close.
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
      <button type="button" aria-label="Close" onClick={onClose} style={closeBtnStyle}>
        ✕
      </button>

      {images.length > 1 ? (
        <>
          <button
            type="button"
            aria-label="Previous image"
            onClick={goPrev}
            disabled={!canPrev}
            style={navBtnStyle("left", canPrev)}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next image"
            onClick={goNext}
            disabled={!canNext}
            style={navBtnStyle("right", canNext)}
          >
            ›
          </button>
        </>
      ) : null}

      {/* Visible zoom controls — pinch/wheel/double-tap still work, but a
          mouse user on desktop needs an obvious affordance. */}
      <div style={zoomGroupStyle}>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.5)} style={zoomBtnStyle}>
          −
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.5)} style={zoomBtnStyle}>
          +
        </button>
      </div>

      <img
        ref={imgRef}
        src={current.src}
        alt={current.alt}
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
          // The backdrop is always near-black (independent of theme), so the
          // same light plate the inline figures get in dark mode (see
          // markdown.css) is applied here unconditionally: white-bg diagrams
          // would glare and transparent line art would vanish on black. Photos
          // just gain a thin frame. (Per-figure theming — plate only diagrams,
          // not photos — is the diagram-polish follow-up.)
          backgroundColor: "#ffffff",
          padding: "0.5rem",
          borderRadius: "6px",
          boxSizing: "border-box",
        }}
      />

      {(current.alt || images.length > 1) ? (
        <div style={captionStyle}>
          {current.alt ? <span>{current.alt}</span> : null}
          {images.length > 1 ? (
            <span style={{ opacity: 0.7 }}>
              {index + 1} / {images.length}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

const closeBtnStyle: React.CSSProperties = {
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
};

function navBtnStyle(side: "left" | "right", enabled: boolean): React.CSSProperties {
  return {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    [side]: "12px",
    width: 48,
    height: 48,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 34,
    lineHeight: 1,
    color: "#fff",
    background: "rgba(0, 0, 0, 0.35)",
    border: "none",
    borderRadius: "50%",
    cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.25,
    zIndex: 1,
  };
}

const zoomGroupStyle: React.CSSProperties = {
  position: "absolute",
  right: "12px",
  bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
  display: "flex",
  gap: 8,
  zIndex: 1,
};

const zoomBtnStyle: React.CSSProperties = {
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
};

const captionStyle: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
  transform: "translateX(-50%)",
  maxWidth: "min(90%, 720px)",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 14px",
  borderRadius: 999,
  background: "rgba(0, 0, 0, 0.5)",
  color: "#fff",
  fontSize: 13,
  lineHeight: 1.4,
  textAlign: "center",
  pointerEvents: "none",
  zIndex: 1,
};
