// Bridge to the native offline-content layer via the `lvSync` WKScriptMessageHandler
// (LvSyncController.swift). This is the ONLY webview→native channel that works from
// the shell's remote origin on a real device — Tauri plugin IPC and custom URL
// schemes both fail there (see memory tauri-remote-ipc-needs-plugin). Same mechanism
// native-audio uses successfully.
//
// Request/response over a one-way message channel: post `{id, cmd, url?}`, and the
// native side calls back `window.__lvSyncResolve(id, ok, payload)`. resolve→payload
// is base64 of the content bytes; stats→a JSON array; syncAll→a number.
//
// Off the shell (PWA / browser) the handler is absent → every helper falls back to
// a normal `fetch` (SW handles offline there). Audio stays in native-audio.ts.

interface MsgHandler {
  postMessage: (m: unknown) => void;
}
function handler(): MsgHandler | null {
  const w = globalThis as { webkit?: { messageHandlers?: { lvSync?: MsgHandler } } };
  return w.webkit?.messageHandlers?.lvSync ?? null;
}

/** True only inside the native shell (where the lvSync handler is installed). */
export function nativeSyncAvailable(): boolean {
  return handler() !== null;
}

interface Reply {
  ok: boolean;
  payload: string;
}
const pending = new Map<string, (r: Reply) => void>();
let resolverInstalled = false;
function ensureResolver(): void {
  if (resolverInstalled) return;
  resolverInstalled = true;
  (globalThis as unknown as {
    __lvSyncResolve?: (id: string, ok: boolean, payload: string) => void;
  }).__lvSyncResolve = (id, ok, payload) => {
    const r = pending.get(id);
    if (r) {
      pending.delete(id);
      r({ ok, payload });
    }
  };
}

let seq = 0;
function call(cmd: string, url?: string, timeoutMs = 30_000): Promise<Reply> {
  const h = handler();
  if (!h) return Promise.reject(new Error("native sync unavailable"));
  ensureResolver();
  const id = `s${++seq}`;
  return new Promise<Reply>((resolve) => {
    pending.set(id, resolve);
    h.postMessage({ id, cmd, url });
    setTimeout(() => {
      if (pending.delete(id)) resolve({ ok: false, payload: "" });
    }, timeoutMs);
  });
}

/** Drop-in `fetch` for reader content. On the shell it resolves through the native
 *  content cache (offline-safe); on a miss while online it falls back to network. */
export async function contentFetch(url: string): Promise<Response> {
  if (nativeSyncAvailable()) {
    const { ok, payload } = await call("resolve", url);
    if (ok) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, { status: 200 });
    }
    return navigator.onLine
      ? fetch(url)
      : new Response(null, { status: 504, statusText: "offline" });
  }
  return fetch(url);
}

/** Per-book offline coverage. */
export interface BookStat {
  slug: string;
  cached: number;
  total: number;
  cb: number;
  tb: number;
}
/** Rich offline-cache stats for non-audio content. */
export interface CacheStats {
  net: "wifi" | "cell" | "none";
  cached: number;
  total: number;
  cb: number;
  tb: number;
  books: BookStat[];
}

interface RawStats {
  net?: string;
  cached?: number;
  total?: number;
  cb?: number;
  tb?: number;
  books?: { s: string; c: number; t: number; cb: number; tb: number }[];
}

/** Global totals + per-book breakdown + current network type. */
export async function nativeCacheStats(): Promise<CacheStats> {
  const { ok, payload } = await call("stats");
  if (!ok) throw new Error("stats unavailable");
  const r = JSON.parse(payload) as RawStats;
  return {
    net: (r.net as CacheStats["net"]) ?? "none",
    cached: r.cached ?? 0,
    total: r.total ?? 0,
    cb: r.cb ?? 0,
    tb: r.tb ?? 0,
    books: (r.books ?? []).map((b) => ({
      slug: b.s,
      cached: b.c,
      total: b.t,
      cb: b.cb,
      tb: b.tb,
    })),
  };
}

/** Eager-pull the whole corpus's non-audio content. When `wifiOnly`, the native
 *  side refuses to use cellular (returns the "nowifi" sentinel off WiFi). Resolves
 *  to bytes downloaded this run; long-running, so poll {@link nativeCacheStats}
 *  for live progress. A second call while one is in flight returns fast ("busy"). */
export async function nativeSyncAll(wifiOnly = false): Promise<number> {
  const h = handler();
  if (!h) return 0;
  ensureResolver();
  const id = `s${++seq}`;
  const { ok, payload } = await new Promise<Reply>((resolve) => {
    pending.set(id, resolve);
    h.postMessage({ id, cmd: "syncAll", wifiOnly });
    setTimeout(() => {
      if (pending.delete(id)) resolve({ ok: false, payload: "" });
    }, 1_200_000);
  });
  if (!ok) throw new Error("sync failed");
  return Number(payload) || 0;
}

// ── Download preferences (persisted, shell-only). Auto-download defaults ON, and
// WiFi-only defaults ON so we never surprise-burn cellular data.

const AUTO_KEY = "lv.offline.auto";
const WIFI_KEY = "lv.offline.wifiOnly";

export function offlineAuto(): boolean {
  return (globalThis.localStorage?.getItem(AUTO_KEY) ?? "1") === "1";
}
export function offlineWifiOnly(): boolean {
  return (globalThis.localStorage?.getItem(WIFI_KEY) ?? "1") === "1";
}
export function setOfflineAuto(on: boolean): void {
  globalThis.localStorage?.setItem(AUTO_KEY, on ? "1" : "0");
  if (on) void ensureAutoSync();
}
export function setOfflineWifiOnly(on: boolean): void {
  globalThis.localStorage?.setItem(WIFI_KEY, on ? "1" : "0");
  // Relaxing the constraint may unblock a previously-refused run.
  if (!on) void ensureAutoSync();
}

/** Kick off (or continue) the eager download IF auto-download is on. Safe to call
 *  repeatedly — the native side guards against concurrent runs, and a WiFi-only
 *  refusal is a no-op until WiFi returns (the settings poll re-fires it). */
export async function ensureAutoSync(): Promise<void> {
  if (!nativeSyncAvailable()) return;
  try {
    await nativeSyncAll(offlineWifiOnly());
  } catch {
    /* transient; the next poll/startup retries */
  }
}
