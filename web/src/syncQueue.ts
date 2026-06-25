// Durable, keyed, last-write-wins OUTBOUND mutation queue for the cross-device
// state the reader writes back to the server — player settings (rate, sleep,
// resume pointer, per-book rendition/lang) and reading progress (scroll). Those
// writes were raw fire-and-forget `fetch`es: OFFLINE they simply vanished, and
// nothing replayed them on reconnect, so an offline edit (or any edit made while
// the network blipped) was silently lost.
//
// This queue makes every such write:
//   1. OPTIMISTIC — the caller's local `mirroredStore` already updated the UI; the
//      queue is purely the write-back, off the interaction's critical path.
//   2. DURABLE     — persisted to localStorage, so it survives a reload / app quit
//      / cold launch and still flushes later.
//   3. COLLAPSED   — only the FINAL value per key is kept (re-enqueuing a key
//      overwrites its slot), so a scrub that fires 50 progress writes, or toggling
//      a setting back and forth, flushes ONE request with the last value. "只需要
//      最终状态，重复状态取最后一个."
//   4. LWW on reconnect — each entry carries the edit's wall-clock `ts`; the server
//      applies it only if it's newer-or-equal to what it already has (the
//      `updated_at <= EXCLUDED.updated_at` guard in src/store/pg.rs). So a stale
//      replay from a device that was offline can NOT clobber a fresher edit another
//      device made meanwhile — "恢复网后和 service 解决冲突，取最后一个." Combined
//      with the stores' remote-wins hydrate (load + the SettingUpdate WS push), all
//      devices converge on the newest edit.
//
// The server is the single conflict arbiter (one passive KV, last-newer-ts wins);
// the client never has to compare values, only deliver its final state with a
// timestamp. Delivery, not acceptance, is the queue's success condition: any HTTP
// response (even a rejected-as-stale 204) means the server has made its call, so
// the entry is dropped; only a network failure keeps it for retry.

interface Entry {
  value: string;
  /** Wall-clock ms at the edit, the LWW key. */
  ts: number;
}

const LS_KEY = "lv.syncq.v1";
const RETRY_MS = 20_000;

// key = "<ns>:<id>" → the collapsed final state for that target. Globally unique
// across namespaces so settings + progress share one queue/loop.
const pending = new Map<string, Entry>();
let flushing = false;
// Set when a flush is requested WHILE one is already running (e.g. the app
// enqueues session/rate during boot's first in-flight flush). The running flush
// re-drains instead of making those writes wait for the next interval tick.
let dirty = false;
let started = false;

function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...pending.entries()]));
  } catch {
    // localStorage full / unavailable (private mode) — the in-memory queue still
    // flushes this session; we just lose durability across reloads.
  }
}

function restore(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw) as [string, Entry][];
    for (const [k, e] of arr) {
      if (e && typeof e.value === "string" && typeof e.ts === "number") {
        pending.set(k, e);
      }
    }
  } catch {
    // corrupt blob — start clean rather than wedging the loop
    try {
      localStorage.removeItem(LS_KEY);
    } catch { /* ignore */ }
  }
}

/** Deliver one queued mutation to its server endpoint, stamped with its edit `ts`.
 *  Static dispatch by namespace (NOT a stored callback) so a restored-from-disk
 *  entry can flush even if its original call site never runs again this session. */
async function send(key: string, e: Entry): Promise<Response> {
  const sep = key.indexOf(":");
  const ns = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (ns === "progress") {
    return fetch("/api/progress", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: id, scroll: Number(e.value), ts: e.ts }),
    });
  }
  // default: a /api/settings key
  return fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: id, value: e.value, ts: e.ts }),
  });
}

/** Try to drain the queue. Safe to call often (re-entrant-guarded). A network
 *  failure leaves the entry for the next trigger; a server response (any status)
 *  retires it — unless a newer value was enqueued for that key meanwhile. */
export async function flushSyncQueue(): Promise<void> {
  // A concurrent call while a flush is in flight marks the queue dirty so the
  // running flush re-drains (a write enqueued mid-flush must NOT wait for the next
  // interval tick); the running flush owns the drain.
  if (flushing) {
    dirty = true;
    return;
  }
  if (pending.size === 0) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  flushing = true;
  try {
    do {
      dirty = false;
      for (const [key, e] of [...pending.entries()]) {
        try {
          const res = await send(key, e);
          // 5xx → server hiccup, keep for retry. Any other response (2xx/204, or a
          // 4xx for a value the server won't take) means "delivered, server decided"
          // → retire, but only if the slot hasn't been superseded by a newer edit.
          if (res.status >= 500) continue;
          const cur = pending.get(key);
          if (cur && cur.ts === e.ts && cur.value === e.value) {
            pending.delete(key);
          }
        } catch {
          // offline / network error — keep the entry, retry on the next trigger.
          // Stop re-draining: the network is down, so retry is the interval's job.
          dirty = false;
        }
      }
      persist();
    } while (dirty && pending.size > 0);
  } finally {
    flushing = false;
  }
}

/** Enqueue (or collapse onto) one keyed mutation and kick a flush. `value` is the
 *  already-encoded string the endpoint stores; `ts` defaults to now (the edit
 *  time). Re-enqueuing the same key overwrites its slot — only the last value
 *  survives, which is the whole point. */
export function enqueueMutation(
  namespace: "setting" | "progress",
  id: string,
  value: string,
  ts: number = Date.now(),
): void {
  ensureStarted();
  pending.set(`${namespace}:${id}`, { value, ts });
  persist();
  void flushSyncQueue();
}

/** Wire the flush triggers once: restore the persisted queue, then drain it
 *  whenever connectivity or visibility returns, plus a slow safety-net interval.
 *  Exported as `startSyncQueue` for main.tsx to call AFTER `installApiShim()` — a
 *  cold-launch flush of restored entries must use the shimmed fetch (relative
 *  `/api/*` rewritten to the remote origin), not the bundled `tauri://localhost`
 *  origin (which would 404 and wrongly retire the write). Live edits call it via
 *  `enqueueMutation` and so always run post-boot. */
function ensureStarted(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  restore();
  globalThis.addEventListener?.("online", () => void flushSyncQueue());
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "visible") void flushSyncQueue();
  });
  globalThis.setInterval?.(() => void flushSyncQueue(), RETRY_MS);
  // A queue restored from a prior session should drain on boot, even before any
  // new edit — the user may have quit while offline with writes still pending.
  void flushSyncQueue();
}

/** Public start hook — call once from main.tsx AFTER installApiShim() so a cold
 *  launch drains writes left pending from a prior (offline) session. Idempotent. */
export const startSyncQueue = ensureStarted;
