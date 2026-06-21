// MIRROR of @shared-utils/native-media (packages/native-media/native-audio.ts).
// Inlined until shared-utils publishes the package + the flake is bumped; keep in sync.
//
// Native iOS AVPlayer audio bridge — moves the actual audio DECODING + session to
// a native AVPlayer (NativeAudioController.swift), with the web app as a thin
// remote. Heavier sibling of native-media.ts: that keeps audio in the web
// `<audio>` and moves only the now-playing/remote layer native; THIS moves
// playback itself off the web.
//
// WHY: WKWebView web `<audio>` cannot reliably hold the audio session or resume
// after a long background/locked pause — a system-gated WebKit limitation
// (bugs.webkit.org #198277 / #204261). For bulletproof lock-screen / background /
// AirPods playback the audio must be decoded natively. The web sends transport
// intents (load/play/pause/seek/rate) and renders the read-along off the position
// the native engine reports back.
//
// Off the native shell (PWA / Android / browser) the `lvNativeAudio` handler is
// absent, so `nativeAudioAvailable()` is false and the app keeps using the web
// `<audio>` element — this bridge is inert.

/** A track to load into the native player. */
export interface NativeAudioTrack {
  /** Absolute media URL (the native URLSession can't resolve a relative path). */
  readonly url: string;
  /** Content hash (manifest audio_hash) — the offline cache key, so the same
   *  audio dedups + survives a re-render. Omit/empty ⇒ native keys by the URL. */
  readonly hash?: string;
  /** Resume position in seconds (0 = from the start). */
  readonly position: number;
  /** Playback rate (1 = normal). */
  readonly rate: number;
  /** Now-playing metadata for the lock screen. */
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  /** Absolute artwork PNG URL (not data:/blob: — iOS needs a real URL). */
  readonly artworkUrl: string;
}

/** A state event the native engine reports back so the web UI + read-along track
 *  it (position drives the karaoke wipe; ended advances the chapter; next/prev
 *  are lock-screen track buttons the web's queue must service). */
export type NativeAudioEvent =
  | { readonly type: "time"; readonly position: number; readonly duration: number }
  | { readonly type: "durationchange"; readonly duration: number }
  | { readonly type: "playing" }
  | { readonly type: "paused" }
  | { readonly type: "ended" }
  | { readonly type: "waiting" }
  | { readonly type: "canplay" }
  | { readonly type: "next" }
  | { readonly type: "prev" }
  | { readonly type: "error"; readonly message: string };

type OutMsg =
  | { readonly kind: "load"; readonly data: NativeAudioTrack }
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" }
  | { readonly kind: "seek"; readonly data: { readonly position: number } }
  | { readonly kind: "rate"; readonly data: { readonly rate: number } }
  | {
    readonly kind: "prefetch";
    readonly data: { readonly url: string; readonly hash?: string };
  };

interface WebKitHandler {
  postMessage(message: unknown): void;
}

function handler(): WebKitHandler | null {
  const w = globalThis as {
    webkit?: { messageHandlers?: Readonly<Record<string, WebKitHandler>> };
  };
  return w.webkit?.messageHandlers?.["lvNativeAudio"] ?? null;
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

/** True only inside the native iOS shell that carries the AVPlayer engine. When
 *  false, the caller must use the web `<audio>` element instead. */
export function nativeAudioAvailable(): boolean {
  return handler() !== null;
}

/** Load (replace) the current track. Pass the resume position + rate so native
 *  seeks before the first play. No-op off-shell. */
export function nativeAudioLoad(data: NativeAudioTrack): boolean {
  return send({ kind: "load", data });
}

export function nativeAudioPlay(): boolean {
  return send({ kind: "play" });
}

export function nativeAudioPause(): boolean {
  return send({ kind: "pause" });
}

export function nativeAudioSeek(position: number): boolean {
  return send({ kind: "seek", data: { position } });
}

export function nativeAudioSetRate(rate: number): boolean {
  return send({ kind: "rate", data: { rate } });
}

/** Stop + clear (book closed / playback stopped). Releases the session + tile. */
export function nativeAudioStop(): boolean {
  return send({ kind: "stop" });
}

/** Download a chapter into the offline cache WITHOUT playing it (save-offline).
 *  Keyed by `hash` (else the URL). No-op off-shell. */
export function nativeAudioPrefetch(url: string, hash?: string): boolean {
  return send({
    kind: "prefetch",
    data: hash !== undefined ? { url, hash } : { url },
  });
}

/**
 * Subscribe to native-engine state events. The shell dispatches a
 * `lv-native-audio` CustomEvent on window with the event in `detail`. Returns an
 * unsubscribe. Safe everywhere — the event never fires off-shell.
 */
export function onNativeAudioEvent(
  handle: (event: NativeAudioEvent) => void,
): () => void {
  const listener = (e: Event): void => {
    const { detail } = e as CustomEvent<NativeAudioEvent>;
    if (detail && typeof detail.type === "string") {
      handle(detail);
    }
  };
  globalThis.addEventListener("lv-native-audio", listener);
  return () => globalThis.removeEventListener("lv-native-audio", listener);
}
