import { useCallback, useEffect, useRef, useState } from "react";
import { Box, IconButton, CircularProgress, Alert, Typography, Slider, Tooltip } from "@mui/material";
import { PlayArrow, Pause } from "@mui/icons-material";
import { useAudiobook } from "@/hooks/useAudiobook";
import { useI18n } from "@/i18n";

interface AudiobookPlayerProps {
  /** Virtual chapter path (`<slug>/<file>.md`). */
  currentPath: string;
  /** Selected edition; narration uses the served edition (overlay → base). */
  lang: string;
  contentMaxWidth: number;
  lineHeight: number;
}

const RATES = [0.75, 1, 1.25, 1.5, 2];
// Don't fight a reader who scrolled by hand: suspend auto-follow this long after
// their last manual scroll.
const MANUAL_SCROLL_GRACE_MS = 4000;

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Audiobook read-along: the spoken text with the narrated sentence highlighted
 *  and auto-scrolled into view (WeChat-Read style), plus a transport bar. */
export function AudiobookPlayer({
  currentPath,
  lang,
  contentMaxWidth,
  lineHeight,
}: AudiobookPlayerProps): React.JSX.Element {
  const { t } = useI18n();
  const { sentences, currentIdx, playing, loading, error, rate, audioRef, togglePlay, seekToSentence, setRate } =
    useAudiobook(currentPath, lang);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Distinguish our own smooth-scroll from the reader's: ignore scroll events
  // fired while `autoScrolling` is set, and pause auto-follow for a grace
  // period after a genuine manual scroll.
  const autoScrolling = useRef(false);
  const lastManualScroll = useRef(0);

  // Transport-bar position (separate lightweight listeners; the hook owns the
  // sentence mapping).
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const onTime = (): void => {
      setCur(audio.currentTime);
    };
    const onMeta = (): void => {
      setDur(audio.duration);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
    };
  }, [audioRef]);

  // Follow the spoken sentence: scroll it to center unless the reader just
  // scrolled by hand.
  useEffect(() => {
    if (currentIdx < 0) return;
    const container = scrollRef.current;
    if (!container) return;
    if (Date.now() - lastManualScroll.current < MANUAL_SCROLL_GRACE_MS) return;
    const el = container.querySelector<HTMLElement>(`[data-sent="${currentIdx}"]`);
    if (!el) return;
    autoScrolling.current = true;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => {
      autoScrolling.current = false;
    }, 700);
  }, [currentIdx]);

  const onScroll = useCallback(() => {
    if (!autoScrolling.current) {
      lastManualScroll.current = Date.now();
    }
  }, []);

  const onSeekBar = useCallback(
    (_e: Event, value: number | number[]) => {
      const audio = audioRef.current;
      if (audio) audio.currentTime = Array.isArray(value) ? (value[0] ?? 0) : value;
    },
    [audioRef]
  );

  const cycleRate = useCallback(() => {
    const i = RATES.indexOf(rate);
    setRate(RATES[(i + 1) % RATES.length] ?? 1);
  }, [rate, setRate]);

  // Re-engage auto-follow when the reader presses play or jumps to a sentence.
  const handlePlay = useCallback(() => {
    lastManualScroll.current = 0;
    togglePlay();
  }, [togglePlay]);
  const handleSentenceClick = useCallback(
    (idx: number) => {
      lastManualScroll.current = 0;
      seekToSentence(idx);
    },
    [seekToSentence]
  );

  return (
    <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {error && (
        <Alert severity="error" square sx={{ py: 0.25 }}>
          {t("audiobook.error", { error })}
        </Alert>
      )}

      <Box
        ref={scrollRef}
        onScroll={onScroll}
        sx={{
          flex: 1,
          overflowY: "auto",
          px: 3,
          py: 4,
        }}
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
                {s}
                {" "}
              </Box>
            ))
          )}
        </Box>
      </Box>

      {/* Transport bar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          px: 2,
          py: 1,
          borderTop: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <IconButton onClick={handlePlay} disabled={loading} color="primary">
          {loading ? <CircularProgress size={24} /> : playing ? <Pause /> : <PlayArrow />}
        </IconButton>
        <Typography variant="caption" sx={{ minWidth: 40, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {fmtTime(cur)}
        </Typography>
        <Slider
          size="small"
          min={0}
          max={dur || 1}
          value={Math.min(cur, dur || 1)}
          onChange={onSeekBar}
          disabled={loading || dur === 0}
          sx={{ flex: 1 }}
          aria-label={t("audiobook.seek")}
        />
        <Typography variant="caption" sx={{ minWidth: 40, fontVariantNumeric: "tabular-nums" }}>
          {fmtTime(dur)}
        </Typography>
        <Tooltip title={t("audiobook.speed")}>
          <IconButton onClick={cycleRate} size="small" sx={{ minWidth: 44, borderRadius: 1.5 }}>
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {rate}×
            </Typography>
          </IconButton>
        </Tooltip>
      </Box>

      {/* Narration audio; no captions track (the read-along text is the caption). */}
      <audio ref={audioRef} preload="metadata" hidden />
    </Box>
  );
}
