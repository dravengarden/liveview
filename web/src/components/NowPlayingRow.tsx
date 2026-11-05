import { rem, tap } from "@/px";
import { Box, ButtonBase, CircularProgress, IconButton, Typography } from "@mui/material";
import { Pause, PlayArrow, Tune } from "@mui/icons-material";
import { DockPortal } from "@/_shell/bottom-dock.tsx";
import { useAudioPlayer, useAudioTime } from "@/audio/player";
import { useI18n } from "@/i18n";
import { playbackControls } from "@/signals.ts";
import { CoverTile } from "./CoverTile";

/**
 * What is playing, as a row of the current surface's bottom dock: shown while
 * audio plays somewhere the full transport is not (the shelf, another book,
 * another chapter). Tapping the title returns to the playing page; play/pause
 * is one tap; the controls button opens the shared playback sheet.
 *
 * A paused session is only a resume hint and stays out of the dock, as do
 * surfaces that already show the transport for this session.
 */
export function NowPlayingRow(
  { hidden, onGoTo }: {
    /** The current surface already represents this session. */
    hidden: boolean;
    onGoTo: () => void;
  },
): React.JSX.Element | null {
  const { t } = useI18n();
  const { nowPlaying, playing, buffering, loading, togglePlay } = useAudioPlayer();
  const shown = nowPlaying !== null && (playing || buffering) && !hidden;
  // Only the visible row follows the ~4 Hz playback clock.
  const { currentTime, duration } = useAudioTime(shown);
  if (!shown || !nowPlaying) return null;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  return (
    <DockPortal slot="accessory">
      <Box
        data-lv-now-playing
        role="region"
        aria-label={t("audiobook.nowPlaying")}
        sx={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 1,
          minHeight: tap(56),
          pl: "max(env(safe-area-inset-left, 0px), 12px)",
          pr: "max(env(safe-area-inset-right, 0px), 8px)",
          borderTop: 1,
          borderColor: "divider",
        }}
      >
        <Box
          aria-hidden
          sx={{ position: "absolute", top: -1, left: 0, height: 2, width: `${pct}%`, bgcolor: "primary.main" }}
        />
        <ButtonBase
          onClick={onGoTo}
          aria-label={t("audiobook.goToCurrent")}
          sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 1.25, justifyContent: "flex-start", py: 0.75, textAlign: "left", borderRadius: 1 }}
        >
          <CoverTile slug={nowPlaying.bookSlug} hasCover={nowPlaying.cover} size={36} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" fontWeight={650} noWrap>{nowPlaying.chapterLabel}</Typography>
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {nowPlaying.bookLabel}
            </Typography>
          </Box>
        </ButtonBase>
        <IconButton
          onClick={togglePlay}
          color="primary"
          aria-label={playing || buffering ? t("audiobook.pause") : t("audiobook.play")}
          sx={{ width: tap(44), height: tap(44) }}
        >
          {loading
            ? <CircularProgress size={rem(24)} color="inherit" />
            : playing || buffering
            ? <Pause sx={{ fontSize: rem(28) }} />
            : <PlayArrow sx={{ fontSize: rem(28) }} />}
        </IconButton>
        <IconButton
          aria-label={t("audiobook.playback")}
          onClick={() => playbackControls.emit()}
          sx={{ width: tap(44), height: tap(44) }}
        >
          <Tune />
        </IconButton>
      </Box>
    </DockPortal>
  );
}
