import { rem } from "@/px";
import { coverSrc } from "@/native-sync";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, CircularProgress } from "@mui/material";
import { Headphones as AudiobookIcon } from "@mui/icons-material";
import { haptic, useAnyDetentSheetOpen } from "../_shell";
import { useAudioPlayer, useAudioTime } from "@/audio/player";
import { useI18n } from "@/i18n";

/** The same slug hue as the shelf/cover, but TRANSLUCENT — a tinted glass version
 *  for the frosted puck: the book colour is just a wash over a backdrop-blur, so
 *  the page reads through it (iOS material look). A real cover image, when
 *  present, still sits opaque on top — only the gradient fallback turns to glass. */
function coverGlass(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  // NEAR-OPAQUE (was 0.55/0.45 translucent + a backdrop blur to read as glass).
  // The puck floats over the reader's scroller, and a `backdrop-filter: blur()`
  // re-rasterizes the moving content under it EVERY frame — a scroll-perf killer
  // on iPad (see the puck sx). An opaque tint needs no blur to stay legible.
  return `linear-gradient(135deg, hsl(${hue} 52% 52% / 0.98), hsl(${
    (hue + 38) % 360
  } 48% 42% / 0.96))`;
}

const SIZE = 56; // bubble diameter (px)
const MARGIN = 12; // gap kept from the viewport edge
const DRAG_THRESHOLD = 6; // px a press must travel before it's a drag (vs a tap)
const IDLE_MS = 3000; // fade + tuck behind the edge after this long untouched
const PEEK = 0.15; // fraction of the bubble that tucks off-edge when idle —
// kept small so the idle bubble stays clearly discoverable (most of it
// visible). It earlier tucked 55% off-screen at 0.3 opacity, which read as
// "the player disappeared".
const IDLE_OPACITY = 0.7; // how faint it gets when idle (still recedes, but
// stays plainly visible, not nearly-gone)
const POS_KEY = "lv-audio-bubble-pos";

type Side = "left" | "right";
interface StoredPos {
  side: Side;
  /** Vertical position as a 0..1 ratio of the usable height — survives resize /
   *  rotation better than an absolute px top. */
  topRatio: number;
}
interface Pos {
  x: number;
  y: number;
  side: Side;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function loadPos(): StoredPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<StoredPos>;
      if (
        (p.side === "left" || p.side === "right") &&
        typeof p.topRatio === "number"
      ) {
        return { side: p.side, topRatio: clamp01(p.topRatio) };
      }
    }
  } catch {
    // corrupt / unavailable storage → fall through to the default dock
  }
  return { side: "right", topRatio: 0.62 };
}

/** Resolve a stored (side, ratio) into absolute top-left px against the live
 *  viewport. The bubble always docks flush to a horizontal edge. */
function resolve(side: Side, topRatio: number): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = side === "left" ? MARGIN : vw - SIZE - MARGIN;
  const yMin = MARGIN;
  const yMax = Math.max(yMin, vh - SIZE - MARGIN);
  const y = Math.round(yMin + topRatio * (yMax - yMin));
  return { x, y, side };
}

/**
 * The floating now-playing bubble — shown when audio is loaded but the user has
 * navigated AWAY from the playing content (browsing another book or the shelf),
 * where the full bottom bar would just be in the way. It's the unobtrusive,
 * out-of-the-way counterpart to {@link MiniPlayer}: a semi-transparent, draggable
 * artwork puck (WeChat 浮窗 / iOS AssistiveTouch lineage) that
 *
 *  - docks to the nearest left/right edge (magnetic snap on release),
 *  - remembers where the user parked it (localStorage; device-local on purpose),
 *  - fades + tucks half behind the edge when idle so it never fights the text,
 *  - and on a *tap* (not a drag) opens the shared PlaybackSheet — the ONE playback
 *    control panel (transport + speed + sleep), the same one the navbar listen
 *    control opens. The puck is purely a launcher; it owns no controls itself.
 *
 * Mutually exclusive with the bottom bar: the bar owns the playing book's page,
 * this owns everywhere else. Both hide while the popup / a sheet is open.
 */
export function FloatingBubble({
  onPlayingPage,
  suppressed = false,
  onOpenControls,
}: {
  onPlayingPage: boolean;
  /** Hide the bubble even though playback is active — used when another bar
   *  already represents the now-playing state (e.g. the navbar read-aloud
   *  control while you're viewing the very chapter being read aloud), so we
   *  don't show two "now playing" affordances for the same session. */
  suppressed?: boolean;
  /** Open the shared playback-control sheet (the puck's only action). */
  onOpenControls: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const { nowPlaying } = useAudioPlayer();
  const { currentTime, duration } = useAudioTime();

  // A DetentSheet (settings / TOC / the PlaybackSheet itself) renders inline, so
  // its z-index is trapped below this root-level fixed puck — it would otherwise
  // show through an open sheet. Recede while any sheet is up.
  const sheetOpen = useAnyDetentSheetOpen();

  const stored = useRef<StoredPos>(loadPos());
  const [pos, setPos] = useState<Pos>(() =>
    resolve(stored.current.side, stored.current.topRatio)
  );
  const [dragging, setDragging] = useState(false);
  const [idle, setIdle] = useState(false);

  const elRef = useRef<HTMLDivElement | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);
  // Mutable drag bookkeeping — kept in a ref so pointermove can update the DOM
  // directly (no per-move re-render) and only commit to state on release.
  const drag = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    baseX: 0,
    baseY: 0,
    x: 0,
    y: 0,
    id: -1,
  });

  // Persist a docked position (side + vertical ratio) to localStorage and state.
  const commitPos = useCallback((side: Side, topRatio: number) => {
    const r = clamp01(topRatio);
    stored.current = { side, topRatio: r };
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(stored.current));
    } catch {
      // storage full / unavailable — position just won't persist this session
    }
    setPos(resolve(side, r));
  }, []);

  // Any interaction resets the idle fade timer.
  const poke = useCallback(() => {
    setIdle(false);
    if (idleTimer.current !== undefined) clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);

  useEffect(() => {
    const onResize = (): void =>
      setPos(resolve(stored.current.side, stored.current.topRatio));
    window.addEventListener("resize", onResize);
    poke();
    return () => {
      window.removeEventListener("resize", onResize);
      if (idleTimer.current !== undefined) clearTimeout(idleTimer.current);
    };
  }, [poke]);

  // Re-resolve the dock against the CURRENT viewport each time the bubble becomes
  // visible. It stays mounted (returns null while hidden) the whole session, so
  // `pos` can be stale from an earlier/taller viewport — without this the bubble
  // reappears docked off the bottom edge on phones.
  const shown = nowPlaying != null && !onPlayingPage && !suppressed;
  useLayoutEffect(() => {
    if (shown) setPos(resolve(stored.current.side, stored.current.topRatio));
  }, [shown]);

  // Single source of truth for the bubble's position: inline left/top. Applied
  // here whenever `pos` settles (mount, edge-snap on release, resize) — the drag
  // handler writes inline directly mid-gesture and skips this (dragging guard).
  useLayoutEffect(() => {
    const el = elRef.current;
    if (el && !dragging) {
      // Clamp to the LIVE viewport on apply: `pos` may have been resolved against
      // a taller innerHeight (rotation, iOS address bar, PWA height), which would
      // otherwise dock the bubble below the bottom edge — invisible.
      const x = Math.min(
        Math.max(MARGIN, pos.x),
        Math.max(MARGIN, window.innerWidth - SIZE - MARGIN),
      );
      const y = Math.min(
        Math.max(MARGIN, pos.y),
        Math.max(MARGIN, window.innerHeight - SIZE - MARGIN),
      );
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [pos.x, pos.y, dragging, shown]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // no active pointer (synthetic event / odd input device) — drag still
        // works off the element's own move/up handlers, capture is just nicer
      }
      drag.current = {
        active: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        baseX: pos.x,
        baseY: pos.y,
        x: pos.x,
        y: pos.y,
        id: e.pointerId,
      };
      poke();
    },
    [pos.x, pos.y, poke],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d.active || e.pointerId !== d.id) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      d.moved = true;
      setDragging(true);
    }
    if (!d.moved) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nx = Math.min(vw - SIZE - MARGIN, Math.max(MARGIN, d.baseX + dx));
    const ny = Math.min(vh - SIZE - MARGIN, Math.max(MARGIN, d.baseY + dy));
    d.x = nx;
    d.y = ny;
    // Drive the DOM directly during the drag for 1:1 finger tracking; React state
    // is only updated once, on release (which snaps to the edge).
    if (elRef.current) {
      elRef.current.style.left = `${nx}px`;
      elRef.current.style.top = `${ny}px`;
    }
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d.active || e.pointerId !== d.id) return;
      d.active = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // capture may already be lost (pointercancel) — ignore
      }
      if (!d.moved) {
        // A tap, not a drag → open the shared playback sheet. Explicit haptic:
        // the bubble uses a custom pointer-capture gesture (not a plain onClick),
        // so the global haptic delegation can't see this tap.
        haptic("light");
        onOpenControls();
        poke();
        return;
      }
      setDragging(false);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const side: Side = d.x + SIZE / 2 < vw / 2 ? "left" : "right";
      const yMin = MARGIN;
      const yMax = Math.max(yMin, vh - SIZE - MARGIN);
      const topRatio = yMax > yMin ? (d.y - yMin) / (yMax - yMin) : 0;
      commitPos(side, topRatio);
      // Docked to an edge — a light tick confirms the snap.
      haptic("light");
      poke();
    },
    [commitPos, onOpenControls, poke],
  );

  // Hidden on the playing book's own page (the bottom bar owns it there), when
  // nothing is loaded, while a sheet/popup is in focus, and when suppressed (the
  // navbar read-aloud control already shows the now-playing state).
  if (!nowPlaying || onPlayingPage || suppressed) return null;

  const slug = nowPlaying.bookSlug;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const tucked = idle && !dragging;
  const hidden = sheetOpen;

  return (
    /* Collapsed bubble: draggable artwork puck with a progress ring. A tap opens
       the shared PlaybackSheet; a drag relocates + edge-snaps it. */
    <Box
      ref={elRef}
      role="button"
      aria-label={t("audiobook.nowPlaying")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerEnter={poke}
      sx={(theme) => ({
        position: "fixed",
        // left/top are NOT set here: they're driven solely by inline style (the
        // layout effect above + the drag handler).
        width: SIZE,
        height: SIZE,
        zIndex: theme.zIndex.fab,
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        cursor: dragging ? "grabbing" : "grab",
        opacity: hidden ? 0 : tucked ? IDLE_OPACITY : 0.92,
        pointerEvents: hidden ? "none" : "auto",
        // Idle tuck: slide a sliver off the docked edge when untouched.
        transform: tucked
          ? `translateX(${pos.side === "right" ? PEEK * 100 : -PEEK * 100}%)`
          : "none",
        transition: dragging
          ? "none"
          : "left .26s cubic-bezier(.2,.8,.2,1), top .26s cubic-bezier(.2,.8,.2,1), opacity .3s, transform .18s cubic-bezier(.2,.8,.2,1)",
      })}
    >
      <CircularProgress
        variant="determinate"
        value={pct}
        size={SIZE}
        thickness={2.4}
        aria-hidden
        sx={{ position: "absolute", inset: 0, color: "primary.main" }}
      />
      <Box
        sx={{
          position: "absolute",
          inset: 5,
          borderRadius: "50%",
          overflow: "hidden",
          // Near-opaque tint (coverGlass), NO backdrop-filter. A cover image
          // (below) overlays opaque when present. The puck floats over the
          // reader's scroller, so a `backdrop-filter: blur()` re-rasterized the
          // moving content under it every frame — janking the scroll on iPad,
          // where the puck sits in the empty side margin. Dropped for perf; the
          // opaque tint keeps it legible without the blur.
          background: coverGlass(slug),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: 2,
        }}
      >
        {nowPlaying.cover
          ? (
            <Box
              component="img"
              src={coverSrc(slug)}
              alt=""
              draggable={false}
              sx={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          )
          : (
            <AudiobookIcon
              sx={{ fontSize: rem(22), color: "rgba(255,255,255,0.92)" }}
            />
          )}
      </Box>
    </Box>
  );
}
