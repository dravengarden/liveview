// Origin handling for the two ways this SPA runs:
//   • REMOTE  — served by the liveview server (PWA / browser, OR the OLD shell
//     that loaded the remote URL). Same-origin `/api/...` just works.
//   • BUNDLED — packaged INTO the native shell (frontendDist = the built SPA),
//     loaded from a LOCAL origin (tauri://localhost / capacitor-like). There is
//     no same-origin backend, so a relative `/api/...` 404s. We must point those
//     at the real server. Reader CONTENT still goes through the native lv-sync
//     plugin (offline); this only covers the rest (audio/cover/progress/version…).
//
// Why BUNDLED at all: on a physical iOS device a REMOTE origin can't reach a
// Rust-only Tauri plugin (its IPC falls back to the iOS Swift PluginManager which
// only knows native plugins). A LOCAL origin reaches the Rust plugin AND the app
// shell is available offline. See memory tauri-remote-ipc-needs-plugin.

/** The real liveview server (same value as the loader's REMOTE / tauri devUrl). */
export const REMOTE = "https://liveview.hawk.thundersparrow.top";

/** True when the SPA was bundled into the native shell (local origin): running
 *  inside the Tauri shell BUT not served from the remote server. (Old shell that
 *  loaded the remote → false; PWA/browser → false; bundled-local shell → true.) */
export const BUNDLED =
  !!(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ &&
  !(globalThis.location?.origin ?? "").includes("thundersparrow.top");

/** Absolutize an app URL: prepend the remote server when BUNDLED, else leave it
 *  relative (same-origin). Use for things that CAN'T go through the plugin —
 *  `<img src>` (cover/artwork) and the native audio URL. */
export function remoteUrl(path: string): string {
  if (!BUNDLED) return path;
  return path.startsWith("http") ? path : REMOTE + path;
}

/** Install a global `fetch` shim (BUNDLED only) that rewrites relative `/api/...`
 *  requests to the remote server, so every plain fetch the app makes still works.
 *  Reader CONTENT is separately served from the offline plugin via contentFetch;
 *  this is the catch-all for the rest (version/progress/settings/tasks/manifest).
 *  Idempotent. No-op on the remote origin (relative URLs already resolve). */
export function installApiShim(): void {
  if (!BUNDLED) return;
  const w = globalThis as { fetch: typeof fetch; __lvApiShim?: boolean };
  if (w.__lvApiShim) return;
  w.__lvApiShim = true;
  const orig = w.fetch.bind(globalThis);
  w.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.startsWith("/api/")) {
      url = REMOTE + url;
      // Offline-first safety net: cap every shimmed /api request (writes included)
      // with a timeout so an unreachable REMOTE fails FAST instead of hanging the
      // connection forever (which froze background writes/reads offline). Don't
      // clobber a caller-supplied signal; guard for older WebKit without timeout().
      const signal = init?.signal ??
        (typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(15_000)
          : null);
      return orig(url, { ...init, signal });
    }
    return orig(input, init);
  };
}
