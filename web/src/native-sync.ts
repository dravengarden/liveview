// Native offline data-layer bridge — via a custom URL SCHEME (`lvsync://`), NOT
// Tauri plugin IPC.
//
// Why not IPC: on iOS the webview→plugin IPC trips its custom-protocol channel and
// PERMANENTLY falls back to postMessage → the iOS Swift PluginManager, which has no
// native `lvsync` plugin → "Plugin lvsync not initialized". A registered URL scheme
// is served by WKWebView's URLSchemeHandler and reaches the Rust lv-sync core
// DIRECTLY from any origin (the shell adds `Access-Control-Allow-Origin: *`), so it
// sidesteps that wall entirely. See tauri-plugin-lvsync register_asynchronous_uri_scheme_protocol.
//
// Off the native shell (PWA / browser) `__TAURI_INTERNALS__` is absent, so every
// helper is inert — callers fall back to a normal `fetch` (the SW handles offline).
// Audio is NOT routed here (native AVPlayer engine, native-audio.ts).

const BASE = "lvsync://localhost";

/** True only inside the native shell (where the lvsync:// scheme is registered). */
export function nativeSyncAvailable(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

/**
 * Drop-in `fetch` for reader content. On the shell it resolves through the native
 * store via `lvsync://localhost/resolve` (offline-safe); a 504 means offline +
 * uncached. ONLINE we still fall back to a normal fetch if the scheme errors, so a
 * scheme problem never takes the app down. Off the shell it's a plain `fetch`.
 */
export async function contentFetch(url: string): Promise<Response> {
  if (nativeSyncAvailable()) {
    try {
      const r = await fetch(`${BASE}/resolve?u=${encodeURIComponent(url)}`);
      if (r.ok) return r;
      // Scheme served a non-ok (504 = offline+uncached). When online, fall back to
      // the network; offline, surface the non-ok so the caller shows offline state.
      return navigator.onLine ? fetch(url) : r;
    } catch {
      return navigator.onLine
        ? fetch(url)
        : new Response(null, { status: 504, statusText: "offline" });
    }
  }
  return fetch(url);
}

/** Offline cache stats for non-audio content: [cachedCount, totalCount, cachedBytes, totalBytes]. */
export async function nativeCacheStats(): Promise<[number, number, number, number]> {
  const r = await fetch(`${BASE}/stats`);
  if (!r.ok) throw new Error(`stats ${r.status}`);
  return (await r.json()) as [number, number, number, number];
}

/** Eager-pull the whole corpus's non-audio content. Resolves to bytes cached.
 *  Long-running; fire it and poll {@link nativeCacheStats} for live progress. */
export async function nativeSyncAll(): Promise<number> {
  const r = await fetch(`${BASE}/sync_all`);
  if (!r.ok) throw new Error(`sync_all ${r.status}`);
  return (await r.json()) as number;
}
