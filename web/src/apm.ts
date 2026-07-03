// Client APM (application performance monitoring): a NATIVE-ONLY, offline-durable
// event pipeline. `logEvent()` records an operation/perf/error event into the
// native Rust SQLite outbox (via the lvsync:// scheme); `flushApm()` batch-sends
// the buffer to the server's /api/ingest when the network is good; the server
// forwards each event to VictoriaLogs, where it's queried/debugged with LogsQL.
//
// Why native-only: the hard case APM exists FOR — an offline device that buffers
// events for hours and flushes on reconnect — only happens on the phone shell,
// which is also the only surface with a real SQLite (lvsync.sqlite). Off the shell
// (PWA / browser) every helper is a no-op: desktop/web is effectively always
// online and a lost analytics event there is not worth an IndexedDB buffer.
//
// The store is schema-dumb (see plugins/lvsync /apm routes): THIS file owns the
// event shape. The server stamps `received_at` and streams by (device_id,
// event_type). Delivery is at-least-once: a row is dropped from the local buffer
// only after the server 200s, and `event_id` (a UUID) dedups a re-send.

import { nativeSyncAvailable } from "@/native-sync";
import { nativeAudioStats } from "@/native-audio";
import { REMOTE } from "@/apiBase";

const SCHEME = "lvsync://localhost";

/** Shared secret gating /api/ingest. Baked into the native build via Vite env
 *  (`VITE_APM_TOKEN`). Empty in dev → the server accepts unauthenticated (it only
 *  enforces when its own LIVEVIEW_APM_TOKEN is set). Embedding it in the client is
 *  not true secrecy — it's a simple "block random junk" gate, which is all a
 *  single-user LAN app needs. */
const TOKEN = (import.meta.env["VITE_APM_TOKEN"] as string | undefined) ?? "";
/** Build id, so events can be attributed to a bundle version. */
const APP_VERSION = (import.meta.env["VITE_APP_VERSION"] as string | undefined) ?? "dev";

const DEVICE_KEY = "lv.apm.device";
const BATCH = 50; // events per flush round-trip
const FLUSH_MS = 30_000; // safety-net interval

/** A stable-enough random id (UUID when available, else a timestamped fallback). */
function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Per-install id, persisted so events from the same device group in VictoriaLogs
 *  (`_stream` field). Falls back to an ephemeral id if localStorage is unavailable. */
function deviceId(): string {
  try {
    let id = globalThis.localStorage?.getItem(DEVICE_KEY);
    if (!id) {
      id = randomId();
      globalThis.localStorage?.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return sessionId; // private mode / sandbox — at least stable within the session
  }
}

/** New per-app-launch id: a reading session's events share it, so a debug view can
 *  reconstruct one sitting's timeline. */
const sessionId = randomId();
let seq = 0;

/** Record one client event. Fire-and-forget: it writes to the native SQLite outbox
 *  and never blocks the caller or throws. No-op off the native shell. `fields` are
 *  merged as top-level event fields — keep perf numbers scalar (e.g. `dur_ms`) so
 *  they're queryable in VictoriaLogs, not buried in a nested object. */
export function logEvent(type: string, fields?: Record<string, unknown>): void {
  if (!nativeSyncAvailable()) return;
  try {
    const event = {
      event_id: randomId(),
      device_id: deviceId(),
      session_id: sessionId,
      seq: seq++,
      client_ts: Date.now(),
      event_type: type,
      app_version: APP_VERSION,
      net: netHint,
      ...fields,
    };
    void fetch(`${SCHEME}/apm/log?e=${encodeURIComponent(JSON.stringify(event))}`).catch(
      () => undefined,
    );
  } catch {
    /* never let telemetry break the app */
  }
}

/** Last-known reachability, refreshed by startApm's poll so each event carries the
 *  network class it happened under (wifi/cell/none). Best-effort. */
let netHint: "wifi" | "cell" | "none" | "unknown" = "unknown";

let flushing = false;

/** Drain the native outbox in BATCH-sized rounds and POST each to /api/ingest,
 *  acking only what the server accepted (200). Any non-2xx or network error stops
 *  the round WITHOUT acking, so the events retry on the next trigger — at-least-once.
 *  No-op off-shell / when offline / when a flush is already running. */
export async function flushApm(): Promise<void> {
  if (!nativeSyncAvailable() || flushing) return;
  // Rough online gate; the native fetcher's fast-fail backstop handles the rest.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  flushing = true;
  try {
    // Round cap: even if an ack somehow never lands, we can't drain more than the
    // buffer's own cap (APM_MAX_ROWS) worth of rounds — bound it so a pathological
    // state can't spin the server. Normal flushes exit far earlier (buffer drained).
    for (let round = 0; round < 200; round++) {
      const drained = await fetch(`${SCHEME}/apm/drain?limit=${BATCH}`);
      if (drained.status !== 200) break;
      const events = (await drained.json()) as Array<Record<string, unknown>>;
      if (!events.length) break;
      const res = await fetch(`${REMOTE}/api/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        },
        body: JSON.stringify(events),
        ...(typeof AbortSignal.timeout === "function"
          ? { signal: AbortSignal.timeout(15_000) }
          : {}),
      });
      // 401 (bad token) / 5xx (VL hiccup) / network → keep the rows, retry later.
      if (!res.ok) break;
      const ids = events.map((e) => String(e["event_id"])).filter((id) => id && id !== "undefined");
      await fetch(`${SCHEME}/apm/ack?ids=${encodeURIComponent(ids.join(","))}`).catch(
        () => undefined,
      );
      if (events.length < BATCH) break; // buffer drained
    }
  } catch {
    /* offline / transient — the next trigger retries */
  } finally {
    flushing = false;
  }
}

let started = false;

/** Wire the flush triggers + global error capture once. Mirrors syncQueue's
 *  trigger set: drain on connectivity/visibility return + a slow interval. Also
 *  installs app-wide error hooks so uncaught exceptions/rejections are logged with
 *  zero per-call-site instrumentation. Native-shell only; idempotent. */
export function startApm(): void {
  if (started || !nativeSyncAvailable() || typeof window === "undefined") return;
  started = true;

  // Uncaught errors → APM, app-wide (the biggest debug win for the least code).
  globalThis.addEventListener?.("error", (ev: ErrorEvent) => {
    logEvent("error", {
      msg: String(ev.message ?? "error"),
      src: ev.filename ?? "",
      line: ev.lineno ?? 0,
    });
  });
  globalThis.addEventListener?.("unhandledrejection", (ev: PromiseRejectionEvent) => {
    logEvent("error", { msg: String(ev.reason ?? "unhandledrejection"), kind: "rejection" });
  });

  // Flush triggers.
  globalThis.addEventListener?.("online", () => void flushApm());
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "visible") void flushApm();
  });
  globalThis.setInterval?.(() => void flushApm(), FLUSH_MS);

  // Keep the network hint fresh (2s, like startOfflineFlagSync) so events carry the
  // class they happened under; also opportunistically flush when wifi returns.
  let inFlight = false;
  globalThis.setInterval?.(() => {
    if (inFlight) return;
    inFlight = true;
    void nativeAudioStats()
      .then((a) => {
        if (a) netHint = a.net;
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, 2000);

  void flushApm(); // drain anything left from a prior offline session
}
