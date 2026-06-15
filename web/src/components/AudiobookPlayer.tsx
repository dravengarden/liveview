import { rem, tap } from "@/px";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  IconButton,
  Slider,
  Typography,
} from "@mui/material";
import {
  Cast as CastIcon,
  MyLocation,
  Pause,
  PlayArrow,
  SkipNext,
  SkipPrevious,
} from "@mui/icons-material";
import { alpha } from "@mui/material/styles";
import { Forward15Icon, Replay15Icon } from "./Skip15Icons";
import { fmtTime, SleepChip, SpeedChip } from "@/audio/playback-ui";
import { useAudioPlayer } from "@/audio/player";
import { READING_COLUMN_MAX } from "@/types";
import { useI18n } from "@/i18n";

interface AudiobookPlayerProps {
  contentMaxWidth: number;
  lineHeight: number;
  /** True when a bottom nav bar sits below the player and already owns the
   *  home-indicator safe area, so the transport drops its own bottom inset
   *  (otherwise the inset is reserved twice — a dead gap above the bar). */
  navbarAtBottom?: boolean;
  /** Persist playback progress (chapter path + 0..1 fraction) — same store as
   *  text reading, so the shelf card can show an audio %. */
  onSaveScroll?: (path: string, ratio: number) => void;
}

/** The full read-along reader for the currently-playing chapter: the spoken text
 *  with the narrated sentence highlighted, an explicit (cancelable) follow mode,
 *  and the transport. All playback state comes from the root audio engine, so
 *  this view is purely a window onto it — leaving it never stops the audio. */
export function AudiobookPlayer(
  { contentMaxWidth, lineHeight, navbarAtBottom = false, onSaveScroll }:
    AudiobookPlayerProps,
): React.JSX.Element {
  const { t } = useI18n();
  const {
    nowPlaying,
    sentences,
    currentIdx,
    currentProgress,
    playing,
    loading,
    error,
    currentTime,
    duration,
    canPrev,
    canNext,
    togglePlay,
    seek,
    skip,
    seekToSentence,
    nextChapter,
    prevChapter,
    playingElsewhere,
    playHere,
  } = useAudioPlayer();

  // Mirror playback position into the shared progress store (debounced upstream
  // per path), so the shelf card shows an audio % like the text reader does. The
  // engine keeps its own second-accurate resume separately; this is just the
  // 0..1 fraction for display.
  useEffect(() => {
    if (!nowPlaying || !onSaveScroll || duration <= 0) return;
    onSaveScroll(nowPlaying.chapterPath, Math.min(1, currentTime / duration));
  }, [currentTime, duration, nowPlaying, onSaveScroll]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Frosted transport overlay: like the NavShell bar, the transport now floats
  // OVER the read-along scroller (frosted glass, content scrolls under it). We
  // measure its rendered height (it grows with the safe-area inset, the optional
  // "playing elsewhere" line, and rotation) and publish it as `--lv-transport-h`
  // on the relative root, so the scroller can reserve foot space for transport +
  // the NavShell bar below it (--shell-bar-h) in one calc.
  const rootRef = useRef<HTMLDivElement>(null);
  const transportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const transportEl = transportRef.current;
    const rootEl = rootRef.current;
    if (!transportEl || !rootEl) return;
    const publish = (): void => {
      rootEl.style.setProperty(
        "--lv-transport-h",
        `${transportEl.offsetHeight}px`,
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(transportEl);
    return () => {
      ro.disconnect();
    };
  }, []);

  // Explicit follow: ON auto-scrolls the spoken line to centre; a genuine user
  // scroll GESTURE turns it OFF (we don't fight the reader), and the follow
  // button / a sentence tap turns it back ON.
  const [following, setFollowing] = useState(true);
  // Accumulating rotation for the skip glyphs: each tap adds a full ∓360°, and
  // the CSS transition animates one smooth turn (iOS-style).
  const [backSpin, setBackSpin] = useState(0);
  const [fwdSpin, setFwdSpin] = useState(0);

  const scrollCurrentIntoView = useCallback(() => {
    const container = scrollRef.current;
    if (!container || currentIdx < 0) return;
    const el = container.querySelector<HTMLElement>(
      `[data-sent="${currentIdx}"]`,
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentIdx]);

  // Auto-follow the spoken sentence while following is on.
  useEffect(() => {
    if (following) scrollCurrentIntoView();
  }, [currentIdx, following, scrollCurrentIntoView]);

  // Cancel follow only on a real user scroll gesture — wheel or touch-drag — so
  // programmatic auto-scroll never switches it off the instant it engages.
  const cancelFollow = useCallback(() => {
    setFollowing(false);
  }, []);

  const jumpToCurrent = useCallback(() => {
    setFollowing(true);
    scrollCurrentIntoView();
  }, [scrollCurrentIntoView]);

  const handleSentenceClick = useCallback(
    (idx: number) => {
      setFollowing(true);
      seekToSentence(idx);
    },
    [seekToSentence],
  );

  const onSeekBar = useCallback(
    (_e: Event, value: number | number[]) => {
      seek(Array.isArray(value) ? (value[0] ?? 0) : value);
    },
    [seek],
  );

  // The transport pieces, built once and arranged into a single row.
  // Chips follow the "no caret, the value IS the tappable affordance" pattern
  // (ui.md): a standard Select stripped of its underline + dropdown icon, with a
  // renderValue showing the live value. FIXED width + centred content so the
  // value changing (1× ↔ 2.25×, 90m ↔ 1m) never shifts the surrounding layout —
  // the chips are the two "ears" of the centred transport, so any width wobble
  // would jiggle the whole row.
  // Ear width matches the bottom NavShell's edge buttons (40px) so each ear's
  // centre lands on the same vertical line as the hamburger / gear below it
  // (paired with the 12px container padding = navbar's). The ear only positions
  // the centre — content wider than it (the "1h30m" sleep label) overflows into
  // the empty space around the cluster, it isn't clipped.
  const CHIP_W = 40;
  // A fixed-width slot that centres one transport "ear" (follow toggle / speed
  // chip), so they line up in one column on the rows above/below.
  const earSx = {
    width: CHIP_W,
    flexShrink: 0,
    display: "flex",
    justifyContent: "center",
  } as const;

  const followBtn = (
    <IconButton
      aria-label={following ? t("audiobook.following") : t("audiobook.follow")}
      onClick={() => (following ? setFollowing(false) : jumpToCurrent())}
      color={following ? "primary" : "default"}
      sx={{ width: tap(44), height: tap(44) }}
    >
      <MyLocation sx={{ fontSize: rem(26) }} />
    </IconButton>
  );

  const mainCluster = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Inter-button gap scales with the font so the cluster tightens at small
        // sizes and breathes at large ones.
        gap: rem(2),
      }}
    >
      <IconButton
        aria-label={t("audiobook.prevChapter")}
        onClick={prevChapter}
        disabled={!canPrev}
        sx={{ width: tap(50), height: tap(50) }}
      >
        <SkipPrevious sx={{ fontSize: rem(33) }} />
      </IconButton>
      <IconButton
        aria-label={t("audiobook.skipBack")}
        onClick={() => {
          skip(-15);
          setBackSpin((s) => s - 360); // one full turn left, iOS-style
        }}
        sx={{ width: tap(50), height: tap(50) }}
      >
        <Replay15Icon
          sx={{
            fontSize: rem(30),
            transform: `rotate(${backSpin}deg)`,
            transition: "transform .5s cubic-bezier(.2,.8,.2,1)",
          }}
        />
      </IconButton>
      <IconButton
        onClick={playingElsewhere ? playHere : togglePlay}
        disabled={loading}
        color="primary"
        aria-label={playingElsewhere
          ? t("audiobook.playHere")
          : playing
          ? t("audiobook.pause")
          : t("audiobook.play")}
        sx={{ width: tap(58), height: tap(58) }}
      >
        {loading ? <CircularProgress size={32} /> : playingElsewhere
          // Take-over affordance: cast/handoff glyph instead of resume.
          ? <CastIcon sx={{ fontSize: rem(33) }} />
          : playing
          ? <Pause sx={{ fontSize: rem(38) }} />
          : <PlayArrow sx={{ fontSize: rem(38) }} />}
      </IconButton>
      <IconButton
        aria-label={t("audiobook.skipForward")}
        onClick={() => {
          skip(15);
          setFwdSpin((s) => s + 360); // one full turn right
        }}
        sx={{ width: tap(50), height: tap(50) }}
      >
        <Forward15Icon
          sx={{
            fontSize: rem(30),
            transform: `rotate(${fwdSpin}deg)`,
            transition: "transform .5s cubic-bezier(.2,.8,.2,1)",
          }}
        />
      </IconButton>
      <IconButton
        aria-label={t("audiobook.nextChapter")}
        onClick={nextChapter}
        disabled={!canNext}
        sx={{ width: tap(50), height: tap(50) }}
      >
        <SkipNext sx={{ fontSize: rem(33) }} />
      </IconButton>
    </Box>
  );

  // A single control row on every breakpoint: the play cluster centred, with the
  // speed chip and the sleep chip as the two fixed-width "ears". Follow doesn't
  // live here — it's an aria-/reading affordance, so it sits at the left of the
  // scrubber row instead (keeps this row to a width a 375px iPhone fits in one
  // line). space-between pins the ears to the edges; the cluster stays centred
  // because both ears are the same fixed width.
  const transportControls = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: tap(58),
      }}
    >
      <Box sx={earSx}>
        <SpeedChip />
      </Box>
      {mainCluster}
      {
        /* Same earSx slot as the speed chip — both controls centred in a CHIP_W
          ear, so the left "2×" and the right sleep button are symmetric. */
      }
      <Box sx={earSx}>
        <SleepChip />
      </Box>
    </Box>
  );

  return (
    <Box
      ref={rootRef}
      sx={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        // The transport is a frosted overlay pinned to this box's bottom, so
        // this is its positioning context (already relative) and carries the
        // published --lv-transport-h the scroller pads by.
        position: "relative",
      }}
    >
      {error && (
        <Alert severity="error" square sx={{ py: 0.25 }}>
          {t("audiobook.error", { error })}
        </Alert>
      )}

      <Box
        ref={scrollRef}
        // Tag the audio read-along scroller so the navbar title-tap
        // (scrollReaderTop in App.tsx, the iOS tap-to-top gesture) finds and
        // scrolls it — the same `[data-lv-scroller="reader"]` hook the text
        // reader (MarkdownViewer) uses. Without this the gesture was a no-op on
        // the audio page.
        data-lv-scroller="reader"
        onWheel={cancelFollow}
        onTouchMove={cancelFollow}
        // Horizontal padding IS the reading MARGIN setting (same as the text
        // reader's MarkdownViewer), so the read-along gutter tracks Settings →
        // Reading → Margin instead of a hardcoded value.
        sx={{
          flex: 1,
          overflowY: "auto",
          px: `${contentMaxWidth}px`,
          pt: 4,
          // Foot space clears BOTH overlays the read-along scrolls under: the
          // frosted transport pinned to this box's bottom (--lv-transport-h) and
          // the NavShell frosted bar below it (--shell-bar-h). Both are 0 before
          // measured / on the solid (desktop) path, leaving the base py:4.
          pb:
            "calc(32px + var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))",
          // Keep follow-mode centring (block:"center") and a sentence tap from
          // parking the spoken line UNDER the transport when it's near the end.
          scrollPaddingBottom:
            "calc(var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))",
        }}
      >
        <Box
          sx={{
            maxWidth: READING_COLUMN_MAX,
            mx: "auto",
            fontFamily: "var(--lv-reading-font)",
            lineHeight,
            // rem so it tracks the app-wide font-size (root font-size) setting.
            fontSize: "1.05rem",
          }}
        >
          {loading && sentences.length === 0
            ? (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  color: "text.secondary",
                }}
              >
                <CircularProgress size={20} />
                <Typography>{t("audiobook.loading")}</Typography>
              </Box>
            )
            : (
              sentences.map((s, i) => (
                <Box
                  component="span"
                  // Index key is safe: sentence order is stable for a chapter.
                  key={i}
                  data-sent={i}
                  onClick={() => {
                    handleSentenceClick(i);
                  }}
                  sx={(theme) => {
                    const active = i === currentIdx;
                    // Read-along highlight in THIS theme's accent (blue / brown /
                    // amber / violet per theme). Three things make it read well on
                    // every surface:
                    //  • per-theme accent (not a fixed colour) so it never clashes;
                    //  • stronger on DARK themes — a low-alpha accent over near-black
                    //    just muddies, so dark surfaces get more of the accent;
                    //  • non-current sentences DIMMED so the current line pops even
                    //    before the band (the Apple-Books focus pattern); and
                    //  • a karaoke read-so-far WIPE within the current sentence: a
                    //    hard edge at the playhead's within-sentence fraction, the
                    //    read part stronger than the not-yet part.
                    const dark = theme.palette.mode === "dark";
                    const accent = theme.palette.primary.main;
                    const weak = alpha(accent, dark ? 0.16 : 0.1);
                    const strong = alpha(accent, dark ? 0.42 : 0.26);
                    const p = Math.round(currentProgress * 1000) / 10; // 0–100
                    const wipe = `linear-gradient(to right, ${strong} ${p}%, ${weak} ${
                      Math.min(100, p + 1.5)
                    }%)`;
                    return {
                      cursor: "pointer",
                      borderRadius: 0.5,
                      transition: "opacity 0.15s ease",
                      background: active ? wipe : "transparent",
                      opacity: active ? 1 : 0.5,
                      color: "inherit",
                      px: active ? 0.25 : 0,
                      "&:hover": {
                        background: active ? wipe : theme.palette.action.hover,
                        opacity: active ? 1 : 0.78,
                      },
                    };
                  }}
                >
                  {s}
                  {" "}
                </Box>
              ))
            )}
        </Box>
      </Box>

      {
        /* Transport: scrubber row + control row. A frosted overlay (iOS-style)
          pinned to the bottom of the relative root, so the read-along text
          scrolls UNDER it; the scroller reserves --lv-transport-h of foot space
          (above). Higher alpha (0.78) than the status strip because real text
          passes under it — the transport's own controls' legibility comes first;
          blur+saturate match the NavShell bar so the two stack as one glass
          layer. background.default (the page bg under the text), not paper. The
          hairline top border keeps the boundary readable over a busy column. */
      }
      <Box
        ref={transportRef}
        sx={{
          position: "absolute",
          left: 0,
          right: 0,
          // Sit ABOVE the NavShell frosted bar when one is below us (bottom
          // tier): both are overlays pinned to the same content region, so lift
          // the transport by the bar's height (--shell-bar-h) instead of letting
          // the two collide at bottom:0. With the bar on top (desktop), the bar
          // doesn't publish the var → 0 → the transport sits at the screen edge.
          bottom: "var(--shell-bar-h, 0px)",
          // Hairline marks the SLAB TOP over the scrolling text (legibility); the
          // transport/navbar boundary below carries NO border, so the two same-
          // recipe glass panes read as one continuous slab (cowboy-style).
          borderTop: 1,
          borderColor: "divider",
          // Same milky glass recipe as the NavShell bar below (0.72 dark / 0.76
          // light, blur 30 / saturate 200) so they're one indistinguishable slab.
          bgcolor: (t) =>
            alpha(
              t.palette.background.default,
              t.palette.mode === "dark" ? 0.72 : 0.76,
            ),
          backdropFilter: "blur(30px) saturate(200%)",
          WebkitBackdropFilter: "blur(30px) saturate(200%)",
          // Match the bottom NavShell's 12px side padding so the transport's
          // edge "ears" (follow/speed left, sleep right) line up vertically with
          // the navbar's hamburger / gear below. Also floors the landscape
          // corner radius.
          pl: "max(env(safe-area-inset-left, 0px), 12px)",
          pr: "max(env(safe-area-inset-right, 0px), 12px)",
          // Top breathing scales with the font (no tap-target here, so no floor).
          pt: rem(4),
          // Bottom inset: when a bottom nav bar sits below us it already clears
          // the home indicator, so just a hair of breathing room (no doubled
          // gap). Otherwise (nav bar on top, player at the screen edge) sit ~8px
          // tighter than the inset so the bar isn't bottom-heavy.
          pb: navbarAtBottom
            ? 0.5
            : "max(calc(env(safe-area-inset-bottom, 0px) - 8px), 4px)",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {
            /* Follow toggle lives on the scrubber row (not the transport row): it
              governs read-along scrolling, not playback, and parking it here
              keeps the transport row narrow enough for one line on a 375px
              iPhone. */
          }
          {
            /* Same CHIP_W centring slot as the speed chip below (earSx), so the
              crosshair and the "2×" share one true centre line. */
          }
          <Box sx={earSx}>{followBtn}</Box>
          <Typography
            variant="caption"
            sx={{
              minWidth: 36,
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtTime(currentTime)}
          </Typography>
          <Slider
            min={0}
            max={duration || 1}
            value={Math.min(currentTime, duration || 1)}
            onChange={onSeekBar}
            disabled={loading || duration === 0}
            aria-label={t("audiobook.seek")}
            // Bigger drag target: a 20px thumb + a taller rail and vertical
            // padding so the scrub bar is easy to grab on touch.
            sx={{
              flex: 1,
              py: 1.25,
              "& .MuiSlider-thumb": { width: 20, height: 20 },
              "& .MuiSlider-rail, & .MuiSlider-track": { height: 6 },
            }}
          />
          <Typography
            variant="caption"
            sx={{ minWidth: 40, fontVariantNumeric: "tabular-nums" }}
          >
            {fmtTime(duration)}
          </Typography>
        </Box>
        {playingElsewhere && (
          // Handoff hint: this client is paused because another device owns
          // playback; the central button takes over.
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 0.5,
              pb: 0.25,
              color: "primary.main",
            }}
          >
            <CastIcon sx={{ fontSize: rem(16) }} />
            <Typography variant="caption" fontWeight={600}>
              {t("audiobook.playingElsewhere", {
                device: playingElsewhere.label,
              })}
            </Typography>
          </Box>
        )}
        {transportControls}
      </Box>
    </Box>
  );
}
