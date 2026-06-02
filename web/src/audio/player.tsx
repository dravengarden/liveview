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
import { getServerSettings, putServerSetting } from "@/serverSettings";
import { useI18n } from "@/i18n";

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
  /** Sleep timer: the chosen option in minutes (0 = off). Drives the menu's
   *  selected highlight; the visible chip uses `sleepRemainingMin` instead. */
  sleepMinutes: number;
  /** Sleep timer: whole minutes remaining (ceil), counting down only while
   *  playing (frozen on pause), WeChat-Reading style. 0 = off. */
  sleepRemainingMin: number;
  /** Arm/replace/cancel the sleep timer (0 cancels). */
  setSleepTimer: (minutes: number) => void;
  setRate: (r: number) => void;
  nextChapter: () => void;
  prevChapter: () => void;
  stop: () => void;
  /** Set when a fresh page load reconciled the resume point to a newer position
   *  from ANOTHER device — drives the "已同步…" snackbar. `seq` lets an identical
   *  message re-fire the toast; null until/unless a cross-device sync lands. */
  syncNotice: { message: string; seq: number } | null;
}

const RATE_KEY = "lv-audio-rate";
const SESSION_KEY = "lv-audio-session";
/** Per-chapter resume position (audio seconds); client-only. */
const posKey = (path: string, lang: string): string => `lv-audio-pos:${path}:${lang}`;

/** Simple string-valued settings that sync across devices, as
 *  (serverKey, localStorageKey) pairs — used ONLY to detect a cross-device
 *  change and toast "已同步设置". Each is owned/applied by its own hook
 *  (useTheme / useFont / i18n) plus this engine (rate); keep this list in step
 *  with them. A drift here only mis-fires the toast, never breaks the sync. */
const SYNCED_SETTING_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["ui.theme", "lv-theme"],
  ["ui.font", "lv-font"],
  ["ui.lang", "lv-lang"],
  ["audio.rate", RATE_KEY],
];

/** Warm the next chapter's synthesis this many seconds before the current ends,
 *  so auto-advance doesn't stall on a cold edge-tts cache. */
const PREFETCH_LEAD_S = 25;

/** A same-chapter resume from another device only "wins" (and toasts) when it's
 *  meaningfully ahead of this device's local position — a few seconds of drift
 *  from rounding / last-tick timing shouldn't masquerade as a cross-device sync. */
const SYNC_POS_LEAD_S = 8;

/** mm:ss for the sync toast. */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function query(path: string, lang: string, rendition: string): string {
  return `path=${encodeURIComponent(path)}&lang=${encodeURIComponent(lang)}&rendition=${encodeURIComponent(rendition)}`;
}

/** Push the element's timeline to the OS so the lock-screen scrubber tracks
 *  playback. iOS in particular NEEDS this once seek handlers are registered:
 *  without a valid position state its remote controls — the play/pause button
 *  included — go unresponsive (desktop browsers are forgiving, so the bug only
 *  shows on iOS). iOS also throws and drops the whole state unless every field
 *  is finite with `0 ≤ position ≤ duration` and `playbackRate > 0`, so clamp. */
function updatePositionState(audio: HTMLAudioElement): void {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const { duration, currentTime } = audio;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const position = Math.min(Math.max(0, currentTime), duration);
  const playbackRate = audio.playbackRate > 0 ? audio.playbackRate : 1;
  try {
    navigator.mediaSession.setPositionState({ duration, playbackRate, position });
  } catch {
    // Older/edge WebKit can still reject a valid-looking state — non-fatal.
  }
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
  const { t } = useI18n();
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
  // Raised once when a fresh load adopts a newer resume point from another
  // device (see the server-reconcile effect). App reads it to toast "已同步…".
  const [syncNotice, setSyncNotice] = useState<{ message: string; seq: number } | null>(null);
  // Listen-plane UI: is the full read-along popup in focus? Default collapsed so
  // a resumed session (rehydrated below) shows only the bar, never auto-expands.
  const [expanded, setExpanded] = useState(false);
  // Sleep timer (WeChat-Reading style): the chosen option (for the menu
  // highlight) plus a remaining-minutes display that counts down ONLY while
  // playing. The live seconds-remaining + last-tick timestamp live in refs so
  // the once-attached timeupdate handler can decrement without re-subscribing.
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepRemainingMin, setSleepRemainingMin] = useState(0);
  const sleepRemainingRef = useRef(0); // live seconds remaining
  const lastSleepTickRef = useRef(0); // Date.now() of last decrement; 0 = reseed, don't count
  const lastSleepPutRef = useRef(0); // throttle for the server save of remaining

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
    // Also persist the resume pointer (book + chapter + queue) server-side so it
    // syncs across devices; the per-chapter position rides "audio.pos" separately.
    putServerSetting("audio.session", JSON.stringify({ nowPlaying: np, queue: q, queueIndex: qi }));
  }, []);

  // Fire-and-forget server-side persistence of a player setting (rate, sleep
  // timer). Survives reloads and syncs across devices; localStorage stays as the
  // offline fallback.
  const persistSetting = useCallback((key: string, value: string) => {
    putServerSetting(key, value);
  }, []);

  // Throttle for the server-side position write (the localStorage posKey write
  // stays per-tick; the server save is rate-limited — see the timeupdate handler).
  const lastPosPutRef = useRef(0);

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

  // Sleep timer: arm N minutes of remaining time (0 cancels). The countdown only
  // advances while playing (driven by the timeupdate handler), so it freezes on
  // pause — WeChat-Reading style. Pauses (not stops) at zero so the chapter
  // resumes where it left off. lastSleepTickRef = 0 means "reseed on the next
  // playing tick", so the paused/armed gap before play isn't counted.
  const setSleepTimer = useCallback((minutes: number) => {
    setSleepMinutes(minutes);
    persistSetting("audio.sleepMinutes", String(minutes));
    sleepRemainingRef.current = minutes * 60;
    setSleepRemainingMin(minutes);
    lastSleepTickRef.current = 0;
    persistSetting("audio.sleepRemaining", String(minutes * 60));
  }, [persistSetting]);

  // Attach the element's listeners ONCE. They read refs so they never go stale.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    const onTime = (): void => {
      setCurrentTime(audio.currentTime);
      updatePositionState(audio);
      setCurrentIdx(markIndex(marksRef.current, audio.currentTime * 1000));
      const np = nowPlayingRef.current;
      if (np && audio.currentTime > 0) {
        localStorage.setItem(posKey(np.chapterPath, np.lang), String(audio.currentTime));
        // Server-save the position at most once every 5s (cross-device resume);
        // localStorage above stays per-tick for instant local resume.
        const now = Date.now();
        if (now - lastPosPutRef.current > 5000) {
          lastPosPutRef.current = now;
          putServerSetting("audio.pos", String(audio.currentTime));
        }
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
      // Sleep-timer countdown. timeupdate fires only while playing, so pausing
      // naturally freezes the countdown — we just track real elapsed time
      // between ticks (reseeding after a pause/arm so the gap isn't charged).
      if (sleepRemainingRef.current > 0) {
        const now = Date.now();
        if (lastSleepTickRef.current === 0) {
          lastSleepTickRef.current = now; // first tick after arm/resume: reseed, no decrement
        } else {
          const dt = (now - lastSleepTickRef.current) / 1000;
          lastSleepTickRef.current = now;
          const remaining = sleepRemainingRef.current - dt;
          if (remaining <= 0) {
            sleepRemainingRef.current = 0;
            lastSleepTickRef.current = 0;
            setSleepRemainingMin(0);
            setSleepMinutes(0);
            audio.pause();
            putServerSetting("audio.sleepRemaining", "0");
            putServerSetting("audio.sleepMinutes", "0");
          } else {
            sleepRemainingRef.current = remaining;
            const mins = Math.ceil(remaining / 60);
            // Only re-render when the displayed minute actually changes (the
            // handler fires ~4×/s).
            setSleepRemainingMin((prev) => (prev === mins ? prev : mins));
            // Throttle the server save of remaining to ~once/5s.
            if (now - lastSleepPutRef.current > 5000) {
              lastSleepPutRef.current = now;
              putServerSetting("audio.sleepRemaining", String(Math.round(remaining)));
            }
          }
        }
      }
    };
    const onMeta = (): void => {
      setDuration(audio.duration);
      audio.playbackRate = rateRef.current;
      // Seed the lock-screen timeline as soon as duration is known, so the OS
      // controls are live from the first frame rather than the first tick.
      updatePositionState(audio);
    };
    const onPlay = (): void => setPlaying(true);
    const onPause = (): void => {
      setPlaying(false);
      // Flush the current position server-side so a pause is immediately
      // resumable on another device (bypasses the 5s throttle).
      if (nowPlayingRef.current && audio.currentTime > 0) {
        lastPosPutRef.current = Date.now();
        putServerSetting("audio.pos", String(audio.currentTime));
      }
      // Freeze the sleep countdown: reseed so the paused gap isn't charged on
      // resume, and flush the remaining seconds so another device picks up the
      // frozen value.
      lastSleepTickRef.current = 0;
      if (sleepRemainingRef.current > 0) {
        putServerSetting("audio.sleepRemaining", String(Math.round(sleepRemainingRef.current)));
      }
    };
    const onEnded = (): void => {
      const np = nowPlayingRef.current;
      if (np) localStorage.removeItem(posKey(np.chapterPath, np.lang));
      // Chapter finished: clear the saved position so a resume starts the next
      // chapter cleanly rather than at the previous chapter's end.
      lastPosPutRef.current = Date.now();
      putServerSetting("audio.pos", "0");
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

  // Restore server-persisted player settings once on mount (rate + sleep). The
  // rate is applied to the audio element via setRate. The sleep timer is
  // restored as remaining SECONDS (frozen until playback resumes the countdown),
  // plus the chosen option for the menu highlight.
  useEffect(() => {
    // Snapshot the synced settings' local values BEFORE the shared GET resolves
    // (the per-setting hooks overwrite them on that same resolve), so we can tell
    // whether the server copy was changed on ANOTHER device.
    const localSettings = SYNCED_SETTING_KEYS.map(([, ls]) => localStorage.getItem(ls));
    void getServerSettings().then((s) => {
      let audioSynced = false;
      const r = Number(s["audio.rate"]);
      if (Number.isFinite(r) && r > 0) setRate(r);
      const sr = Number(s["audio.sleepRemaining"]);
      const smChoice = Number(s["audio.sleepMinutes"]);
      if (Number.isFinite(sr) && sr > 0) {
        sleepRemainingRef.current = sr;
        setSleepRemainingMin(Math.ceil(sr / 60));
        if (Number.isFinite(smChoice) && smChoice > 0) setSleepMinutes(smChoice);
        lastSleepTickRef.current = 0; // counts down once playback starts (frozen until then)
      }
      // Reconcile the resume pointer (the server reflects the most recent write
      // from ANY device). Reload when the chapter differs from what the
      // localStorage effect rehydrated, OR when it's the same chapter but the
      // server is meaningfully ahead — i.e. another device kept listening past
      // this one. Either is a genuine cross-device pull, so it also raises the
      // "已同步…" toast (App renders it via the shared snackbar).
      const raw = s["audio.session"];
      if (raw) {
        try {
          const sess = JSON.parse(raw) as PersistedSession;
          if (sess.nowPlaying && Array.isArray(sess.queue)) {
            const cur = nowPlayingRef.current;
            const chapterDiffers =
              !cur ||
              cur.chapterPath !== sess.nowPlaying.chapterPath ||
              cur.bookSlug !== sess.nowPlaying.bookSlug;
            const serverPos = Number(s["audio.pos"]);
            const localPos = cur
              ? Number(localStorage.getItem(posKey(cur.chapterPath, cur.lang)) ?? "0")
              : 0;
            // Same chapter on both devices, but the server (another device) is
            // further along → adopt its position rather than this device's. Use a
            // small lead so timing drift on the same device doesn't false-trigger.
            const posAhead =
              !chapterDiffers &&
              Number.isFinite(serverPos) &&
              serverPos > localPos + SYNC_POS_LEAD_S;
            if (chapterDiffers || posAhead) {
              if (Number.isFinite(serverPos) && serverPos > 0) {
                // Seed the per-chapter localStorage pos so loadTrack's existing
                // restore picks it up.
                localStorage.setItem(
                  posKey(sess.nowPlaying.chapterPath, sess.nowPlaying.lang),
                  String(serverPos)
                );
              }
              loadTrack(sess.nowPlaying, sess.queue, sess.queueIndex, false); // PAUSED
              audioSynced = true;
              setSyncNotice({
                seq: Date.now(),
                message: t("sync.audio", {
                  book: sess.nowPlaying.bookLabel,
                  chapter: sess.nowPlaying.chapterLabel,
                  time: fmtClock(Number.isFinite(serverPos) ? serverPos : 0),
                }),
              });
            }
          }
        } catch {
          // ignore a corrupt server session blob
        }
      }
      // A simple setting (theme / font / language / rate) changed on another
      // device → the generic "已同步设置" toast. Audio's richer toast wins when
      // both moved on the same load.
      if (!audioSynced) {
        const changed = SYNCED_SETTING_KEYS.some(([srv], i) => {
          const v = s[srv];
          return v != null && v !== localSettings[i];
        });
        if (changed) setSyncNotice({ seq: Date.now(), message: t("sync.settings") });
      }
    });
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
      // Always supply artwork so the iOS/iPadOS/macOS lock-screen tile is never
      // blank: /api/artwork returns the real cover when the book has one, else a
      // deterministic gradient PNG. A real server URL (not a data:/blob: URI) is
      // required — iOS Safari is unreliable about rendering inline-encoded
      // artwork on the lock screen.
      artwork: [
        { src: `/api/artwork?book=${encodeURIComponent(nowPlaying.bookSlug)}`, sizes: "512x512", type: "image/png" },
      ],
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
      // Opening an audiobook loads it PAUSED — the player shows up at the saved
      // position and the user taps play to start. Chapter navigation
      // (goTo/next/prev/goToChapter) and auto-advance (onEnded) still autoplay,
      // since those happen during an active listen.
      loadTrack({ ...np, chapterLabel: label }, q, qi >= 0 ? qi : 0, false);
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
    persistSetting("audio.rate", String(r));
    const a = audioRef.current;
    if (a) {
      a.playbackRate = r;
      a.defaultPlaybackRate = r;
      // Reflect the new rate in the OS timeline now — a paused element fires no
      // timeupdate, so the lock-screen scrubber would otherwise drift.
      updatePositionState(a);
    }
  }, [persistSetting]);
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
    sleepRemainingRef.current = 0;
    lastSleepTickRef.current = 0;
    setSleepRemainingMin(0);
    setSleepMinutes(0);
    putServerSetting("audio.sleepRemaining", "0");
    localStorage.removeItem(SESSION_KEY);
    // Clear the server-side resume pointer too, so a stopped session doesn't
    // resurrect on this or another device (empty value clears the key).
    putServerSetting("audio.session", "");
    putServerSetting("audio.pos", "0");
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
      sleepRemainingMin,
      setSleepTimer,
      setRate,
      nextChapter,
      prevChapter,
      stop,
      syncNotice,
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
      sleepRemainingMin,
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
      syncNotice,
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
