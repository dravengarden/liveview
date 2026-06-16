import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Skeleton } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { PlaybackBar } from "./PlaybackBar";
import { ScrollToTopButton } from "./ScrollToTopButton";
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
  /** Footer under the read-along text — the prev/next <ChapterPager>. */
  footer?: React.ReactNode;
}

/** The full read-along reader for the currently-playing chapter: the spoken text
 *  with the narrated sentence highlighted, an explicit (cancelable) follow mode,
 *  and the shared <PlaybackBar> transport. All playback state comes from the root
 *  audio engine, so this view is purely a window onto it — leaving it never stops
 *  the audio. */
export function AudiobookPlayer(
  { contentMaxWidth, lineHeight, navbarAtBottom = false, onSaveScroll, footer }:
    AudiobookPlayerProps,
): React.JSX.Element {
  const { t } = useI18n();
  const {
    nowPlaying,
    sentences,
    currentIdx,
    currentProgress,
    error,
    currentTime,
    duration,
    seekToSentence,
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

  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        // The <PlaybackBar> is a frosted overlay pinned to this box's bottom, so
        // this is its positioning context (already relative) and carries the
        // published --lv-transport-h the scroller pads by.
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
        // (scrollReaderBottom in App.tsx) and the scroll-to-top FAB find and
        // scroll it — the same `[data-lv-scroller="reader"]` hook the text reader
        // (MarkdownViewer) uses. Without this the gesture was a no-op here.
        data-lv-scroller="reader"
        onWheel={cancelFollow}
        onTouchMove={cancelFollow}
        // Horizontal padding IS the reading MARGIN setting (same as the text
        // reader's MarkdownViewer), so the read-along gutter tracks Settings →
        // Reading → Margin instead of a hardcoded value.
        sx={{
          flex: 1,
          overflowY: "auto",
          px: `${contentMaxWidth}px`,
          pt: 4,
          // Foot space clears BOTH overlays the read-along scrolls under: the
          // frosted transport pinned to this box's bottom (--lv-transport-h) and
          // the NavShell frosted bar below it (--shell-bar-h). Both are 0 before
          // measured / on the solid (desktop) path, leaving the base py:4.
          pb:
            "calc(32px + var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))",
          // Keep follow-mode centring (block:"center") and a sentence tap from
          // parking the spoken line UNDER the transport when it's near the end.
          scrollPaddingBottom:
            "calc(var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))",
        }}
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
          {sentences.length === 0
            ? (
              // No sentences yet — the chapter's text is still loading (or being
              // synthesized). Show a shimmer skeleton of text lines, NOT a blank
              // column or a lone spinner, so the read-along never reads as empty.
              <Box
                aria-label={t("audiobook.loading")}
                sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}
              >
                {[96, 88, 92, 70, 94, 84, 90, 62, 86].map((w, i) => (
                  <Skeleton
                    key={i}
                    variant="text"
                    width={`${w}%`}
                    sx={{ fontSize: "1.2rem" }}
                  />
                ))}
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
                  sx={(theme) => {
                    const active = i === currentIdx;
                    // Read-along highlight in THIS theme's accent (blue / brown /
                    // amber / violet per theme). Three things make it read well on
                    // every surface:
                    //  • per-theme accent (not a fixed colour) so it never clashes;
                    //  • stronger on DARK themes — a low-alpha accent over near-black
                    //    just muddies, so dark surfaces get more of the accent;
                    //  • non-current sentences DIMMED so the current line pops even
                    //    before the band (the Apple-Books focus pattern); and
                    //  • a karaoke read-so-far WIPE within the current sentence: a
                    //    hard edge at the playhead's within-sentence fraction, the
                    //    read part stronger than the not-yet part.
                    const dark = theme.palette.mode === "dark";
                    const accent = theme.palette.primary.main;
                    const weak = alpha(accent, dark ? 0.16 : 0.1);
                    const strong = alpha(accent, dark ? 0.42 : 0.26);
                    const p = Math.round(currentProgress * 1000) / 10; // 0–100
                    const wipe = `linear-gradient(to right, ${strong} ${p}%, ${weak} ${
                      Math.min(100, p + 1.5)
                    }%)`;
                    return {
                      cursor: "pointer",
                      borderRadius: 0.5,
                      transition: "opacity 0.15s ease",
                      background: active ? wipe : "transparent",
                      opacity: active ? 1 : 0.5,
                      color: "inherit",
                      px: active ? 0.25 : 0,
                      "&:hover": {
                        background: active ? wipe : theme.palette.action.hover,
                        opacity: active ? 1 : 0.78,
                      },
                    };
                  }}
                >
                  {s}
                  {" "}
                </Box>
              ))
            )}
          {/* Prev/next chapter pager — inside the centred reading column. */}
          {footer}
        </Box>
      </Box>

      {/* Reliable "back to chapter top": iOS reserves the status-bar tap (and it
          never reaches an inner scroll container anyway), so the read-along needs
          the same explicit FAB the text reader has. Lifted above BOTH the
          transport (--lv-transport-h) and the nav bar (--shell-bar-h). */}
      <ScrollToTopButton
        targetRef={scrollRef}
        bottomLift="calc(var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))"
      />

      <PlaybackBar
        navbarAtBottom={navbarAtBottom}
        follow={{
          following,
          onToggle: () => (following ? setFollowing(false) : jumpToCurrent()),
        }}
      />
    </Box>
  );
}
