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
  Tune,
} from "@mui/icons-material";
import { Forward15Icon, Replay15Icon } from "./Skip15Icons";
import {
  fmtTime,
  SleepChip,
  SpeedChip,
  useScrubber,
} from "@/audio/playback-ui";
import { useAudioPlayer, useAudioTime } from "@/audio/player";
import { useI18n } from "@/i18n";
import { PlaybackPreparation } from "./PlaybackPreparation";
import { playbackControls } from "@/signals.ts";
import { DockPortal } from "@/_shell/bottom-dock.tsx";

/** Read-along follow control for the host reader (audiobook page OR the in-place
 *  text read-aloud). The bar renders the toggle; the host owns the scroll. */
export interface PlaybackFollow {
  following: boolean;
  /** Toggle follow: off→on re-centres on the spoken line, on→off stops following. */
  onToggle: () => void;
}

interface PlaybackBarProps {
  /** True when the dock's bar sits below us and already owns the
   *  home-indicator safe area, so the transport drops its own bottom inset. */
  navbarAtBottom?: boolean | undefined;
  /** Follow toggle for the host reader; omit to hide the follow affordance. */
  follow?: PlaybackFollow | undefined;
}

/** Transport band top/bottom padding (MUI spacing → ×8px). SAME on both edges so
 *  the controls sit vertically centred (symmetric whitespace). */
const SLAB_PAD_Y = 0.75;

/** The shared playback transport, rendered as the accessory row of the
 *  surface's bottom dock. ONE transport for BOTH the audiobook read-along and
 *  the in-place text read-aloud. All playback state comes from the root audio
 *  engine; the only host-specific bit is the follow toggle (the host owns its
 *  own scroller). The dock's `--lv-dock-h` already includes this row. */
export function PlaybackBar(
  { navbarAtBottom = false, follow }: PlaybackBarProps,
): React.JSX.Element {
  const { t } = useI18n();
  const {
    playing,
    buffering,
    loading,
    canPrev,
    canNext,
    togglePlay,
    seek,
    skip,
    nextChapter,
    prevChapter,
  } = useAudioPlayer();
  const { currentTime, duration } = useAudioTime();
  const scrub = useScrubber(currentTime, seek);

  const transportRef = useRef<HTMLDivElement>(null);
  // ONE row (scrubber + controls together) when wide enough, else TWO rows,
  // measured off the transport's own width (the dock may be only the content
  // column beside a desktop sidebar). The switch changes height, not width, so
  // there is no feedback loop.
  const [oneRow, setOneRow] = useState(false);
  useLayoutEffect(() => {
    const el = transportRef.current;
    if (!el) return;
    const ONE_ROW_MIN = 680; // px of width that comfortably fits one row
    const measure = (): void => setOneRow(el.clientWidth >= ONE_ROW_MIN);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
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
        aria-pressed={follow.following}
        sx={{
          width: tap(44),
          height: tap(44),
          color: follow.following ? "primary.main" : "text.secondary",
          bgcolor: "transparent",
          boxShadow: "none",
          "&:hover": {
            bgcolor: "transparent",
          },
        }}
      >
        <MyLocation sx={{ fontSize: rem(26) }} />
      </IconButton>
    )
    : <Box sx={{ width: tap(44), height: tap(44) }} />; // keep the ear slot

  const controlsBtn = (
    <IconButton aria-label={t("audiobook.playback")} onClick={() => playbackControls.emit()}
      sx={{ width: tap(44), height: tap(44) }} data-testid="playback-controls">
      <Tune />
    </IconButton>
  );

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
        disabled={loading && !buffering}
        color="primary"
        aria-label={playing || buffering
          ? t("audiobook.pause")
          : t("audiobook.play")}
        // Unavailable audio looks it, yet stays tappable: Play retries.
        sx={{ width: tap(48), height: tap(48) }}
      >
        {loading
          ? <CircularProgress size={rem(32)} color="inherit" />
          : playing || buffering
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
      sx={{
        minWidth: 36,
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {fmtTime(scrub.value)}
    </Typography>
  );
  const scrubber = (
    <Slider
      min={0}
      max={duration || 1}
      value={Math.min(scrub.value, duration || 1)}
      onChange={scrub.onChange}
      onChangeCommitted={scrub.onChangeCommitted}
      disabled={duration === 0}
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
    <DockPortal slot="accessory">
      <Box
        ref={transportRef}
        data-lv-playback-bar="true"
        sx={{
          // The dock is the material; this row only draws its top edge.
          borderTop: 1,
          borderColor: "divider",
          pl: "max(env(safe-area-inset-left, 0px), 12px)",
          pr: "max(env(safe-area-inset-right, 0px), 12px)",
          // Symmetric breathing room; with the bar directly below in the same
          // dock, the bar drops its own top padding instead.
          pt: SLAB_PAD_Y,
          pb: navbarAtBottom
            ? 0
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
              <PlaybackPreparation timeline={duration > 0}>{timeStart}{scrubber}{timeEnd}</PlaybackPreparation>
              <Box sx={earSx}>
                <SpeedChip />
              </Box>
              <Box sx={earSx}>
                <SleepChip />
              </Box>
              <Box sx={earSx}>{controlsBtn}</Box>
            </Box>
          )
          : (
            <>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box sx={earSx}>{followBtn}</Box>
                <PlaybackPreparation timeline={duration > 0}>{timeStart}{scrubber}{timeEnd}</PlaybackPreparation>
                <Box sx={earSx}>{controlsBtn}</Box>
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
    </DockPortal>
  );
}
