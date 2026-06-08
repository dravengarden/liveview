import { mirroredStore } from "@/_sync/mod.ts";
import { idbPersistence } from "@/_sync-idb/mod.ts";
import { persisted } from "@/_store/mod.ts";
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
    remote.path === local.path && remote.t > local.t + SYNC_POS_LEAD_S
      ? remote
      : local,
  push: { throttleMs: 5000 },
});

// ── Single active player (Spotify-Connect-style handoff) ────────────────────
// Only ONE client (tab / device / native app instance) plays audio at a time;
// every other client pauses and offers "play here". The claim is just another
// cross-device `mirroredStore` over `/api/settings`, now live via the WS push.

/** Mint a fresh random id. Secure-context-safe: `crypto.randomUUID` only exists
 *  in a SECURE CONTEXT (https / localhost); over plain-HTTP LAN it's undefined
 *  and a bare call throws at module load, crashing the whole app. These ids only
 *  need to be unique, not cryptographically strong, so fall back to a random
 *  string off the always-present `getRandomValues` (or Math.random as a last
 *  resort). */
function mintId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  const rand = c?.getRandomValues
    ? Array.from(
      c.getRandomValues(new Uint8Array(8)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("")
    : Math.random().toString(16).slice(2, 18);
  return `c-${rand}`;
}

// ── Device identity: three distinct ids, one stable ────────────────────────────
// The device identity is the STABLE id; the human name is just an alias of it;
// the per-page-load id only disambiguates two tabs of the SAME browser. Keeping
// these separate is what lets the user rename a device without it becoming a
// "new" device, while two tabs still mutually exclude each other for playback.

/** THE device identity: STABLE, persisted, unique-per-device. Everything else
 *  (the human name below, the server-side device record) hangs off THIS id.
 *  It survives reloads / app relaunches — localStorage persists in the native
 *  Tauri WKWebView (per-install) and per-profile in a browser. Minted once on
 *  first run via the secure-context-safe `mintId`, then read back forever.
 *
 *  Written DIRECTLY (not via `persisted`): a `persisted` store doesn't write its
 *  initial value until the first `.set()`, so a never-set store would re-mint
 *  `mintId()` every load and the id would NOT be stable. This id never changes,
 *  so it's a plain write-once constant. If localStorage is unavailable (private
 *  mode / blocked) it degrades to a per-session id — the acceptable web fallback. */
function loadOrMintDeviceId(): string {
  const KEY = "lv-device-id";
  try {
    const existing = globalThis.localStorage?.getItem(KEY);
    if (existing) {
      return existing;
    }
    const id = mintId();
    globalThis.localStorage?.setItem(KEY, id);
    return id;
  } catch {
    return mintId();
  }
}

export const DEVICE_ID = loadOrMintDeviceId();

/** Per-PAGE-LOAD id, minted fresh at module load — NOT persisted. It exists ONLY
 *  so two tabs/windows of the SAME browser (which share one `DEVICE_ID`) are
 *  distinguishable for playback mutual-exclusion — the claim is keyed on THIS.
 *  A reload mints a new one (correct: the old tab is gone). It is an
 *  implementation detail of the single-active-player handoff, NOT the device
 *  identity — never persist it, never show it. */
export const INSTANCE_ID = mintId();

/** Best-effort human label for THIS device, from the UA/platform, so other
 *  devices show "playing on <label>". Coarse on purpose (we only need a
 *  recognizable name); the user can override it via the persisted store below. */
function deriveLabel(): string {
  const ua = navigator.userAgent;
  const platform = (navigator.platform ?? "").toLowerCase();
  let device = "This device";
  if (/iPhone/i.test(ua)) {
    device = "iPhone";
  } else if (
    /iPad/i.test(ua) ||
    (platform === "macintel" && navigator.maxTouchPoints > 1)
  ) {
    // iPadOS 13+ reports a desktop "MacIntel" UA; touch points disambiguate it.
    device = "iPad";
  } else if (/Android/i.test(ua)) {
    device = "Android";
  } else if (/Mac/i.test(ua) || platform.startsWith("mac")) {
    device = "Mac";
  } else if (/Win/i.test(ua) || platform.startsWith("win")) {
    device = "Windows";
  }
  // A browser hint when it's cheap to spot, so two browsers on one machine read
  // apart (e.g. "Mac · Chrome").
  let browser = "";
  if (/Edg\//.test(ua)) {
    browser = "Edge";
  } else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) {
    browser = "Chrome";
  } else if (/Firefox\//.test(ua)) {
    browser = "Firefox";
  } else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) {
    browser = "Safari";
  }
  return browser ? `${device} · ${browser}` : device;
}

/** The human NAME for this device — an editable ALIAS of `DEVICE_ID`, NOT an
 *  identity of its own. Renaming it (Settings exposes a field) changes only the
 *  label; `DEVICE_ID` stays exactly the same, so a renamed device is still the
 *  same device. Device-LOCAL (`persisted`), so it never syncs — each device
 *  names itself. Default derived from the UA via `deriveLabel`. */
export const deviceLabelStore = persisted<string>(
  "lv-device-label",
  deriveLabel(),
);

/** The current claim: who is playing, and when they last refreshed it (heartbeat
 *  `ts`, so a crashed owner's claim goes stale instead of wedging playback).
 *  `deviceId` records WHICH device holds it (stable, for display/debug);
 *  `instanceId` is the per-page-load id the mutual-exclusion check actually keys
 *  on, so two tabs of one browser (same `deviceId`) still exclude each other. */
export interface ActivePlayer {
  deviceId: string;
  instanceId: string;
  label: string;
  ts: number;
}

// JSON codec; `null` (no one playing) ⇄ "" (the server's "unset" value), like
// sessionCodec. An empty/blank push also decodes to null so a cleared claim is
// observed live (a bare JSON.parse("") would throw → be ignored).
const jsonCodec: Codec<ActivePlayer | null> = {
  enc: (v) => (v === null ? "" : JSON.stringify(v)),
  dec: (raw) => {
    if (raw === "") {
      return null;
    }
    const ap = JSON.parse(raw) as ActivePlayer | null;
    if (
      ap !== null &&
      (typeof ap.deviceId !== "string" || typeof ap.instanceId !== "string" ||
        typeof ap.ts !== "number")
    ) {
      throw new Error("audio.activePlayer: malformed");
    }
    return ap;
  },
};

export const activePlayerStore = mirroredStore<ActivePlayer | null>({
  initial: null,
  remote: settingBackend("audio.activePlayer", jsonCodec),
  // Default reconcile (remote-wins): the latest claim from any device wins, which
  // is exactly the takeover semantics. Immediate push (no pacing) so a takeover
  // is felt instantly on the other client.
});

/** Every server-synced audio store, for the lifecycle helpers (hydrate → connect
 *  on startup, flush on pagehide). */
export const audioStores = [
  rateStore,
  sleepMinutesStore,
  sleepRemainingStore,
  sessionStore,
  posStore,
  activePlayerStore,
] as const;
