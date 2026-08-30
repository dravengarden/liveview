// Facade over the TypeScript IDB replica for reader content, plus the thin
// `lvsync://localhost` host for overlay/origins. AUDIO decode files stay in
// native-audio.ts (AVPlayer + bounded cacheFromUrl queue).
//
// Off the shell (PWA / browser) every helper falls back to a normal `fetch`
// (the service worker handles HTTP cache there).
//
// Reader content, covers, Downloads stats, and eager fill go through the
// TypeScript IDB replica. `lvsync://localhost` remains the document origin and
// thin host scheme (overlay / origins / host-info).

import { nativeAudioRequestState, onNativeAudioEvent } from "./native-audio.ts";
import { setAllowsCellular } from "./native-host.ts";
import { remoteUrl } from "./apiBase.ts";
import {
  artworkBlobSrc,
  currentReplicaPolicy,
  materializeArtworkSrc,
  pullMissingTextArt,
  refreshReplicaManifest,
  replicaAudioIndex,
  replicaCacheStats,
  replicaContentFetch,
  replicaFlag,
  setReplicaOfflineProbe,
} from "./replica/mod.ts";

/** True only inside the native shell (thin `lvsync://` host is registered). */
export function nativeSyncAvailable(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

/** Drop-in `fetch` for reader content. Resolves through the TypeScript IDB
 *  replica (store-first for manifest resources; cache/network-first for
 *  url-keyed lists). `fresh` is accepted for API compatibility. */
export async function contentFetch(
  url: string,
  opts?: { fresh?: boolean; cacheFirst?: boolean; connectMs?: number },
): Promise<Response> {
  if (replicaFlag() === "idb") {
    return replicaContentFetch(url, {
      ...(opts?.cacheFirst === true ? { cacheFirst: true } : {}),
      ...(opts?.connectMs !== undefined ? { connectMs: opts.connectMs } : {}),
      offline: isLikelyOffline() || nativeNetworkClass() === "none",
    });
  }
  // Replica is the only store; leftover `native` flags map to idb.
  return fetch(url);
}

/** Primary `src` for a book-cover `<img>`. Cover bytes are content-addressed DAG
 *  resources and auto-sync offline; physical WKWebViews have occasionally
 *  failed custom-scheme image loads even while fetches through the same scheme
 *  work. Use the ordinary remote image URL while online and let the image error
 *  handler fall back to the offline lvsync cache. */
export function coverSrc(slug: string): string {
  const u = `/api/cover?book=${encodeURIComponent(slug)}`;
  return artworkBlobSrc("cover", slug) ?? remoteUrl(u);
}

/** Wide, text-free DAG artwork for LiveView cards and hero surfaces. */
export function backdropSrc(slug: string): string {
  const u = `/api/backdrop?book=${encodeURIComponent(slug)}`;
  return artworkBlobSrc("backdrop", slug) ?? remoteUrl(u);
}

/** Compact opaque DAG rendition used by scrolling shelf cards. */
export function cardBackdropSrc(slug: string): string {
  const u = `/api/card-backdrop?book=${encodeURIComponent(slug)}`;
  return artworkBlobSrc("card-backdrop", slug) ?? remoteUrl(u);
}

/** Offline fallback for a failed native cover request. Returns `true` only when
 *  it changed the image source, so callers can stop retrying after both routes
 *  fail and reveal their gradient placeholder. */
export function recoverCoverImage(
  image: HTMLImageElement,
  slug: string,
): boolean {
  if (image.dataset["lvCover"] === slug) return false;
  image.dataset["lvCover"] = slug;
  void materializeArtworkSrc("cover", slug).then((url) => {
    if (url) image.src = url;
    else image.style.display = "none";
  });
  return true;
}

/** Native offline fallback for wide artwork. Mirrors cover recovery while
 * keeping the two cache keys and retry guards independent. */
export function recoverBackdropImage(
  image: HTMLImageElement,
  slug: string,
): boolean {
  if (image.dataset["lvBackdrop"] === slug) return false;
  image.dataset["lvBackdrop"] = slug;
  void materializeArtworkSrc("backdrop", slug).then((url) => {
    if (url) image.src = url;
    else image.style.display = "none";
  });
  return true;
}

/** Recover a card rendition through its native DAG cache.
 *
 * Never fall back to the full-size backdrop here. The shelf is a scrolling hot
 * path: decoding a 1600x900 hero image as each card enters the viewport causes
 * visible main-thread stalls in WKWebView. A missing compact DAG rendition is a
 * deployment/sync fault, so the card should reveal its deterministic gradient
 * until the next catalog sync repairs it. Larger hero surfaces may still use
 * {@link recoverBackdropImage} directly. */
export function recoverCardBackdropImage(
  image: HTMLImageElement,
  slug: string,
): boolean {
  const stage = image.dataset["lvCardBackdrop"];
  if (stage === "idb") return false;
  image.dataset["lvCardBackdrop"] = "idb";
  void materializeArtworkSrc("card-backdrop", slug).then((url) => {
    if (url) image.src = url;
    else image.style.display = "none";
  });
  return true;
}

/** Per-book offline coverage (not currently surfaced by the panel; kept for the type). */
export interface BookStat {
  slug: string;
  cached: number;
  total: number;
  cb: number;
  tb: number;
}
/** Offline-cache stats for non-audio content. `net` is a neutral placeholder here —
 *  content sync isn't network-gated (it's small); the "Waiting for WiFi" cue reads
 *  the AUDIO layer's reachability (native-audio), which owns the large WiFi-gated
 *  download. */
export interface CacheStats {
  net: "wifi" | "cell" | "none";
  cached: number;
  total: number;
  cb: number;
  tb: number;
  books: BookStat[];
}

/** Global non-audio content totals from the IDB replica agg row. */
export async function nativeCacheStats(): Promise<CacheStats> {
  const s = await replicaCacheStats();
  return {
    net: "wifi",
    cached: s.cached,
    total: s.total,
    cb: s.cachedBytes,
    tb: s.totalBytes,
    books: [],
  };
}

/** Eager-pull the whole corpus's non-audio content into the IDB replica. */
export async function nativeSyncAll(_wifiOnly = false): Promise<number> {
  await pullMissingTextArt();
  return (await replicaCacheStats()).cachedBytes;
}

export interface NativeAudioResource {
  hash: string;
  kind: "audio" | "marks";
  url: string;
  path: string;
  bytes: number;
}

/** Audio/marks subset of the IDB replica path index. */
export async function nativeAudioIndex(): Promise<NativeAudioResource[]> {
  return replicaAudioIndex();
}

/** Keep replica fail-fast in sync with connectivity.
 *
 *  Two signals, because `navigator.onLine` is unreliable in WKWebView (it often
 *  stays `true` in airplane mode):
 *   - navigator.onLine + online/offline events: instant WHEN they fire.
 *   - native NWPathMonitor push events: the reliable airplane-mode signal.
 */
/** Last-known reliable offline state, kept fresh by NWPathMonitor events. Read
 *  this instead of `navigator.onLine`, which is unreliable
 *  in WKWebView (commonly stays `true` in airplane mode). */
let knownOffline = false;
export type NativeNetworkClass = "wifi" | "cell" | "none" | "unknown";
let knownNetworkClass: NativeNetworkClass = "unknown";
const networkListeners = new Set<(net: NativeNetworkClass) => void>();

export function nativeNetworkClass(): NativeNetworkClass {
  return knownNetworkClass;
}

export function onNativeNetworkClass(
  listener: (net: NativeNetworkClass) => void,
): () => void {
  networkListeners.add(listener);
  listener(knownNetworkClass);
  return () => {
    networkListeners.delete(listener);
  };
}

/** Whether the device is (reliably) offline. On the shell this is the NWPathMonitor-
 *  derived flag; off-shell it falls back to `navigator.onLine` (reliable there). */
export function isLikelyOffline(): boolean {
  if (nativeSyncAvailable()) return knownOffline;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function startOfflineFlagSync(): void {
  setReplicaOfflineProbe(
    () => isLikelyOffline() || nativeNetworkClass() === "none",
  );
  if (!nativeSyncAvailable()) return;
  let last: boolean | null = null;
  const apply = (offline: boolean): void => {
    knownOffline = offline; // reliable signal for the reader path (isLikelyOffline)
    if (offline === last) return;
    last = offline;
  };
  const applyNetwork = (net: NativeNetworkClass): void => {
    if (knownNetworkClass === net) return;
    knownNetworkClass = net;
    for (const listener of networkListeners) listener(net);
    apply(net === "none");
  };
  apply(!navigator.onLine);
  globalThis.addEventListener("online", () => apply(false));
  globalThis.addEventListener("offline", () => apply(true));
  // Native re-emits `network` on `state` so a listener installed after the
  // first NWPathMonitor fire still gets a snapshot.
  nativeAudioRequestState();
  onNativeAudioEvent((event) => {
    if (event.type === "network") applyNetwork(event.net);
  });
}

/** Re-pull /api/dag → refresh the native content manifest. MUST run on every app
 *  open + foreground, not just cold launch: otherwise a warm-resumed device never
 *  learns about resources ADDED to the corpus since its last cold launch (e.g. the
 *  audio-rendition `spoken` transcripts), so `total` never grows, the cached<total
 *  sync never fires, and those chapters stay blank offline. After this returns the
 *  sync pump (useAudioPreloadDriver) downloads whatever's newly listed. No-op
 *  off-shell; never throws. */
export async function nativeRefreshManifest(): Promise<string> {
  return refreshReplicaManifest();
}

// ── Download preferences (persisted, shell-only). Auto-download defaults ON, and
// WiFi-only defaults ON so we never surprise-burn cellular data.

const AUTO_KEY = "lv.offline.auto";
const WIFI_KEY = "lv.offline.wifiOnly";

export function offlineAuto(): boolean {
  return (globalThis.localStorage?.getItem(AUTO_KEY) ?? "1") === "1";
}
export function offlineWifiOnly(): boolean {
  return (globalThis.localStorage?.getItem(WIFI_KEY) ?? "1") === "1";
}
export function setOfflineAuto(on: boolean): void {
  globalThis.localStorage?.setItem(AUTO_KEY, on ? "1" : "0");
  if (on) void ensureAutoSync();
}
export function setOfflineWifiOnly(on: boolean): void {
  globalThis.localStorage?.setItem(WIFI_KEY, on ? "1" : "0");
  // Native enforces this on its foreground `.default` pool via
  // allowsCellularAccess. Those sessions suspend when the app backgrounds —
  // that is the accepted ceiling; JS cannot continue transfers while suspended.
  setAllowsCellular({ on: !on });
  // Relaxing the constraint may unblock a previously-refused run.
  if (!on) void ensureAutoSync();
}

/** Kick off (or continue) the eager download IF auto-download is on. Safe to call
 *  repeatedly — the native side guards against concurrent runs, and a WiFi-only
 *  refusal is a no-op until WiFi returns (the settings poll re-fires it). */
export async function ensureAutoSync(): Promise<void> {
  if (currentReplicaPolicy().mode !== "eager") return;
  try {
    await nativeSyncAll(offlineWifiOnly());
  } catch {
    /* transient; the next poll/startup retries */
  }
}
