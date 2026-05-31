import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  IconButton,
  CircularProgress,
  Alert,
  Typography,
  Slider,
  Select,
  MenuItem,
} from "@mui/material";
import {
  PlayArrow,
  Pause,
  SkipNext,
  SkipPrevious,
  Replay10,
  Forward10,
  MyLocation,
  Bedtime,
  Speed,
} from "@mui/icons-material";
import { useAudioPlayer } from "@/audio/player";
import { useI18n } from "@/i18n";

interface AudiobookPlayerProps {
  contentMaxWidth: number;
  lineHeight: number;
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

/** The full read-along reader for the currently-playing chapter: the spoken text
 *  with the narrated sentence highlighted, an explicit (cancelable) follow mode,
 *  and the transport. All playback state comes from the root audio engine, so
 *  this view is purely a window onto it — leaving it never stops the audio. */
export function AudiobookPlayer({ contentMaxWidth, lineHeight }: AudiobookPlayerProps): React.JSX.Element {
  const { t } = useI18n();
  const {
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
    setSleepTimer,
    nextChapter,
    prevChapter,
  } = useAudioPlayer();

  const scrollRef = useRef<HTMLDivElement>(null);
  // Explicit follow: ON auto-scrolls the spoken line to centre; a genuine user
  // scroll GESTURE turns it OFF (we don't fight the reader), and the follow
  // button / a sentence tap turns it back ON.
  const [following, setFollowing] = useState(true);

  const scrollCurrentIntoView = useCallback(() => {
    const container = scrollRef.current;
    if (!container || currentIdx < 0) return;
    const el = container.querySelector<HTMLElement>(`[data-sent="${currentIdx}"]`);
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
    [seekToSentence]
  );

  const onSeekBar = useCallback(
    (_e: Event, value: number | number[]) => {
      seek(Array.isArray(value) ? (value[0] ?? 0) : value);
    },
    [seek]
  );

  return (
    <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {error && (
        <Alert severity="error" square sx={{ py: 0.25 }}>
          {t("audiobook.error", { error })}
        </Alert>
      )}

      <Box
        ref={scrollRef}
        onWheel={cancelFollow}
        onTouchMove={cancelFollow}
        sx={{ flex: 1, overflowY: "auto", px: 3, py: 4 }}
      >
        <Box
          sx={{
            maxWidth: contentMaxWidth > 0 ? contentMaxWidth : "none",
            mx: "auto",
            fontFamily: "var(--lv-reading-font)",
            lineHeight,
            fontSize: "1.05rem",
          }}
        >
          {loading && sentences.length === 0 ? (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, color: "text.secondary" }}>
              <CircularProgress size={20} />
              <Typography>{t("audiobook.loading")}</Typography>
            </Box>
          ) : (
            sentences.map((s, i) => (
              <Box
                component="span"
                // Index key is safe: sentence order is stable for a chapter.
                key={i}
                data-sent={i}
                onClick={() => {
                  handleSentenceClick(i);
                }}
                sx={{
                  cursor: "pointer",
                  borderRadius: 0.5,
                  transition: "background-color 0.15s ease",
                  bgcolor: i === currentIdx ? "warning.main" : "transparent",
                  color: i === currentIdx ? "warning.contrastText" : "inherit",
                  px: i === currentIdx ? 0.25 : 0,
                  "&:hover": { bgcolor: i === currentIdx ? "warning.main" : "action.hover" },
                }}
              >
                {s}{" "}
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
          pt: 0.5,
          // Trimmed bottom: sit ~8px tighter than the home-indicator inset
          // (floored to 4px on devices without one) so the bar isn't bottom-heavy.
          pb: "max(calc(env(safe-area-inset-bottom, 0px) - 8px), 4px)",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
          <Typography variant="caption" sx={{ minWidth: 40, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
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
          <Typography variant="caption" sx={{ minWidth: 40, fontVariantNumeric: "tabular-nums" }}>
            {fmtTime(duration)}
          </Typography>
        </Box>
        {/* Transport: follow pinned absolute-left so the play cluster stays
            optically centred; touch-sized controls (from the sizing sweep). */}
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 0.25, position: "relative", minHeight: 58 }}>
          <IconButton
            aria-label={following ? t("audiobook.following") : t("audiobook.follow")}
            onClick={() => (following ? setFollowing(false) : jumpToCurrent())}
            color={following ? "primary" : "default"}
            sx={{ position: "absolute", left: 0, width: 50, height: 50 }}
          >
            <MyLocation sx={{ fontSize: 29 }} />
          </IconButton>
          <IconButton aria-label={t("audiobook.prevChapter")} onClick={prevChapter} disabled={!canPrev} sx={{ width: 50, height: 50 }}>
            <SkipPrevious sx={{ fontSize: 33 }} />
          </IconButton>
          <IconButton aria-label={t("audiobook.skipBack")} onClick={() => skip(-10)} sx={{ width: 50, height: 50 }}>
            <Replay10 sx={{ fontSize: 30 }} />
          </IconButton>
          <IconButton
            onClick={togglePlay}
            disabled={loading}
            color="primary"
            aria-label={playing ? t("audiobook.pause") : t("audiobook.play")}
            sx={{ width: 58, height: 58 }}
          >
            {loading ? <CircularProgress size={32} /> : playing ? <Pause sx={{ fontSize: 38 }} /> : <PlayArrow sx={{ fontSize: 38 }} />}
          </IconButton>
          <IconButton aria-label={t("audiobook.skipForward")} onClick={() => skip(10)} sx={{ width: 50, height: 50 }}>
            <Forward10 sx={{ fontSize: 30 }} />
          </IconButton>
          <IconButton aria-label={t("audiobook.nextChapter")} onClick={nextChapter} disabled={!canNext} sx={{ width: 50, height: 50 }}>
            <SkipNext sx={{ fontSize: 33 }} />
          </IconButton>
        </Box>

        {/* Speed + sleep timer as standard outlined Select dropdowns — a proper,
            recognizable control (leading icon · value · caret) rather than a bare
            glyph, on their own centred row so the transport above stays clean. */}
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1.5, pt: 0.5 }}>
          <Select
            size="small"
            value={rate}
            onChange={(e) => {
              setRate(Number(e.target.value));
            }}
            aria-label={t("audiobook.speed")}
            renderValue={(v) => (
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                <Speed fontSize="small" />
                <span>{v}×</span>
              </Box>
            )}
            sx={{ minWidth: 92, minHeight: 44, "& .MuiSelect-select": { display: "flex", alignItems: "center", py: 0.75 } }}
          >
            {RATES.map((r) => (
              <MenuItem key={r} value={r}>
                {r}×
              </MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            value={sleepMinutes}
            onChange={(e) => {
              setSleepTimer(Number(e.target.value));
            }}
            aria-label={t("audiobook.sleepTimer")}
            renderValue={(v) => (
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, color: v > 0 ? "primary.main" : "inherit" }}>
                <Bedtime fontSize="small" />
                <span>{v > 0 ? t("audiobook.sleepMinutes", { n: v }) : t("audiobook.sleepOff")}</span>
              </Box>
            )}
            sx={{ minWidth: 116, minHeight: 44, "& .MuiSelect-select": { display: "flex", alignItems: "center", py: 0.75 } }}
          >
            <MenuItem value={0}>{t("audiobook.sleepOff")}</MenuItem>
            {SLEEP_MINUTES.map((m) => (
              <MenuItem key={m} value={m}>
                {t("audiobook.sleepMinutes", { n: m })}
              </MenuItem>
            ))}
          </Select>
        </Box>
      </Box>
    </Box>
  );
}
