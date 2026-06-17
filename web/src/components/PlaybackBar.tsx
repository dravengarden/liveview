import { rem, tap } from "@/px";
import { useLayoutEffect, useRef, useState } from "react";
import {
  Box,
  CircularProgress,
  IconButton,
  Slider,
  Typography,
} from "@mui/material";
import {
  MyLocation,
  Pause,
  PlayArrow,
  SkipNext,
  SkipPrevious,
} from "@mui/icons-material";
import { Forward15Icon, Replay15Icon } from "./Skip15Icons";
import { fmtTime, SleepChip, SpeedChip } from "@/audio/playback-ui";
import { useAudioPlayer } from "@/audio/player";
import { useI18n } from "@/i18n";

/** Read-along follow control for the host reader (audiobook page OR the in-place
 *  text read-aloud). The bar renders the toggle; the host owns the scroll. */
export interface PlaybackFollow {
  following: boolean;
  /** Toggle follow: off→on re-centres on the spoken line, on→off stops following. */
  onToggle: () => void;
}

interface PlaybackBarProps {
  /** True when a bottom nav bar sits below us and already owns the home-indicator
   *  safe area, so the bar drops its own bottom inset (no doubled gap). */
  navbarAtBottom?: boolean | undefined;
  /** Follow toggle for the host reader; omit to hide the follow affordance. */
  follow?: PlaybackFollow | undefined;
}

/** Transport band top/bottom padding (MUI spacing → ×8px). SAME on both edges so
 *  the controls sit vertically centred (symmetric whitespace). */
const SLAB_PAD_Y = 0.75;

/** The shared playback transport — a frosted bar pinned over the bottom of the
 *  reading surface. ONE bar for BOTH the audiobook read-along and the in-place
 *  text read-aloud, so book + audiobook playback look and behave identically. All
 *  playback state comes from the root audio engine; the only host-specific bit is
 *  the follow toggle (the host owns its own scroller). The bar publishes its
 *  measured height as `--lv-transport-h` on its positioned ancestor, so that
 *  ancestor's scroller can reserve foot space for it. */
export function PlaybackBar(
  { navbarAtBottom = false, follow }: PlaybackBarProps,
): React.JSX.Element {
  const { t } = useI18n();
  const {
    playing,
    loading,
    currentTime,
    duration,
    canPrev,
    canNext,
    togglePlay,
    seek,
    skip,
    nextChapter,
    prevChapter,
  } = useAudioPlayer();

  const transportRef = useRef<HTMLDivElement>(null);
  // ONE row (scrubber + controls together) when wide enough, else TWO rows.
  // Measured off the bar's OWN width (not the viewport — in the desktop popup it's
  // only the right pane). The switch changes height not width → no feedback loop.
  const [oneRow, setOneRow] = useState(false);
  useLayoutEffect(() => {
    const el = transportRef.current;
    const host = el?.offsetParent as HTMLElement | null;
    if (!el || !host) return;
    const ONE_ROW_MIN = 600; // px of bar width that comfortably fits one row
    const publish = (): void => {
      host.style.setProperty("--lv-transport-h", `${el.offsetHeight}px`);
      setOneRow(el.clientWidth >= ONE_ROW_MIN);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      // Reset, else the reserved foot space lingers after the bar unmounts (the
      // text reader mounts/unmounts the bar as read-aloud starts/stops — the
      // audiobook page keeps it mounted, so this only bites the in-place case).
      host.style.removeProperty("--lv-transport-h");
    };
  }, []);

  // Accumulating rotation for the skip glyphs: each tap adds ∓360°, the CSS
  // transition animates one smooth turn (iOS-style).
  const [backSpin, setBackSpin] = useState(0);
  const [fwdSpin, setFwdSpin] = useState(0);

  const CHIP_W = 40;
  const earSx = {
    width: CHIP_W,
    flexShrink: 0,
    display: "flex",
    justifyContent: "center",
  } as const;

  const followBtn = follow
    ? (
      <IconButton
        aria-label={follow.following
          ? t("audiobook.following")
          : t("audiobook.follow")}
        onClick={follow.onToggle}
        color={follow.following ? "primary" : "default"}
        sx={{ width: tap(44), height: tap(44) }}
      >
        <MyLocation sx={{ fontSize: rem(26) }} />
      </IconButton>
    )
    : <Box sx={{ width: tap(44), height: tap(44) }} />; // keep the ear slot

  const mainCluster = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: rem(2),
      }}
    >
      <IconButton
        aria-label={t("audiobook.prevChapter")}
        onClick={prevChapter}
        disabled={!canPrev}
        sx={{ width: tap(44), height: tap(44) }}
      >
        <SkipPrevious sx={{ fontSize: rem(33) }} />
      </IconButton>
      <IconButton
        aria-label={t("audiobook.skipBack")}
        onClick={() => {
          skip(-15);
          setBackSpin((s) => s - 360);
        }}
        sx={{ width: tap(44), height: tap(44) }}
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
        onClick={togglePlay}
        disabled={loading}
        color="primary"
        aria-label={playing ? t("audiobook.pause") : t("audiobook.play")}
        sx={{ width: tap(48), height: tap(48) }}
      >
        {loading
          ? <CircularProgress size={32} />
          : playing
          ? <Pause sx={{ fontSize: rem(32) }} />
          : <PlayArrow sx={{ fontSize: rem(32) }} />}
      </IconButton>
      <IconButton
        aria-label={t("audiobook.skipForward")}
        onClick={() => {
          skip(15);
          setFwdSpin((s) => s + 360);
        }}
        sx={{ width: tap(44), height: tap(44) }}
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
        sx={{ width: tap(44), height: tap(44) }}
      >
        <SkipNext sx={{ fontSize: rem(33) }} />
      </IconButton>
    </Box>
  );

  const timeStart = (
    <Typography
      variant="caption"
      sx={{ minWidth: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
    >
      {fmtTime(currentTime)}
    </Typography>
  );
  const scrubber = (
    <Slider
      min={0}
      max={duration || 1}
      value={Math.min(currentTime, duration || 1)}
      onChange={(_e, v) => seek(Array.isArray(v) ? (v[0] ?? 0) : v)}
      disabled={loading || duration === 0}
      aria-label={t("audiobook.seek")}
      sx={{
        flex: 1,
        py: 0.5,
        "& .MuiSlider-thumb": { width: 20, height: 20 },
        "& .MuiSlider-rail, & .MuiSlider-track": { height: 6 },
      }}
    />
  );
  const timeEnd = (
    <Typography
      variant="caption"
      sx={{ minWidth: 40, fontVariantNumeric: "tabular-nums" }}
    >
      {fmtTime(duration)}
    </Typography>
  );

  return (
    <Box
      ref={transportRef}
      sx={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "var(--shell-bar-h, 0px)",
        borderTop: 1,
        borderColor: "divider",
        // SOLID (was frosted to match the old glass NavShell bar). The backdrop
        // blur re-rendered out of sync with the rubber-band → edge jitter; opaque
        // has no backdrop to re-sample, so the bounce under it stays smooth. Now
        // matches the solid NavShell bar below.
        bgcolor: "background.default",
        pl: "max(env(safe-area-inset-left, 0px), 12px)",
        pr: "max(env(safe-area-inset-right, 0px), 12px)",
        // SYMMETRIC top/bottom so the controls sit vertically centred.
        pt: SLAB_PAD_Y,
        pb: navbarAtBottom
          ? SLAB_PAD_Y
          : `max(calc(env(safe-area-inset-bottom, 0px) - 8px), ${
            SLAB_PAD_Y * 8
          }px)`,
      }}
    >
      {oneRow
        ? (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              minHeight: tap(48),
            }}
          >
            <Box sx={earSx}>{followBtn}</Box>
            {mainCluster}
            {timeStart}
            {scrubber}
            {timeEnd}
            <Box sx={earSx}>
              <SpeedChip />
            </Box>
            <Box sx={earSx}>
              <SleepChip />
            </Box>
          </Box>
        )
        : (
          <>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Box sx={earSx}>{followBtn}</Box>
              {timeStart}
              {scrubber}
              {timeEnd}
            </Box>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                minHeight: tap(48),
              }}
            >
              <Box sx={earSx}>
                <SpeedChip />
              </Box>
              {mainCluster}
              <Box sx={earSx}>
                <SleepChip />
              </Box>
            </Box>
          </>
        )}
    </Box>
  );
}
