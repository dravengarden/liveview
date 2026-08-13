// Repository-owned native media bridge contract.

// Native iOS media-control bridge — routes the OS now-playing / remote-control
// layer (lock screen, AirPods, CarPlay, steering wheel, Control Center) through
// native MPRemoteCommandCenter + MPNowPlayingInfoCenter + AVAudioSession, while
// the actual audio keeps playing in the web `<audio>` element.
//
// WHY: in a WKWebView the web MediaSession API is an unreliable proxy for the OS
// controls — AirPods taps don't toggle play/pause, AirPods removal doesn't pause,
// the lock-screen tile + transport go stale when the screen locks / the app
// backgrounds (the page's media session is deactivated). The audio itself keeps
// playing (the native shell's AVAudioSession is Playback), so the FIX is to move
// just the CONTROL + now-playing layer to native and bridge it to the web audio.
//
// Two directions:
//   • web → native: report what's playing + the play/pause/position/rate so native
//     can populate MPNowPlayingInfoCenter (iOS extrapolates the ticking progress
//     from elapsed + rate) and enable the right remote commands.
//   • native → web: deliver OS commands (play/pause/toggle/skip/seek/next/prev,
//     plus auto-pause on route change / interruption) back so the web applies them
//     to its `<audio>` element.
//
// Off the native iOS shell (PWA / Android / browser) the handler is absent, so every
// call no-ops and `onNativeMediaCommand` never fires — the web keeps its existing
// MediaSession path, untouched.

/** Metadata for the OS now-playing tile (lock screen / Control Center / CarPlay). */
export interface NativeNowPlaying {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  /** Server URL of the artwork PNG (not a data:/blob: URI — iOS needs a real URL). */
  readonly artworkUrl: string;
  /** Total chapter duration in seconds (0 if unknown yet). */
  readonly duration: number;
}

/** Live transport state — native sets MPNowPlayingInfoCenter elapsed + rate from it. */
export interface NativeMediaState {
  readonly playing: boolean;
  /** Current playback position in seconds. */
  readonly position: number;
  /** Playback rate (1 = normal). 0 when paused is fine — native reads `playing`. */
  readonly rate: number;
}

/** An OS-originated transport command the web should apply to its audio element. */
export type NativeMediaCommand =
  | { readonly type: "play" }
  | { readonly type: "pause" }
  | { readonly type: "toggle" }
  | { readonly type: "next" }
  | { readonly type: "prev" }
  | { readonly type: "skipforward"; readonly seconds: number }
  | { readonly type: "skipbackward"; readonly seconds: number }
  | { readonly type: "seek"; readonly position: number };

type OutMsg =
  | { readonly kind: "nowplaying"; readonly data: NativeNowPlaying }
  | { readonly kind: "state"; readonly data: NativeMediaState }
  | { readonly kind: "clear" };

interface WebKitHandler {
  postMessage(message: unknown): void;
}

function handler(): WebKitHandler | null {
  const w = globalThis as {
    webkit?: { messageHandlers?: Readonly<Record<string, WebKitHandler>> };
  };
  return w.webkit?.messageHandlers?.["lvNativeMedia"] ?? null;
}

function send(message: OutMsg): boolean {
  const h = handler();
  if (!h) {
    return false;
  }
  try {
    // WKScriptMessageHandler.postMessage (one-arg native bridge), NOT window.postMessage.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    h.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/** True only inside the native iOS shell that carries the media bridge. */
export function nativeMediaAvailable(): boolean {
  return handler() !== null;
}

/** Tell native what's now playing (call on chapter / book change). No-op off-shell. */
export function nativeMediaSetNowPlaying(data: NativeNowPlaying): boolean {
  return send({ kind: "nowplaying", data });
}

/**
 * Tell native the live transport state (call on play / pause / seek / rate change,
 * and periodically while playing so the lock-screen scrubber stays accurate). iOS
 * extrapolates the ticking progress from `position` + `rate`, so a low cadence
 * (~1–2s) while playing is enough. No-op off-shell.
 */
export function nativeMediaSetState(data: NativeMediaState): boolean {
  return send({ kind: "state", data });
}

/** Clear the OS now-playing tile (call when playback stops / the book closes). */
export function nativeMediaClear(): void {
  send({ kind: "clear" });
}

/**
 * Subscribe to OS transport commands (lock screen, AirPods, CarPlay, route-change
 * auto-pause, interruptions). The native shell dispatches a `lv-native-media`
 * CustomEvent on window with the command in `detail`; apply it to the audio
 * element. Returns an unsubscribe. Safe everywhere — the event never fires
 * off-shell.
 */
export function onNativeMediaCommand(
  handle: (command: NativeMediaCommand) => void,
): () => void {
  const listener = (e: Event): void => {
    const { detail } = e as CustomEvent<NativeMediaCommand>;
    if (detail && typeof detail.type === "string") {
      handle(detail);
    }
  };
  globalThis.addEventListener("lv-native-media", listener);
  return () => globalThis.removeEventListener("lv-native-media", listener);
}
