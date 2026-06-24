import type { RemoteBackend } from "@/_sync/mod.ts";
import { contentFetch } from "@/native-sync";
import type { ProgressEntry } from "@/types";

// RemoteBackend adapters over liveview's EXISTING server endpoints, for the
// `mirroredStore` (state-based) tier. The server is a passive KV — it stores +
// returns whole values; conflict is resolved client-side by each store's
// `reconcile`. No Rust changes: these speak the same `/api/settings` +
// `/api/progress` contracts the old fire-and-forget code did.

// ── Shared settings map (/api/settings) ─────────────────────────────────────
// One memoized bulk GET per page load (the endpoint returns the whole
// {key: value} map). Every `settingBackend(key)` reads its slot out of this
// shared promise rather than issuing its own round-trip, so N synced settings
// cost ONE fetch. A PUT also patches the cached map so a later `load()` in the
// same session reflects our own write (the GET is fetched once, never refetched).
let settingsCache: Promise<Record<string, string>> | null = null;

function loadSettingsMap(): Promise<Record<string, string>> {
  // fresh: live settings online, last-known offline (the native shell caches the
  // map so reader prefs hydrate offline instead of resetting to defaults).
  settingsCache ??= contentFetch("/api/settings", { fresh: true })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : {}))
    .catch(() => ({}));
  return settingsCache;
}

/** Read a single setting's raw string from the memoized server map (or null if
 *  unset). Exposed for call sites that need the raw server value once at startup
 *  (e.g. the audio engine's cross-device reconcile of session + position). */
export async function loadServerSetting(key: string): Promise<string | null> {
  const map = await loadSettingsMap();
  return map[key] ?? null;
}

/** Read the whole memoized server settings map. For a consumer that scans many
 *  keys at once (e.g. App hydrating every `book.<slug>.{rendition,lang}` pref). */
export function loadAllServerSettings(): Promise<Record<string, string>> {
  return loadSettingsMap();
}

/** Immediate (un-paced) write of one setting to the server, keeping the memoized
 *  map current. The `mirroredStore`s pace their own writes; this is for the
 *  imperative call sites that want a single fire-and-forget remote-wins push
 *  (e.g. App's per-book rendition/lang prefs). */
export function putServerSetting(key: string, value: string): Promise<void> {
  // Keep the memoized map current so a later load() in this session reflects our
  // own write.
  if (settingsCache !== null) {
    settingsCache = settingsCache.then((s) => ({ ...s, [key]: value }));
  }
  return fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  }).then(() => {
    // best-effort; the local mirror remains the offline fallback
  });
}

// ── Live server→client setting push (one-way WebSocket) ─────────────────────
// The server broadcasts a `SettingUpdate {key, value}` on every accepted
// `/api/settings` PUT (see src/main.rs). `useWebSocket` routes each one here;
// every `settingBackend(key).subscribe` listener registered for that key gets
// the raw value, decodes it, and hands it to its `mirroredStore` to re-reconcile
// — so all mirrored settings (rate/pos/session/active-player) go live
// cross-device, not just on the next page load.
const settingPushListeners = new Map<string, Set<(raw: string) => void>>();

/** Deliver a raw server setting value to every listener subscribed on `key`.
 *  Also patches the memoized settings map so a later `load()` is consistent with
 *  the push (the bulk GET is fetched once and never refetched). */
export function emitServerSettingPush(key: string, value: string): void {
  if (settingsCache !== null) {
    settingsCache = settingsCache.then((s) => ({ ...s, [key]: value }));
  }
  const ls = settingPushListeners.get(key);
  if (ls) {
    for (const l of ls) {
      l(value);
    }
  }
}

/** Encode/decode a typed setting value to/from the string the KV stores. */
export interface Codec<T> {
  enc(value: T): string;
  dec(raw: string): T;
}

/** A `RemoteBackend<T>` over one `/api/settings` key. `load` reads the memoized
 *  server map; `save` PUTs `{key, value}`. A decode error (corrupt/legacy blob)
 *  surfaces as `null` (no remote value) rather than throwing, so the store keeps
 *  its local value. */
export function settingBackend<T>(
  key: string,
  codec: Codec<T>,
): RemoteBackend<T> {
  return {
    load: async (): Promise<T | null> => {
      const raw = await loadServerSetting(key);
      if (raw === null || raw === "") {
        return null;
      }
      try {
        return codec.dec(raw);
      } catch {
        return null;
      }
    },
    save: (value: T): Promise<void> => putServerSetting(key, codec.enc(value)),
    // Live invalidation over the broadcast WebSocket: on every server-pushed
    // change to this key, decode + hand the value to the store to re-reconcile.
    // A decode error (corrupt/legacy blob) is ignored (the store keeps local);
    // the empty value ("" = unset) decodes via the codec like load() does NOT —
    // we pass it through so codecs that map "" → null (session/activePlayer)
    // observe the cleared state.
    subscribe: (onRemote: (value: T) => void): () => void => {
      const listener = (raw: string): void => {
        try {
          onRemote(codec.dec(raw));
        } catch {
          // ignore an undecodable push — local value stands
        }
      };
      let ls = settingPushListeners.get(key);
      if (ls === undefined) {
        ls = new Set();
        settingPushListeners.set(key, ls);
      }
      ls.add(listener);
      return (): void => {
        ls.delete(listener);
      };
    },
  };
}

// ── Reading progress (/api/progress) ────────────────────────────────────────
// Per-doc scroll ratio. `load` fetches the doc's book and picks this path's row;
// `save` PUTs `{path, scroll}`. The shelf's bulk `/api/progress/recent` stays a
// plain fetch (see useProgress) — it's a read-only aggregate, not a store.

/** A `RemoteBackend<number>` for one document's scroll ratio (0..1), over
 *  `/api/progress`. `load` reads the book's rows and returns this path's saved
 *  scroll (or null if none); `save` writes `{path, scroll}`. */
export function progressBackend(path: string): RemoteBackend<number> {
  const slug = path.split("/")[0] ?? "";
  return {
    load: async (): Promise<number | null> => {
      try {
        const res = await fetch(
          `/api/progress?book=${encodeURIComponent(slug)}`,
        );
        if (!res.ok) {
          return null;
        }
        const rows = (await res.json()) as ProgressEntry[];
        const row = rows.find((r) => r.path === path);
        return row ? row.scroll : null;
      } catch {
        return null;
      }
    },
    save: (scroll: number): Promise<void> =>
      fetch("/api/progress", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, scroll }),
      }).then(() => {
        // best-effort: a lost progress write just means a slightly stale resume
      }),
  };
}
