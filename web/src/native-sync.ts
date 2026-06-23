// Native offline data-layer bridge (iOS/Mac Tauri shell only).
//
// On the native shell the reader content (text/units/spoken/marks/assets) is
// served by the Rust lv-sync core via Tauri IPC (src-tauri/src/sync.rs): a
// content-addressed filesystem store that resolves store-first, so once read
// online a resource replays OFFLINE with zero network. This is the EAGER-mode
// counterpart to the PWA's lazy SW cache-first path.
//
// Off the shell (PWA / browser) `__TAURI_INTERNALS__` is absent, so
// `nativeSyncAvailable()` is false and every helper is inert — callers fall back
// to a plain `fetch`. Audio is NOT routed here (it stays in the native AVPlayer
// engine, native-audio.ts).

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}
function internals(): TauriInternals | null {
  const w = globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

/** True only inside the native Tauri shell (where the lv_* commands exist). */
export function nativeSyncAvailable(): boolean {
  return internals() !== null;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const i = internals();
  if (!i) return Promise.reject(new Error("native sync unavailable"));
  return i.invoke(cmd, args ?? {}) as Promise<T>;
}

/**
 * Drop-in `fetch` for reader content.
 *
 * On the native shell this is the SOLE content path: `lv_resolve` serves it from
 * the native store (manifest resources content-addressed; everything else —
 * `/api/tree`, `/api/books`, covers — url-keyed network-first), all offline-safe.
 * We deliberately do NOT fall back to a raw `fetch()` here: a WKWebView `fetch()`
 * HANGS offline (it doesn't fail fast like Chromium), which made an offline card
 * tap → `/api/tree` appear DEAD. On a native miss we return a fast non-ok
 * Response so the caller shows its offline state instead of hanging.
 *
 * Off the shell (PWA/browser) it's a plain `fetch` — the service worker provides
 * the offline cache there.
 */
export async function contentFetch(url: string): Promise<Response> {
  if (nativeSyncAvailable()) {
    try {
      const buf = await invoke<ArrayBuffer>("lv_resolve", { url });
      return new Response(buf, { status: 200 });
    } catch {
      // Native couldn't serve it. ONLINE → fall back to a normal fetch: a
      // WKWebView fetch works fine online (the hang is OFFLINE-only), so this
      // keeps the shell fully functional even if the native data layer is
      // unavailable. OFFLINE → do NOT fetch (it would hang); return a fast non-ok
      // so the caller shows its offline state.
      if (navigator.onLine) return fetch(url);
      return new Response(null, { status: 504, statusText: "offline" });
    }
  }
  return fetch(url);
}

/** Byte-weighted offline fraction in [0,1] over the whole corpus (native only). */
export function nativeOfflineFraction(): Promise<number> {
  return invoke<number>("lv_offline_fraction");
}

/** Eager-pull one book's non-audio content into the native store. Bytes cached. */
export function nativeSyncBook(slug: string): Promise<number> {
  return invoke<number>("lv_sync_book", { slug });
}

/** Re-pull the manifest from the network; resolves to the new root hash. */
export function nativeRefresh(): Promise<string> {
  return invoke<string>("lv_refresh");
}

/** Current manifest root + resource count (readiness probe). */
export function nativeStatus(): Promise<[string, number]> {
  return invoke<[string, number]>("lv_status");
}

/** GC store entries no longer in the manifest. Resolves to the count dropped. */
export function nativeGc(): Promise<number> {
  return invoke<number>("lv_gc");
}
