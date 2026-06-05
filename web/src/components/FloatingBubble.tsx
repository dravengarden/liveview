import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Box,
  CircularProgress,
  Fade,
  Grow,
  IconButton,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import {
  Close,
  Forward10,
  Headphones as AudiobookIcon,
  Pause,
  PlayArrow,
  Replay10,
  SkipNext,
  SkipPrevious,
} from "@mui/icons-material";
import { useAudioPlayer } from "@/audio/player";
import { useI18n } from "@/i18n";

/** Stable hue from a slug → a calm gradient cover stand-in (mirrors the shelf
 *  / mini-player). Kept local on purpose: the same 6-liner lives in
 *  MiniPlayer / Landing / NowPlayingPopup — the established convention here is
 *  to duplicate this trivial helper rather than share a module, so a feature
 *  branch shouldn't be the thing that refactors all four. */
function coverGradient(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `linear-gradient(135deg, hsl(${hue} 52% 52%), hsl(${
    (hue + 38) % 360
  } 48% 42%))`;
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
const CARD_H = 138; // approx control-card height, for bottom-clamping the card
/** Playback-speed options for the card's speed menu (same list as the full player). */
const RATES = [0.75, 1, 1.25, 1.5, 2, 2.25, 2.5, 2.75, 3] as const;
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
 * navigated AWAY from the playing book (browsing another book or the shelf),
 * where the full bottom bar would just be in the way. It's the unobtrusive,
 * out-of-the-way counterpart to {@link MiniPlayer}: a semi-transparent, draggable
 * artwork puck (WeChat 浮窗 / iOS AssistiveTouch lineage) that
 *
 *  - docks to the nearest left/right edge (magnetic snap on release),
 *  - remembers where the user parked it (localStorage; device-local on purpose —
 *    a phone and a desktop want it in different places),
 *  - fades + tucks half behind the edge when idle so it never fights the text,
 *  - and on a *tap* (not a drag) opens a compact control card: prev / play-pause
 *    / next, plus a tap on the artwork/title to jump back into the full player.
 *
 * Mutually exclusive with the bottom bar: the bar owns the playing book's page,
 * this owns everywhere else. Both hide while the popup is expanded.
 */
export function FloatingBubble({
  onPlayingPage,
  onOpenPlayer,
}: {
  onPlayingPage: boolean;
  onOpenPlayer: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const {
    nowPlaying,
    playing,
    loading,
    currentTime,
    duration,
    canPrev,
    canNext,
    togglePlay,
    nextChapter,
    prevChapter,
    skip,
    rate,
    setRate,
  } = useAudioPlayer();

  const stored = useRef<StoredPos>(loadPos());
  const [pos, setPos] = useState<Pos>(() =>
    resolve(stored.current.side, stored.current.topRatio)
  );
  const [dragging, setDragging] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [speedAnchor, setSpeedAnchor] = useState<HTMLElement | null>(null);

  const elRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);
  // True only between a pointerdown that landed ON the scrim and its click, so
  // the scrim closes on a genuine tap of itself — NOT on the synthetic click
  // iOS fires right after the bubble tap that OPENED the card (whose pointerdown
  // was on the bubble), which would otherwise close it instantly.
  const scrimPressed = useRef(false);
  const [cardDragging, setCardDragging] = useState(false);
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
  const cardDrag = useRef({
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
  // Shared by the bubble drag and the expanded-card drag so both stay in sync.
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

  // Single source of truth for the bubble's position: inline left/top. Applied
  // here whenever `pos` settles (mount, edge-snap on release, resize) — the drag
  // handler writes inline directly mid-gesture and skips this (dragging guard),
  // so a release always animates from the finger to the snapped edge.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (el && !dragging) {
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
    }
  }, [pos.x, pos.y, dragging]);

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
    // Drive the DOM directly during the drag for 1:1 finger tracking; React
    // state is only updated once, on release (which snaps to the edge).
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
        // A tap, not a drag → toggle the control card.
        setControlsOpen((o) => !o);
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
      poke();
    },
    [commitPos, poke],
  );

  // ── Expanded-card drag — the card has its OWN grab handle so the user can
  // reposition it while it's open; on release it edge-snaps and writes the same
  // shared docked position the bubble reads, so collapsing lands it in place. ──
  const cardWidth = (): number => Math.min(320, window.innerWidth - 24);

  const cardDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // synthetic / odd pointer — handle's own move/up still drive the drag
      }
      const vw = window.innerWidth;
      const cw = cardWidth();
      const baseX = pos.side === "right" ? vw - cw - MARGIN : MARGIN;
      const baseY = Math.min(
        Math.max(MARGIN, pos.y),
        window.innerHeight - CARD_H - MARGIN,
      );
      cardDrag.current = {
        active: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        baseX,
        baseY,
        x: baseX,
        y: baseY,
        id: e.pointerId,
      };
      poke();
    },
    [pos.side, pos.y, poke],
  );

  const cardMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = cardDrag.current;
    if (!d.active || e.pointerId !== d.id) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      d.moved = true;
      setCardDragging(true);
    }
    if (!d.moved) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = cardWidth();
    const nx = Math.min(vw - cw - MARGIN, Math.max(MARGIN, d.baseX + dx));
    const ny = Math.min(vh - CARD_H - MARGIN, Math.max(MARGIN, d.baseY + dy));
    d.x = nx;
    d.y = ny;
    if (cardRef.current) {
      cardRef.current.style.left = `${nx}px`;
      cardRef.current.style.top = `${ny}px`;
    }
  }, []);

  const cardUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = cardDrag.current;
      if (!d.active || e.pointerId !== d.id) return;
      d.active = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // capture may already be lost — ignore
      }
      setCardDragging(false);
      // A tap on the handle (no movement) is a no-op — it must NOT close the
      // card (that's the X / backdrop's job).
      if (!d.moved) {
        poke();
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const cw = cardWidth();
      const side: Side = d.x + cw / 2 < vw / 2 ? "left" : "right";
      // Map the card's top onto the bubble's vertical range so the collapsed
      // bubble re-appears where the card was parked.
      const yMin = MARGIN;
      const yMax = Math.max(yMin, vh - SIZE - MARGIN);
      const topRatio = yMax > yMin ? (d.y - yMin) / (yMax - yMin) : 0;
      // Snap the (still-open) card to the docked edge: overwrite the inline
      // left/top the drag wrote with the resolved edge position, so it doesn't
      // sit wherever the finger let go.
      if (cardRef.current) {
        cardRef.current.style.left = `${
          side === "right" ? vw - cw - MARGIN : MARGIN
        }px`;
        cardRef.current.style.top = `${
          Math.min(
            Math.max(MARGIN, resolve(side, topRatio).y),
            vh - CARD_H - MARGIN,
          )
        }px`;
      }
      commitPos(side, topRatio);
      poke();
    },
    [commitPos, poke],
  );

  // Hidden on the playing book's own page (the bottom bar owns it there), when
  // nothing is loaded, and while the full popup is in focus.
  if (!nowPlaying || onPlayingPage) return null;

  const slug = nowPlaying.bookSlug;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const tucked = idle && !dragging && !controlsOpen;
  // The card docks to the same edge as the bubble; clamp its top so it never
  // spills off the bottom of the screen. Positioned with left (not a right
  // anchor) so a drag and the edge-snap share one coordinate space.
  const cardTop = Math.min(
    Math.max(MARGIN, pos.y),
    window.innerHeight - CARD_H - MARGIN,
  );
  const cardW = cardWidth();
  const cardLeft = pos.side === "right"
    ? window.innerWidth - cardW - MARGIN
    : MARGIN;

  return (
    <>
      {
        /* Collapsed bubble: draggable artwork puck with a progress ring. A tap
          opens the control card; a drag relocates + edge-snaps it. */
      }
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
          // left/top are NOT set here: they're driven solely by inline style
          // (the layout effect below + the drag handler). Putting them in `sx`
          // too made the leftover inline value from a drag override the emotion
          // class, so the bubble froze mid-screen instead of snapping to the edge.
          width: SIZE,
          height: SIZE,
          zIndex: theme.zIndex.fab,
          touchAction: "none",
          cursor: dragging ? "grabbing" : "grab",
          opacity: controlsOpen ? 0 : tucked ? IDLE_OPACITY : 0.92,
          pointerEvents: controlsOpen ? "none" : "auto",
          transform: tucked
            ? `translateX(${pos.side === "right" ? PEEK * 100 : -PEEK * 100}%)`
            : "none",
          transition: dragging
            ? "none"
            : "left .26s cubic-bezier(.2,.8,.2,1), top .26s cubic-bezier(.2,.8,.2,1), opacity .3s, transform .3s",
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
            background: coverGradient(slug),
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
                src={`/api/cover?book=${encodeURIComponent(slug)}`}
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
                sx={{ fontSize: 22, color: "rgba(255,255,255,0.92)" }}
              />
            )}
          {
            /* Just the artwork + the progress ring around it — no play-state glyph
              over the centre (it read as clutter / a fake button). The ring
              conveys progress; play/pause lives in the tap-to-open card. */
          }
        </Box>
      </Box>

      {
        /* Modal scrim — a dim backdrop (like the settings sheet) that makes the
          card read as a modal; tapping the dark area closes it. Closes on the
          full CLICK, not pointerdown: closing on pointerdown removes the scrim
          before iOS synthesises the tap's click, which then lands on the book
          card underneath and navigates (the click-through / "ghost click" bug).
          Keeping the scrim mounted through the click lets it swallow the tap —
          exactly what MUI's Modal backdrop does. */
      }
      <Fade in={controlsOpen} unmountOnExit>
        <Box
          onPointerDown={() => {
            scrimPressed.current = true;
          }}
          onPointerCancel={() => {
            scrimPressed.current = false;
          }}
          onClick={() => {
            if (!scrimPressed.current) return;
            scrimPressed.current = false;
            setControlsOpen(false);
            poke();
          }}
          sx={(theme) => ({
            position: "fixed",
            inset: 0,
            zIndex: theme.zIndex.fab - 1,
            bgcolor: "rgba(0,0,0,0.45)",
          })}
        />
      </Fade>
      <Grow
        in={controlsOpen}
        unmountOnExit
        style={{
          transformOrigin: pos.side === "right"
            ? "right center"
            : "left center",
        }}
      >
        <Box
          ref={cardRef}
          sx={(theme) => ({
            position: "fixed",
            top: cardDragging ? cardDrag.current.y : cardTop,
            left: cardDragging ? cardDrag.current.x : cardLeft,
            zIndex: theme.zIndex.fab,
            display: "flex",
            flexDirection: "column",
            gap: 0.5,
            px: 1,
            pb: 1,
            pt: 0.25,
            width: cardW,
            bgcolor: "background.paper",
            borderRadius: 4,
            boxShadow: 8,
            border: 1,
            borderColor: "divider",
          })}
        >
          {
            /* Drag handle + close: drag the grip to reposition the whole widget
              (edge-snaps + persists on release); the X dismisses the card. */
          }
          <Box
            sx={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 22,
              touchAction: "none",
              cursor: cardDragging ? "grabbing" : "grab",
            }}
            onPointerDown={cardDown}
            onPointerMove={cardMove}
            onPointerUp={cardUp}
            onPointerCancel={cardUp}
          >
            <Box
              sx={{
                width: 34,
                height: 4,
                borderRadius: 2,
                bgcolor: "text.disabled",
                opacity: 0.5,
              }}
            />
            <IconButton
              aria-label={t("audiobook.collapse")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setControlsOpen(false);
                poke();
              }}
              size="small"
              sx={{
                position: "absolute",
                right: -4,
                top: -2,
                color: "text.secondary",
              }}
            >
              <Close fontSize="small" />
            </IconButton>
          </Box>

          {/* Row 1 — artwork + title: the "back to the player" handle. */}
          <Box
            component="button"
            aria-label={t("audiobook.openPlayer")}
            onClick={() => {
              onOpenPlayer();
              setControlsOpen(false);
            }}
            sx={{
              all: "unset",
              display: "flex",
              alignItems: "center",
              gap: 1,
              minWidth: 0,
              cursor: "pointer",
              borderRadius: 2,
              px: 0.5,
              "&:hover": { opacity: 0.85 },
            }}
          >
            <Box
              sx={{
                flexShrink: 0,
                width: 38,
                height: 38,
                borderRadius: "50%",
                overflow: "hidden",
                position: "relative",
                background: coverGradient(slug),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {nowPlaying.cover
                ? (
                  <Box
                    component="img"
                    src={`/api/cover?book=${encodeURIComponent(slug)}`}
                    alt=""
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
                    sx={{ fontSize: 20, color: "rgba(255,255,255,0.92)" }}
                  />
                )}
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" fontWeight={700} noWrap>
                {nowPlaying.chapterLabel}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                noWrap
                sx={{ display: "block" }}
              >
                {nowPlaying.bookLabel}
              </Typography>
            </Box>
          </Box>

          {
            /* Row 2 — transport: prev-chapter · −10s · play/pause · +10s ·
              next-chapter, with a compact speed cycle pinned to the right. */
          }
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <IconButton
              aria-label={t("audiobook.prevChapter")}
              onClick={prevChapter}
              disabled={!canPrev}
              sx={{ width: 38, height: 38 }}
            >
              <SkipPrevious />
            </IconButton>
            <IconButton
              aria-label={t("audiobook.skipBack")}
              onClick={() => skip(-10)}
              sx={{ width: 38, height: 38 }}
            >
              <Replay10 />
            </IconButton>
            <IconButton
              aria-label={playing ? t("audiobook.pause") : t("audiobook.play")}
              onClick={togglePlay}
              color="primary"
              sx={{ width: 48, height: 48 }}
            >
              {loading
                ? <CircularProgress size={24} />
                : playing
                ? <Pause sx={{ fontSize: 32 }} />
                : <PlayArrow sx={{ fontSize: 32 }} />}
            </IconButton>
            <IconButton
              aria-label={t("audiobook.skipForward")}
              onClick={() => skip(10)}
              sx={{ width: 38, height: 38 }}
            >
              <Forward10 />
            </IconButton>
            <IconButton
              aria-label={t("audiobook.nextChapter")}
              onClick={nextChapter}
              disabled={!canNext}
              sx={{ width: 38, height: 38 }}
            >
              <SkipNext />
            </IconButton>
            {/* Tap to open the speed menu (mirrors the full player's list). */}
            <Box
              component="button"
              aria-label={t("audiobook.speed")}
              aria-haspopup="true"
              onClick={(e) => setSpeedAnchor(e.currentTarget)}
              sx={{
                all: "unset",
                cursor: "pointer",
                minWidth: 38,
                textAlign: "center",
                px: 0.5,
                py: 0.25,
                borderRadius: 1.5,
                fontSize: 13,
                fontWeight: 700,
                color: "text.secondary",
                "&:hover": { color: "text.primary", bgcolor: "action.hover" },
              }}
            >
              {rate}×
            </Box>
          </Box>
        </Box>
      </Grow>

      {/* Playback-speed menu — a popup over the card (above the fab z-index). */}
      <Menu
        anchorEl={speedAnchor}
        open={speedAnchor !== null}
        onClose={() => setSpeedAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        transformOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {RATES.map((r) => (
          <MenuItem
            key={r}
            selected={r === rate}
            onClick={() => {
              setRate(r);
              setSpeedAnchor(null);
            }}
          >
            {r}×
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
