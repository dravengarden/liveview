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
import {
  nativeMediaAvailable,
  nativeMediaClear,
  nativeMediaSetNowPlaying,
  nativeMediaSetState,
  onNativeMediaCommand,
} from "@/native-media";
import { useI18n } from "@/i18n";
import { loadServerSetting } from "@/syncBackends";
import {
  activePlayerStore,
  type AudioPos,
  audioStores,
  DEVICE_ID,
  deviceLabelStore,
  INSTANCE_ID,
  type PersistedSession,
  posStore,
  rateStore,
  sessionStore,
  sleepMinutesStore,
  sleepRemainingStore,
} from "./stores";

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
  /** Read fraction (0–1) WITHIN the current sentence — drives the karaoke
   *  read-so-far wipe. 0 when nothing is playing. */
  currentProgress: number;
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
  /** Start (or replace) playback at a chapter, seeding the book's chapter queue.
   *  `autoplay` (default false = audiobook "open paused, tap to start") is true
   *  for the reader's read-aloud button, which should begin speaking on one tap. */
  playChapter: (
    np: Omit<NowPlaying, "chapterLabel">,
    queue: Track[],
    autoplay?: boolean,
  ) => void;
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
  /** Non-null when audio is currently playing on ANOTHER client (tab/device/app).
   *  This client is paused (yielded); the play surfaces show "play here" instead
   *  of the normal toggle, and `label` is that device's human name. */
  playingElsewhere: { label: string } | null;
  /** Take over playback here: claim it (the other client pauses) and resume from
   *  the synced position. Used by the "play here" affordance. */
  playHere: () => void;
}

// Device-local FAST PATH for the resume position + rate. The cross-device
// authority (+ the >8s same-chapter reconcile) now lives in the `mirroredStore`s
// (audio/stores.ts); these localStorage keys stay only as the SYNCHRONOUS local
// seed (`loadTrack` reads posKey to set `audio.currentTime` before any async
// store resolves, and the rate paints instantly on mount). The session's local
// mirror moved into `sessionStore` (IDB), so it has no localStorage key anymore.
const RATE_KEY = "lv-audio-rate";
/** Per-chapter resume position (audio seconds); local sync-seed only. */
const posKey = (path: string, lang: string): string =>
  `lv-audio-pos:${path}:${lang}`;

/** Warm the next chapter's synthesis this many seconds before the current ends,
 *  so auto-advance doesn't stall on a cold edge-tts cache. */
const PREFETCH_LEAD_S = 25;

/** A claim older than this is considered DEAD (the owner crashed / closed without
 *  releasing) — other clients then ignore it and may claim freely. Must comfortably
 *  exceed HEARTBEAT_MS so a live owner is never mistaken for stale. */
const CLAIM_STALE_MS = 15000;
/** A playing client re-stamps its claim this often so it stays fresh < STALE. */
const HEARTBEAT_MS = 5000;

/** A same-chapter resume from another device only "wins" (and toasts) when it's
 *  meaningfully ahead of this device's local position — a few seconds of drift
 *  from rounding / last-tick timing shouldn't masquerade as a cross-device sync.
 *  (The `posStore.reconcile` enforces the same lead server-side; this drives the
 *  toast decision in the calling code.) */
const SYNC_POS_LEAD_S = 8;

/** mm:ss for the sync toast. */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function query(path: string, lang: string, rendition: string): string {
  return `path=${encodeURIComponent(path)}&lang=${
    encodeURIComponent(lang)
  }&rendition=${encodeURIComponent(rendition)}`;
}

/** Push the element's timeline to the OS so the lock-screen scrubber tracks
 *  playback. iOS in particular NEEDS this once seek handlers are registered:
 *  without a valid position state its remote controls — the play/pause button
 *  included — go unresponsive (desktop browsers are forgiving, so the bug only
 *  shows on iOS). iOS also throws and drops the whole state unless every field
 *  is finite with `0 ≤ position ≤ duration` and `playbackRate > 0`, so clamp. */
function updatePositionState(audio: HTMLAudioElement): void {
  if (
    !("mediaSession" in navigator) || !navigator.mediaSession.setPositionState
  ) return;
  const { duration, currentTime } = audio;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const position = Math.min(Math.max(0, currentTime), duration);
  const playbackRate = audio.playbackRate > 0 ? audio.playbackRate : 1;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate,
      position,
    });
  } catch {
    // Older/edge WebKit can still reject a valid-looking state — non-fatal.
  }
}

/** Play with iOS interruption recovery.
 *
 * Why: when the screen locks (or the PWA is backgrounded), iOS deactivates the
 * page's audio session AND drops the element's decoded media buffer. The next
 * `play()` then rejects (AbortError / a media error) and — if the rejection is
 * swallowed — the play button silently does nothing. That's the "息屏后点击播放
 * 无法播放" bug. The first `play()` here runs synchronously so it stays inside
 * the tap's user-activation window; on rejection we re-establish the (evicted)
 * resource with `load()`, restore the position once metadata is back, and retry.
 * iOS keeps media-playback activation alive briefly after a gesture-initiated
 * play(), so the retry is permitted. `onError` fires ONLY if the retry also
 * fails, so a normal interruption recovers without flashing an error. */
function playAudio(
  audio: HTMLAudioElement,
  onError?: (e: unknown) => void,
): void {
  const p = audio.play() as Promise<void> | undefined;
  if (!p || typeof p.catch !== "function") return;
  p.catch((err: unknown) => {
    // NotAllowedError = playback isn't permitted in this context: no user
    // gesture (auto-advance to the next chapter), or the iOS standalone-PWA
    // background/lock restriction. This is benign and EXPECTED — stay paused
    // silently so the user can tap play. Do NOT reload (that would pointlessly
    // re-fetch and reset the position) and do NOT surface an error banner.
    if (err instanceof DOMException && err.name === "NotAllowedError") return;
    // Any other rejection: assume the media resource was dropped (an iOS
    // screen-lock interruption evicts the decoded buffer) and re-establish it at
    // the same position. A retry that's still NotAllowed stays silent too.
    const at = audio.currentTime;
    audio.addEventListener(
      "loadedmetadata",
      () => {
        if (Number.isFinite(at) && at > 0) {
          try {
            audio.currentTime = at;
          } catch {
            // currentTime not settable yet — resume from 0 rather than fail.
          }
        }
        void audio.play().catch((e: unknown) => {
          if (!(e instanceof DOMException && e.name === "NotAllowedError")) {
            onError?.(e);
          }
        });
      },
      { once: true },
    );
    try {
      audio.load();
    } catch (e) {
      onError?.(e);
    }
  });
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

const Ctx = createContext<AudioPlayer | null>(null);

export function AudioPlayerProvider(
  { children }: { children: React.ReactNode },
): React.JSX.Element {
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
  const [syncNotice, setSyncNotice] = useState<
    { message: string; seq: number } | null
  >(null);
  // Listen-plane UI: is the full read-along popup in focus? Default collapsed so
  // a resumed session (rehydrated below) shows only the bar, never auto-expands.
  const [expanded, setExpanded] = useState(false);
  // Single-active-player handoff: non-null when ANOTHER fresh client owns
  // playback right now. The three play surfaces then render a "play here" / take
  // over control instead of the normal play toggle. Null = we're free to play.
  const [playingElsewhere, setPlayingElsewhere] = useState<
    { label: string } | null
  >(null);
  // True only while WE are pausing the element because another client took over
  // (a "yielded" pause). The <audio> `pause` event can't tell a yield from a
  // user pause, so this flag tells `onPause` to NOT release our claim (the new
  // owner holds it — releasing would null it and fight them).
  const yieldingRef = useRef(false);
  // Sleep timer (WeChat-Reading style): the chosen option (for the menu
  // highlight) plus a remaining-minutes display that counts down ONLY while
  // playing. The live seconds-remaining + last-tick timestamp live in refs so
  // the once-attached timeupdate handler can decrement without re-subscribing.
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepRemainingMin, setSleepRemainingMin] = useState(0);
  const sleepRemainingRef = useRef(0); // live seconds remaining
  const lastSleepTickRef = useRef(0); // Date.now() of last decrement; 0 = reseed, don't count

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

  const persistSession = useCallback(
    (np: NowPlaying, q: Track[], qi: number) => {
      // The resume pointer (book + chapter + queue) — its own mirrored store:
      // immediate server push + an IDB local mirror for instant offline resume
      // (replacing the SESSION_KEY localStorage write). The per-chapter position
      // rides `posStore` separately.
      sessionStore.set({ nowPlaying: np, queue: q, queueIndex: qi });
    },
    [],
  );

  // Write the current resume position to its mirrored store (server + reconcile
  // tier). The synchronous local fast-path (posKey localStorage) is written
  // separately per-tick in the timeupdate handler.
  const persistPos = useCallback((path: string, t: number) => {
    posStore.set({ path, t });
  }, []);

  // ── Single-active-player claim primitives ──────────────────────────────────
  // Claim playback for THIS client (fresh ts). Called whenever this client
  // starts playing (togglePlay→play, playChapter? no — load is paused;
  // playHere, auto-advance) and re-fired by the heartbeat to stay non-stale.
  const claimPlayback = useCallback(() => {
    activePlayerStore.set({
      deviceId: DEVICE_ID,
      instanceId: INSTANCE_ID,
      label: deviceLabelStore.get(),
      ts: Date.now(),
    });
  }, []);

  // Release the claim ONLY if we still own it (a user-initiated pause/stop on the
  // owning client → "no one is playing now"). Keyed on instanceId (NOT deviceId)
  // so a second tab of the SAME browser can't release this tab's claim. Never
  // call this on a yielded pause: the new owner holds the claim and we must not
  // null it.
  const releasePlayback = useCallback(() => {
    if (activePlayerStore.get()?.instanceId === INSTANCE_ID) {
      activePlayerStore.set(null);
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
            // The book's last chapter gets a spoken "全书完" tail baked into its
            // audio server-side (so it plays on the lock screen, unlike a
            // client-side cue). `q` is the full book spine, so the last index is
            // genuinely the end of the book. Only the audio src carries the
            // flag — spoken/marks stay clean, so the read-along isn't affected.
            const isBookEnd = qi === q.length - 1;
            audio.src = `/api/audio?${q1}${isBookEnd ? "&tail=bookend" : ""}`;
            // load() resets playbackRate from defaultPlaybackRate — set both so
            // the chosen rate survives (also re-applied on loadedmetadata).
            audio.defaultPlaybackRate = rateRef.current;
            audio.playbackRate = rateRef.current;
            audio.load();
            const saved = Number(
              localStorage.getItem(posKey(np.chapterPath, np.lang)) ?? "",
            );
            if (Number.isFinite(saved) && saved > 0) audio.currentTime = saved;
            if (autoplay) {
              playAudio(
                audio,
                (e) => setError(e instanceof Error ? e.message : String(e)),
              );
            }
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
    [persistSession],
  );

  // Advance/retreat within the queue, carrying the book identity forward.
  const goTo = useCallback(
    (qi: number, autoplay: boolean) => {
      const q = queueRef.current;
      const track = q[qi];
      const base = nowPlayingRef.current;
      if (!track || !base) return;
      loadTrack(
        { ...base, chapterPath: track.path, chapterLabel: track.label },
        q,
        qi,
        autoplay,
      );
    },
    [loadTrack],
  );

  const nextChapter = useCallback(() => {
    if (queueIndexRef.current < queueRef.current.length - 1) {
      goTo(queueIndexRef.current + 1, true);
    }
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
    [goTo],
  );

  // Sleep timer: arm N minutes of remaining time (0 cancels). The countdown only
  // advances while playing (driven by the timeupdate handler), so it freezes on
  // pause — WeChat-Reading style. Pauses (not stops) at zero so the chapter
  // resumes where it left off. lastSleepTickRef = 0 means "reseed on the next
  // playing tick", so the paused/armed gap before play isn't counted.
  const setSleepTimer = useCallback((minutes: number) => {
    setSleepMinutes(minutes);
    sleepMinutesStore.set(minutes);
    sleepRemainingRef.current = minutes * 60;
    setSleepRemainingMin(minutes);
    lastSleepTickRef.current = 0;
    sleepRemainingStore.set(minutes * 60);
  }, []);

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
        localStorage.setItem(
          posKey(np.chapterPath, np.lang),
          String(audio.currentTime),
        );
        // Cross-device resume: write the position to its mirrored store every
        // tick; the store throttles the server save to ~once/5s (push.throttleMs).
        // The localStorage above stays per-tick for instant local resume.
        persistPos(np.chapterPath, audio.currentTime);
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
        if (next) {
          void fetch(`/api/marks?${query(next.path, np.lang, np.rendition)}`)
            .catch(() => {});
        }
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
            sleepRemainingStore.set(0);
            sleepMinutesStore.set(0);
          } else {
            sleepRemainingRef.current = remaining;
            const mins = Math.ceil(remaining / 60);
            // Only re-render when the displayed minute actually changes (the
            // handler fires ~4×/s).
            setSleepRemainingMin((prev) => (prev === mins ? prev : mins));
            // Write the remaining seconds every tick; the store throttles the
            // server save to ~once/5s (push.throttleMs).
            sleepRemainingStore.set(Math.round(remaining));
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
    const onPlay = (): void => {
      setPlaying(true);
      // Any path that actually starts the element (togglePlay, playHere,
      // auto-advance, OS/lock-screen play) claims playback for this client. We
      // own it now, so we're not "playing elsewhere".
      claimPlayback();
      setPlayingElsewhere(null);
    };
    const onPause = (): void => {
      setPlaying(false);
      // Distinguish a YIELDED pause (another client took over — keep their claim)
      // from a USER pause on the owning client (release → no one is playing).
      if (yieldingRef.current) {
        yieldingRef.current = false;
      } else {
        releasePlayback();
      }
      // Flush the current position server-side so a pause is immediately
      // resumable on another device (force the write past the store's throttle).
      const np = nowPlayingRef.current;
      if (np && audio.currentTime > 0) {
        persistPos(np.chapterPath, audio.currentTime);
        void posStore.flush();
      }
      // Freeze the sleep countdown: reseed so the paused gap isn't charged on
      // resume, and flush the remaining seconds so another device picks up the
      // frozen value.
      lastSleepTickRef.current = 0;
      if (sleepRemainingRef.current > 0) {
        sleepRemainingStore.set(Math.round(sleepRemainingRef.current));
        void sleepRemainingStore.flush();
      }
    };
    const onEnded = (): void => {
      const np = nowPlayingRef.current;
      if (np) localStorage.removeItem(posKey(np.chapterPath, np.lang));
      // Chapter finished: clear the saved position so a resume starts the next
      // chapter cleanly rather than at the previous chapter's end.
      if (np) {
        persistPos(np.chapterPath, 0);
        void posStore.flush();
      }
      // Book-level continuous playback: roll into the next chapter, else stop.
      if (queueIndexRef.current < queueRef.current.length - 1) {
        goTo(queueIndexRef.current + 1, true);
      } else {
        setPlaying(false);
        setCurrentIdx(-1);
      }
    };

    // The play/pause button must ALWAYS match the element. The `play`/`pause`
    // events alone aren't enough: loading a new chapter (a src change) pauses the
    // element WITHOUT firing `pause`, leaving the button stuck on "playing" (the
    // observed bug — a freshly-opened chapter showed the pause icon at 0:00). So
    // re-derive `playing` from `audio.paused` (the single source of truth) on every
    // transition that can change it, not just play/pause.
    const syncPlaying = (): void => {
      const real = !audio.paused;
      setPlaying((prev) => (prev === real ? prev : real));
    };
    const SYNC_EVENTS = [
      "playing",
      "waiting",
      "stalled",
      "emptied",
      "loadstart",
      "canplay",
      "seeked",
      "ratechange",
    ];

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    for (const ev of SYNC_EVENTS) audio.addEventListener(ev, syncPlaying);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      for (const ev of SYNC_EVENTS) audio.removeEventListener(ev, syncPlaying);
    };
  }, [goTo, claimPlayback, releasePlayback]);

  // Heartbeat: while WE are playing, re-stamp the claim every HEARTBEAT_MS so its
  // `ts` stays fresh (< CLAIM_STALE_MS) and another client never mistakes us for
  // a dead owner. Cleared on pause/unmount.
  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(claimPlayback, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [playing, claimPlayback]);

  // Observe the claim: when ANOTHER fresh client owns playback and we're audibly
  // playing, YIELD — pause our element without releasing the claim (the owner
  // holds it), and surface "playing on <label>". When the claim becomes ours /
  // null / stale, clear the "elsewhere" state so our play affordance returns.
  useEffect(() => {
    const evaluate = (): void => {
      const ap = activePlayerStore.get();
      // Keyed on instanceId (NOT deviceId): a claim from another tab of the SAME
      // browser still counts as "elsewhere", preserving same-browser two-tab
      // mutual exclusion exactly as before.
      const ownedElsewhere = ap !== null &&
        ap.instanceId !== INSTANCE_ID &&
        Date.now() - ap.ts < CLAIM_STALE_MS;
      if (ownedElsewhere) {
        const a = audioRef.current;
        if (a && !a.paused) {
          // Yielded pause: flag it so onPause keeps the new owner's claim intact.
          yieldingRef.current = true;
          a.pause();
        }
        setPlayingElsewhere({ label: ap.label });
      } else {
        // Our own claim, no claim, or a stale (dead-owner) claim → we're free.
        setPlayingElsewhere(null);
      }
    };
    evaluate();
    return activePlayerStore.subscribe(evaluate);
  }, []);

  // Startup lifecycle for the server-synced audio stores: HYDRATE (load each
  // store's device-local mirror for an instant first paint) → resume the local
  // session PAUSED → CONNECT (pull the server + reconcile + live-subscribe). The
  // adopt-the-server-position decision + the "已同步…" toast are driven HERE (the
  // calling code), not inside any store's `reconcile` — reconcile must stay pure.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 1) Hydrate every store from its local mirror. Only `sessionStore` has one
      //    (IDB), so this restores THIS device's last session for an instant
      //    paused mini-player ("continue listening" without auto-playing).
      await Promise.all(audioStores.map((s) => s.hydrate()));
      if (cancelled) return;
      const localSession = sessionStore.get();
      if (localSession) {
        loadTrack(
          localSession.nowPlaying,
          localSession.queue,
          localSession.queueIndex,
          false,
        );
      }

      // 2) Read the server copies (the bulk GET is memoized, so this shares the
      //    same fetch the `connect()` calls below use — no extra round-trip).
      const [rawRate, rawSleepRem, rawSleepMin, rawSession, rawPos] =
        await Promise
          .all([
            loadServerSetting("audio.rate"),
            loadServerSetting("audio.sleepRemaining"),
            loadServerSetting("audio.sleepMinutes"),
            loadServerSetting("audio.session"),
            loadServerSetting("audio.pos"),
          ]);
      if (cancelled) return;

      // 3) Start the live mirror lifecycle (pull + reconcile + subscribe). The
      //    stores now own the cross-device value; the imperative engine below
      //    just adopts the resume point + raises the toast once.
      for (const s of audioStores) s.connect();

      // Apply server rate (remote-wins) to the element. A rate that differs from
      // this device's last local value means another device changed it — raise
      // the generic "已同步设置" toast (the richer audio toast below wins if a
      // resume position also moved on the same load).
      let settingsSynced = false;
      const localRate = localStorage.getItem(RATE_KEY);
      const r = Number(rawRate);
      if (Number.isFinite(r) && r > 0) {
        setRate(r);
        if (rawRate !== null && rawRate !== localRate) settingsSynced = true;
      }

      // Restore the sleep timer as remaining SECONDS (frozen until playback
      // resumes the countdown), plus the chosen option for the menu highlight.
      const sr = Number(rawSleepRem);
      const smChoice = Number(rawSleepMin);
      if (Number.isFinite(sr) && sr > 0) {
        sleepRemainingRef.current = sr;
        setSleepRemainingMin(Math.ceil(sr / 60));
        if (Number.isFinite(smChoice) && smChoice > 0) {
          setSleepMinutes(smChoice);
        }
        lastSleepTickRef.current = 0; // counts down once playback starts (frozen until then)
      }

      // Reconcile the resume pointer (the server reflects the most recent write
      // from ANY device). Reload when the chapter differs from what hydrate
      // restored, OR when it's the same chapter but the server is meaningfully
      // ahead — i.e. another device kept listening past this one. Either is a
      // genuine cross-device pull, so it also raises the "已同步…" toast.
      let serverSession: PersistedSession | null = null;
      if (rawSession) {
        try {
          const parsed = JSON.parse(rawSession) as PersistedSession;
          if (parsed.nowPlaying && Array.isArray(parsed.queue)) {
            serverSession = parsed;
          }
        } catch {
          // ignore a corrupt server session blob
        }
      }
      let serverPos: AudioPos | null = null;
      if (rawPos) {
        try {
          const parsed = JSON.parse(rawPos) as AudioPos;
          if (typeof parsed.path === "string" && Number.isFinite(parsed.t)) {
            serverPos = parsed;
          }
        } catch {
          // ignore a corrupt server pos blob
        }
      }
      let audioSynced = false;
      if (serverSession) {
        const cur = nowPlayingRef.current;
        const chapterDiffers = !cur ||
          cur.chapterPath !== serverSession.nowPlaying.chapterPath ||
          cur.bookSlug !== serverSession.nowPlaying.bookSlug;
        const serverT = serverPos &&
            serverPos.path === serverSession.nowPlaying.chapterPath
          ? serverPos.t
          : 0;
        const localPos = cur
          ? Number(
            localStorage.getItem(posKey(cur.chapterPath, cur.lang)) ?? "0",
          )
          : 0;
        // Same chapter on both devices, but the server (another device) is
        // further along → adopt its position. The lead matches posStore.reconcile.
        const posAhead = !chapterDiffers &&
          serverT > localPos + SYNC_POS_LEAD_S;
        if (chapterDiffers || posAhead) {
          if (serverT > 0) {
            // Seed the per-chapter localStorage pos so loadTrack's existing
            // restore picks it up.
            localStorage.setItem(
              posKey(
                serverSession.nowPlaying.chapterPath,
                serverSession.nowPlaying.lang,
              ),
              String(serverT),
            );
          }
          loadTrack(
            serverSession.nowPlaying,
            serverSession.queue,
            serverSession.queueIndex,
            false,
          ); // PAUSED
          audioSynced = true;
          setSyncNotice({
            seq: Date.now(),
            message: t("sync.audio", {
              book: serverSession.nowPlaying.bookLabel,
              chapter: serverSession.nowPlaying.chapterLabel,
              time: fmtClock(serverT),
            }),
          });
        }
      }
      // A simple setting (rate) changed on another device → the generic
      // "已同步设置" toast. The richer audio toast wins when both moved.
      if (!audioSynced && settingsSynced) {
        setSyncNotice({ seq: Date.now(), message: t("sync.settings") });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Force any debounced/throttled writes out before the page is hidden/unloaded,
  // so a backgrounded tab (iOS especially) doesn't lose the last position / rate
  // / sleep / session. `pagehide` is the iOS-reliable terminal event (the page
  // may never fire `beforeunload`). One listener, flushing every audio store.
  useEffect(() => {
    const onPageHide = (): void => {
      for (const s of audioStores) void s.flush();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // OS / lock-screen / headphone controls. Metadata follows the chapter; the
  // handlers are wired once.
  useEffect(() => {
    // Native iOS shell: the native media bridge OWNS the OS controls (see the
    // onNativeMediaCommand effect below) — don't ALSO wire web MediaSession, they'd
    // fight over the same MPRemoteCommandCenter commands.
    if (nativeMediaAvailable()) return;
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => {
      const a = audioRef.current;
      if (a) {
        playAudio(
          a,
          (e) => setError(e instanceof Error ? e.message : String(e)),
        );
      }
    });
    ms.setActionHandler("pause", () => audioRef.current?.pause());
    ms.setActionHandler("previoustrack", () => prevChapter());
    ms.setActionHandler("nexttrack", () => nextChapter());
    ms.setActionHandler("seekbackward", (d) => {
      const a = audioRef.current;
      if (a) a.currentTime = Math.max(0, a.currentTime - (d.seekOffset ?? 15));
    });
    ms.setActionHandler("seekforward", (d) => {
      const a = audioRef.current;
      if (a) {
        a.currentTime = Math.min(
          a.duration || a.currentTime,
          a.currentTime + (d.seekOffset ?? 15),
        );
      }
    });
    ms.setActionHandler("seekto", (d) => {
      const a = audioRef.current;
      if (a && d.seekTime != null) a.currentTime = d.seekTime;
    });
  }, [nextChapter, prevChapter]);

  useEffect(() => {
    if (nativeMediaAvailable()) return; // native owns MPNowPlayingInfoCenter
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
        {
          src: `/api/artwork?book=${encodeURIComponent(nowPlaying.bookSlug)}`,
          sizes: "512x512",
          type: "image/png",
        },
      ],
    });
  }, [nowPlaying]);

  useEffect(() => {
    if (nativeMediaAvailable()) return; // native owns playbackState via setState
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = playing
      ? "playing"
      : nowPlaying
      ? "paused"
      : "none";
  }, [playing, nowPlaying]);

  // iOS deactivates the page's audio session AND its lock-screen position state
  // when the screen locks / the PWA is backgrounded. On return to the
  // foreground, re-push the element's timeline so the OS transport controls stay
  // responsive — a stale position state can leave even the lock-screen play
  // button unresponsive (see updatePositionState). The actual in-app resume is
  // handled by playAudio's interruption recovery.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      const a = audioRef.current;
      if (!a) return;
      updatePositionState(a);
      // Re-sync the in-app timeline + read-along highlight on return. While
      // backgrounded the page's JS (and `timeupdate`) is suspended, so
      // currentTime/currentIdx freeze at the moment we left — the highlight
      // then lags until the NEXT sentence boundary fires. Snap both to the
      // real playback position immediately so the highlight (and follow-scroll)
      // are correct the instant the reader reappears.
      setCurrentTime(a.currentTime);
      setCurrentIdx(markIndex(marksRef.current, a.currentTime * 1000));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Declare playback intent via the Audio Session API (the web equivalent of
  // AVAudioSession's `.playback` category). WebKit-only, best-effort: it does
  // NOT lift the standalone-PWA background/lock restriction (that needs a native
  // wrapper — see the Tauri shell), but it keeps foreground Safari and the
  // WKWebView (Tauri) case from ducking/mixing the narration. No-op elsewhere.
  useEffect(() => {
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = "playback";
    } catch {
      // unsupported browser — ignore
    }
  }, []);

  const playChapter = useCallback(
    (np: Omit<NowPlaying, "chapterLabel">, q: Track[], autoplay = false) => {
      const qi = q.findIndex((tk) => tk.path === np.chapterPath);
      const label = q[qi]?.label ?? np.chapterPath.split("/").pop() ??
        np.chapterPath;
      // Opening an audiobook loads it PAUSED — the player shows up at the saved
      // position and the user taps play to start. Chapter navigation
      // (goTo/next/prev/goToChapter) and auto-advance (onEnded) still autoplay,
      // since those happen during an active listen. The reader's read-aloud
      // button passes autoplay=true so one tap starts speaking immediately (the
      // tap is the user gesture iOS needs).
      loadTrack({ ...np, chapterLabel: label }, q, qi >= 0 ? qi : 0, autoplay);
    },
    [loadTrack],
  );

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      playAudio(a, (e) => setError(e instanceof Error ? e.message : String(e)));
    } else a.pause();
  }, []);

  // Take over playback from whichever client currently owns it. Claim FIRST (so
  // the handoff is felt instantly — the previous owner's observer pauses it),
  // then resume from the synced position (the element is already loaded at it;
  // posStore keeps it cross-device current). onPlay clears `playingElsewhere`
  // once the element actually starts.
  const playHere = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    claimPlayback();
    setPlayingElsewhere(null);
    playAudio(a, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [claimPlayback]);
  const seek = useCallback((sec: number) => {
    const a = audioRef.current;
    if (a) a.currentTime = sec;
  }, []);
  const skip = useCallback((delta: number) => {
    const a = audioRef.current;
    if (a) {
      a.currentTime = Math.min(
        a.duration || a.currentTime + delta,
        Math.max(0, a.currentTime + delta),
      );
    }
  }, []);
  const seekToSentence = useCallback((idx: number) => {
    const a = audioRef.current;
    const m = marksRef.current[idx];
    if (!a || !m) return;
    a.currentTime = m.start_ms / 1000;
    playAudio(a, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const setRate = useCallback((r: number) => {
    setRateState(r);
    rateRef.current = r;
    // localStorage stays the synchronous local seed for instant first paint;
    // the mirrored store owns the cross-device server write (immediate push).
    localStorage.setItem(RATE_KEY, String(r));
    rateStore.set(r);
    const a = audioRef.current;
    if (a) {
      a.playbackRate = r;
      a.defaultPlaybackRate = r;
      // Reflect the new rate in the OS timeline now — a paused element fires no
      // timeupdate, so the lock-screen scrubber would otherwise drift.
      updatePositionState(a);
    }
  }, []);
  // ── Native iOS media bridge (shared-utils native-media) ──────────────────────
  // On the native shell the OS controls (AirPods / lock screen / CarPlay) run
  // through native MPRemoteCommandCenter + MPNowPlayingInfoCenter — reliable where
  // the WKWebView MediaSession is not. Apply native commands to the audio element,
  // and feed native the now-playing metadata + transport state. No-ops off-shell.
  useEffect(() => {
    if (!nativeMediaAvailable()) return;
    return onNativeMediaCommand((cmd) => {
      switch (cmd.type) {
        case "play":
          playHere();
          break;
        case "pause":
          audioRef.current?.pause();
          break;
        case "toggle":
          togglePlay();
          break;
        case "next":
          nextChapter();
          break;
        case "prev":
          prevChapter();
          break;
        case "skipforward":
          skip(cmd.seconds);
          break;
        case "skipbackward":
          skip(-cmd.seconds);
          break;
        case "seek":
          seek(cmd.position);
          break;
      }
    });
  }, [togglePlay, playHere, skip, seek, nextChapter, prevChapter]);

  useEffect(() => {
    if (!nativeMediaAvailable()) return;
    if (!nowPlaying) {
      nativeMediaClear();
      return;
    }
    nativeMediaSetNowPlaying({
      title: nowPlaying.chapterLabel,
      artist: nowPlaying.bookLabel,
      album: nowPlaying.bookLabel,
      // Absolute URL — native URLSession can't resolve a relative path.
      artworkUrl: `${globalThis.location.origin}/api/artwork?book=${
        encodeURIComponent(nowPlaying.bookSlug)
      }`,
      duration,
    });
  }, [nowPlaying, duration]);

  useEffect(() => {
    if (!nativeMediaAvailable() || !nowPlaying) return;
    const push = (): void => {
      nativeMediaSetState({
        playing,
        position: audioRef.current?.currentTime ?? currentTime,
        rate,
      });
    };
    push();
    if (!playing) return;
    // Low-frequency tick — iOS extrapolates the scrubber between pushes from
    // elapsed + rate, so this just corrects drift / a seek.
    const id = window.setInterval(push, 1500);
    return () => window.clearInterval(id);
    // currentTime intentionally omitted — the interval reads it fresh off the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, rate, nowPlaying]);

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
    sleepRemainingStore.set(0);
    // Clear the resume pointer + position so a stopped session doesn't resurrect
    // on this or another device. sessionStore's codec encodes null as "" (the
    // empty value the server treats as "unset"); its IDB local mirror is cleared
    // too. posStore resets to its empty initial.
    sessionStore.set(null);
    posStore.set({ path: "", t: 0 });
  }, []);

  // Within-sentence read fraction (0–1) for the karaoke read-so-far wipe: the
  // playhead's position between this sentence's start mark and the next one's.
  const currentProgress = useMemo(() => {
    const m = marksRef.current;
    const cur = m[currentIdx];
    if (currentIdx < 0 || !cur) return 0;
    const start = cur.start_ms / 1000;
    const next = m[currentIdx + 1];
    const end = next ? next.start_ms / 1000 : (duration || start + 1);
    if (end <= start) return 0;
    return Math.min(1, Math.max(0, (currentTime - start) / (end - start)));
  }, [currentTime, currentIdx, duration]);

  const value = useMemo<AudioPlayer>(
    () => ({
      nowPlaying,
      sentences,
      currentIdx,
      currentProgress,
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
      playingElsewhere,
      playHere,
    }),
    [
      nowPlaying,
      sentences,
      currentIdx,
      currentProgress,
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
      playingElsewhere,
      playHere,
    ],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {
        /* The single, always-mounted narration element — never unmounts, so
          playback survives every in-app navigation. */
      }
      <audio ref={audioRef} preload="metadata" hidden />
    </Ctx.Provider>
  );
}

export function useAudioPlayer(): AudioPlayer {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useAudioPlayer must be used within an AudioPlayerProvider",
    );
  }
  return ctx;
}
