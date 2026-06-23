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
 * Resolve a content URL through the native store → a `Response`, so call sites
 * that already `fetch(url)` can swap to this with no parsing change. Returns
 * `null` when the native layer can't serve it (URL not in the manifest, or the
 * shell isn't present) — the caller then does its normal `fetch`. Throws only on
 * a hard offline+uncached miss, which the caller treats like a failed fetch.
 */
export async function nativeFetch(url: string): Promise<Response | null> {
  if (!nativeSyncAvailable()) return null;
  let known = false;
  try {
    known = await invoke<boolean>("lv_knows", { url });
  } catch {
    return null;
  }
  if (!known) return null;
  const buf = await invoke<ArrayBuffer>("lv_resolve", { url });
  return new Response(buf, { status: 200 });
}

/**
 * Drop-in `fetch` for reader content: native store first (offline-safe on the
 * shell), else a plain network `fetch`. On the PWA/browser this is just `fetch`.
 * A native hard-miss (offline + uncached) falls through to `fetch`, which fails
 * the same way — so the caller's existing offline handling still fires.
 */
export async function contentFetch(url: string): Promise<Response> {
  const native = await nativeFetch(url).catch(() => null);
  return native ?? fetch(url);
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
