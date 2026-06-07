import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Slider,
  Typography,
} from "@mui/material";
import {
  Bedtime,
  MyLocation,
  Pause,
  PlayArrow,
  SkipNext,
  SkipPrevious,
} from "@mui/icons-material";
import { alpha } from "@mui/material/styles";
import { Forward15Icon, Replay15Icon } from "./Skip15Icons";
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

const RATES = [0.75, 1, 1.25, 1.5, 2, 2.25, 2.5, 2.75, 3];
// Sleep-timer options in minutes (0 = off). Capped at 90.
const SLEEP_MINUTES = [15, 30, 45, 60, 90];

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Compact sleep-timer label: 15m / 60→1h / 90→1h30m. Used for both the menu
 *  options and the live remaining display. */
function fmtSleep(min: number): string {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }
  return `${min}m`;
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
    playing,
    loading,
    error,
    rate,
    currentTime,
    duration,
    canPrev,
    canNext,
    togglePlay,
    seek,
    skip,
    seekToSentence,
    setRate,
    sleepMinutes,
    sleepRemainingMin,
    setSleepTimer,
    nextChapter,
    prevChapter,
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
  const CHIP_W = 72;
  const chipSelectSx = {
    width: CHIP_W,
    "& .MuiSelect-select": {
      py: 0.5,
      // MUI reserves padding-right (24px) for the dropdown icon even with
      // IconComponent removed; force it off both sides so the value is truly
      // centred and the widest label ("1h30m") isn't clipped.
      px: "0 !important",
      minHeight: "44px !important",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 0.25,
    },
  } as const;

  const speedChip = (
    <Select
      variant="standard"
      disableUnderline
      IconComponent={() => null}
      value={rate}
      onChange={(e) => {
        setRate(Number(e.target.value));
      }}
      aria-label={t("audiobook.speed")}
      renderValue={(v) => (
        <Typography
          component="span"
          variant="body2"
          fontWeight={700}
          sx={{ fontVariantNumeric: "tabular-nums" }}
        >
          {`${v}×`}
        </Typography>
      )}
      sx={chipSelectSx}
    >
      {RATES.map((r) => (
        <MenuItem key={r} value={r}>
          {r}×
        </MenuItem>
      ))}
    </Select>
  );

  const sleepActive = sleepRemainingMin > 0;
  const sleepChip = (
    <Select
      variant="standard"
      disableUnderline
      IconComponent={() => null}
      value={sleepMinutes}
      onChange={(e) => {
        setSleepTimer(Number(e.target.value));
      }}
      aria-label={t("audiobook.sleepTimer")}
      renderValue={() =>
        // Off → just the moon. Armed → only the remaining time (no moon), so the
        // longest label (e.g. "1h30m") fits the fixed-width chip without being
        // clipped by the icon.
        sleepActive
          ? (
            <Typography
              component="span"
              variant="body2"
              fontWeight={700}
              color="primary"
              sx={{ fontVariantNumeric: "tabular-nums" }}
            >
              {fmtSleep(sleepRemainingMin)}
            </Typography>
          )
          : <Bedtime sx={{ fontSize: 22, color: "text.secondary" }} />}
      sx={chipSelectSx}
    >
      <MenuItem value={0}>{t("audiobook.sleepOff")}</MenuItem>
      {SLEEP_MINUTES.map((m) => (
        <MenuItem key={m} value={m}>
          {fmtSleep(m)}
        </MenuItem>
      ))}
    </Select>
  );

  const followBtn = (
    <IconButton
      aria-label={following ? t("audiobook.following") : t("audiobook.follow")}
      onClick={() => (following ? setFollowing(false) : jumpToCurrent())}
      color={following ? "primary" : "default"}
      sx={{ width: 44, height: 44 }}
    >
      <MyLocation sx={{ fontSize: 26 }} />
    </IconButton>
  );

  const mainCluster = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 0.25,
      }}
    >
      <IconButton
        aria-label={t("audiobook.prevChapter")}
        onClick={prevChapter}
        disabled={!canPrev}
        sx={{ width: 50, height: 50 }}
      >
        <SkipPrevious sx={{ fontSize: 33 }} />
      </IconButton>
      <IconButton
        aria-label={t("audiobook.skipBack")}
        onClick={() => {
          skip(-15);
          setBackSpin((s) => s - 360); // one full turn left, iOS-style
        }}
        sx={{ width: 50, height: 50 }}
      >
        <Replay15Icon
          sx={{
            fontSize: 30,
            transform: `rotate(${backSpin}deg)`,
            transition: "transform .5s cubic-bezier(.2,.8,.2,1)",
          }}
        />
      </IconButton>
      <IconButton
        onClick={togglePlay}
        disabled={loading}
        color="primary"
        aria-label={playing ? t("audiobook.pause") : t("audiobook.play")}
        sx={{ width: 58, height: 58 }}
      >
        {loading
          ? <CircularProgress size={32} />
          : playing
          ? <Pause sx={{ fontSize: 38 }} />
          : <PlayArrow sx={{ fontSize: 38 }} />}
      </IconButton>
      <IconButton
        aria-label={t("audiobook.skipForward")}
        onClick={() => {
          skip(15);
          setFwdSpin((s) => s + 360); // one full turn right
        }}
        sx={{ width: 50, height: 50 }}
      >
        <Forward15Icon
          sx={{
            fontSize: 30,
            transform: `rotate(${fwdSpin}deg)`,
            transition: "transform .5s cubic-bezier(.2,.8,.2,1)",
          }}
        />
      </IconButton>
      <IconButton
        aria-label={t("audiobook.nextChapter")}
        onClick={nextChapter}
        disabled={!canNext}
        sx={{ width: 50, height: 50 }}
      >
        <SkipNext sx={{ fontSize: 33 }} />
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
        minHeight: 58,
      }}
    >
      {speedChip}
      {mainCluster}
      {sleepChip}
    </Box>
  );

  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
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
        sx={{ flex: 1, overflowY: "auto", px: `${contentMaxWidth}px`, py: 4 }}
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
                  sx={(theme) => ({
                    cursor: "pointer",
                    borderRadius: 0.5,
                    transition: "background-color 0.15s ease",
                    // Themed soft highlight: a tint of the active theme's accent
                    // (blue / brown / amber per theme) instead of a fixed orange,
                    // so it never clashes and the text stays readable on top.
                    bgcolor: i === currentIdx
                      ? alpha(theme.palette.primary.main, 0.28)
                      : "transparent",
                    color: "inherit",
                    px: i === currentIdx ? 0.25 : 0,
                    "&:hover": {
                      bgcolor: i === currentIdx
                        ? alpha(theme.palette.primary.main, 0.28)
                        : theme.palette.action.hover,
                    },
                  })}
                >
                  {s}
                  {" "}
                </Box>
              ))
            )}
        </Box>
      </Box>

      {/* Transport: scrubber row + control row. */}
      <Box
        sx={{
          borderTop: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          // Floor the sides off the landscape corner radius (the follow + sleep
          // controls sit at the edges). Kept tight (8px) so the big-button
          // transport row still fits a narrow (375px) iPhone.
          pl: "max(env(safe-area-inset-left, 0px), 8px)",
          pr: "max(env(safe-area-inset-right, 0px), 8px)",
          pt: 0.25,
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
          <Box
            sx={{
              // Match the speed chip's width and centre the follow toggle in it,
              // so the crosshair lines up directly above the "2×" chip on the
              // transport row below (the two left "ears" share one centre line).
              width: CHIP_W,
              flexShrink: 0,
              display: "flex",
              justifyContent: "center",
            }}
          >
            {followBtn}
          </Box>
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
        {transportControls}
      </Box>
    </Box>
  );
}
