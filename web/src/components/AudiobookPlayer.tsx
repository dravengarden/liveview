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
  Button,
} from "@mui/material";
import {
  PlayArrow,
  Pause,
  SkipNext,
  SkipPrevious,
  Replay10,
  Forward10,
  MyLocation,
  KeyboardArrowDown,
  KeyboardArrowUp,
  Bedtime,
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
  // scroll GESTURE turns it OFF (we don't fight the reader), and the jump pill /
  // a sentence tap turns it back ON.
  const [following, setFollowing] = useState(true);
  // Whether the spoken line currently sits above or below the viewport, so the
  // jump pill can point the right way.
  const [lineDir, setLineDir] = useState<"up" | "down" | null>(null);

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

  // Track whether the current line is off-screen (and which way) to drive the
  // jump pill, but only while NOT following (when following it's always centred).
  const updateLineDir = useCallback(() => {
    const container = scrollRef.current;
    if (!container || currentIdx < 0) {
      setLineDir(null);
      return;
    }
    const el = container.querySelector<HTMLElement>(`[data-sent="${currentIdx}"]`);
    if (!el) {
      setLineDir(null);
      return;
    }
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.bottom < cRect.top + 8) setLineDir("up");
    else if (eRect.top > cRect.bottom - 8) setLineDir("down");
    else setLineDir(null);
  }, [currentIdx]);

  useEffect(() => {
    if (!following) updateLineDir();
  }, [currentIdx, following, updateLineDir]);

  // Position-only: keep the jump pill's direction current. Runs on every scroll
  // (programmatic or not) — it must NOT cancel follow (our own scrollIntoView
  // fires scroll events too).
  const onScroll = useCallback(() => {
    updateLineDir();
  }, [updateLineDir]);

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

  const showJumpPill = !following && lineDir !== null;

  return (
    <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {error && (
        <Alert severity="error" square sx={{ py: 0.25 }}>
          {t("audiobook.error", { error })}
        </Alert>
      )}

      <Box
        ref={scrollRef}
        onScroll={onScroll}
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

      {/* "Jump to the spoken line" pill — appears only when follow is off and the
          line has scrolled off-screen; tapping re-engages follow. */}
      {showJumpPill && (
        <Button
          variant="contained"
          size="small"
          onClick={jumpToCurrent}
          startIcon={lineDir === "up" ? <KeyboardArrowUp /> : <KeyboardArrowDown />}
          sx={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: 88,
            borderRadius: 999,
            boxShadow: 4,
            textTransform: "none",
            zIndex: 2,
          }}
        >
          {t("audiobook.jumpToLine")}
        </Button>
      )}

      {/* Transport: scrubber row + control row. */}
      <Box
        sx={{
          borderTop: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          // Floor the sides off the landscape corner radius (the follow + sleep
          // controls sit at the edges) — matches cowboy's edge discipline.
          pl: "max(env(safe-area-inset-left, 0px), 16px)",
          pr: "max(env(safe-area-inset-right, 0px), 16px)",
          pt: 1,
          pb: "max(env(safe-area-inset-bottom, 0px), 8px)",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <Typography variant="caption" sx={{ minWidth: 40, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {fmtTime(currentTime)}
          </Typography>
          <Slider
            size="small"
            min={0}
            max={duration || 1}
            value={Math.min(currentTime, duration || 1)}
            onChange={onSeekBar}
            disabled={loading || duration === 0}
            sx={{ flex: 1 }}
            aria-label={t("audiobook.seek")}
          />
          <Typography variant="caption" sx={{ minWidth: 40, fontVariantNumeric: "tabular-nums" }}>
            {fmtTime(duration)}
          </Typography>
          <Select
            size="small"
            variant="standard"
            disableUnderline
            value={rate}
            onChange={(e) => {
              setRate(Number(e.target.value));
            }}
            aria-label={t("audiobook.speed")}
            renderValue={(v) => `${v}×`}
            // No dropdown caret — the value itself is the affordance (the whole
            // chip is tappable); the triangle is visual noise.
            IconComponent={() => null}
            sx={{ "& .MuiSelect-select": { py: 0.5, pr: "0 !important", fontWeight: 600, fontSize: "0.8rem" } }}
          >
            {RATES.map((r) => (
              <MenuItem key={r} value={r} dense>
                {r}×
              </MenuItem>
            ))}
          </Select>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 0.75 }}>
          <IconButton
            aria-label={following ? t("audiobook.following") : t("audiobook.follow")}
            onClick={() => (following ? setFollowing(false) : jumpToCurrent())}
            color={following ? "primary" : "default"}
            sx={{ mr: "auto" }}
          >
            <MyLocation />
          </IconButton>
          <IconButton aria-label={t("audiobook.prevChapter")} onClick={prevChapter} disabled={!canPrev}>
            <SkipPrevious />
          </IconButton>
          <IconButton aria-label={t("audiobook.skipBack")} onClick={() => skip(-10)}>
            <Replay10 />
          </IconButton>
          <IconButton onClick={togglePlay} disabled={loading} color="primary" aria-label={playing ? t("audiobook.pause") : t("audiobook.play")}>
            {loading ? <CircularProgress size={24} /> : playing ? <Pause /> : <PlayArrow />}
          </IconButton>
          <IconButton aria-label={t("audiobook.skipForward")} onClick={() => skip(10)}>
            <Forward10 />
          </IconButton>
          <IconButton aria-label={t("audiobook.nextChapter")} onClick={nextChapter} disabled={!canNext}>
            <SkipNext />
          </IconButton>
          {/* Sleep timer — balances the follow button (keeps the transport
              centred) and doubles as the "auto-pause after N minutes" control.
              Off shows just the muted moon; armed shows the moon + minutes. */}
          <Select
            size="small"
            variant="standard"
            disableUnderline
            value={sleepMinutes}
            onChange={(e) => {
              setSleepTimer(Number(e.target.value));
            }}
            aria-label={t("audiobook.sleepTimer")}
            // No dropdown caret — the moon (+ minutes when armed) is the whole
            // affordance; the triangle is visual noise.
            IconComponent={() => null}
            renderValue={(v) => (
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.25, color: v > 0 ? "primary.main" : "text.secondary" }}>
                <Bedtime sx={{ fontSize: 19 }} />
                {v > 0 && (
                  <Typography variant="caption" fontWeight={700}>
                    {v}
                  </Typography>
                )}
              </Box>
            )}
            sx={{ ml: "auto", "& .MuiSelect-select": { py: 0.5, pr: "0 !important" } }}
          >
            <MenuItem value={0} dense>
              {t("audiobook.sleepOff")}
            </MenuItem>
            {SLEEP_MINUTES.map((m) => (
              <MenuItem key={m} value={m} dense>
                {t("audiobook.sleepMinutes", { n: m })}
              </MenuItem>
            ))}
          </Select>
        </Box>
      </Box>
    </Box>
  );
}
