// The web (HTMLAudioElement) engine adapter: the element's events mapped onto
// the player, plus the iOS media-session and interruption-recovery helpers.

/** The player state and operations the element's events drive. */
export interface WebEngineHost {
  /** An explicit load is replacing the source; the element still holds the old one. */
  readonly sourcePending: boolean;
  readonly rate: number;
  position(position: number, duration: number): void;
  duration(duration: number): void;
  startSleepSession(): void;
  setPlaying(playing: boolean): void;
  /** The element paused at `position`, or `null` when the position belongs to
   *  a source being replaced or playback never started. */
  paused(position: number | null): void;
  ended(): void;
  failed(message: string): void;
}

/** The element surface the adapter reads (an `HTMLAudioElement` in the app). */
export type WebAudioElement = Pick<
  HTMLAudioElement,
  | "addEventListener"
  | "removeEventListener"
  | "currentTime"
  | "duration"
  | "paused"
  | "error"
  | "playbackRate"
>;

/** Events after which `playing` is re-derived from `audio.paused`. Loading a
 *  new source pauses the element WITHOUT firing `pause`, so play/pause alone
 *  would leave the button stuck on "playing" at 0:00. */
const SYNC_EVENTS = [
  "playing",
  "waiting",
  "stalled",
  "emptied",
  "loadstart",
  "canplay",
  "seeked",
  "ratechange",
] as const;

/** Wire the element's events to `host`; returns the detach function. */
export function attachWebAudio(audio: WebAudioElement, host: WebEngineHost): () => void {
  const onTime = (): void => {
    host.position(audio.currentTime, audio.duration);
    // <audio> path only: native owns MPNowPlayingInfoCenter itself.
    updatePositionState(audio);
  };
  const onMeta = (): void => {
    host.duration(audio.duration);
    audio.playbackRate = host.rate;
    // Seed the lock-screen timeline as soon as duration is known, so the OS
    // controls are live from the first frame rather than the first tick.
    updatePositionState(audio);
  };
  const onPlay = (): void => {
    host.startSleepSession();
    host.setPlaying(true);
  };
  const onPause = (): void => {
    host.setPlaying(false);
    // While a new chapter is resolving `audio.currentTime` still belongs to the
    // chapter being replaced.
    host.paused(!host.sourcePending && audio.currentTime > 0 ? audio.currentTime : null);
  };
  const onEnded = (): void => host.ended();
  // A source that cannot load (offline and not downloaded, or a failed
  // synthesis) only reports here; without it the transport sat at 0:00 with a
  // live-looking Play button and no explanation.
  const onMediaError = (): void => {
    if (host.sourcePending || !audio.error) return;
    host.failed(audio.error.message || `media error ${audio.error.code}`);
  };
  const syncPlaying = (): void => host.setPlaying(!audio.paused);

  const listeners: [string, () => void][] = [
    ["timeupdate", onTime],
    ["loadedmetadata", onMeta],
    ["durationchange", onMeta],
    ["play", onPlay],
    ["pause", onPause],
    ["ended", onEnded],
    ["error", onMediaError],
    ...SYNC_EVENTS.map((ev): [string, () => void] => [ev, syncPlaying]),
  ];
  for (const [ev, fn] of listeners) audio.addEventListener(ev, fn);
  return () => {
    for (const [ev, fn] of listeners) audio.removeEventListener(ev, fn);
  };
}

/** Push the element's timeline to the OS so the lock-screen scrubber tracks
 *  playback. iOS in particular NEEDS this once seek handlers are registered:
 *  without a valid position state its remote controls — the play/pause button
 *  included — go unresponsive (desktop browsers are forgiving, so the bug only
 *  shows on iOS). iOS also throws and drops the whole state unless every field
 *  is finite with `0 ≤ position ≤ duration` and `playbackRate > 0`, so clamp. */
export function updatePositionState(audio: Pick<HTMLAudioElement, "duration" | "currentTime" | "playbackRate">): void {
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
export function playAudio(
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

