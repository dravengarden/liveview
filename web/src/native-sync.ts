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
//
// Off the shell (PWA / browser) the scheme is absent → every helper falls back to a
// normal `fetch` (the service worker handles offline there).

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
    const r = await fetch(`${SCHEME}/resolve?u=${encodeURIComponent(url)}${cf}`);
    if (r.status === 200) return new Response(await r.arrayBuffer(), { status: 200 });
    return new Response(null, { status: 504, statusText: "offline" });
  } catch {
    // Scheme failed unexpectedly — last resort to the network (online only).
    return navigator.onLine ? fetch(url) : new Response(null, { status: 504 });
  }
}

/** The `src` for a book-cover `<img>`. On the bundled native origin a relative
 *  `/api/cover` would resolve to `tauri://localhost/api/cover` → 404 (the shim
 *  only intercepts `fetch`, not `<img>`), so covers were blank on the shell —
 *  online AND offline. Route them through the lvsync:// scheme instead: the
 *  url-keyed path is NETWORK-FIRST (fresh cover when online) and falls back to the
 *  cached bytes offline, so one online shelf view caches every cover. Off-shell it
 *  stays the plain server URL (the SW handles offline). */
export function coverSrc(slug: string): string {
  const u = `/api/cover?book=${encodeURIComponent(slug)}`;
  return nativeSyncAvailable()
    ? `${SCHEME}/resolve?u=${encodeURIComponent(u)}`
    : u;
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
