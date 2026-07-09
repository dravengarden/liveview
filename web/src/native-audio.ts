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
  | { readonly kind: "state" }
  | { readonly kind: "seek"; readonly data: { readonly position: number } }
  | { readonly kind: "rate"; readonly data: { readonly rate: number } }
  | {
    readonly kind: "prefetch";
    readonly data: { readonly url: string; readonly hash?: string };
  }
  | {
    readonly kind: "pin";
    readonly data: { readonly items: { url: string; hash: string }[] };
  }
  | {
    readonly kind: "preload";
    readonly data: { readonly items: { url: string; hash: string }[] };
  }
  | { readonly kind: "unpin"; readonly data: { readonly keys: string[] } }
  | { readonly kind: "setCap"; readonly data: { readonly bytes: number } }
  | { readonly kind: "setWifiOnly"; readonly data: { readonly on: boolean } }
  | { readonly kind: "audioStats"; readonly data: { readonly id: string } };

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

/** True only inside the native iOS shell that carries the AVPlayer engine (the
 *  `lvNativeAudio` WKScriptMessageHandler is registered). When false, the caller
 *  uses the web `<audio>` element instead. The native engine is the DEFAULT on
 *  the shell — it's what gives reliable lock-screen / background / resume that
 *  WKWebView's `<audio>` can't. */
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

/** Ask the native engine to re-emit its CURRENT state (playing/paused + position
 *  + duration). The web calls this on mount so a page reload re-syncs to the
 *  still-running native player instead of showing a stale paused button. */
export function nativeAudioRequestState(): boolean {
  return send({ kind: "state" });
}

/** Download a chapter into the offline cache WITHOUT playing it (save-offline).
 *  Keyed by `hash` (else the URL). No-op off-shell. */
export function nativeAudioPrefetch(url: string, hash?: string): boolean {
  return send({
    kind: "prefetch",
    data: hash !== undefined ? { url, hash } : { url },
  });
}

// ── Offline pinning (per-book audio download) + store stats. The audio store is
// durable (Application Support) with two tiers: PINNED (user-downloaded, never
// evicted) and auto (LRU-capped, cached as a side-effect of playing).

/** MANUAL download: pin a book's chapters (protected — never auto-evicted). */
export function nativeAudioPin(items: { url: string; hash: string }[]): boolean {
  return send({ kind: "pin", data: { items } });
}

/** AUTO preload: fill the storage budget with these chapters (evictable, LRU). */
export function nativeAudioPreload(items: { url: string; hash: string }[]): boolean {
  return send({ kind: "preload", data: { items } });
}

/** Set the audio storage budget (bytes); native evicts evictable audio to fit. */
export function nativeAudioSetCap(bytes: number): boolean {
  return send({ kind: "setCap", data: { bytes } });
}

/** Push the "prefetch on WiFi only" preference to the native downloader. Native
 *  enforces it on its BACKGROUND download sessions via `allowsCellularAccess` —
 *  the web's own WiFi gate only stops ENQUEUING and can't reach transfers that
 *  keep running in the system daemon while the app is suspended. Push it at
 *  startup and whenever the toggle changes. No-op off-shell. */
export function nativeAudioSetWifiOnly(on: boolean): boolean {
  return send({ kind: "setWifiOnly", data: { on } });
}

/** Remove (delete) a book's audio — the only way audio leaves the durable store
 *  (nothing is auto-evicted). `keys` are the sanitized content hashes. */
export function nativeAudioUnpin(keys: string[]): boolean {
  return send({ kind: "unpin", data: { keys } });
}

/** Audio store state for the Downloads UI. `cached` is the set of cache keys
 *  (sanitized content hashes) on disk; the caller maps them to books via the
 *  manifest. `usedBytes` is total durable audio storage used (no cap — it's data,
 *  not a cache). */
export interface AudioStats {
  usedBytes: number;
  /** Storage budget in bytes (the user's max-storage setting). */
  cap: number;
  /** Bytes held by PINNED (manually-downloaded, eviction-protected) books. */
  pinnedBytes: number;
  /** Count of cached blobs — the O(1) SQLite aggregate. Lets the Downloads UI show
   *  done/total WITHOUT diffing the full `cached` array against the manifest. */
  cachedCount: number;
  /** All cache keys on disk (sanitized content hashes). Still used by the download
   *  driver to skip already-cached items; the UI prefers `cachedCount`. */
  cached: string[];
  /** The pinned (protected) subset. */
  pinned: string[];
  /** Live network path type — drives the "prefetch on WiFi only" gate for the large
   *  audio download (the WiFi-gated one). Moved here from the retired content layer. */
  net: "wifi" | "cell" | "none";
  /** Download diagnostics (native downloader): tasks in flight, items queued,
   *  completions since launch, and the most recent non-cancel transfer error.
   *  Surfaced in the Downloads panel so a stalled fill is debuggable on-device. */
  dlInflight?: number;
  dlQueued?: number;
  dlDone?: number;
  dlErr?: string;
  /** TRUE on-disk `.caf` count (diagnostic). If this exceeds `cachedCount` the
   *  SQLite index has drifted below disk and the fill is wedged (native skips the
   *  re-sent items as already-on-disk). */
  dlDisk?: number;
  /** Device free space in bytes (volumeAvailableCapacityForImportantUsage). The
   *  fill can't grow past this regardless of the app budget. */
  freeBytes?: number;
}

const audioPending = new Map<string, (json: string) => void>();
let audioResolverInstalled = false;
function ensureAudioResolver(): void {
  if (audioResolverInstalled) return;
  audioResolverInstalled = true;
  (globalThis as unknown as {
    __lvAudioResolve?: (id: string, json: string) => void;
  }).__lvAudioResolve = (id, json) => {
    const r = audioPending.get(id);
    if (r) {
      audioPending.delete(id);
      r(json);
    }
  };
}
let audioSeq = 0;

/** Query the native audio store (null off-shell or on timeout). */
export async function nativeAudioStats(): Promise<AudioStats | null> {
  if (!nativeAudioAvailable()) return null;
  ensureAudioResolver();
  const id = `a${++audioSeq}`;
  const json = await new Promise<string>((resolve) => {
    audioPending.set(id, resolve);
    send({ kind: "audioStats", data: { id } });
    setTimeout(() => {
      if (audioPending.delete(id)) resolve("");
    }, 20_000);
  });
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<AudioStats>;
    return {
      usedBytes: o.usedBytes ?? 0,
      cap: o.cap ?? 0,
      pinnedBytes: o.pinnedBytes ?? 0,
      cachedCount: o.cachedCount ?? (o.cached?.length ?? 0),
      cached: o.cached ?? [],
      pinned: o.pinned ?? [],
      net: o.net ?? "wifi",
      ...(o.dlInflight != null ? { dlInflight: o.dlInflight } : {}),
      ...(o.dlQueued != null ? { dlQueued: o.dlQueued } : {}),
      ...(o.dlDone != null ? { dlDone: o.dlDone } : {}),
      ...(o.dlErr != null ? { dlErr: o.dlErr } : {}),
      ...(o.dlDisk != null ? { dlDisk: o.dlDisk } : {}),
      ...(o.freeBytes != null ? { freeBytes: o.freeBytes } : {}),
    };
  } catch {
    return null;
  }
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
