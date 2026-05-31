import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Mark, SpokenContent } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// Book-level audio engine.
//
// Why a root-level provider: the audio element and all playback state live here,
// ABOVE every view, so navigating (bookshelf ⇄ reader, chapter ⇄ chapter, book ⇄
// book, text ⇄ audio) never unmounts the <audio> — playback is decoupled from
// the screen and simply doesn't stop. Views (the read-along reader, the mini
// player) observe this state; they don't own the audio. This is the standard
// "persistent player = mounted-at-root context" pattern.
// ─────────────────────────────────────────────────────────────────────────────

/** One chapter in the playing book's queue (drives next/prev + auto-advance). */
export interface Track {
  /** Virtual chapter path — the `<slug>/<aid>.spoken.md` script. */
  path: string;
  /** Display title for the chapter (current UI edition). */
  label: string;
}

/** What's currently loaded into the player (the book + chapter being narrated). */
export interface NowPlaying {
  bookSlug: string;
  bookLabel: string;
  /** Whether `/api/cover?book=<slug>` exists (for the mini-player artwork). */
  cover: boolean;
  chapterPath: string;
  chapterLabel: string;
  lang: string;
  rendition: string;
}

export interface AudioPlayer {
  nowPlaying: NowPlaying | null;
  /** Read-along sentences of the playing chapter, in spoken order. */
  sentences: string[];
  /** Index of the sentence being spoken, or -1. */
  currentIdx: number;
  playing: boolean;
  /** True while fetching sentences + synthesizing audio (first play is slow). */
  loading: boolean;
  error: string | null;
  rate: number;
  currentTime: number;
  duration: number;
  canPrev: boolean;
  canNext: boolean;
  /** Whether the full read-along popup is in focus (expanded) vs collapsed to the
   *  bottom bar. The popup floats above every view, so this is pure listen-plane
   *  UI state — it never touches what the browse plane shows. */
  expanded: boolean;
  setExpanded: (open: boolean) => void;
  /** The playing book's ordered chapter queue (with labels) — also the popup's
   *  table of contents. */
  queue: Track[];
  queueIndex: number;
  /** Start (or replace) playback at a chapter, seeding the book's chapter queue. */
  playChapter: (np: Omit<NowPlaying, "chapterLabel">, queue: Track[]) => void;
  togglePlay: () => void;
  seek: (sec: number) => void;
  /** Jump by a delta (negative = back) in seconds, clamped to the chapter. */
  skip: (deltaSec: number) => void;
  seekToSentence: (idx: number) => void;
  /** Jump to a chapter by queue index and play it (the popup TOC). */
  goToChapter: (qi: number) => void;
  /** Sleep timer: minutes until playback auto-pauses (0 = off). */
  sleepMinutes: number;
  /** Arm/replace/cancel the sleep timer (0 cancels). */
  setSleepTimer: (minutes: number) => void;
  setRate: (r: number) => void;
  nextChapter: () => void;
  prevChapter: () => void;
  stop: () => void;
}

const RATE_KEY = "lv-audio-rate";
const SESSION_KEY = "lv-audio-session";
/** Per-chapter resume position (audio seconds); client-only. */
const posKey = (path: string, lang: string): string => `lv-audio-pos:${path}:${lang}`;

/** Warm the next chapter's synthesis this many seconds before the current ends,
 *  so auto-advance doesn't stall on a cold edge-tts cache. */
const PREFETCH_LEAD_S = 25;

function query(path: string, lang: string, rendition: string): string {
  return `path=${encodeURIComponent(path)}&lang=${encodeURIComponent(lang)}&rendition=${encodeURIComponent(rendition)}`;
}

/** Map playback ms → sentence index via binary search over contiguous marks. */
function markIndex(marks: Mark[], ms: number): number {
  let lo = 0;
  let hi = marks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = marks[mid];
    if (!m) break;
    if (ms < m.start_ms) hi = mid - 1;
    else if (ms >= m.end_ms) lo = mid + 1;
    else return mid;
  }
  return -1;
}

interface PersistedSession {
  nowPlaying: NowPlaying;
  queue: Track[];
  queueIndex: number;
}

const Ctx = createContext<AudioPlayer | null>(null);

export function AudioPlayerProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [sentences, setSentences] = useState<string[]>([]);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRateState] = useState<number>(() => {
    const v = Number(localStorage.getItem(RATE_KEY) ?? "1");
    return Number.isFinite(v) && v > 0 ? v : 1;
  });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  // Listen-plane UI: is the full read-along popup in focus? Default collapsed so
  // a resumed session (rehydrated below) shows only the bar, never auto-expands.
  const [expanded, setExpanded] = useState(false);
  // Sleep timer: minutes until auto-pause (0 = off). The pending timeout id lives
  // in a ref so it survives re-renders and can be cleared/replaced.
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const sleepTimerRef = useRef<number | null>(null);

  // Refs the once-attached <audio> listeners read without re-subscribing.
  const marksRef = useRef<Mark[]>([]);
  const rateRef = useRef(rate);
  const nowPlayingRef = useRef<NowPlaying | null>(null);
  const queueRef = useRef<Track[]>([]);
  const queueIndexRef = useRef(-1);
  // Monotonic load token: a newer load() invalidates an in-flight older fetch.
  const loadSeq = useRef(0);
  // Chapter path we've already warmed the *next* synth for, so we prefetch once.
  const prefetchedFrom = useRef<string | null>(null);

  rateRef.current = rate;

  const persistSession = useCallback((np: NowPlaying, q: Track[], qi: number) => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ nowPlaying: np, queue: q, queueIndex: qi }));
    } catch {
      // storage full / disabled — non-fatal, just no resume-on-reload.
    }
  }, []);

  // Load a chapter into the element: fetch sentences (instant) then marks
  // (triggers server synth — slow on first play), point <audio> at the cached
  // MP3, restore the saved position, and optionally play.
  const loadTrack = useCallback(
    (np: NowPlaying, q: Track[], qi: number, autoplay: boolean) => {
      const audio = audioRef.current;
      const seq = ++loadSeq.current;
      prefetchedFrom.current = null;

      setNowPlaying(np);
      nowPlayingRef.current = np;
      setQueue(q);
      queueRef.current = q;
      setQueueIndex(qi);
      queueIndexRef.current = qi;
      setLoading(true);
      setError(null);
      setSentences([]);
      setCurrentIdx(-1);
      setCurrentTime(0);
      setDuration(0);
      marksRef.current = [];
      persistSession(np, q, qi);

      const q1 = query(np.chapterPath, np.lang, np.rendition);
      void (async () => {
        try {
          const sres = await fetch(`/api/spoken?${q1}`);
          if (!sres.ok) throw new Error(`spoken: ${sres.status}`);
          const sdata = (await sres.json()) as SpokenContent;
          if (loadSeq.current !== seq) return;
          setSentences(sdata.sentences);

          const mres = await fetch(`/api/marks?${q1}`);
          if (!mres.ok) throw new Error(`marks: ${mres.status}`);
          const mdata = (await mres.json()) as Mark[];
          if (loadSeq.current !== seq) return;
          marksRef.current = mdata;

          if (audio) {
            audio.src = `/api/audio?${q1}`;
            // load() resets playbackRate from defaultPlaybackRate — set both so
            // the chosen rate survives (also re-applied on loadedmetadata).
            audio.defaultPlaybackRate = rateRef.current;
            audio.playbackRate = rateRef.current;
            audio.load();
            const saved = Number(localStorage.getItem(posKey(np.chapterPath, np.lang)) ?? "");
            if (Number.isFinite(saved) && saved > 0) audio.currentTime = saved;
            if (autoplay) void audio.play();
          }
          setLoading(false);
        } catch (e) {
          if (loadSeq.current === seq) {
            setError(e instanceof Error ? e.message : String(e));
            setLoading(false);
          }
        }
      })();
    },
    [persistSession]
  );

  // Advance/retreat within the queue, carrying the book identity forward.
  const goTo = useCallback(
    (qi: number, autoplay: boolean) => {
      const q = queueRef.current;
      const track = q[qi];
      const base = nowPlayingRef.current;
      if (!track || !base) return;
      loadTrack({ ...base, chapterPath: track.path, chapterLabel: track.label }, q, qi, autoplay);
    },
    [loadTrack]
  );

  const nextChapter = useCallback(() => {
    if (queueIndexRef.current < queueRef.current.length - 1) goTo(queueIndexRef.current + 1, true);
  }, [goTo]);
  const prevChapter = useCallback(() => {
    if (queueIndexRef.current > 0) goTo(queueIndexRef.current - 1, true);
  }, [goTo]);
  // Jump to an arbitrary chapter (the popup's table of contents). Clamped to the
  // queue; a no-op for an out-of-range index.
  const goToChapter = useCallback(
    (qi: number) => {
      if (qi >= 0 && qi < queueRef.current.length) goTo(qi, true);
    },
    [goTo]
  );

  // Sleep timer: auto-pause after N minutes (wall-clock from when armed). Picking
  // a new value restarts the countdown; 0 cancels it. Pauses (not stops) so the
  // chapter can be resumed where it left off.
  const setSleepTimer = useCallback((minutes: number) => {
    if (sleepTimerRef.current !== null) {
      window.clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    setSleepMinutes(minutes);
    if (minutes > 0) {
      sleepTimerRef.current = window.setTimeout(() => {
        audioRef.current?.pause();
        sleepTimerRef.current = null;
        setSleepMinutes(0);
      }, minutes * 60_000);
    }
  }, []);

  // Attach the element's listeners ONCE. They read refs so they never go stale.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    const onTime = (): void => {
      setCurrentTime(audio.currentTime);
      setCurrentIdx(markIndex(marksRef.current, audio.currentTime * 1000));
      const np = nowPlayingRef.current;
      if (np && audio.currentTime > 0) {
        localStorage.setItem(posKey(np.chapterPath, np.lang), String(audio.currentTime));
      }
      // Warm the next chapter's synth shortly before this one ends.
      if (
        np &&
        audio.duration > 0 &&
        audio.duration - audio.currentTime < PREFETCH_LEAD_S &&
        queueIndexRef.current < queueRef.current.length - 1 &&
        prefetchedFrom.current !== np.chapterPath
      ) {
        prefetchedFrom.current = np.chapterPath;
        const next = queueRef.current[queueIndexRef.current + 1];
        if (next) void fetch(`/api/marks?${query(next.path, np.lang, np.rendition)}`).catch(() => {});
      }
    };
    const onMeta = (): void => {
      setDuration(audio.duration);
      audio.playbackRate = rateRef.current;
    };
    const onPlay = (): void => setPlaying(true);
    const onPause = (): void => setPlaying(false);
    const onEnded = (): void => {
      const np = nowPlayingRef.current;
      if (np) localStorage.removeItem(posKey(np.chapterPath, np.lang));
      // Book-level continuous playback: roll into the next chapter, else stop.
      if (queueIndexRef.current < queueRef.current.length - 1) {
        goTo(queueIndexRef.current + 1, true);
      } else {
        setPlaying(false);
        setCurrentIdx(-1);
      }
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [goTo]);

  // Resume-on-load: rehydrate the last session as a PAUSED mini-player, so the
  // user sees "continue listening" without auto-playing on a fresh page.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as PersistedSession;
      if (s.nowPlaying && Array.isArray(s.queue)) {
        loadTrack(s.nowPlaying, s.queue, s.queueIndex, false);
      }
    } catch {
      // ignore a corrupt/old session blob
    }
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // OS / lock-screen / headphone controls. Metadata follows the chapter; the
  // handlers are wired once.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => void audioRef.current?.play());
    ms.setActionHandler("pause", () => audioRef.current?.pause());
    ms.setActionHandler("previoustrack", () => prevChapter());
    ms.setActionHandler("nexttrack", () => nextChapter());
    ms.setActionHandler("seekbackward", (d) => {
      const a = audioRef.current;
      if (a) a.currentTime = Math.max(0, a.currentTime - (d.seekOffset ?? 15));
    });
    ms.setActionHandler("seekforward", (d) => {
      const a = audioRef.current;
      if (a) a.currentTime = Math.min(a.duration || a.currentTime, a.currentTime + (d.seekOffset ?? 15));
    });
    ms.setActionHandler("seekto", (d) => {
      const a = audioRef.current;
      if (a && d.seekTime != null) a.currentTime = d.seekTime;
    });
  }, [nextChapter, prevChapter]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!nowPlaying) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlaying.chapterLabel,
      artist: nowPlaying.bookLabel,
      album: nowPlaying.bookLabel,
      artwork: nowPlaying.cover
        ? [{ src: `/api/cover?book=${encodeURIComponent(nowPlaying.bookSlug)}`, sizes: "512x512" }]
        : [],
    });
  }, [nowPlaying]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = playing ? "playing" : nowPlaying ? "paused" : "none";
  }, [playing, nowPlaying]);

  const playChapter = useCallback(
    (np: Omit<NowPlaying, "chapterLabel">, q: Track[]) => {
      const qi = q.findIndex((tk) => tk.path === np.chapterPath);
      const label = q[qi]?.label ?? np.chapterPath.split("/").pop() ?? np.chapterPath;
      loadTrack({ ...np, chapterLabel: label }, q, qi >= 0 ? qi : 0, true);
    },
    [loadTrack]
  );

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }, []);
  const seek = useCallback((sec: number) => {
    const a = audioRef.current;
    if (a) a.currentTime = sec;
  }, []);
  const skip = useCallback((delta: number) => {
    const a = audioRef.current;
    if (a) a.currentTime = Math.min(a.duration || a.currentTime + delta, Math.max(0, a.currentTime + delta));
  }, []);
  const seekToSentence = useCallback((idx: number) => {
    const a = audioRef.current;
    const m = marksRef.current[idx];
    if (!a || !m) return;
    a.currentTime = m.start_ms / 1000;
    void a.play();
  }, []);
  const setRate = useCallback((r: number) => {
    setRateState(r);
    rateRef.current = r;
    localStorage.setItem(RATE_KEY, String(r));
    const a = audioRef.current;
    if (a) {
      a.playbackRate = r;
      a.defaultPlaybackRate = r;
    }
  }, []);
  const stop = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    loadSeq.current++;
    setNowPlaying(null);
    nowPlayingRef.current = null;
    setSentences([]);
    setCurrentIdx(-1);
    setPlaying(false);
    setQueue([]);
    queueRef.current = [];
    setQueueIndex(-1);
    queueIndexRef.current = -1;
    setExpanded(false);
    if (sleepTimerRef.current !== null) {
      window.clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    setSleepMinutes(0);
    localStorage.removeItem(SESSION_KEY);
  }, []);

  const value = useMemo<AudioPlayer>(
    () => ({
      nowPlaying,
      sentences,
      currentIdx,
      playing,
      loading,
      error,
      rate,
      currentTime,
      duration,
      canPrev: queueIndex > 0,
      canNext: queueIndex >= 0 && queueIndex < queue.length - 1,
      expanded,
      setExpanded,
      queue,
      queueIndex,
      playChapter,
      togglePlay,
      seek,
      skip,
      seekToSentence,
      goToChapter,
      sleepMinutes,
      setSleepTimer,
      setRate,
      nextChapter,
      prevChapter,
      stop,
    }),
    [
      nowPlaying,
      sentences,
      currentIdx,
      playing,
      loading,
      error,
      rate,
      currentTime,
      duration,
      expanded,
      queue,
      queueIndex,
      sleepMinutes,
      setSleepTimer,
      playChapter,
      togglePlay,
      seek,
      skip,
      seekToSentence,
      goToChapter,
      setRate,
      nextChapter,
      prevChapter,
      stop,
    ]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* The single, always-mounted narration element — never unmounts, so
          playback survives every in-app navigation. */}
      <audio ref={audioRef} preload="metadata" hidden />
    </Ctx.Provider>
  );
}

export function useAudioPlayer(): AudioPlayer {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAudioPlayer must be used within an AudioPlayerProvider");
  return ctx;
}
