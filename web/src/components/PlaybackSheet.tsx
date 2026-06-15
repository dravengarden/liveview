import { rem, tap } from "@/px";
import { useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Slider,
  Typography,
} from "@mui/material";
import {
  Cast as CastIcon,
  Pause,
  PlayArrow,
  SkipNext,
  SkipPrevious,
} from "@mui/icons-material";
import { Forward15Icon, Replay15Icon } from "./Skip15Icons";
import { CoverTile } from "./CoverTile";
import { BottomSheet } from "../_shell";
import { SleepChip, SpeedChip, fmtTime } from "@/audio/playback-ui";
import { useAudioPlayer } from "@/audio/player";
import { useI18n } from "@/i18n";

// The ONE portable playback panel. Whatever is playing — read-aloud of a text
// chapter or a pre-generated audiobook — this is the single surface that holds
// the full transport (scrubber, play/pause, skip ±15, prev/next chapter) plus
// the playback CONFIG (speed, sleep). It is opened identically from the navbar
// listen control (while reading text) and the floating now-playing bubble (while
// browsing away), so there is exactly one place — and one look — for these
// controls regardless of mode. The dedicated audio read-along page keeps its own
// inline transport (it IS the expanded view); this sheet is for everywhere else.

export function PlaybackSheet({
  open,
  onClose,
  onGoToNowPlaying,
}: {
  open: boolean;
  onClose: () => void;
  /** Navigate to the currently-playing chapter (audio page or the text chapter),
   *  decided by the host. Null hides the "go to" action (already there). */
  onGoToNowPlaying?: (() => void) | undefined;
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
    skip,
    seek,
    prevChapter,
    nextChapter,
    playingElsewhere,
    playHere,
    stop,
  } = useAudioPlayer();
  // Stop drops the now-playing + resume position, so it asks first (a stray tap
  // mid-listen shouldn't wipe progress). Inline two-step, no nested sheet.
  const [confirmStop, setConfirmStop] = useState(false);

  // Keep the sheet mounted but inert when nothing plays (it can't open then).
  if (!nowPlaying) return null;

  const chipSx = {
    bgcolor: "action.hover",
    borderRadius: 999,
    px: 1.5,
    minWidth: 72,
  } as const;

  // A labelled config control (speed / sleep), stacked under a caption so the
  // bare value chip reads clearly out of the transport's context.
  const labelled = (label: string, control: React.ReactNode): React.JSX.Element => (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.5,
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      {control}
    </Box>
  );

  return (
    <BottomSheet open={open} onClose={onClose} title={t("audiobook.playback")}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5, pb: 1 }}>
        {/* Cover + what's playing */}
        <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
          <CoverTile
            slug={nowPlaying.bookSlug}
            hasCover={nowPlaying.cover}
            size={56}
          />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} noWrap>
              {nowPlaying.chapterLabel}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap
              sx={{ display: "block" }}
            >
              {playingElsewhere
                ? t("audiobook.playingElsewhere", { device: playingElsewhere.label })
                : nowPlaying.bookLabel}
            </Typography>
          </Box>
        </Box>

        {/* Scrubber */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontVariantNumeric: "tabular-nums", minWidth: 36 }}
          >
            {fmtTime(currentTime)}
          </Typography>
          <Slider
            size="small"
            min={0}
            max={duration || 0}
            value={Math.min(currentTime, duration || 0)}
            onChange={(_e, v) => seek(Number(v))}
            aria-label={t("audiobook.seek")}
            sx={{ flex: 1 }}
          />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right" }}
          >
            {fmtTime(duration)}
          </Typography>
        </Box>

        {/* Transport */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 1,
          }}
        >
          <IconButton
            onClick={prevChapter}
            disabled={!canPrev}
            aria-label={t("audiobook.prevChapter")}
            sx={{ width: tap(48), height: tap(48) }}
          >
            <SkipPrevious sx={{ fontSize: rem(26) }} />
          </IconButton>
          <IconButton
            onClick={() => skip(-15)}
            aria-label={t("audiobook.skipBack")}
            sx={{ width: tap(48), height: tap(48) }}
          >
            <Replay15Icon sx={{ fontSize: rem(26) }} />
          </IconButton>
          <IconButton
            onClick={() => (playingElsewhere ? playHere() : togglePlay())}
            aria-label={playing ? t("audiobook.pause") : t("audiobook.play")}
            sx={{
              width: tap(64),
              height: tap(64),
              bgcolor: "primary.main",
              color: "primary.contrastText",
              "&:hover": { bgcolor: "primary.dark" },
            }}
          >
            {loading
              ? <CircularProgress size={26} color="inherit" />
              : playingElsewhere
              ? <CastIcon sx={{ fontSize: rem(30) }} />
              : playing
              ? <Pause sx={{ fontSize: rem(34) }} />
              : <PlayArrow sx={{ fontSize: rem(34) }} />}
          </IconButton>
          <IconButton
            onClick={() => skip(15)}
            aria-label={t("audiobook.skipForward")}
            sx={{ width: tap(48), height: tap(48) }}
          >
            <Forward15Icon sx={{ fontSize: rem(26) }} />
          </IconButton>
          <IconButton
            onClick={nextChapter}
            disabled={!canNext}
            aria-label={t("audiobook.nextChapter")}
            sx={{ width: tap(48), height: tap(48) }}
          >
            <SkipNext sx={{ fontSize: rem(26) }} />
          </IconButton>
        </Box>

        {/* Config: speed + sleep — the two settings the user kept hunting for */}
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-around",
            alignItems: "flex-start",
          }}
        >
          {labelled(t("audiobook.speed"), <SpeedChip sx={chipSx} />)}
          {labelled(t("audiobook.sleepTimer"), <SleepChip sx={chipSx} />)}
        </Box>

        {/* Footer: jump-to-current (when away) + stop (inline confirm). */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
            mt: 0.5,
          }}
        >
          {onGoToNowPlaying
            ? (
              <Button
                variant="text"
                onClick={() => {
                  onClose();
                  onGoToNowPlaying();
                }}
              >
                {t("audiobook.goToCurrent")}
              </Button>
            )
            : <span />}
          {confirmStop
            ? (
              <Box sx={{ display: "flex", gap: 0.5 }}>
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => setConfirmStop(false)}
                >
                  {t("audiobook.cancel")}
                </Button>
                <Button
                  size="small"
                  color="error"
                  variant="contained"
                  onClick={() => {
                    setConfirmStop(false);
                    stop();
                    onClose();
                  }}
                >
                  {t("audiobook.stop")}
                </Button>
              </Box>
            )
            : (
              <Button
                variant="text"
                color="error"
                onClick={() => setConfirmStop(true)}
              >
                {t("audiobook.stop")}
              </Button>
            )}
        </Box>
      </Box>
    </BottomSheet>
  );
}
