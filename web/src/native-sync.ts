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

/** Offline cache stats for non-audio content: [cachedCount, totalCount, cachedBytes, totalBytes]. */
export async function nativeCacheStats(): Promise<[number, number, number, number]> {
  const { ok, payload } = await call("stats");
  if (!ok) throw new Error("stats unavailable");
  return JSON.parse(payload) as [number, number, number, number];
}

/** Eager-pull the whole corpus's non-audio content. Resolves to bytes cached.
 *  Long-running; fire it and poll {@link nativeCacheStats} for live progress. */
export async function nativeSyncAll(): Promise<number> {
  const { ok, payload } = await call("syncAll", undefined, 1_200_000);
  if (!ok) throw new Error("sync failed");
  return Number(payload);
}
