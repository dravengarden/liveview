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
//
// SELF-PROTECTION (never let telemetry harm the app):
//   1. Every path is try/catch-swallowed — a failing log/flush is a NO-OP, never a
//      throw into the app, and APM NEVER logs its own failures (that would be a
//      self-feeding garbage loop: an APM error → an error event → written offline →
//      … until storage fills).
//   2. Storage is bounded: the native outbox caps at APM_MAX_ROWS (drops oldest);
//      `error` events are de-duplicated + capped so an error storm can't flood it;
//      connectivity transitions are logged ONCE per flip, never one-per-retry.

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
      reachable,
      ...fields,
    };
    void fetch(`${SCHEME}/apm/log?e=${encodeURIComponent(JSON.stringify(event))}`).catch(
      () => undefined,
    );
  } catch {
    /* never let telemetry break the app */
  }
}

// ── error de-dup + cap ──────────────────────────────────────────────────────
// An uncaught-error loop must NOT write a row per throw. De-dupe by signature
// (log the FIRST occurrence of each distinct msg|src|line only) and cap the number
// of distinct signatures per session — together these bound the worst case to
// MAX_DISTINCT_ERRORS rows no matter how badly the app is misbehaving.
const errSeen = new Map<string, number>();
function logError(msg: string, extra: Record<string, unknown>): void {
  try {
    const key = `${msg}|${extra["src"] ?? ""}|${extra["line"] ?? ""}`;
    const n = errSeen.get(key) ?? 0;
    errSeen.set(key, n + 1);
    if (n > 0) return; // this exact error already logged this session → skip
    if (errSeen.size > MAX_DISTINCT_ERRORS) return; // storm backstop
    logEvent("error", { ...extra, msg });
  } catch {
    /* error-logging must itself never throw */
  }
}

// ── reachability state machine ──────────────────────────────────────────────
// Emit a transition event ONLY on an actual flip (state-guarded), so an offline
// stretch logs exactly one net_offline + one net_online — never one-per-retry.
function markReachable(): void {
  if (reachable) return;
  reachable = true;
  logEvent("net_online");
}
function markUnreachable(): void {
  if (!reachable) return;
  reachable = false;
  // logEvent writes to LOCAL SQLite (works offline) — so this is recorded at the
  // moment of detection with its true client_ts, then delivered on reconnect.
  logEvent("net_offline");
}

/** Cheap GET to sample server reachability when there's nothing to flush, so a
 *  SILENT offline (no user activity, empty outbox) still flips the state machine.
 *  Rate-limited to IDLE_PROBE_MS; produces NO event itself (only updates state). */
async function probeReachability(): Promise<void> {
  const now = Date.now();
  if (now - lastProbe < IDLE_PROBE_MS) return;
  lastProbe = now;
  try {
    await fetch(`${REMOTE}/api/root`, {
      cache: "no-store",
      ...(typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(8_000) } : {}),
    });
    markReachable(); // any response ⇒ server reachable
  } catch {
    markUnreachable();
  }
}

let flushing = false;

/** Drain the native outbox in BATCH-sized rounds and POST each to /api/ingest,
 *  acking only what the server accepted (200). A network error (server unreachable)
 *  flips the reachability state machine and stops the round WITHOUT acking, so the
 *  events retry on the next trigger — at-least-once. No-op off-shell / when a flush
 *  is already running. Never throws. */
export async function flushApm(): Promise<void> {
  if (!nativeSyncAvailable() || flushing) return;
  flushing = true;
  try {
    // Round cap: even if an ack somehow never lands, we can't drain more than the
    // buffer's own cap (APM_MAX_ROWS) worth of rounds — bound it so a pathological
    // state can't spin the server. Normal flushes exit far earlier (buffer drained).
    for (let round = 0; round < 200; round++) {
      const drained = await fetch(`${SCHEME}/apm/drain?limit=${BATCH}`);
      if (drained.status !== 200) break;
      const events = (await drained.json()) as Array<Record<string, unknown>>;
      if (!events.length) {
        await probeReachability(); // nothing to send → still sample reachability
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
        markUnreachable(); // network error = server unreachable; keep the rows, retry later
        break;
      }
      markReachable(); // server responded (ANY status, incl. 401/502) ⇒ reachable
      // 401 (bad token) / 5xx (VL hiccup) → reachable but not accepted; keep the rows.
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

/** Wire the flush triggers + global error capture once. Also emits session-lifecycle
 *  events (session_start, app_foreground/background) and installs app-wide error hooks
 *  so uncaught exceptions/rejections are logged (de-duped) with zero per-call-site
 *  instrumentation. Native-shell only; idempotent. */
export function startApm(): void {
  if (started || !nativeSyncAvailable() || typeof window === "undefined") return;
  started = true;

  // Uncaught errors → APM, app-wide, de-duped/capped (the biggest debug win for the
  // least code). Uses logError, NOT logEvent, so an error loop can't flood the outbox.
  globalThis.addEventListener?.("error", (ev: ErrorEvent) => {
    logError(String(ev.message ?? "error"), { src: ev.filename ?? "", line: ev.lineno ?? 0 });
  });
  globalThis.addEventListener?.("unhandledrejection", (ev: PromiseRejectionEvent) => {
    logError(String(ev.reason ?? "unhandledrejection"), { kind: "rejection" });
  });

  // Session lifecycle: one per launch, plus foreground/background transitions (these
  // are bounded — a few per sitting — not high-frequency, so they're worth keeping).
  logEvent("session_start");
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      logEvent("app_foreground");
      void flushApm();
    } else {
      logEvent("app_background");
    }
  });

  // Flush triggers.
  globalThis.addEventListener?.("online", () => void flushApm());
  globalThis.setInterval?.(() => void flushApm(), FLUSH_MS);

  // Keep the OS network-class hint fresh (2s, like startOfflineFlagSync) so events
  // carry the class they happened under. (Reachability is tracked separately, above.)
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
