// max-lines + max-lines-per-function are disabled for THIS file only: it's the
// most gesture/animation-dense component here — a single cohesive sheet whose
// WHY-dense comments (the house style — every non-obvious geometry/gesture
// choice is explained) push it just past both caps while the executable code
// stays lean. Splitting it or tightening the docs to satisfy a line count would
// lose more than it saves.
// oxlint-disable max-lines, max-lines-per-function

// DetentSheet — a content-sizing momentum sheet for mobile.
//
// Anchors to the bottom (slides up) by DEFAULT, or to the top (`anchor="top"`,
// slides down) for a nav drawer. The geometry, gesture and animation are
// identical either way — mirrored by a `sign` — so a top sheet gets the same
// finger-tracking drag, flick-to-dismiss and snap as the bottom one. The grab
// handle sits on the sheet's INNER edge (top edge for a bottom sheet, bottom
// edge for a top sheet); the corners round on that same edge.
//
// Initial height fits the CONTENT, not the viewport: the sheet is as tall as
// its rows (capped at MAX_FRACTION so a scrim strip always shows) and opens
// fully visible. A short sheet (a confirm, a two-row settings panel) is short —
// no wasted empty space, no janky full-page feel. Only when the content is tall
// enough to be worth a second stop (> PEEK_ENABLE_FRACTION of the viewport) does
// the sheet gain the medium "peek" detent below full; below that it has a single
// content-sized level (flick to dismiss). "Two levels by default; one level
// when the content is small."
//
// Self-contained overlay: it renders a fixed scrim + sheet INSIDE the caller's
// own tree and touches nothing else. Deliberately NOT a MUI Modal — a Modal
// mounts into document.body, locks body scroll, and sets aria-hidden on #root.
// When the app is embedded in a cross-origin iframe host (a portal), #root holds
// that hosted iframe; on iOS those document mutations perturb the visual
// viewport, which the host mirrors into the iframe height — so opening the sheet
// flashed the app behind it. This overlay has ZERO document-level side effects:
// no portal-to-body, no scroll lock, no attributes on #root or the iframe. That
// property is harmless for a standalone app and required when hosted in an
// iframe, so it is always safe.
//
// One opt-in exception: when `surfaceColor` is set, the sheet repaints the
// standalone status bar via `<meta theme-color>` so the top safe-area strip
// dims in lockstep with the scrim (and restores on close). That write is NOT a
// viewport-perturbing mutation (no reflow, no scroll lock, no #root/iframe
// attribute) and a cross-origin iframe's theme-color never reaches the host's
// status bar — only the top-level document's does. So it is effective only
// standalone and an inert no-op when hosted, which keeps the property above.
//
// Dependency-free on purpose: this is a shared package, so it must not drag an
// animation library into every consumer's bundle. The drag follows the finger
// via one rAF-coalesced style write per frame (no React render); the release
// settle (snap / dismiss / the open slide-in) rides a CSS transition. translateY
// only — a compositor property — with will-change + contain bounding the work to
// the sheet.
//
// Mobile only — the caller renders a centered dialog on desktop (see
// bottom-sheet.tsx), where a sheet and its drag handle read wrong on a wide
// pointer-driven screen.

import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Box, Paper } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { markDetentSheetOpen } from "./detent-sheet-open.ts";
import { haptic as fireHaptic } from "./haptics.ts";

// The sheet sizes to its content but never taller than this fraction of the
// viewport, so a strip of dimmed page always stays beyond it (it reads as a
// sheet, not a full-page modal).
const MAX_FRACTION = 0.88;
// The medium "peek" detent, as a fraction of the viewport.
const PEEK_FRACTION = 0.5;
// Add the peek detent only when the content-fit sheet is at least this tall
// (fraction of viewport). Below it the gap to the 0.5 peek is too small to be a
// distinct stop, so the sheet stays single-level (a confirm/short panel just
// fits its content). 0.66 ≈ keep ≥0.16vh of travel between peek and full.
const PEEK_ENABLE_FRACTION = 0.66;

// Release velocity (px/ms) projects this far forward to choose the detent; a
// flick toward hidden faster than this dismisses instead of snapping.
const PROJECTION_MS = 110;
const FLICK_DISMISS = 0.55;
// Settle duration + easing for snap / dismiss / open. An ease-out curve that
// reads as a snappy, lightly-damped spring without a physics library.
const SETTLE_MS = 320;
const SETTLE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
// Scrim darkens as the sheet rises (0 closed → this at full).
const SCRIM_MAX = 0.45;
// The `frosted` variant uses a much LIGHTER scrim: the translucent frosted
// surface diffuses the page behind it, so a heavy black scrim would just mud the
// glass — the lighter dim lets content read THROUGH the material (the iOS sheet
// look) while still signalling "tap outside to dismiss".
const FROSTED_SCRIM_MAX = 0.22;
// A `cover` fills the screen, so its scrim is entirely BEHIND the sheet (no
// visible dim strip, dismiss is the grab-flick not a tap-outside) — and any dim
// makes the glass body DARKER than the bg-coloured app chrome (AppBar) showing
// through the sheet's top, which reads as a brightness band under the status bar.
// Near-zero keeps the whole sheet at the page's own brightness, so the top blends
// into the (bg) status bar and the chat reads brightly through the glass.
const COVER_SCRIM_MAX = 0.03;
// Frosted surface tint opacity (composited UNDER the blur+saturate). Two very
// different needs share the same material, so they get different tints:
//   • thin `frosted` sheet  → see-through (you don't read a form THROUGH it).
//   • full-screen `cover`   → a primary READING surface, so it must stay legible
//     even when the blur does nothing. On iOS, backdrop-filter does NOT blur
//     separately-composited backdrop content (cards/images promoted to their own
//     layer punch through SHARP), so a thin cover tint over a failed blur leaves
//     the page fully legible under the sheet's own content — the reported
//     bleed-through bug. So the cover tint ALONE must occlude the page; the
//     blur+saturate are then just texture on top where they work. It must be
//     near-FULLY opaque, not merely high: high-contrast page content (black text
//     on a light shelf) stays a visible ghost until the tint hides ~98% of it —
//     0.9 leaves a ~10% sharp smudge on iOS (no blur to soften it). RE-LEARNED
//     2026-06-13: dropping the cover to 0.93/0.95 to "let the glass breathe" did
//     NOT read as frosted glass — over the composited reader iOS blurs nothing,
//     so the 5-7% became SHARP page text bleeding through (the exact lv-v95 bug,
//     not a soft wash). The platform CANNOT give see-through-and-blurred here, so
//     transparency is the wrong lever: the cover stays near-opaque (no bleed) and
//     the glass FEEL comes from the painted sheen (frostSheen) on top, not from
//     seeing the page. Back to 0.98/0.96. Light themes reveal page colour more,
//     so a touch higher there.
const FROSTED_TINT_LIGHT = 0.6;
const FROSTED_TINT_DARK = 0.54;
const COVER_TINT_LIGHT = 0.98;
const COVER_TINT_DARK = 0.96;
// Tint opacity for the frosted material, by theme mode and whether it's a cover.
const frostTint = (mode: "light" | "dark", isCover: boolean): number => {
  const dark = mode === "dark";
  if (isCover) {
    return dark ? COVER_TINT_DARK : COVER_TINT_LIGHT;
  }
  return dark ? FROSTED_TINT_DARK : FROSTED_TINT_LIGHT;
};
// A painted specular sheen over the frosted tint: a soft highlight brightest at
// the sheet's inner (revealed) edge, fading down over ~110px. This is what makes
// a milky tint read as a LIT pane of glass rather than flat paint — the detail
// real frosted glass and iOS UIVisualEffectView both have, and the thing CSS
// `backdrop-filter` cannot supply on iOS (it can't blur composited backdrops).
// It depends on NOTHING behind the sheet, so it looks identical over the reader,
// the bookshelf, or the keyboard — and costs zero legibility. Stronger in dark
// mode, where the flat-panel deadness was worst; gentle in light, where the
// surface is already airy. Composited OVER the alpha tint (which is the
// `bgcolor`), so the tint still shows through the gradient's transparent tail.
const frostSheen = (mode: "light" | "dark", isTop: boolean): string => {
  const edge = mode === "dark" ? "rgba(255, 255, 255, 0.10)" : "rgba(255, 255, 255, 0.45)";
  // Brightest at the sheet's INNER (revealed) edge — the top for a bottom sheet,
  // the bottom for a top (drawer) sheet — so the highlight sits where the glass
  // meets the page. 180deg points down (stop at top); 0deg points up (stop at
  // bottom).
  const dir = isTop ? "0deg" : "180deg";
  return `linear-gradient(${dir}, ${edge} 0%, rgba(255, 255, 255, 0) 110px)`;
};
// The sheet is a drawer-class overlay, so it sits in MUI's DRAWER band — above
// app chrome (banners z=10, AppBar 1100, MUI Drawer 1200) but BELOW the modal
// band (zIndex.modal = 1300). That ordering is load-bearing: MUI Menu / Select /
// Popover / Dialog all portal into the modal band, so a sheet at 1300+ OCCLUDES
// every popup opened from inside it (the long-standing "menu/dropdown opens
// behind the sheet" bug). Keeping the sheet < 1300 lets all those overlays
// render above it for free — no per-control z-index overrides needed anywhere.
const Z = 1250;
const SAFE_BOTTOM = "calc(16px + env(safe-area-inset-bottom, 0px))";
const SAFE_TOP = "env(safe-area-inset-top, 0px)";

// `cover` variant — a TRUE full-screen sheet: the frosted-glass layer fills the
// whole screen (`100dvh`, the DYNAMIC viewport, tracks the visible height under
// the iOS toolbar), and its CONTENT is padded down by the top safe-area inset so
// the grab handle + rows clear the notch / Dynamic Island while the glass itself
// bleeds under the status bar. Single full detent (flick down to dismiss — no
// medium peek). Capped + centred so it's edge-to-edge on a phone but a centred
// card on an iPad.
const COVER_HEIGHT = "100dvh";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Composite an opaque `#rgb` / `#rrggbb` base UNDER black at `dim` (0..1) →
// the colour the status bar should show so it visually matches the page scrim
// (black @ dim painted over the same base). Returns the input unchanged if it
// isn't a hex colour, so a non-hex `surfaceColor` degrades to "no dim".
function dimHex(base: string, dim: number): string {
  const hex = base.trim().replace(/^#/u, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (full.length !== 6 || /[^0-9a-f]/iu.test(full)) {
    return base;
  }
  const f = 1 - clamp(dim, 0, 1);
  const ch = (i: number): string =>
    Math.round(Number.parseInt(full.slice(i, i + 2), 16) * f)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

// The single document-level write this overlay permits (see header): repaint the
// standalone status bar. REPLACE the <meta name="theme-color"> node rather than
// mutate its `content`: iOS standalone PWAs frequently ignore an in-place
// attribute change (the bar keeps the colour it read at launch) but re-read a
// freshly-inserted node. This matches each app's own theme-color writer (e.g.
// liveview's useTheme), so a sheet's dim/restore and a runtime theme switch
// agree on the mechanism — the sheet's restore-on-close (the page surface) then
// reliably lands the post-switch colour instead of leaving it stuck. No-op-safe
// when no meta exists (we just append one).
function setStatusBarColor(color: string): void {
  const { head } = globalThis.document;
  if (!head) {
    return;
  }
  for (const m of head.querySelectorAll('meta[name="theme-color"]')) {
    m.remove();
  }
  const meta = globalThis.document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", color);
  head.append(meta);
}

// Scrim opacity for a given translateY — the exact value `paint` writes to the
// scrim, factored out so the status-bar tint can be kept in lockstep with it.
// |y| because the hidden direction is signed (down for a top sheet).
function scrimOpacityAt(y: number, closedPx: number, max: number): number {
  return closedPx > 0 ? clamp((closedPx - Math.abs(y)) / closedPx, 0, 1) * max : 0;
}

export interface DetentSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  // `| undefined` (not just `?`) so a caller compiling with
  // exactOptionalPropertyTypes can pass an explicit undefined.
  readonly ariaLabel?: string | undefined;
  /** Which edge the sheet anchors to: "bottom" (slides up, default) or "top"
   *  (slides down — a nav drawer). */
  readonly anchor?: "top" | "bottom" | undefined;
  /** Allow a tall sheet to rest at the half-height peek detent. Disable this for
   *  navigation surfaces, where a half-open state obscures both the destination
   *  content and the navigation list. Default true. */
  readonly peekDetent?: boolean | undefined;
  /** The bar next to the grab handle (the drag affordance). Buttons in here
   *  should `stopPropagation` on pointerdown so a tap acts, not drags. */
  readonly header?: ReactNode;
  /** Scrollable body. */
  readonly children: ReactNode;
  /** Optional row pinned to the bottom (e.g. Save / Cancel), safe-area padded.
   *  Bottom-anchored sheets only. */
  readonly footer?: ReactNode;
  /** Float the footer over the scrolling body instead of reserving a solid row.
   *  The body keeps enough trailing clearance that its final content can still
   *  scroll above the controls. Bottom-anchored sheets only. */
  readonly footerOverlay?: boolean | undefined;
  /** Opaque surface colour (typically the theme's `background.paper`). When set,
   *  the standalone iOS/Android status bar is dimmed in lockstep with the scrim
   *  while open and restored on close — so the top safe-area strip stops reading
   *  as an undimmed band above the dimmed page. Omit to leave the status bar
   *  untouched (the historical zero-side-effect behaviour). Effective only
   *  standalone; an inert no-op when hosted in a cross-origin iframe (see
   *  header). */
  readonly surfaceColor?: string | undefined;
  /** Frosted-glass surface variant: the sheet becomes a translucent, blurred
   *  "磨砂玻璃" material (the page diffuses through it) instead of the solid
   *  `background.paper`, and the scrim lightens to match. Same recipe as the app
   *  bars (alpha tint + `blur(30px) saturate(200%)`). Default false = solid. */
  readonly frosted?: boolean | undefined;
  /** Cover variant: a near-full-screen frosted sheet (微信读书 / iOS pageSheet
   *  feel) — rises to leave a thin sliver of dimmed page at the top, single full
   *  detent (flick to dismiss, no peek), capped + centred on a tablet. Implies
   *  the frosted material. Bottom-anchored only. Default false. */
  readonly cover?: boolean | undefined;
  /** Fire a light haptic tap when the sheet opens. Inside a Tauri (iOS/Android)
   *  native shell this calls the real OS haptics plugin (UIImpactFeedbackGenerator
   *  on iOS); in a plain web/PWA context it degrades to navigator.vibrate (Android)
   *  and the iOS 17.4+ `<input type="checkbox" switch>` toggle trick. A silent
   *  no-op where unsupported. Default true. */
  readonly haptic?: boolean | undefined;
}

// Haptic tap on open is delegated to the shared `haptic()` primitive (./haptics) —
// native OS haptic inside a Tauri shell, web fallback otherwise. Kept as a thin
// alias so the open effect reads clearly.
function sheetHaptic(): void {
  fireHaptic("medium");
}

export function DetentSheet(
  {
    open,
    onClose,
    ariaLabel,
    anchor = "bottom",
    peekDetent = true,
    header,
    children,
    footer,
    footerOverlay = false,
    surfaceColor,
    frosted = false,
    cover = false,
    haptic = true,
  }: DetentSheetProps,
): ReactNode {
  // +1 hides downward (bottom sheet), −1 hides upward (top sheet). All geometry
  // is mirrored by this; `closedPx` (the slide distance) stays positive.
  const sign = anchor === "top" ? -1 : 1;
  const isTop = anchor === "top";
  // `cover` is a bottom-only variant and always uses the frosted material.
  const isCover = cover && !isTop;
  const useFrost = frosted || isCover;
  // Lighter scrim under the frosted material so the page reads THROUGH the glass.
  let scrimMax = SCRIM_MAX;
  if (isCover) {
    scrimMax = COVER_SCRIM_MAX;
  } else if (useFrost) {
    scrimMax = FROSTED_SCRIM_MAX;
  }

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const yRef = useRef(0); // current translateY (px), signed
  const geomRef = useRef<{ detents: number[]; closedPx: number }>({ detents: [0, 0], closedPx: 0 });
  // True once the open slide-in has played for the current open. A geometry
  // recompute WHILE already open (e.g. `cover` toggled by the keyboard
  // showing/hiding, switching full-screen ↔ content-height) must NOT re-seed the
  // closed offset + re-slide — that flickers the sheet off-screen and back on
  // every toggle. Reset when the sheet closes.
  const animatedRef = useRef(false);
  const dragRef = useRef<{ startPointerY: number; startY: number; samples: { t: number; y: number }[] } | null>(null);
  const rafRef = useRef(0);
  // Latest drag position waiting for the next animation frame. Keeping it in a
  // ref is important: several pointermoves commonly arrive before one frame,
  // and the sheet must paint the LAST one rather than lag at the first.
  const pendingYRef = useRef<number | null>(null);
  const movingTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  // Mirror props into refs so `paint` (deps []) reads the latest without being
  // re-created (which would replay the open animation).
  const surfaceColorRef = useRef(surfaceColor);
  const signRef = useRef(sign);
  const scrimMaxRef = useRef(scrimMax);
  useEffect(() => {
    surfaceColorRef.current = surfaceColor;
    signRef.current = sign;
    scrimMaxRef.current = scrimMax;
  }, [surfaceColor, sign, scrimMax]);

  // Write translateY + scrim opacity straight to the DOM (no React render). The
  // settle rides a CSS transition; an active drag turns it off so the sheet
  // tracks the finger 1:1.
  const paint = useCallback((y: number, animate: boolean): void => {
    yRef.current = y;
    const { closedPx } = geomRef.current;
    const sheet = sheetRef.current;
    const scrim = scrimRef.current;
    if (sheet) {
      // A settled sheet promotes its nested overflow body so iOS can momentum-
      // scroll it asynchronously. While the SHEET ITSELF moves, however, that
      // creates a promoted tiled scroller inside another moving layer; on a
      // chart-heavy page physical iPhones then spend the transition relocating
      // the whole layer subtree and visibly drop compositor frames even though
      // the JS thread is idle. Mark the short moving phase so descendant
      // scrollers collapse back into the sheet's single cached layer. The
      // transform transition-end below restores their async promotion once the
      // surface is stationary again.
      sheet.dataset["detentMoving"] = "";
      if (movingTimerRef.current !== null) {
        globalThis.clearTimeout(movingTimerRef.current);
        movingTimerRef.current = null;
      }
      sheet.style.transition = animate ? `transform ${String(SETTLE_MS)}ms ${SETTLE_EASE}` : "none";
      sheet.style.transform = `translateY(${String(y)}px)`;
      if (animate) {
        // A zero-distance snap does not emit transitionend. Keep a timeout as
        // the deterministic fallback so merely tapping the grab bar cannot
        // leave nested momentum scrolling disabled for the rest of the sheet.
        movingTimerRef.current = globalThis.setTimeout(() => {
          delete sheet.dataset["detentMoving"];
          movingTimerRef.current = null;
        }, SETTLE_MS + 34);
      }
    }
    if (scrim) {
      scrim.style.transition = animate ? `opacity ${String(SETTLE_MS)}ms ${SETTLE_EASE}` : "none";
      scrim.style.opacity = String(scrimOpacityAt(y, closedPx, scrimMaxRef.current));
    }
    // Match the status bar to the scrim, but only at settle points: iOS paints
    // `theme-color` with a hard snap (no animation), so a per-frame write during
    // the drag would jank. `animate` is true exactly on the settle transitions
    // (open / snap / dismiss); the bar then steps between detents, not per frame.
    const surface = surfaceColorRef.current;
    if (animate && surface !== undefined) {
      setStatusBarColor(dimHex(surface, scrimOpacityAt(y, closedPx, scrimMaxRef.current)));
    }
  }, []);

  useEffect(() => () => {
    if (movingTimerRef.current !== null) {
      globalThis.clearTimeout(movingTimerRef.current);
    }
  }, []);

  // (Re)compute geometry against the rendered content on open, then animate in.
  useEffect(() => {
    if (!open) {
      animatedRef.current = false;
      return;
    }
    const h = globalThis.innerHeight;
    // The sheet's ACTUAL rendered height — content-driven, clamped by the CSS
    // maxHeight (MAX_FRACTION vh). This is both the slide-out distance and the
    // "full" extent: opening at translateY 0 reveals the whole sheet, so a short
    // confirm shows its actions without any drag. offsetHeight (not a vh
    // computation) is exact under the iOS Safari 100vh-vs-innerHeight gap.
    const closedPx = sheetRef.current?.offsetHeight ?? MAX_FRACTION * h;
    // Two levels only when the content is tall enough for a peek to be a
    // distinct stop; otherwise a single content-sized level. Detents are
    // translateY values, ordered most-hidden → full (0).
    // A cover is a single full level (flick down dismisses) — never a peek, even
    // though it's tall enough to otherwise earn one.
    const hasPeek = peekDetent && !isCover && closedPx >= PEEK_ENABLE_FRACTION * h;
    const peekY = sign * (closedPx - PEEK_FRACTION * h);
    const detents = hasPeek ? [peekY, 0] : [0];
    geomRef.current = { detents, closedPx };
    const openY = detents.at(-1) ?? 0; // full
    if (animatedRef.current) {
      // Already open — this is a geometry change (cover ↔ content-height), the
      // CSS height/anchor already updated reactively. Just settle to the open
      // position (snaps a stale peek offset to full); never re-seed + re-slide.
      paint(openY, true);
      return;
    }
    animatedRef.current = true;
    if (haptic) {
      sheetHaptic(); // light tap on open (best-effort; see sheetHaptic)
    }
    paint(sign * closedPx, false); // seed closed (no transition)…
    const id = globalThis.requestAnimationFrame(() => paint(openY, true)); // …then slide open
    return () => globalThis.cancelAnimationFrame(id);
  }, [open, paint, sign, isCover, peekDetent, haptic]);

  const dismiss = useCallback((): void => {
    // Light tap on dismiss — the single choke point for every close path (flick
    // down, tap-outside, programmatic), mirroring the tap on open.
    fireHaptic("light");
    paint(signRef.current * geomRef.current.closedPx, true);
    globalThis.setTimeout(onClose, SETTLE_MS);
  }, [paint, onClose]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startPointerY: e.clientY, startY: yRef.current, samples: [{ t: e.timeStamp, y: e.clientY }] };
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const d = dragRef.current;
      if (!d) {
        return;
      }
      const s = signRef.current;
      const { closedPx } = geomRef.current;
      let y = d.startY + (e.clientY - d.startPointerY);
      if (s * y < 0) {
        y *= 0.12; // rubberband past full-open
      }
      // Don't drag past fully hidden (sign*closedPx).
      y = s > 0 ? Math.min(y, closedPx) : Math.max(y, -closedPx);
      d.samples.push({ t: e.timeStamp, y: e.clientY });
      if (d.samples.length > 5) {
        d.samples.shift();
      }
      pendingYRef.current = y;
      if (rafRef.current === 0) {
        rafRef.current = globalThis.requestAnimationFrame(() => {
          rafRef.current = 0;
          const pendingY = pendingYRef.current;
          pendingYRef.current = null;
          if (pendingY !== null) {
            paint(pendingY, false);
          }
        });
      }
    },
    [paint],
  );

  const flushPendingDragFrame = useCallback((): void => {
    if (rafRef.current !== 0) {
      globalThis.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    // Flush the final coalesced move before projecting the release. Previously
    // pointerup cancelled it, so the sheet could jump back a frame and choose a
    // detent from a stale visual position.
    const pendingY = pendingYRef.current;
    pendingYRef.current = null;
    if (pendingY !== null) {
      paint(pendingY, false);
    }
  }, [paint]);

  const finishDrag = useCallback((projectVelocity: boolean): void => {
    const d = dragRef.current;
    dragRef.current = null;
    flushPendingDragFrame();
    if (!d) {
      return;
    }
    const s = signRef.current;
    const { detents, closedPx } = geomRef.current;
    const last = d.samples.at(-1);
    const prev = d.samples.at(-2) ?? last;
    if (!last || !prev) {
      return;
    }
    const dt = last.t - prev.t;
    const vy = dt > 0 ? (last.y - prev.y) / dt : 0; // px/ms, + = downward
    const projected = yRef.current + (projectVelocity ? vy * PROJECTION_MS : 0);
    const low = detents[0] ?? 0; // most-hidden detent
    // Work in "hiddenness" (s*y: 0 open → closedPx hidden) so the thresholds are
    // anchor-agnostic: a fast flick toward hidden, or a projected position past
    // the half-way point between the lowest detent and fully hidden, dismisses.
    const lowHid = s * low;
    if (
      projectVelocity &&
      (s * vy > FLICK_DISMISS || s * projected > lowHid + (closedPx - lowHid) * 0.5)
    ) {
      dismiss();
      return;
    }
    let best = 0;
    detents.forEach((dd, i) => {
      if (Math.abs(dd - projected) < Math.abs((detents[best] ?? 0) - projected)) {
        best = i;
      }
    });
    paint(detents[best] ?? 0, true);
  }, [dismiss, flushPendingDragFrame, paint]);

  const onPointerUp = useCallback((): void => finishDrag(true), [finishDrag]);
  // iOS can cancel a captured pointer when a system gesture or interruption
  // wins. Never strand the surface mid-drag: discard velocity and settle to the
  // nearest valid detent. lostpointercapture shares the same idempotent cleanup;
  // after a normal pointerup dragRef is already null, so it is a no-op.
  const onPointerCancel = useCallback((): void => finishDrag(false), [finishDrag]);

  // Track this sheet in the module open-count while open, so other fixed chrome
  // (a floating puck) can recede behind it — the inline sheet can't out-stack a
  // root-level fixed element via z-index alone (see detent-sheet-open.ts). The
  // returned `level` is this sheet's depth in the open stack; it drives the
  // scrim/surface z-index below so a later sheet's scrim covers an earlier sheet
  // (otherwise every sheet shares one z-band and the lower one peeks through).
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!open) {
      return;
    }
    const { level: l, close } = markDetentSheetOpen();
    // `level` is only knowable AFTER markDetentSheetOpen() imperatively
    // registers this sheet (mount/unmount side effects), so storing the
    // returned depth via setState here is the correct pattern — not the
    // render-loop anti-pattern the rule guards against.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLevel(l);
    return close;
  }, [open]);

  // Escape closes — keyboard parity with a dialog, without being a Modal.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        dismiss();
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  // Status-bar tint that `paint`'s settle-only write can't cover: (1) restore
  // the undimmed surface when the sheet closes/unmounts; (2) re-tint when
  // `surfaceColor` changes WHILE open (the settings sheet switches the theme).
  useEffect(() => {
    if (!open || surfaceColor === undefined) {
      return;
    }
    setStatusBarColor(dimHex(surfaceColor, scrimOpacityAt(yRef.current, geomRef.current.closedPx, scrimMax)));
    return () => {
      setStatusBarColor(surfaceColor);
    };
  }, [open, surfaceColor, scrimMax]);

  // Unmounted when closed; the dismiss runs the settle (open still true) and
  // only then calls onClose, so the slide-out is seen.
  if (!open) {
    return null;
  }

  // The grab strip (handle pill) — on the sheet's INNER edge, draggable.
  const grabStrip = (
    <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 34, py: 0.75 }}>
      <Box sx={{ width: 56, height: 6, borderRadius: 3, bgcolor: "text.disabled" }} />
    </Box>
  );
  // The draggable bar: grab strip + header. For a top sheet it lives at the
  // BOTTOM edge with the handle below the header; for a bottom sheet at the top
  // with the handle above. touchAction:none so the browser doesn't claim the
  // gesture; header buttons stopPropagation so a tap acts.
  const dragBar = (
    <Box
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      sx={{ flexShrink: 0, touchAction: "none", cursor: "grab" }}
    >
      {isTop
        ? (
          <>
            {header}
            {grabStrip}
          </>
        )
        : (
          <>
            {grabStrip}
            {header}
          </>
        )}
    </Box>
  );

  // A top sheet clears the notch at its leading (top) edge; a bottom sheet pads
  // its trailing (bottom) edge when there's no footer.
  let bodyPb: number | string = 0;
  if (!isTop) {
    bodyPb = footer == null ? SAFE_BOTTOM : footerOverlay ? `calc(76px + ${SAFE_BOTTOM})` : 1;
  }
  const body = (
    <Box
      sx={{
        // basis:auto so the body takes its content height (the sheet fits
        // content); shrink:1 + minHeight:0 so it shrinks and scrolls only once
        // the content hits the sheet's maxHeight. A cover is a FIXED tall sheet,
        // so the body GROWS to fill it (flex:1) and scrolls within.
        flex: isCover ? "1 1 auto" : "0 1 auto",
        minHeight: 0,
        overflowY: "auto",
        // iOS scroll perf: this scroller is nested under the sheet root, which
        // carries transform (translateY detent) + will-change + contain — an
        // ancestor combo that DEMOTES a nested overflow scroller off the
        // compositor onto the main thread, so flicking a long sheet (e.g.
        // Settings) drops frames. Give the scroller its OWN compositing layer +
        // momentum so iOS scrolls it async again. Touch only the scroller, never
        // the root's animation props (those drive the slide-in).
        WebkitOverflowScrolling: "touch",
        transform: "translateZ(0)",
        // Promotion is valuable only while this nested scroller is stationary.
        // DetentSheet marks its root during slide/drag motion so the entire
        // surface travels as one composited layer instead of a moving tree of
        // independently tiled layers. It is restored on transform transition-
        // end, preserving async momentum for long Settings / Contents lists.
        "[data-detent-moving] &": { transform: "none" },
        // No horizontal padding: the sheet doesn't impose a side gutter on its
        // content, so an edge-to-edge body (a full-width list, a chart) works.
        // Consumers that want a text gutter add their own px (BottomSheet does).
        pt: isTop ? SAFE_TOP : 0,
        pb: bodyPb,
      }}
    >
      {children}
    </Box>
  );

  // Per-level z so a later sheet stacks ABOVE earlier ones: scrim = z, surface =
  // z+1. Clamped to 24 levels (z ≤ 1298) so even a pathological stack stays under
  // MUI's modal band (1300) — a Menu/Select opened from a sheet must still float
  // above it.
  const z = Z + Math.min(level, 24) * 2;

  return (
    <>
      {
        /* Scrim: dims the app, taps dismiss. Painted imperatively. Self-contained
          — it does NOT touch #root/body. */
      }
      <Box
        ref={scrimRef}
        aria-hidden
        onClick={dismiss}
        sx={{ position: "fixed", inset: 0, bgcolor: "common.black", zIndex: z, opacity: 0, touchAction: "none" }}
      />
      {
        /* Cover backdrop: an OPAQUE background-coloured layer that fully hides the
          page behind a full-screen cover, so the frosted sheet's blur+saturate
          sample THIS smooth surface — not the page. That's the whole trick behind
          a clean frosted-glass cover: a flat backdrop can look like lit glass;
          over a dense, high-contrast page the same material otherwise bleeds
          SHARP text, because iOS won't blur the composited page. An opaque
          backdrop makes EVERY cover sample a uniform surface, so it reads as
          uniform glass and never bleeds — independent of whether iOS blurs.
          Cover-only (a content sheet shows a dimmed page strip by design). Fades
          in so the page doesn't pop. */
      }
      {isCover && (
        <Box
          aria-hidden
          sx={{
            position: "fixed",
            inset: 0,
            zIndex: z,
            bgcolor: "background.default",
            pointerEvents: "none",
            "@keyframes cover-bg-in": { from: { opacity: 0 }, to: { opacity: 1 } },
            animation: "cover-bg-in 0.2s ease",
            "@media (prefers-reduced-motion: reduce)": { animation: "none" },
          }}
        />
      )}
      {
        /* Keyboard skirt (cover only): a frosted band filling the keyboard-occupied
          area BEHIND the on-screen keyboard. The cover ends at the keyboard's top
          (bottom:--kb-inset), so the keyboard's rounded top corners + the empty
          IME-candidate strip otherwise leak the sharp page through at the sheet's
          bottom edge. Painting the same frosted material there hides the leak. 0
          height (invisible) when there's no keyboard / `--kb-inset` is unset. */
      }
      {isCover && (
        <Box
          aria-hidden
          sx={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            // +24px so the skirt extends a touch PAST the keyboard's top edge:
            // the keyboard's rounded top corners would otherwise reveal a sliver of
            // the sharp page at the skirt/cover seam (bottom-left/right). The
            // overshoot sits BEHIND the cover's footer (z-order) + the keyboard, so
            // it's a harmless overlap, not a visible band.
            height: "calc(var(--kb-inset, 0px) + 24px)",
            zIndex: z + 1,
            pointerEvents: "none",
            // Skirt is cover-only → use the near-opaque cover tint so it matches
            // the cover surface as one continuous slab (isCover is true here).
            bgcolor: (t) => alpha(t.palette.background.default, frostTint(t.palette.mode, true)),
            backdropFilter: "blur(30px) saturate(200%)",
            WebkitBackdropFilter: "blur(30px) saturate(200%)",
          }}
        />
      )}
      {
        /* An elevated MUI Paper: its SHADOW reads as a layer floating above the
          dimmed page ("transient overlay, tap scrim to dismiss"). The surface is
          pinned to flat `background.paper` (backgroundImage:none below) NOT Paper's
          dark-mode elevation overlay, so the chrome matches the `background.paper`
          content consumers fill it with (the tint made the handle strip a lighter
          band — a two-tone bug). `square` drops the all-corner radius. */
      }
      <Paper
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        elevation={8}
        square
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "transform") {
            delete event.currentTarget.dataset["detentMoving"];
            if (movingTimerRef.current !== null) {
              globalThis.clearTimeout(movingTimerRef.current);
              movingTimerRef.current = null;
            }
          }
        }}
        sx={{
          position: "fixed",
          left: 0,
          right: 0,
          // A bottom COVER lifts above the on-screen keyboard via `--kb-inset` (set
          // by the host from visualViewport; 0px fallback when there's no keyboard or
          // the host doesn't track it). iOS never resizes the layout viewport for the
          // keyboard, so this var is the only signal — paired with the height shrink
          // below, the full-screen sheet fills exactly the area above the keyboard
          // and its footer/field stay visible. Non-cover sheets are content-height
          // and rise on their own, so they stay pinned at 0.
          ...(isTop ? { top: 0 } : { bottom: isCover ? "var(--kb-inset, 0px)" : 0 }),
          // Cover: a true FULL-BLEED full-screen sheet — `left:0/right:0` above
          // already span the viewport, so no width cap (an earlier 720px cap left
          // a centred card with bare side gutters on an iPad — the reported bug).
          // Otherwise: content-driven height, capped so a scrim strip always shows.
          ...(isCover
            ? {
              // Shrink by the keyboard inset so the sheet fills exactly the area
              // ABOVE the keyboard (paired with bottom:--kb-inset above). 0px
              // fallback → full 100dvh when the keyboard is down.
              height: `calc(${COVER_HEIGHT} - var(--kb-inset, 0px))`,
              maxHeight: `calc(${COVER_HEIGHT} - var(--kb-inset, 0px))`,
              // The glass bleeds to the very top; the content (grab handle + rows)
              // is pushed below the notch / Dynamic Island by the safe-area inset.
              pt: SAFE_TOP,
            }
            : { maxHeight: `${String(MAX_FRACTION * 100)}vh` }),
          zIndex: z + 1,
          willChange: "transform",
          contain: "layout paint",
          display: "flex",
          flexDirection: "column",
          // Flat background.paper (see the Paper comment) — drops the dark-mode
          // elevation overlay so chrome + content are one surface. The `frosted`
          // variant swaps it for a translucent 磨砂玻璃 material (same recipe as the
          // app bars): a milky tint over a heavy blur+saturate, so the page diffuses
          // through it. The `none` base (drop MUI's elevation overlay) is set in
          // each branch below so it appears exactly once; `frosted` replaces it
          // with the specular sheen.
          ...(useFrost
            ? {
              // A thin `frosted` sheet stays see-through (frostTint). A full-screen
              // `cover` is a primary surface that must NEVER show the page: its own
              // pixels are FULLY opaque (background.default, alpha 1) so it can't
              // bleed regardless of the backdrop layer or whether iOS blurs — the
              // glass FEEL comes from the sheen + blur+saturate on top, not from
              // any translucency (which on iOS = sharp page text over composited
              // content, the long-standing bug).
              bgcolor: (t) =>
                isCover
                  ? t.palette.background.default
                  : alpha(t.palette.background.default, frostTint(t.palette.mode, false)),
              // A content-sized sheet gets a short edge sheen. A full-screen
              // cover must stay one continuous semantic surface: stretching the
              // same 110px highlight across its top made the safe-area/handle
              // region look like a mismatched grey header. Cover identity comes
              // from its opaque tint; keep its background flat and continuous.
              backgroundImage: (t) => isCover ? "none" : frostSheen(t.palette.mode, isTop),
              backdropFilter: "blur(30px) saturate(200%)",
              WebkitBackdropFilter: "blur(30px) saturate(200%)",
            }
            : { bgcolor: "background.paper", backgroundImage: "none" }),
          // Round the inner (revealed) edge only — but a full-screen cover bleeds
          // to the screen edges, so it's square (rounded corners at the very top
          // would sit behind the status bar / island and just clip the glass).
          ...(!isCover && isTop ? { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 } : {}),
          ...(!isCover && !isTop ? { borderTopLeftRadius: 16, borderTopRightRadius: 16 } : {}),
          outline: "none",
          // Pre-paint: offscreen until the open effect's first frame slides it in.
          transform: `translateY(${String(sign * 100)}vh)`,
        }}
      >
        {isTop
          ? (
            <>
              {body}
              {dragBar}
            </>
          )
          : (
            <>
              {dragBar}
              {body}
              {footer == null ? null : (
                <Box
                  sx={{
                    ...(footerOverlay
                      ? {
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: 2,
                        pointerEvents: "none",
                        "& > *": { pointerEvents: "auto" },
                      }
                      : { flexShrink: 0 }),
                    display: "flex",
                    justifyContent: "center",
                    gap: 1,
                    px: 2,
                    // The circular dismiss island already has its own internal
                    // glass breathing room; a full 8px footer lead made it look
                    // detached from the final control. Keep a compact 4px seam.
                    pt: 0.5,
                    // A cover lifts itself above the keyboard (bottom:--kb-inset), so
                    // when the keyboard is up the home-indicator clearance is moot —
                    // collapse to a small gap above the keyboard; full SAFE_BOTTOM
                    // when it's down (or for non-cover sheets).
                    pb: isCover ? `max(8px, calc(${SAFE_BOTTOM} - var(--kb-inset, 0px)))` : SAFE_BOTTOM,
                  }}
                >
                  {footer}
                </Box>
              )}
            </>
          )}
      </Paper>
    </>
  );
}
