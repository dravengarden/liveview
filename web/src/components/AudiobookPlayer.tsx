import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Alert, Box, Skeleton } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import { PlaybackBar } from "./PlaybackBar";
import { ScrollToTopButton } from "./ScrollToTopButton";
import {
  useAudioPlayer,
  useAudioReadAlong,
  useAudioTime,
} from "@/audio/player";
import { READING_COLUMN_MAX } from "@/types";
import { useI18n } from "@/i18n";

/** Minimum spacing between shelf-progress writes during continuous playback.
 *  The progress store debounces its server push (800 ms after writes settle), so
 *  writing on every ~4 Hz clock tick kept resetting that debounce and nothing
 *  was ever saved while audio kept playing. */
const PROGRESS_SAVE_INTERVAL_MS = 5000;

/** Mirrors playback position into the shared progress store (the same store as
 *  text reading, so the shelf card shows an audio %). The only subscriber to the
 *  fast clock on this page besides the transport: it renders nothing. Writes are
 *  throttled, and the latest fraction is flushed on pause, chapter change, and
 *  unmount so a stopped session still lands its final position. */
function PlaybackProgressMirror(
  { path, playing, onSaveScroll }: {
    path: string;
    playing: boolean;
    onSaveScroll: (path: string, ratio: number) => void;
  },
): null {
  const { currentTime, duration } = useAudioTime();
  const latestRef = useRef<{ path: string; ratio: number } | null>(null);
  const savedAtRef = useRef<{ path: string; at: number } | null>(null);

  useEffect(() => {
    if (duration <= 0) return;
    const ratio = Math.min(1, currentTime / duration);
    latestRef.current = { path, ratio };
    const now = Date.now();
    const saved = savedAtRef.current;
    if (
      saved && saved.path === path && now - saved.at < PROGRESS_SAVE_INTERVAL_MS
    ) {
      return;
    }
    savedAtRef.current = { path, at: now };
    onSaveScroll(path, ratio);
  }, [currentTime, duration, path, onSaveScroll]);

  const flush = useCallback(() => {
    const latest = latestRef.current;
    if (!latest) return;
    savedAtRef.current = { path: latest.path, at: Date.now() };
    onSaveScroll(latest.path, latest.ratio);
  }, [onSaveScroll]);

  useEffect(() => {
    if (!playing) flush();
  }, [playing, flush]);
  // Cleanup runs on chapter change (before the new chapter's first write) and
  // on unmount, so the previous chapter's last fraction is never dropped.
  useEffect(() => flush, [path, flush]);
  return null;
}

/** Drives the karaoke read-so-far wipe of the ACTIVE sentence through a CSS
 *  custom property on that one span. The sentence list itself never re-renders
 *  for the ~4 Hz clock; only this null-rendering component does. */
function ReadAlongWipe(
  { containerRef, currentIdx, sentences }: {
    containerRef: RefObject<HTMLElement | null>;
    currentIdx: number;
    /** Re-resolve the active span when the transcript (re)loads. */
    sentences: string[];
  },
): null {
  const { currentProgress } = useAudioTime(currentIdx >= 0);
  const activeRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const previous = activeRef.current;
    activeRef.current = currentIdx < 0
      ? null
      : containerRef.current?.querySelector<HTMLElement>(
        `[data-sent="${currentIdx}"]`,
      ) ?? null;
    if (previous && previous !== activeRef.current) {
      previous.style.removeProperty("--lv-wipe");
    }
  }, [containerRef, currentIdx, sentences]);
  useLayoutEffect(() => {
    const el = activeRef.current;
    if (!el?.isConnected) return;
    el.style.setProperty(
      "--lv-wipe",
      `${Math.round(currentProgress * 1000) / 10}%`,
    );
  }, [currentProgress, currentIdx, sentences]);
  return null;
}

const Sentence = memo(function Sentence(
  { index, text, active, onSelect }: {
    index: number;
    text: string;
    active: boolean;
    onSelect: (event: React.MouseEvent<HTMLElement>) => void;
  },
): React.JSX.Element {
  return (
    <span
      data-sent={index}
      data-active={active ? "" : undefined}
      onClick={onSelect}
    >
      {text}{" "}
    </span>
  );
});

/** Read-along highlight, in THIS theme's accent (blue / brown / amber / violet
 *  per theme). Three things make it read well on every surface:
 *   • per-theme accent (not a fixed colour) so it never clashes;
 *   • stronger on DARK themes — a low-alpha accent over near-black just
 *     muddies, so dark surfaces get more of the accent;
 *   • non-current sentences DIMMED so the current line pops even before the
 *     band (the Apple-Books focus pattern); and
 *   • a karaoke read-so-far WIPE within the current sentence: a hard edge at the
 *     playhead's within-sentence fraction (`--lv-wipe`, written by
 *     <ReadAlongWipe>), the read part stronger than the not-yet part.
 *  Declared once on the column instead of per sentence, so a sentence change
 *  only toggles `data-active` on two spans. */
function sentenceSx(theme: Theme): Record<string, unknown> {
  const dark = theme.palette.mode === "dark";
  const accent = theme.palette.primary.main;
  const weak = alpha(accent, dark ? 0.16 : 0.1);
  const strong = alpha(accent, dark ? 0.42 : 0.26);
  const wipe =
    `linear-gradient(to right, ${strong} var(--lv-wipe, 0%), ${weak} calc(var(--lv-wipe, 0%) + 1.5%))`;
  return {
    "& [data-sent]": {
      cursor: "pointer",
      borderRadius: `${Number(theme.shape.borderRadius) * 0.5}px`,
      transition: "opacity 0.15s ease",
      background: "transparent",
      opacity: 0.5,
      color: "inherit",
      "&:hover": {
        background: theme.palette.action.hover,
        opacity: 0.78,
      },
    },
    "& [data-sent][data-active]": {
      background: wipe,
      opacity: 1,
      paddingInline: theme.spacing(0.25),
      "&:hover": { background: wipe, opacity: 1 },
    },
  };
}

const SentenceList = memo(function SentenceList(
  { sentences, currentIdx, onSelect }: {
    sentences: string[];
    currentIdx: number;
    onSelect: (event: React.MouseEvent<HTMLElement>) => void;
  },
): React.JSX.Element {
  return (
    <>
      {sentences.map((s, i) => (
        // Index key is safe: sentence order is stable for a chapter.
        <Sentence
          key={i}
          index={i}
          text={s}
          active={i === currentIdx}
          onSelect={onSelect}
        />
      ))}
    </>
  );
});

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
  const { nowPlaying, playing, error, seekToSentence } = useAudioPlayer();
  const { sentences, transcriptUnavailable, currentIdx } = useAudioReadAlong();

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

  // RETURN FROM BACKGROUND = a re-entry: re-centre on the spoken line, ALWAYS.
  // iOS suspends the page JS while backgrounded, so the follow-scroll never ran
  // and the line drifted off-screen (the engine re-syncs the audio position on
  // the same event — player.tsx). A background round-trip is not an in-app
  // scroll-away, so force `following` back on and re-centre. Read the LIVE index
  // through a ref (a stale closure would target the pre-background sentence) and
  // defer one frame so currentIdx has re-synced and the page is laid out.
  const currentIdxRef = useRef(currentIdx);
  currentIdxRef.current = currentIdx;
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      setFollowing(true);
      requestAnimationFrame(() => {
        const container = scrollRef.current;
        const idx = currentIdxRef.current;
        if (!container || idx < 0) return;
        container.querySelector<HTMLElement>(`[data-sent="${idx}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Cancel follow only on a real user scroll gesture — wheel or touch-drag — so
  // programmatic auto-scroll never switches it off the instant it engages.
  const cancelFollow = useCallback(() => {
    setFollowing(false);
  }, []);

  const jumpToCurrent = useCallback(() => {
    setFollowing(true);
    scrollCurrentIntoView();
  }, [scrollCurrentIntoView]);

  // One stable handler for every sentence (reads the index from the span), so
  // the memoized sentences never re-render for a new callback identity.
  const handleSentenceClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const idx = Number(event.currentTarget.dataset["sent"]);
      if (!Number.isInteger(idx)) return;
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
            "calc(32px + var(--lv-syncbar-h, 0px) + var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))",
          // Keep follow-mode centring (block:"center") and a sentence tap from
          // parking the spoken line UNDER the transport when it's near the end.
          scrollPaddingBottom:
            "calc(var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))",
        }}
      >
        <Box
          sx={[
            {
              maxWidth: READING_COLUMN_MAX,
              mx: "auto",
              fontFamily: "var(--lv-reading-font)",
              lineHeight,
              // rem so it tracks the app-wide font-size (root font-size) setting.
              fontSize: "1.05rem",
            },
            sentenceSx,
          ]}
        >
          {transcriptUnavailable
            ? (
              <Alert severity="info">
                {t("audiobook.transcriptUnavailable")}
              </Alert>
            )
            : sentences.length === 0
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
              <SentenceList
                sentences={sentences}
                currentIdx={currentIdx}
                onSelect={handleSentenceClick}
              />
            )}
          {/* Prev/next chapter pager — inside the centred reading column. */}
          {footer}
        </Box>
      </Box>

      {
        /* Reliable "back to chapter top": iOS reserves the status-bar tap (and it
          never reaches an inner scroll container anyway), so the read-along needs
          the same explicit FAB the text reader has. Lifted above BOTH the
          transport (--lv-transport-h) and the nav bar (--shell-bar-h). */
      }
      <ScrollToTopButton
        targetRef={scrollRef}
        bottomLift="calc(var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))"
      />

      <ReadAlongWipe
        containerRef={scrollRef}
        currentIdx={currentIdx}
        sentences={sentences}
      />
      {nowPlaying && onSaveScroll && (
        <PlaybackProgressMirror
          path={nowPlaying.chapterPath}
          playing={playing}
          onSaveScroll={onSaveScroll}
        />
      )}

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
