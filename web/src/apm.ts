// Client APM (application performance monitoring): a NATIVE-ONLY, offline-durable
// event pipeline. `logEvent()` records an operation/perf/error event into the
// TypeScript IDB outbox; `flushApm()` batch-sends the buffer to the server's
// /api/ingest when the network is good; the server forwards each event to
// VictoriaLogs, where it's queried/debugged with LogsQL.
//
// Why native-only: the hard case APM exists FOR — an offline device that buffers
// events for hours and flushes on reconnect — only happens on the phone shell.
// Off the shell (PWA / browser) every helper is a no-op.
//
// The store is schema-dumb: THIS file owns the event shape. The replica `apm`
// object store is INSERT-OR-IGNORE, capped at APM_MAX_ROWS (5000). Delivery is
// at-least-once: a row is dropped only after the server 200s, and `event_id`
// (a UUID) dedups a re-send.
//
// SELF-PROTECTION (never let telemetry harm the app):
//   1. Every path is try/catch-swallowed — a failing log/flush is a NO-OP, never a
//      throw into the app, and APM NEVER logs its own failures (that would be a
//      self-feeding garbage loop).
//   2. Storage is bounded: the outbox caps at APM_MAX_ROWS (drops oldest);
//      `error` events are de-duplicated + capped so an error storm can't flood it;
//      connectivity transitions are logged ONCE per flip, never one-per-retry.

import {
  nativeSyncAvailable,
  onNativeNetworkClass,
} from "./native-sync.ts";
import { REMOTE } from "./apiBase.ts";
import {
  ackApmEvents,
  drainApmEvents,
  putApmEvent,
} from "./replica/mod.ts";
import { APM_MAX_ROWS } from "./replica/schema.ts";

const ENABLED = (import.meta.env["VITE_APM_ENABLED"] as string | undefined)
  ?.toLocaleLowerCase() === "true";

/** Optional bearer token gating /api/ingest. Baked into a deployment via the
 *  Vite environment and expected to match the server configuration. Embedding
 *  it in a client is not true secrecy; use a trusted network boundary. */
const TOKEN = (import.meta.env["VITE_APM_TOKEN"] as string | undefined) ?? "";
/** Build id, so events can be attributed to a bundle version. */
const APP_VERSION = (import.meta.env["VITE_APP_VERSION"] as string | undefined) ?? "dev";

const DEVICE_KEY = "lv.apm.device";
const BATCH = 50; // events per flush round-trip
const FLUSH_MS = 30_000; // safety-net interval
const IDLE_PROBE_MS = 60_000; // min gap between reachability probes when idle
const MAX_DISTINCT_ERRORS = 50; // per-session cap on distinct error signatures

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

/** Last-known OS network CLASS (wifi/cell/none) from NWPathMonitor. NOTE this is
 *  NOT reachability — the OS reads WiFi as "up" while the tunnel/server is
 *  unreachable, so an event can carry net="wifi" yet reachable=false. Keep both. */
let netHint: "wifi" | "cell" | "none" | "unknown" = "unknown";

/** Last-known SERVER reachability — the ONLY reliable offline/online signal (OS
 *  flags lie; see above). Ground truth = the flush POST outcome, backstopped by an
 *  idle probe. Attached to every event as `reachable` (last-known at log time). */
let reachable = true;
let lastProbe = 0;

/** Record one client event. Fire-and-forget: it writes to the IDB outbox
 *  and never blocks the caller or throws. No-op off the native shell. `fields` are
 *  merged as top-level event fields — keep perf numbers scalar (e.g. `dur_ms`) so
 *  they're queryable in VictoriaLogs, not buried in a nested object. */
export function logEvent(type: string, fields?: Record<string, unknown>): void {
  if (!ENABLED || !nativeSyncAvailable()) return;
  try {
    const event_id = randomId();
    const client_ts = Date.now();
    const event = {
      event_id,
      device_id: deviceId(),
      session_id: sessionId,
      seq: seq++,
      client_ts,
      event_type: type,
      app_version: APP_VERSION,
      net: netHint,
      reachable,
      ...fields,
    };
    void putApmEvent({ event_id, ts: client_ts, body: event }).catch(() => undefined);
  } catch {
    /* never let telemetry break the app */
  }
}

// ── error de-dup + cap ──────────────────────────────────────────────────────
const errSeen = new Map<string, number>();
function logError(msg: string, extra: Record<string, unknown>): void {
  try {
    const key = `${msg}|${extra["src"] ?? ""}|${extra["line"] ?? ""}`;
    const n = errSeen.get(key) ?? 0;
    errSeen.set(key, n + 1);
    if (n > 0) return;
    if (errSeen.size > MAX_DISTINCT_ERRORS) return;
    logEvent("error", { ...extra, msg });
  } catch {
    /* error-logging must itself never throw */
  }
}

function markReachable(): void {
  if (reachable) return;
  reachable = true;
  logEvent("net_online");
}
function markUnreachable(): void {
  if (!reachable) return;
  reachable = false;
  logEvent("net_offline");
}

async function probeReachability(): Promise<void> {
  const now = Date.now();
  if (now - lastProbe < IDLE_PROBE_MS) return;
  lastProbe = now;
  try {
    await fetch(`${REMOTE}/api/root`, {
      cache: "no-store",
      ...(typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(8_000) } : {}),
    });
    markReachable();
  } catch {
    markUnreachable();
  }
}

let flushing = false;

/** Drain the IDB outbox in BATCH-sized rounds and POST each to /api/ingest,
 *  acking only what the server accepted (200). Never throws. Never logs its own
 *  failures. */
export async function flushApm(): Promise<void> {
  if (!ENABLED || !nativeSyncAvailable() || flushing) return;
  flushing = true;
  try {
    for (let round = 0; round < Math.ceil(APM_MAX_ROWS / BATCH); round++) {
      let events: unknown[];
      try {
        events = await drainApmEvents(BATCH);
      } catch {
        break;
      }
      if (!Array.isArray(events) || events.length === 0) {
        await probeReachability();
        break;
      }
      let res: Response;
      try {
        res = await fetch(`${REMOTE}/api/ingest`, {
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
      } catch {
        markUnreachable();
        break;
      }
      markReachable();
      if (!res.ok) break;
      const ids = events.flatMap((e) => {
        if (!e || typeof e !== "object") return [];
        const id = (e as { event_id?: unknown }).event_id;
        return typeof id === "string" && id ? [id] : [];
      });
      try {
        await ackApmEvents(ids);
      } catch {
        break;
      }
      if (events.length < BATCH) break;
    }
  } catch {
    /* offline / transient — the next trigger retries; never log own failures */
  } finally {
    flushing = false;
  }
}

let started = false;

export function startApm(): void {
  if (!ENABLED || started || !nativeSyncAvailable() || typeof window === "undefined") return;
  started = true;

  globalThis.addEventListener?.("error", (ev: ErrorEvent) => {
    logError(String(ev.message ?? "error"), { src: ev.filename ?? "", line: ev.lineno ?? 0 });
  });
  globalThis.addEventListener?.("unhandledrejection", (ev: PromiseRejectionEvent) => {
    logError(String(ev.reason ?? "unhandledrejection"), { kind: "rejection" });
  });

  logEvent("session_start");
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      logEvent("app_foreground");
      void flushApm();
    } else {
      logEvent("app_background");
    }
  });

  globalThis.addEventListener?.("online", () => void flushApm());
  globalThis.setInterval?.(() => void flushApm(), FLUSH_MS);

  onNativeNetworkClass((net) => {
    netHint = net;
  });

  void flushApm();
}
