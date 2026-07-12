import { rem } from "@/px";
import { coverSrc, recoverCoverImage } from "@/native-sync";
import {
  Box,
  ButtonBase,
  CircularProgress,
  IconButton,
  LinearProgress,
  Typography,
} from "@mui/material";
import {
  Headphones as AudiobookIcon,
  Pause,
  PlayArrow,
  SkipNext,
  SkipPrevious,
} from "@mui/icons-material";
import { useAudioPlayer, useAudioTime } from "@/audio/player";
import { useI18n } from "@/i18n";

/** Stable hue from a slug → a calm gradient stand-in cover (mirrors the shelf). */
function coverGradient(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `linear-gradient(135deg, hsl(${hue} 52% 52%), hsl(${
    (hue + 38) % 360
  } 48% 42%))`;
}

/**
 * The persistent bottom now-playing bar — the collapsed (脱离 focus) state of the
 * listen plane. Lives at the app root (its own row, so it pushes content up
 * rather than overlapping it) and stays put across every navigation: it IS the
 * "audio doesn't stop when you move around" surface and the handle back into the
 * full popup. Tapping the title/cover expands the popup; the buttons drive
 * playback and chapter nav. Hidden while the popup is already in focus (expanded)
 * and whenever nothing is loaded.
 *
 * Scoped to the playing book's own page: `onPlayingPage` is true only when the
 * book currently being browsed IS the one playing. Anywhere else (another book,
 * the shelf) the full bar is just in the way, so it yields to the floating
 * bubble ({@link FloatingBubble}) instead — the two are mutually exclusive.
 */
export function MiniPlayer(
  { onPlayingPage }: { onPlayingPage: boolean },
): React.JSX.Element | null {
  const { t } = useI18n();
  const {
    nowPlaying,
    expanded,
    setExpanded,
    playing,
    loading,
    canPrev,
    canNext,
    togglePlay,
    nextChapter,
    prevChapter,
  } = useAudioPlayer();
  const { currentTime, duration } = useAudioTime();

  if (expanded || !nowPlaying || !onPlayingPage) return null;

  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <Box
      sx={{
        flexShrink: 0,
        position: "relative",
        borderTop: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        // Clear the iPhone home indicator / landscape rounded corners; floor the
        // sides to 12px so the cover (left) and next-chapter button (right) sit
        // off the corner radius (mirrors cowboy's composer edge discipline).
        pb: "max(calc(env(safe-area-inset-bottom, 0px) - 8px), 4px)",
        pl: "max(env(safe-area-inset-left, 0px), 12px)",
        pr: "max(env(safe-area-inset-right, 0px), 12px)",
        pt: 0.5,
      }}
    >
      {/* Hairline progress along the very top edge of the bar. */}
      <LinearProgress
        variant="determinate"
        value={pct}
        aria-hidden
        sx={{ position: "absolute", top: 0, left: 0, right: 0, height: 2 }}
      />
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        {
          /* Cover + title: the tap target that re-opens the reader. ButtonBase so
            it's a real MUI button with a ripple. */
        }
        <ButtonBase
          aria-label={t("audiobook.openPlayer")}
          onClick={() => setExpanded(true)}
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            textAlign: "left",
            gap: 1.25,
            flex: 1,
            minWidth: 0,
            borderRadius: 1,
            py: 0.5,
            "&:hover": { opacity: 0.85 },
          }}
        >
          <Box
            sx={{
              flexShrink: 0,
              width: 40,
              height: 40,
              borderRadius: 1,
              overflow: "hidden",
              position: "relative",
              background: coverGradient(nowPlaying.bookSlug),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <AudiobookIcon
              sx={{ fontSize: rem(22), color: "rgba(255,255,255,0.92)" }}
            />
            <Box
              component="img"
              src={coverSrc(nowPlaying.bookSlug)}
              alt=""
              onError={(event) =>
                recoverCoverImage(
                  event.currentTarget,
                  nowPlaying.bookSlug,
                )}
              sx={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          </Box>
          <Box sx={{ minWidth: 0 }}>
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
        </ButtonBase>

        {
          /* Transport: prev / play-pause / next chapter. Uniform 40px targets
            (play 44px for emphasis) with a gap so they aren't cramped on iOS —
            the same touch ergonomics as cowboy's composer action row. */
        }
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            gap: 0.5,
          }}
        >
          <IconButton
            aria-label={t("audiobook.prevChapter")}
            onClick={prevChapter}
            disabled={!canPrev}
            sx={{ width: 52, height: 52 }}
          >
            <SkipPrevious sx={{ fontSize: rem(34) }} />
          </IconButton>
          <IconButton
            aria-label={playing ? t("audiobook.pause") : t("audiobook.play")}
            onClick={togglePlay}
            color="primary"
            sx={{ width: 60, height: 60 }}
          >
            {loading
              ? <CircularProgress size={rem(39)} color="inherit" />
              : playing
              ? <Pause sx={{ fontSize: rem(39) }} />
              : <PlayArrow sx={{ fontSize: rem(39) }} />}
          </IconButton>
          <IconButton
            aria-label={t("audiobook.nextChapter")}
            onClick={nextChapter}
            disabled={!canNext}
            sx={{ width: 52, height: 52 }}
          >
            <SkipNext sx={{ fontSize: rem(34) }} />
          </IconButton>
        </Box>
      </Box>
    </Box>
  );
}
