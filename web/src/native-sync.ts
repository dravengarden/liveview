// Bridge to the native offline-content layer via the `lvsync://` URI SCHEME
// (tauri-plugin-lvsync, Rust + SqliteBlobStore). The bundled SPA loads from the
// LOCAL origin (tauri://localhost), where a registered WKURLSchemeHandler reaches
// Rust DIRECTLY — reliable on device, unlike webview→plugin IPC. This REPLACES the
// old Swift "lvSync" WKScriptMessageHandler (LvSyncController) for reader CONTENT;
// AUDIO stays in native-audio.ts (native AVPlayer, its own cache).
//
//   GET lvsync://localhost/resolve?u=<encoded api url>  → bytes (200) | 504 offline
//   GET lvsync://localhost/stats                        → [cached,total,cb,tb]
//   GET lvsync://localhost/sync_all                     → bytes-cached (number)
//   GET lvsync://localhost/audio-index                  → cached audio/marks manifest
//
// Off the shell (PWA / browser) the scheme is absent → every helper falls back to a
// normal `fetch` (the service worker handles offline there).

import { nativeAudioSetWifiOnly, nativeAudioStats } from "@/native-audio";
import { remoteUrl } from "@/apiBase";

const SCHEME = "lvsync://localhost";

/** True only inside the native shell (where the lvsync:// plugin is registered). */
export function nativeSyncAvailable(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

/** Drop-in `fetch` for reader content. On the shell it resolves through the native
 *  Rust content store (offline-safe): the engine serves immutable content-addressed
 *  resources cache-first and LIVE lists (/api/tree, /api/books, progress…) network-
 *  first-then-cache automatically, so freshness is implied by the resource — `fresh`
 *  is accepted for API compatibility but no longer needed. */
export async function contentFetch(
  url: string,
  opts?: { fresh?: boolean; cacheFirst?: boolean },
): Promise<Response> {
  if (!nativeSyncAvailable()) return fetch(url);
  try {
    // cacheFirst: serve the cached copy WITHOUT a network round-trip for a
    // deploy-stable map on a hot path (e.g. audioHash's /api/manifest, which the
    // audio switch awaits — a network-first stall there hangs playback even though
    // the bytes are local). The url-keyed path is network-first otherwise.
    const cf = opts?.cacheFirst ? "&cf=1" : "";
    const r = await fetch(
      `${SCHEME}/resolve?u=${encodeURIComponent(url)}${cf}`,
    );
    if (r.status === 200) {
      return new Response(await r.arrayBuffer(), { status: 200 });
    }
    return new Response(null, { status: 504, statusText: "offline" });
  } catch {
    // Scheme failed unexpectedly — last resort to the network (online only).
    return navigator.onLine ? fetch(url) : new Response(null, { status: 504 });
  }
}

/** Primary `src` for a book-cover `<img>`. Physical WKWebViews have occasionally
 *  failed custom-scheme image loads even while fetches through the same scheme
 *  work. Use the ordinary remote image URL while online and let the image error
 *  handler fall back to the offline lvsync cache. */
export function coverSrc(slug: string): string {
  const u = `/api/cover?book=${encodeURIComponent(slug)}`;
  return nativeSyncAvailable() ? remoteUrl(u) : u;
}

/** Wide, text-free artwork for LiveView cards and hero surfaces. */
export function backdropSrc(slug: string): string {
  const u = `/api/backdrop?book=${encodeURIComponent(slug)}`;
  return nativeSyncAvailable() ? remoteUrl(u) : u;
}

/** Offline fallback for a failed native cover request. Returns `true` only when
 *  it changed the image source, so callers can stop retrying after both routes
 *  fail and reveal their gradient placeholder. */
export function recoverCoverImage(
  image: HTMLImageElement,
  slug: string,
): boolean {
  if (!nativeSyncAvailable()) return false;
  const u = `/api/cover?book=${encodeURIComponent(slug)}`;
  const fallback = `${SCHEME}/resolve?u=${encodeURIComponent(u)}`;
  if (image.src !== fallback && image.dataset["lvCover"] !== slug) {
    image.src = fallback;
    return true;
  }
  if (image.dataset["lvCover"] === slug) return false;

  // Some physical WKWebViews reject a custom-scheme URL specifically when it
  // is assigned to <img src>, although fetch() through the same registered
  // scheme succeeds. Materialize those bytes as a WebKit-owned blob URL. This
  // is attempted only after both the ordinary remote URL and direct scheme URL
  // fail, so normal browsers and healthy native loads keep lazy image loading.
  image.dataset["lvCover"] = slug;
  void fetch(fallback)
    .then((response) => {
      if (!response.ok) throw new Error(`cover ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      image.src = URL.createObjectURL(blob);
    })
    .catch((error: unknown) => {
      console.warn("cover image recovery failed", { slug, error });
      image.style.display = "none";
    });
  return true;
}

/** Native offline fallback for wide artwork. Mirrors cover recovery while
 * keeping the two cache keys and retry guards independent. */
export function recoverBackdropImage(
  image: HTMLImageElement,
  slug: string,
): boolean {
  if (!nativeSyncAvailable()) return false;
  const u = `/api/backdrop?book=${encodeURIComponent(slug)}`;
  const fallback = `${SCHEME}/resolve?u=${encodeURIComponent(u)}`;
  if (image.src !== fallback && image.dataset["lvBackdrop"] !== slug) {
    image.src = fallback;
    return true;
  }
  if (image.dataset["lvBackdrop"] === slug) return false;
  image.dataset["lvBackdrop"] = slug;
  void fetch(fallback)
    .then((response) => {
      if (!response.ok) throw new Error(`backdrop ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      image.src = URL.createObjectURL(blob);
    })
    .catch((error: unknown) => {
      console.warn("backdrop image recovery failed", { slug, error });
      image.style.display = "none";
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

/** Global non-audio content totals from the Rust store: [cached, total, cb, tb]. */
export async function nativeCacheStats(): Promise<CacheStats> {
  const r = await fetch(`${SCHEME}/stats`);
  if (r.status !== 200) throw new Error("stats unavailable");
  const a = (await r.json()) as [number, number, number, number];
  return {
    net: "wifi", // content isn't wifi-gated; OfflineSection takes net from audio
    cached: a[0] ?? 0,
    total: a[1] ?? 0,
    cb: a[2] ?? 0,
    tb: a[3] ?? 0,
    books: [],
  };
}

/** Eager-pull the whole corpus's non-audio content into the Rust store. Resolves to
 *  bytes downloaded this run; long-running, so poll {@link nativeCacheStats} for
 *  live progress. Content is small (~tens of MB) so it is NOT WiFi-gated — the large
 *  audio download stays WiFi-gated in native-audio. `wifiOnly` is accepted for API
 *  compatibility but not enforced for content. */
export async function nativeSyncAll(_wifiOnly = false): Promise<number> {
  if (!nativeSyncAvailable()) return 0;
  const r = await fetch(`${SCHEME}/sync_all`);
  if (r.status !== 200) throw new Error("sync failed");
  return Number(await r.text()) || 0;
}

export interface NativeAudioResource {
  hash: string;
  kind: "audio" | "marks";
  url: string;
  path: string;
}

/** Audio/marks subset of the manifest already refreshed by the Rust plugin. */
export async function nativeAudioIndex(): Promise<NativeAudioResource[]> {
  if (!nativeSyncAvailable()) return [];
  const response = await fetch(`${SCHEME}/audio-index`);
  if (!response.ok) throw new Error("audio index unavailable");
  const body = (await response.json()) as { resources?: NativeAudioResource[] };
  return body.resources ?? [];
}

/** Tell the native fetcher whether to fast-fail network reads. The plugin's
 *  content fetcher waits a 4s TCP connect-timeout per network-first MISS; offline,
 *  a single screen (e.g. switching to the audiobook) fires several such reads and
 *  each stalls 4s → the tap feels frozen. Flipping this when `navigator.onLine`
 *  goes false makes those misses fail INSTANTLY (cache hits are unaffected — they
 *  never touch the fetcher), so offline navigation is snappy. No-op off-shell. */
function setNativeOffline(on: boolean): void {
  if (!nativeSyncAvailable()) return;
  try {
    void fetch(`${SCHEME}/offline?on=${on ? 1 : 0}`);
  } catch {
    /* non-fatal */
  }
}

/** Keep the native fast-fail flag in sync with connectivity so offline navigation
 *  never eats the per-request connect timeout.
 *
 *  TWO signals, because `navigator.onLine` is UNRELIABLE in WKWebView (it often
 *  stays `true` in airplane mode, so it alone never flips the flag — that was why
 *  the audiobook jump stayed laggy):
 *   - navigator.onLine + online/offline events: instant WHEN they fire.
 *   - a 2s poll of the native NWPathMonitor (`nativeAudioStats().net === "none"`):
 *     the RELIABLE signal — the OS path monitor knows airplane mode for sure.
 *  Plus the plugin's own OFFLINE_UNTIL backstop catches anything these miss. */
/** Last-known RELIABLE offline state, kept fresh by startOfflineFlagSync's
 *  NWPathMonitor poll. Read this instead of `navigator.onLine`, which is unreliable
 *  in WKWebView (commonly stays `true` in airplane mode). */
let knownOffline = false;

/** Whether the device is (reliably) offline. On the shell this is the NWPathMonitor-
 *  derived flag; off-shell it falls back to `navigator.onLine` (reliable there). */
export function isLikelyOffline(): boolean {
  if (nativeSyncAvailable()) return knownOffline;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function startOfflineFlagSync(): void {
  if (!nativeSyncAvailable()) return;
  let last: boolean | null = null;
  const apply = (offline: boolean): void => {
    knownOffline = offline; // reliable signal for the reader path (isLikelyOffline)
    if (offline === last) return;
    last = offline;
    setNativeOffline(offline);
  };
  apply(!navigator.onLine);
  globalThis.addEventListener("online", () => apply(false));
  globalThis.addEventListener("offline", () => apply(true));
  // Reliable poll: the native net state from NWPathMonitor (via the audio layer).
  let inFlight = false;
  globalThis.setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void nativeAudioStats()
      .then((a) => {
        if (a) apply(a.net === "none");
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, 2000);
}

/** Re-pull /api/dag → refresh the native content manifest. MUST run on every app
 *  open + foreground, not just cold launch: otherwise a warm-resumed device never
 *  learns about resources ADDED to the corpus since its last cold launch (e.g. the
 *  audio-rendition `spoken` transcripts), so `total` never grows, the cached<total
 *  sync never fires, and those chapters stay blank offline. After this returns the
 *  sync pump (useAudioPreloadDriver) downloads whatever's newly listed. No-op
 *  off-shell; never throws. */
export async function nativeRefreshManifest(): Promise<void> {
  if (!nativeSyncAvailable()) return;
  // Skip offline: refresh re-fetches /api/dag (its own 4s connect timeout), wasted
  // when we know there's no network. The next foreground (online) retries.
  if (!navigator.onLine) return;
  try {
    await fetch(`${SCHEME}/refresh`);
  } catch {
    /* offline / transient — the next foreground retries */
  }
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
  // Push to native so its BACKGROUND download sessions get the new cellular policy
  // (allowsCellularAccess) — the web gate alone can't stop transfers already handed
  // to the system daemon, which keep running while the app is suspended.
  nativeAudioSetWifiOnly(on);
  // Relaxing the constraint may unblock a previously-refused run.
  if (!on) void ensureAutoSync();
}

/** Kick off (or continue) the eager download IF auto-download is on. Safe to call
 *  repeatedly — the native side guards against concurrent runs, and a WiFi-only
 *  refusal is a no-op until WiFi returns (the settings poll re-fires it). */
export async function ensureAutoSync(): Promise<void> {
  if (!nativeSyncAvailable()) return;
  try {
    await nativeSyncAll(offlineWifiOnly());
  } catch {
    /* transient; the next poll/startup retries */
  }
}
