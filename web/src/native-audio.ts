// Repository-owned native audio bridge contract.
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

import { hostAudioAvailable, postHostAudio } from "./native-host.ts";

export {
  cacheCount,
  cacheDelete,
  cacheFromUrl,
  cacheHas,
  setAllowsCellular,
} from "./native-host.ts";

/** A track to load into the native player. */
export interface NativeAudioTrack {
  /** Absolute media URL (the native URLSession can't resolve a relative path). */
  readonly url: string;
  /** Content hash (manifest audio_hash) — the offline cache key, so the same
   *  audio dedups + survives a re-render. Omit/empty ⇒ native keys by the URL. */
  readonly hash?: string;
  /** Exact body length from the DAG/manifest. Optional for older web bundles. */
  readonly bytes?: number;
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
  /** Opaque reader identity, echoed when native advances without JavaScript. */
  readonly context?: string;
  readonly queue?: { readonly id: string; readonly index: number; readonly count: number };
}

export interface NativePlaybackSnapshot {
  readonly type: "snapshot";
  readonly queueVersion: 1;
  readonly queueId: string | null;
  readonly index: number;
  readonly count: number;
  readonly context: string | null;
  readonly position: number;
  readonly duration: number;
  readonly rate: number;
  readonly playing: boolean;
  readonly waiting: boolean;
  readonly sleepRemaining: number;
  readonly needsAdvance: boolean;
  readonly ended: boolean;
  readonly error: string | null;
  readonly completed: readonly { readonly serial: number; readonly context: string }[];
}

export interface NativeWidgetSnapshot {
  readonly serverURL: string;
  readonly items: readonly {
    readonly label: string;
    readonly slug: string;
    readonly progress: number;
    readonly coverURL: string;
  }[];
}

/** A state event the native engine reports back so the web UI + read-along track
 *  it (position drives the karaoke wipe; ended advances the chapter; next/prev
 *  are lock-screen track buttons the web's queue must service). */
export type NativeAudioEvent = NativePlaybackSnapshot | ({
    readonly type: "time";
    readonly position: number;
    readonly duration: number;
    readonly sleepRemaining?: number;
  }
  | { readonly type: "durationchange"; readonly duration: number }
  | { readonly type: "playing" }
  | { readonly type: "paused" }
  | { readonly type: "ended" }
  | { readonly type: "waiting" }
  | { readonly type: "canplay" }
  | {
    readonly type: "network";
    readonly net: "wifi" | "cell" | "none";
  }
  | { readonly type: "next" }
  | { readonly type: "prev" }
  | { readonly type: "error"; readonly message: string }
  | {
    readonly type: "cacheProgress";
    readonly hash: string;
    readonly ok: boolean;
  }) & { readonly queueId?: string; readonly index?: number };

type OutMsg =
  | { readonly kind: "load"; readonly data: NativeAudioTrack }
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" }
  | { readonly kind: "state" }
  | { readonly kind: "queueTracks"; readonly data: { queueId: string; start: number; tracks: readonly (NativeAudioTrack | null)[] } }
  | { readonly kind: "queueGo"; readonly data: { queueId: string; index: number } }
  | { readonly kind: "queueAck"; readonly data: { queueId: string; through: number } }
  | { readonly kind: "sleep"; readonly data: { seconds: number } }
  | { readonly kind: "seek"; readonly data: { readonly position: number } }
  | { readonly kind: "rate"; readonly data: { readonly rate: number } }
  | { readonly kind: "widgetSnapshot"; readonly data: NativeWidgetSnapshot };

function send(message: OutMsg): boolean {
  return postHostAudio(message);
}

/** True only inside the native iOS shell that carries the AVPlayer engine (the
 *  `lvNativeAudio` WKScriptMessageHandler is registered). When false, the caller
 *  uses the web `<audio>` element instead. The native engine is the DEFAULT on
 *  the shell — it's what gives reliable lock-screen / background / resume that
 *  WKWebView's `<audio>` can't. */
export function nativeAudioAvailable(): boolean {
  return hostAudioAvailable();
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

/** Ask the native engine to re-emit its CURRENT state (playing/paused + position
 *  + duration). The web calls this on mount so a page reload re-syncs to the
 *  still-running native player instead of showing a stale paused button. */
export function nativeAudioRequestState(): boolean {
  return send({ kind: "state" });
}

let queueSupported = false;

export function nativeAudioQueueAvailable(): boolean { return queueSupported; }

/** Probe the existing v1 state command. New shells reply with a snapshot first;
 * legacy shells reply with time/duration events and keep their existing path. */
export async function nativeAudioProbeState(): Promise<NativePlaybackSnapshot | null> {
  if (!nativeAudioAvailable()) return null;
  return new Promise(resolve => {
    const done = (state: NativePlaybackSnapshot | null): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
    };
    const unsubscribe = onNativeAudioEvent(event => {
      if (event.type === "snapshot") done(event);
      // A running queue can emit its periodic clock before the state reply.
      // That clock is not a legacy probe response: wait for its native pointer.
      else if (event.type === "time" && !event.queueId && !queueSupported) done(null);
    });
    const timer = setTimeout(() => done(null), 1000);
    nativeAudioRequestState();
  });
}

export function nativeAudioQueueTracks(queueId: string, start: number, tracks: readonly (NativeAudioTrack | null)[]): boolean {
  return queueSupported && tracks.length <= 16 && send({ kind: "queueTracks", data: { queueId, start, tracks } });
}

export function nativeAudioQueueGo(queueId: string, index: number): boolean {
  return queueSupported && send({ kind: "queueGo", data: { queueId, index } });
}

export function nativeAudioQueueAck(queueId: string, through: number): boolean {
  return queueSupported && send({ kind: "queueAck", data: { queueId, through } });
}

export function nativeAudioSleep(seconds: number): boolean {
  return queueSupported && send({ kind: "sleep", data: { seconds } });
}

/** Publish a compact, cover-backed reading snapshot for WidgetKit. The native
 * layer writes it to the App Group when that entitlement is available; the
 * widget independently keeps its network fallback for Personal Team builds. */
export function nativeWidgetPublish(data: NativeWidgetSnapshot): boolean {
  return send({ kind: "widgetSnapshot", data });
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
      if (detail.type === "snapshot") {
        if (detail.queueVersion !== 1) return;
        queueSupported = true;
      }
      handle(detail);
    }
  };
  globalThis.addEventListener("lv-native-audio", listener);
  return () => globalThis.removeEventListener("lv-native-audio", listener);
}
