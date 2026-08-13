// Pointer/zoom/pan machinery for <ImageLightbox>, split out so the component
// file stays small and each function stays well under the line caps. All state
// is imperative (refs written straight to the DOM for 60fps gestures); the only
// React surface is the handlers this hook returns.

import { type RefObject, useCallback, useEffect, useRef } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 6;
// Vertical drag (at 1x) past this many px releases into a dismiss.
const DISMISS_THRESHOLD = 110;
// Horizontal drag (at 1x) past this many px flips to the prev/next image.
const SWIPE_NAV_THRESHOLD = 70;
// Pointer PATH travel below this (px) counts as a tap, not a drag.
const TAP_SLOP = 8;
// …but a thumb tap on a phone often jitters well past 8px of total path while
// ending within a few px of where it started. So ALSO treat a release whose NET
// displacement (start→end) is below this as a tap — otherwise an imprecise tap
// on the backdrop falls through to "short drag → snap back" and never closes.
// Generous on purpose: a docs figure viewer is modal-like, so users expect a
// backdrop tap to dismiss even when their thumb rolls a fair bit; a deliberate
// drag (nav >70px, dismiss >110px) is still well clear of this.
const TAP_NET_SLOP = 44;
// Apple reserves double tap for zooming. A single image tap is intentionally a
// no-op so a finger lifted after inspecting/panning can never collapse the view.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 32;
const TAP_ZOOM_SCALE = 2.5;
const EDGE_RESISTANCE = 0.32;

export interface LightboxGesturesParams {
  imgRef: RefObject<HTMLImageElement | null>;
  overlayRef: RefObject<HTMLDivElement | null>;
  /** Whether the lightbox is currently showing an image. */
  open: boolean;
  /** Source of the current image; a change resets the view. */
  src: string | null;
  canPrev: boolean;
  canNext: boolean;
  goPrev: () => void;
  goNext: () => void;
  onClose: () => void;
}

export interface LightboxGestures {
  // Bound to the OVERLAY (not the <img>), so pinch / pan / tap work over the
  // whole backdrop, not just on the image itself.
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerEnd: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
  onImageLoad: () => void;
  /** Step zoom toward the viewport centre (the dock +/− buttons). */
  zoomBy: (factor: number) => void;
}

const clamp = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function useLightboxGestures(params: LightboxGesturesParams): LightboxGestures {
  const { imgRef, overlayRef, open, src, canPrev, canNext, goPrev, goNext, onClose } = params;

  // A zoomed image is deliberately promoted only after its final scale has
  // painted. Promoting it while the pinch is still changing scale makes iOS
  // cache a low-resolution texture; never promoting it makes every pan briefly
  // re-rasterize. Delayed promotion gives panning a stable, sharp final-scale
  // layer without adding latency to pointermove.
  const promoteTimer = useRef(0);
  // Live transform, applied imperatively for 60fps gestures.
  const tf = useRef({ scale: 1, x: 0, y: 0 });
  // At rest, the logical scale is baked into the element's CSS dimensions so
  // panning moves 1:1 rendered pixels instead of a scaled WebKit texture.
  const bakedScale = useRef(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const geometry = useRef<
    {
      centerX: number;
      centerY: number;
      viewportWidth: number;
      viewportHeight: number;
      imageWidth: number;
      imageHeight: number;
    } | null
  >(null);
  const g = useRef({
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: 0,
    pinchDist: 0,
    pinchScale: 1,
    pinchMidX: 0,
    pinchMidY: 0,
    pinched: false,
    onImage: false,
    panX: 0,
    panY: 0,
  });
  const lastImageTap = useRef({ at: 0, x: 0, y: 0 });

  const measureGeometry = useCallback(() => {
    const img = imgRef.current;
    const overlay = overlayRef.current;
    if (!img || !overlay) {
      geometry.current = null;
      return;
    }
    const rect = overlay.getBoundingClientRect();
    geometry.current = {
      centerX: rect.left + overlay.clientWidth / 2,
      centerY: rect.top + overlay.clientHeight / 2,
      viewportWidth: overlay.clientWidth,
      viewportHeight: overlay.clientHeight,
      imageWidth: img.offsetWidth / bakedScale.current,
      imageHeight: img.offsetHeight / bakedScale.current,
    };
  }, [imgRef, overlayRef]);

  // Keep a zoomed image covering the viewport axis it exceeds. Without this a
  // pinch near an edge (or a fast follow-up pan) can leave the whole image
  // floating off-screen with no visual way to recover it.
  const constrainPan = useCallback((elastic = false) => {
    const box = geometry.current;
    if (!box || tf.current.scale <= 1) {
      return;
    }
    const maxX = Math.max(
      0,
      (box.imageWidth * tf.current.scale - box.viewportWidth) / 2,
    );
    const maxY = Math.max(
      0,
      (box.imageHeight * tf.current.scale - box.viewportHeight) / 2,
    );
    const constrainAxis = (value: number, bound: number): number => {
      if (value > bound) {
        return elastic ? bound + (value - bound) * EDGE_RESISTANCE : bound;
      }
      if (value < -bound) {
        return elastic ? -bound + (value + bound) * EDGE_RESISTANCE : -bound;
      }
      return value;
    };
    tf.current.x = constrainAxis(tf.current.x, maxX);
    tf.current.y = constrainAxis(tf.current.y, maxY);
  }, []);

  const paintTransform = useCallback((animate = false, panLayer = false) => {
    const img = imgRef.current;
    if (!img) {
      return;
    }
    const { scale, x, y } = tf.current;
    const visualScale = scale / bakedScale.current;
    img.style.transition = animate ? "transform 0.22s ease" : "none";
    img.style.transform = `translate(${x}px, ${y}px) scale(${visualScale})`;
    img.style.cursor = scale > 1 ? "grab" : "zoom-out";
    img.style.willChange = scale <= 1 || panLayer ? "transform" : "auto";
  }, [imgRef]);

  // Pointer events are already display-aligned by WebKit. Painting immediately
  // avoids adding a full frame of input latency; the operation is one transform
  // write and performs no layout reads.
  const applyTransform = useCallback((animate = false, panLayer = false) => {
    paintTransform(animate, panLayer);
  }, [paintTransform]);

  const unbakeScale = useCallback(() => {
    const img = imgRef.current;
    const box = geometry.current;
    if (!img || !box || bakedScale.current === 1) {
      return;
    }
    img.style.width = `${box.imageWidth}px`;
    img.style.height = `${box.imageHeight}px`;
    img.style.maxWidth = "100%";
    img.style.maxHeight = "100%";
    bakedScale.current = 1;
  }, [imgRef]);

  const bakePanLayer = useCallback(() => {
    const img = imgRef.current;
    const box = geometry.current;
    if (!img || !box || tf.current.scale <= 1 || pointers.current.size !== 0) {
      return;
    }
    // Bake the settled scale into layout dimensions. SVG text is then
    // rasterized at its displayed size and panning is a scale(1) transform,
    // avoiding the transient blur WebKit produces when moving a scaled
    // compositor texture.
    img.style.width = `${box.imageWidth * tf.current.scale}px`;
    img.style.height = `${box.imageHeight * tf.current.scale}px`;
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
    bakedScale.current = tf.current.scale;
    paintTransform(false, true);
  }, [imgRef, paintTransform]);

  const schedulePanLayer = useCallback((delay = 0) => {
    if (promoteTimer.current !== 0) {
      clearTimeout(promoteTimer.current);
    }
    promoteTimer.current = globalThis.setTimeout(() => {
      promoteTimer.current = 0;
      bakePanLayer();
    }, delay) as unknown as number;
  }, [bakePanLayer]);

  const setBackdrop = useCallback((dimAlpha: number) => {
    const o = overlayRef.current;
    if (o) {
      o.style.backgroundColor = `rgba(0, 0, 0, ${dimAlpha})`;
    }
  }, [overlayRef]);

  const reset = useCallback((animate = false) => {
    if (promoteTimer.current !== 0) {
      clearTimeout(promoteTimer.current);
      promoteTimer.current = 0;
    }
    const img = imgRef.current;
    if (img) {
      img.style.width = "";
      img.style.height = "";
      img.style.maxWidth = "100%";
      img.style.maxHeight = "100%";
    }
    bakedScale.current = 1;
    tf.current = { scale: 1, x: 0, y: 0 };
    applyTransform(animate);
    setBackdrop(0.92);
  }, [applyTransform, setBackdrop]);

  // Zoom by `factor` keeping the viewport point (cx, cy) stationary.
  const zoomAt = useCallback((opts: {
    factor: number;
    cx: number;
    cy: number;
    animate?: boolean;
    elastic?: boolean;
  }) => {
    const box = geometry.current;
    if (!box) {
      return;
    }
    const prev = tf.current.scale;
    const next = clamp(prev * opts.factor);
    if (next === prev) {
      return;
    }
    if (promoteTimer.current !== 0) {
      clearTimeout(promoteTimer.current);
      promoteTimer.current = 0;
    }
    unbakeScale();
    // The untransformed image is flex-centred in the overlay. Derive its visual
    // centre from that stable box plus our live translation instead of reading
    // getBoundingClientRect(): during a pinch the midpoint translation has been
    // updated in `tf` but has not painted yet, so the DOM rect is one frame stale
    // and feeds a small compounding drift back into every scale step.
    const centerX = box.centerX + tf.current.x;
    const centerY = box.centerY + tf.current.y;
    const ratio = next / prev;
    tf.current.x += (opts.cx - centerX) * (1 - ratio);
    tf.current.y += (opts.cy - centerY) * (1 - ratio);
    tf.current.scale = next;
    if (next === MIN_SCALE) {
      tf.current.x = 0;
      tf.current.y = 0;
    } else {
      constrainPan(opts.elastic ?? false);
    }
    applyTransform(opts.animate ?? false);
  }, [applyTransform, constrainPan, unbakeScale]);

  const zoomBy = useCallback((factor: number) => {
    measureGeometry();
    zoomAt({ factor, cx: globalThis.innerWidth / 2, cy: globalThis.innerHeight / 2, animate: true });
    schedulePanLayer(240);
  }, [measureGeometry, zoomAt, schedulePanLayer]);

  const settleGeometry = useCallback(() => {
    measureGeometry();
    if (tf.current.scale > 1) {
      constrainPan();
      applyTransform(true);
    } else if (tf.current.x !== 0 || tf.current.y !== 0) {
      reset(true);
    }
  }, [measureGeometry, constrainPan, applyTransform, reset]);

  // New image (open or navigation) → reset the view.
  useEffect(() => {
    if (src) {
      geometry.current = null;
      reset();
    }
  }, [src, reset]);

  // Wheel zoom (passive:false so we can preventDefault the page scroll). On the
  // OVERLAY so the wheel zooms from anywhere over the backdrop, not just the img.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !open) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!geometry.current) {
        measureGeometry();
      }
      zoomAt({ factor: e.deltaY < 0 ? 1.18 : 1 / 1.18, cx: e.clientX, cy: e.clientY });
    };
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      overlay.removeEventListener("wheel", onWheel);
    };
  }, [overlayRef, open, src, measureGeometry, zoomAt]);

  useEffect(() => {
    globalThis.addEventListener("resize", settleGeometry);
    return () => globalThis.removeEventListener("resize", settleGeometry);
  }, [settleGeometry]);

  // Clear any pending layer promotion on unmount.
  useEffect(() => () => {
    if (promoteTimer.current !== 0) {
      clearTimeout(promoteTimer.current);
    }
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    if (pointers.current.size === 1) {
      measureGeometry();
      st.startX = e.clientX;
      st.lastX = e.clientX;
      st.startY = e.clientY;
      st.lastY = e.clientY;
      st.moved = 0;
      st.panX = tf.current.x;
      st.panY = tf.current.y;
      // Did the press land on the image (vs the backdrop)? Drives tap behaviour:
      // image → zoom toggle, backdrop → dismiss. getBoundingClientRect is the
      // VISUAL (transformed) box, so this is correct whether fit or zoomed.
      const ir = imgRef.current?.getBoundingClientRect();
      st.onImage = ir !== undefined && e.clientX >= ir.left &&
        e.clientX <= ir.right && e.clientY >= ir.top && e.clientY <= ir.bottom;
    } else if (pointers.current.size === 2) {
      unbakeScale();
      applyTransform();
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        st.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        st.pinchScale = tf.current.scale;
        st.pinchMidX = (a.x + b.x) / 2;
        st.pinchMidY = (a.y + b.y) / 2;
        st.pinched = true;
      }
    }
  }, [imgRef, measureGeometry, unbakeScale, applyTransform]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) {
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b && st.pinchDist > 0) {
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        // A pinch is scale AND translation: keep the content under the moving
        // midpoint instead of letting it drift away as both fingers travel.
        tf.current.x += midX - st.pinchMidX;
        tf.current.y += midY - st.pinchMidY;
        st.pinchMidX = midX;
        st.pinchMidY = midY;
        const target = clamp((st.pinchScale * dist) / st.pinchDist);
        zoomAt({ factor: target / tf.current.scale, cx: midX, cy: midY, elastic: true });
        st.panX = tf.current.x;
        st.panY = tf.current.y;
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
      st.panX += dx;
      st.panY += dy;
      tf.current.x = st.panX;
      tf.current.y = st.panY;
      constrainPan(true);
      applyTransform(false, true);
    } else {
      // At fit: follow the finger on both axes. The release handler decides
      // whether the dominant axis means navigate (horizontal) or dismiss
      // (vertical). Only vertical travel fades the backdrop.
      tf.current.x = e.clientX - st.startX;
      tf.current.y = e.clientY - st.startY;
      applyTransform();
      setBackdrop(0.92 * (1 - Math.min(1, Math.abs(tf.current.y) / 400)));
    }
  }, [zoomAt, applyTransform, constrainPan, setBackdrop]);

  const onPointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) {
      // Rebase single-finger panning to the surviving pointer. Keeping the
      // pre-pinch lastX/lastY makes its next move look like a huge delta and is
      // the source of the post-pinch image jump.
      const remaining = pointers.current.values().next().value;
      if (remaining) {
        g.current.lastX = remaining.x;
        g.current.lastY = remaining.y;
      }
      return; // still pinching
    }
    const st = g.current;

    // A completed pinch is never a tap/dismiss gesture. Settle within bounds
    // and wait for the next independent pointer sequence.
    if (st.pinched) {
      st.pinched = false;
      if (tf.current.scale <= 1) {
        reset();
        return;
      }
      // Convert to full-resolution CSS dimensions before any release
      // animation. The elastic correction below then animates only a scale(1)
      // translation, so lifting the fingers cannot expose a blurry scaled
      // texture for the duration of the snap-back.
      bakePanLayer();
      constrainPan();
      applyTransform(true, true);
      return;
    }

    if (tf.current.scale <= 1) {
      const { x, y } = tf.current;
      // Horizontal swipe wins when it dominates → previous / next image.
      if (Math.abs(x) > Math.abs(y) && Math.abs(x) > SWIPE_NAV_THRESHOLD) {
        const moved = x > 0 ? canPrev : canNext;
        if (moved) {
          if (x > 0) {
            goPrev();
          } else {
            goNext();
          }
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

    // Tap = small path OR small net finger displacement (start→end). The net
    // check rescues jittery thumb taps that drift past TAP_SLOP yet land where
    // they began — the common "tap the backdrop to close" gesture.
    const netMove = Math.hypot(e.clientX - st.startX, e.clientY - st.startY);
    if (st.moved < TAP_SLOP || netMove < TAP_NET_SLOP) {
      // A tap on the image only zooms when it completes a double tap. This
      // follows the iOS convention and prevents an ordinary finger lift while
      // inspecting a zoomed diagram from unexpectedly collapsing it.
      if (st.onImage) {
        const now = performance.now();
        const previous = lastImageTap.current;
        const isDoubleTap = now - previous.at <= DOUBLE_TAP_MS &&
          Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= DOUBLE_TAP_SLOP;
        lastImageTap.current = { at: now, x: e.clientX, y: e.clientY };
        if (isDoubleTap) {
          lastImageTap.current.at = 0;
          if (tf.current.scale > 1) {
            reset(true);
          } else {
            zoomAt({ factor: TAP_ZOOM_SCALE, cx: e.clientX, cy: e.clientY, animate: true });
            schedulePanLayer(240);
          }
        } else if (tf.current.scale > 1) {
          constrainPan();
          applyTransform(true);
        }
      } else {
        onClose();
      }
      return;
    }

    // A short drag that didn't dismiss / navigate → snap back to fit. A zoomed
    // drag may be resting in the elastic margin, so settle it to hard bounds.
    if (tf.current.scale <= 1) {
      reset(true);
    } else {
      constrainPan();
      applyTransform(true);
    }
  }, [
    onClose,
    reset,
    zoomAt,
    constrainPan,
    applyTransform,
    bakePanLayer,
    schedulePanLayer,
    canPrev,
    canNext,
    goPrev,
    goNext,
  ]);

  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) {
      return;
    }
    pointers.current.delete(e.pointerId);
    const remaining = pointers.current.values().next().value;
    if (remaining) {
      g.current.lastX = remaining.x;
      g.current.lastY = remaining.y;
      return;
    }
    g.current.pinched = false;
    if (tf.current.scale <= 1) {
      reset(true);
    } else {
      constrainPan();
      applyTransform(true);
      setBackdrop(0.92);
    }
  }, [reset, constrainPan, applyTransform, setBackdrop]);

  return { onPointerDown, onPointerMove, onPointerEnd, onPointerCancel, onImageLoad: settleGeometry, zoomBy };
}
