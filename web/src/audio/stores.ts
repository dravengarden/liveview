import { mirroredStore } from "@/_sync/mod.ts";
import { idbPersistence } from "@/_sync-idb/mod.ts";
import type { Codec } from "@/syncBackends";
import { settingBackend } from "@/syncBackends";
import type { NowPlaying, Track } from "./player";

// The audio engine's SERVER-SYNCED state, on the `mirroredStore` (state-based)
// tier. Each is a passive-KV mirror over `/api/settings`: device edits push to
// the server (paced), the server is pulled + `reconcile`d on connect. The player
// keeps its imperative `<audio>` machinery — it just writes these via `.set()`
// instead of fire-and-forget PUTs, and reads the adopted value after `connect()`.
//
// Device-LOCAL prefs (theme/font/margins/shelf-sort/lang) are NOT here — they
// stay `persisted` (see the hooks). Only cross-device playback truth lives here.

// ── Playback rate ───────────────────────────────────────────────────────────
// Remote-wins, immediate push. Stored as a bare number string (matches the
// pre-migration `audio.rate` server format).
const numberCodec: Codec<number> = {
  enc: (v) => String(v),
  dec: (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error("audio.rate: not a number");
    }
    return n;
  },
};

export const rateStore = mirroredStore<number>({
  initial: 1,
  remote: settingBackend("audio.rate", numberCodec),
  // remote-wins is the default; rate is a simple last-writer-wins pref.
});

// ── Sleep timer ─────────────────────────────────────────────────────────────
// Two keys: the chosen option (minutes) and the live remaining (seconds). Both
// remote-wins; paced at most once / 5s (the countdown ticks ~4×/s). Stored as
// bare number strings (matching the pre-migration server format).
export const sleepMinutesStore = mirroredStore<number>({
  initial: 0,
  remote: settingBackend("audio.sleepMinutes", numberCodec),
  push: { throttleMs: 5000 },
});

export const sleepRemainingStore = mirroredStore<number>({
  initial: 0,
  remote: settingBackend("audio.sleepRemaining", numberCodec),
  push: { throttleMs: 5000 },
});

// ── Resume session pointer ──────────────────────────────────────────────────
// {nowPlaying, queue, queueIndex} — which book/chapter to resume, cross-device.
// Remote-wins, immediate push, rehydrated on load. Stored as JSON.
export interface PersistedSession {
  nowPlaying: NowPlaying;
  queue: Track[];
  queueIndex: number;
}

const sessionCodec: Codec<PersistedSession | null> = {
  enc: (v) => (v === null ? "" : JSON.stringify(v)),
  dec: (raw) => {
    const s = JSON.parse(raw) as PersistedSession;
    if (!s.nowPlaying || !Array.isArray(s.queue)) {
      throw new Error("audio.session: malformed");
    }
    return s;
  },
};

export const sessionStore = mirroredStore<PersistedSession | null>({
  initial: null,
  remote: settingBackend("audio.session", sessionCodec),
  // Instant offline resume of the last session (replaces the SESSION_KEY
  // localStorage write); structured-clone via IDB, no manual JSON.
  local: idbPersistence<PersistedSession | null>("audio.session"),
});

// ── Per-chapter resume position ─────────────────────────────────────────────
// {path, t}: the chapter and audio-seconds offset. The reconcile is the existing
// rule — adopt the SERVER position only if it's >8s ahead on the SAME chapter
// (a few seconds of last-tick drift on the same device must not masquerade as a
// cross-device sync). PURE: no side effects; the "已同步…" toast is fired by the
// calling code when it observes the adopted value, never in here.
export interface AudioPos {
  path: string;
  t: number;
}

const SYNC_POS_LEAD_S = 8;

const posCodec: Codec<AudioPos> = {
  enc: (v) => JSON.stringify(v),
  dec: (raw) => {
    const p = JSON.parse(raw) as AudioPos;
    if (typeof p.path !== "string" || !Number.isFinite(p.t)) {
      throw new Error("audio.pos: malformed");
    }
    return p;
  },
};

export const posStore = mirroredStore<AudioPos>({
  initial: { path: "", t: 0 },
  remote: settingBackend("audio.pos", posCodec),
  reconcile: (local, remote) =>
    remote.path === local.path && remote.t > local.t + SYNC_POS_LEAD_S ? remote : local,
  push: { throttleMs: 5000 },
});

/** Every server-synced audio store, for the lifecycle helpers (hydrate → connect
 *  on startup, flush on pagehide). */
export const audioStores = [
  rateStore,
  sleepMinutesStore,
  sleepRemainingStore,
  sessionStore,
  posStore,
] as const;
