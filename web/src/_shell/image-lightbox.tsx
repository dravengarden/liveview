// ImageLightbox — a fullscreen image gallery with zoom + pan, driven by pointer
// events so one code path serves mouse, touch, and pen:
//
//   - wheel / pinch          → zoom toward the cursor / pinch midpoint (ANYWHERE
//                              over the backdrop, not just on the image)
//   - tap the image          → toggle zoom (in at the tap point, or back to fit)
//   - tap the backdrop        → close
//   - drag (zoomed in)       → pan
//   - drag sideways (at fit) → previous / next image
//   - drag down (at fit)     → swipe-to-dismiss, backdrop fades with distance
//   - ← / → arrows           → previous / next image
//   - Esc / ✕                → close
//
// Pointer events are bound to the OVERLAY (not the <img>), so every gesture
// works over the whole near-black backdrop; the dock bar stops propagation so a
// control tap isn't read as a dismiss.
//
// The gesture machinery lives in ./image-lightbox-gestures (imperative refs
// written straight to the DOM, no React re-render per frame); this file is the
// presentation + the open/index plumbing.
//
// Document side effects, deliberately scoped: this DOES `createPortal` to
// document.body — a fullscreen lightbox must escape any transformed /
// `overflow:hidden` ancestor to cover the viewport, and portal alone appends a
// fixed node without touching body overflow or `#root`. It does NOT lock body
// scroll (no `document.body.style.overflow`): that mutation perturbs the iOS
// visual viewport, which a cross-origin portal host mirrors into the iframe
// height — the same flash the sheet primitives avoid. `touchAction: none` on the
// overlay + image blocks touch-scrolling the background instead.
//
// Business-free: presentational only. The caller owns the gallery array and the
// open/index state.

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Box, IconButton, SvgIcon, useTheme } from "@mui/material";
import { FloatingActionIsland } from "./bottom-sheet.tsx";
import { useLightboxGestures } from "./image-lightbox-gestures.ts";
import { haptic as fireHaptic } from "./haptics.ts";

export interface GalleryImage {
  src: string;
  alt: string;
  /**
   * The image is already theme-native — it was rendered/snapshotted for the
   * ACTIVE light/dark mode (e.g. a mermaid SVG the host re-renders on every
   * theme toggle). Such a figure must NOT get the dark-mode invert the plate
   * applies to fixed-colour line art (that would double-correct it — an
   * already-dark diagram flips back to light); the lightbox instead backs it
   * with a mode-matched plate (a subtle dark card in dark mode). Default false =
   * the fixed-colour behaviour (white plate, inverted in dark mode).
   */
  themed?: boolean;
}

export interface ImageLightboxProps {
  /** All zoomable images in the current context, in reading order. */
  images: GalleryImage[];
  /** Index of the open image, or `null` to keep the lightbox closed. */
  index: number | null;
  /** Request a different image (prev/next, swipe, arrow keys). */
  onIndex: (index: number) => void;
  onClose: () => void;
  /**
   * Paint a white plate (background + padding) behind the image. ON by default:
   * white-bg diagrams and transparent line art would glare or vanish on the
   * near-black backdrop, so docs/figure galleries want it. Set `false` for
   * arbitrary screenshots / photos (e.g. a chat transcript) where a white frame
   * looks wrong.
   */
  plate?: boolean;
  /**
   * Optional clearance below the control dock. Hosts with persistent bottom
   * chrome can lift the dock above it instead of visually colliding with that
   * chrome when the previewed image is itself an app screenshot.
   */
  controlsBottom?: number | string;
}

export function ImageLightbox(props: ImageLightboxProps): React.JSX.Element | null {
  const {
    images,
    index,
    onIndex,
    onClose,
    plate = true,
    controlsBottom,
  } = props;
  // In dark mode a plated FIXED-colour figure (white-bg diagram / line art) goes
  // dark-native via invert + hue-rotate — the same the in-page figure plate uses
  // — so it reads identically enlarged instead of glaring white. A self-themed
  // image (themed:true, e.g. a mermaid SVG re-rendered per mode) is already right
  // for the mode and is NEVER inverted (see the per-image block below). Photos
  // (plate=false) are never touched. (useTheme runs unconditionally — never gate
  // a hook behind `&&`.)
  const isDarkMode = useTheme().palette.mode === "dark";
  const overlayRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const open = index !== null && index >= 0 && index < images.length;
  // Light tap when the lightbox DISMISSES — one central hook covering every close
  // path (backdrop tap, Esc, ✕, swipe-down, programmatic). Open is covered by the
  // thumbnail's own press. (Open isn't a custom MuiModal, so the global delegation
  // can't see its dismiss; this is the equivalent of DetentSheet's dismiss tap.)
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      fireHaptic("light");
    }
    wasOpen.current = open;
  }, [open]);
  const current = open && index !== null ? images[index] : undefined;
  const src = current?.src ?? null;
  const canPrev = open && index !== null && index > 0;
  const canNext = open && index !== null && index < images.length - 1;

  const goPrev = useCallback(() => {
    if (index !== null && index > 0) {
      onIndex(index - 1);
    }
  }, [index, onIndex]);
  const goNext = useCallback(() => {
    if (index !== null && index < images.length - 1) {
      onIndex(index + 1);
    }
  }, [index, images.length, onIndex]);

  const { onPointerDown, onPointerMove, onPointerEnd, onPointerCancel, onImageLoad, zoomBy } = useLightboxGestures({
    imgRef,
    overlayRef,
    open,
    src,
    canPrev,
    canNext,
    goPrev,
    goNext,
    onClose,
  });

  // Key shortcuts while open. No body-scroll lock — see the file header.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft") {
        goPrev();
      } else if (e.key === "ArrowRight") {
        goNext();
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => {
      globalThis.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, goPrev, goNext]);

  if (!open || index === null || current === undefined) {
    return null;
  }

  // Per-image plate: a self-themed figure (mermaid) is already correct for the
  // mode, so it's never inverted and gets a mode-matched plate (a subtle dark
  // card in dark mode, white in light); a fixed-colour figure keeps the white
  // plate + dark-mode invert.
  const selfThemed = current.themed === true;
  const invertPlate = plate && !selfThemed && isDarkMode;
  let plateBg = "transparent";
  if (plate) {
    plateBg = selfThemed && isDarkMode ? "rgba(255, 255, 255, 0.06)" : "#ffffff";
  }
  const previousIcon = <ControlIcon path="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />;
  const nextIcon = <ControlIcon path="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />;
  const zoomOutIcon = <ControlIcon path="M19 13H5v-2h14z" />;
  const zoomInIcon = <ControlIcon path="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" />;
  const closeIcon = (
    <ControlIcon path="M18.3 5.71 16.89 4.3 12 9.17 7.11 4.3 5.7 5.71 10.59 10.6 5.7 15.49 7.11 16.9 12 12.01 16.89 16.9 18.3 15.49 13.41 10.6z" />
  );

  return createPortal(
    <Box
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      data-mobile-pager-modal="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        // Frosted-dark-glass backdrop: FULLY opaque (no page text bleeds — over
        // the composited reader iOS won't blur it away, so transparency is off
        // the table), styled to read as a lit pane of glass rather than flat
        // black — a near-black surface + a soft top sheen + a blur/saturate that
        // frosts the thin edges around the grab handle / controls. Fade-in 0→1.
        backgroundColor: "#0b0b0e",
        backgroundImage: "radial-gradient(130% 90% at 50% 0%, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%)",
        backdropFilter: "blur(28px) saturate(160%)",
        WebkitBackdropFilter: "blur(28px) saturate(160%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        touchAction: "none",
        "@keyframes shared-lightbox-in": {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
        animation: "shared-lightbox-in 0.18s ease",
        "@media (prefers-reduced-motion: reduce)": { animation: "none" },
      }}
    >
      <img
        ref={imgRef}
        src={current.src}
        alt={current.alt}
        onLoad={onImageLoad}
        draggable={false}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          cursor: "zoom-out",
          // The plate (see `plate` prop): docs/figures need it so white-bg
          // diagrams don't glare and transparent line art doesn't vanish on the
          // near-black backdrop; photos/screenshots opt out. A self-themed figure
          // gets a mode-matched plate (subtle dark card in dark mode).
          backgroundColor: plateBg,
          padding: plate ? "0.5rem" : 0,
          borderRadius: "6px",
          boxSizing: "border-box",
          // Fixed-colour figures invert in dark mode (plate + art together, hues
          // preserved) to match the in-page plate; self-themed figures (mermaid)
          // are already mode-correct and must NOT be inverted.
          filter: invertPlate ? "invert(0.9) hue-rotate(180deg)" : undefined,
        }}
      />

      {
        /* One bottom dock holds every control, within the thumb's reach on a
          phone (and a single obvious cluster on desktop). Order mirrors how a
          hand sweeps the arc: navigate · zoom · close, split by hairlines so a
          reach for "next" doesn't fat-finger "close". A tap anywhere off the bar
          (image or backdrop) dismisses; Close, Esc, and swipe-down work too. The
          dock stops pointer propagation so a control tap isn't read as a tap-to-
          dismiss. */
      }
      <div
        style={{
          ...dockStyle,
          ...(controlsBottom === undefined ? {} : { bottom: controlsBottom, paddingBottom: 0 }),
        }}
        // Isolate the control bar from the overlay's pointer gestures — otherwise
        // a tap on a dock button would register as a backdrop tap and dismiss.
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        {current.alt ? <div style={captionStyle}>{current.alt}</div> : null}
        <Box
          sx={{
            // Three 44 px targets already consume 132 px before the flex gaps
            // and the island's own padding. The old 132 px single-image width
            // therefore clipped the outer controls against the glass rim. Keep
            // a real 12 px optical inset on both sides, and let the dock grow
            // with the root rem scale used by the controls. Galleries reserve
            // the same inset around their five controls and counter.
            width: images.length > 1 ? "max(308px, calc(16.5rem + 44px))" : "max(164px, calc(8.25rem + 32px))",
            maxWidth: "100%",
            pointerEvents: "auto",
          }}
        >
          <FloatingActionIsland maxWidth="100%">
            <Box sx={barSx}>
              {images.length > 1
                ? (
                  <>
                    <IconButton aria-label="Previous image" onClick={goPrev} disabled={!canPrev} sx={ctrlBtnSx}>
                      {previousIcon}
                    </IconButton>
                    <Box component="span" sx={counterSx}>
                      {index + 1} / {images.length}
                    </Box>
                    <IconButton aria-label="Next image" onClick={goNext} disabled={!canNext} sx={ctrlBtnSx}>
                      {nextIcon}
                    </IconButton>
                  </>
                )
                : null}
              <IconButton aria-label="Zoom out" onClick={() => zoomBy(1 / 1.5)} sx={ctrlBtnSx}>
                {zoomOutIcon}
              </IconButton>
              <IconButton aria-label="Zoom in" onClick={() => zoomBy(1.5)} sx={ctrlBtnSx}>
                {zoomInIcon}
              </IconButton>
              <IconButton aria-label="Close" onClick={onClose} sx={ctrlBtnSx}>
                {closeIcon}
              </IconButton>
            </Box>
          </FloatingActionIsland>
        </Box>
      </div>
    </Box>,
    document.body,
  );
}

// The control dock pinned to the bottom of the viewport. It spans the width and
// centres its children (caption above the bar), but is click-through
// (pointerEvents: none) so only the bar swallows taps — everywhere else falls to
// the image. Insets are floored on all four edges so the bar clears the iOS home
// indicator and landscape rounded corners (ui.md §7).
const dockStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 10,
  paddingBottom: "max(env(safe-area-inset-bottom, 0px), 16px)",
  paddingLeft: "max(env(safe-area-inset-left, 0px), 12px)",
  paddingRight: "max(env(safe-area-inset-right, 0px), 12px)",
  pointerEvents: "none",
};

// The controls share the same liquid-glass island as mobile sheet actions.
// Their individual hit targets remain distinct without hard separators.
const barSx = {
  display: "flex",
  alignItems: "center",
  gap: 0.5,
  justifyContent: "center",
  minWidth: 0,
  // A fixed height clipped the rem-scaled 44 px targets above 100% global font
  // size. The island may grow, but never becomes shorter than its compact base.
  minHeight: 46,
} as const;

// Keep the iOS minimum target while letting the vector itself inherit Cowboy's
// root `rem` scale. Real SVG icons share one optical box, unlike text glyphs
// whose baselines made − / + / ✕ appear at different heights.
const ctrlBtnSx: NonNullable<React.ComponentProps<typeof IconButton>["sx"]> = {
  flex: "0 0 auto",
  width: "max(44px, 2.75rem)",
  height: "max(44px, 2.75rem)",
  padding: 0,
  fontSize: "1rem",
  lineHeight: 1,
  color: "text.primary",
  transition: "transform 160ms cubic-bezier(0.22, 1, 0.36, 1), background-color 160ms ease",
  "&:active": {
    transform: "scale(0.94)",
    backgroundColor: "action.selected",
  },
  "&.Mui-disabled": { color: "text.disabled" },
};

const ctrlIconSx = {
  display: "block",
  fontSize: "1.5em",
} as const;

function ControlIcon({ path }: { readonly path: string }): React.JSX.Element {
  return (
    <SvgIcon sx={ctrlIconSx}>
      <path d={path} />
    </SvgIcon>
  );
}

const counterSx = {
  flex: "0 0 auto",
  padding: "0 0.375rem",
  color: "text.primary",
  fontSize: "0.8125rem",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  userSelect: "none",
} as const;

const captionStyle: React.CSSProperties = {
  maxWidth: "min(90vw, 680px)",
  padding: "4px 12px",
  borderRadius: 999,
  background: "rgba(0, 0, 0, 0.55)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  color: "#fff",
  fontSize: 13,
  lineHeight: 1.4,
  textAlign: "center",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  pointerEvents: "none",
};
