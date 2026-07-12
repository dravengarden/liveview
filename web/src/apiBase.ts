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

const CONFIGURED_REMOTES = (
  (import.meta.env["VITE_LIVEVIEW_ORIGINS"] as string | undefined) ??
    "http://127.0.0.1:4160"
)
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const DEFAULT_REMOTE = CONFIGURED_REMOTES[0] ?? "http://127.0.0.1:4160";
const REMOTE_KEY = "lv.remote.origin";

function normalizeOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (typeof candidate !== "string") return [];
    const origin = candidate.trim().replace(/\/$/, "");
    try {
      const parsed = new URL(origin);
      return ["http:", "https:"].includes(parsed.protocol) &&
          parsed.origin === origin
        ? [origin]
        : [];
    } catch {
      return [];
    }
  });
}

/** Native Rust is the deployment-config authority. Web bundles are OTA-updated
 * independently and must not replace a device's working endpoints with whatever
 * defaults happened to be present in the server build. Older shells lack this
 * bridge, so compile-time origins remain a backward-compatible fallback. */
async function nativeOrigins(): Promise<string[]> {
  if (!BUNDLED) return [];
  try {
    const response = await fetch("lvsync://localhost/origins", {
      cache: "no-store",
    });
    if (!response.ok) return [];
    return normalizeOrigins(await response.json());
  } catch {
    return [];
  }
}

/** The selected liveview server. ES-module imports are live bindings, so callers
 *  see the endpoint chosen by selectRemote() before React mounts. */
export let REMOTE = DEFAULT_REMOTE;

/** True when the SPA was bundled into the native shell (local origin): running
 *  inside the Tauri shell BUT not served from the remote server. (Old shell that
 *  loaded the remote → false; PWA/browser → false; bundled-local shell → true.) */
export const BUNDLED =
  !!(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ &&
  !["http:", "https:"].includes(globalThis.location?.protocol ?? "");

/** Select the first reachable configured native backend instead of treating one
 *  route as a single point of failure. A short bounded probe adds at most 750 ms
 *  to an offline cold launch, and the last winner is retained as a candidate. */
export async function selectRemote(): Promise<string> {
  if (!BUNDLED) return REMOTE;
  let previous: string | null = null;
  try {
    previous = globalThis.localStorage?.getItem(REMOTE_KEY) ?? null;
  } catch {
    // Storage is an optimization only.
  }
  const candidates = [
    ...new Set([
      ...(await nativeOrigins()),
      previous,
      ...CONFIGURED_REMOTES,
    ].filter(Boolean)),
  ] as string[];
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 750);
  try {
    REMOTE = await Promise.any(
      candidates.map(async (origin) => {
        const response = await fetch(`${origin}/api/version`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`${origin} -> ${response.status}`);
        return origin;
      }),
    );
    try {
      globalThis.localStorage?.setItem(REMOTE_KEY, REMOTE);
    } catch {
      // Private mode / quota: use the in-memory winner for this launch.
    }
  } catch {
    // Every route is unavailable: keep the prior/default origin and let the native
    // content cache provide the offline experience.
    REMOTE = previous ?? DEFAULT_REMOTE;
  } finally {
    globalThis.clearTimeout(timer);
    controller.abort();
  }
  return REMOTE;
}

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
  w.fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
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
