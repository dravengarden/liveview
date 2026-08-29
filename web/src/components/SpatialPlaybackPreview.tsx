import { rem } from "@/px";
import { LIVEVIEW_BRAND, LIVEVIEW_RADII } from "@/brand";
import { useAudioPlayer } from "@/audio/player";
import { useI18n } from "@/i18n";
import {
  Box,
  CircularProgress,
  IconButton,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { Pause, PlayArrow } from "@mui/icons-material";

/**
 * Stable playback entry point for the narrow workspace rail left visible by the
 * Cowboy-style Contents drawer. The full transport belongs to the translated
 * reader and is necessarily clipped to a few pixels there; this bounded control
 * belongs to the stationary drawer presentation instead.
 *
 * It deliberately exists even before a player session is loaded: the first tap
 * starts the current page, later taps pause/resume the existing session. That
 * keeps OTA reloads, chapter changes, and an explicitly stopped player from
 * turning the drawer's playback area into an unexplained blank strip.
 */
export function SpatialPlaybackPreview({
  onStartCurrent,
}: {
  readonly onStartCurrent: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { nowPlaying, playing, loading, togglePlay } = useAudioPlayer();
  const loaded = nowPlaying !== null;
  const theme = useTheme();
  const wideRail = useMediaQuery(theme.breakpoints.up("sm"));
  const label = loaded
    ? playing ? t("audiobook.pause") : t("audiobook.play")
    : t("audiobook.readAloud");

  // A tablet leaves enough of the translated reader visible for the complete
  // transport. Keep this control only as its idle-state launcher there, then
  // yield as soon as that transport mounts. Phones always need the compact
  // stationary control because only a 48-64 px rail remains visible.
  if (wideRail && loaded) return <></>;

  return (
    <Box
      data-lv-spatial-playback-preview
      data-state={loading
        ? "loading"
        : playing
        ? "playing"
        : loaded
        ? "paused"
        : "ready"}
      sx={{
        width: 52,
        minHeight: 76,
        py: 0.75,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 0.5,
        border: 1,
        borderColor: (theme) =>
          alpha(
            theme.palette.common.white,
            theme.palette.mode === "dark" ? 0.14 : 0.72,
          ),
        borderRadius: `${LIVEVIEW_RADII.control + 6}px`,
        bgcolor: (theme) =>
          alpha(
            theme.palette.background.paper,
            theme.palette.mode === "dark" ? 0.96 : 0.97,
          ),
        boxShadow: (theme) =>
          [
            `0 12px 30px ${
              alpha(
                theme.palette.common.black,
                theme.palette.mode === "dark" ? 0.34 : 0.16,
              )
            }`,
            `inset 0 1px 0 ${
              alpha(
                theme.palette.common.white,
                theme.palette.mode === "dark" ? 0.12 : 0.78,
              )
            }`,
          ].join(", "),
      }}
    >
      <IconButton
        aria-label={label}
        onClick={loaded ? togglePlay : onStartCurrent}
        sx={{
          width: 44,
          height: 44,
          color: playing ? LIVEVIEW_BRAND.activity : "primary.main",
          "&:active": { transform: "scale(0.92)" },
        }}
      >
        {loading
          ? <CircularProgress size={rem(24)} color="inherit" />
          : playing
          ? <Pause sx={{ fontSize: rem(27) }} />
          : <PlayArrow sx={{ fontSize: rem(29) }} />}
      </IconButton>
      <Box
        aria-hidden
        sx={{
          width: playing ? 16 : 5,
          height: 4,
          borderRadius: 999,
          bgcolor: playing ? LIVEVIEW_BRAND.activity : "divider",
          transition: "width 160ms ease, background-color 160ms ease",
        }}
      />
    </Box>
  );
}
