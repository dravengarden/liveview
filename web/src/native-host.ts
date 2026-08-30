// Frozen native host protocol v1.
//
// Document origin `lvsync://localhost` is the persistence contract, so the
// scheme stays.

/** Persistence + host-route origin. */
export const HOST_ORIGIN = "lvsync://localhost";

/** `host-info.protocol` starts at 1. */
export const HOST_PROTOCOL = 1;

export const HOST_AUDIO_HANDLER = "lvNativeAudio";
export const HOST_NAV_HANDLER = "lvNativeNav";

export const HOST_CMD_APP_VERSION = "plugin:app|version";
export const HOST_CMD_OPEN_URL = "plugin:opener|open_url";
export const HOST_CMD_HAPTIC_IMPACT = "plugin:haptics|impact_feedback";
export const HOST_CMD_HAPTIC_NOTIFICATION =
  "plugin:haptics|notification_feedback";
export const HOST_CMD_HAPTIC_SELECTION = "plugin:haptics|selection_feedback";
export const HOST_CMD_HAPTIC_VIBRATE = "plugin:haptics|vibrate";

/** Media transport kinds that stay in protocol v1. */
export const HOST_PROTOCOL_V1_MEDIA_KINDS = [
  "load",
  "play",
  "pause",
  "stop",
  "state",
  "seek",
  "rate",
  "widgetSnapshot",
] as const;

/** Navigation snapshot messages posted as `{ type }` (not `{ kind }`). */
export const HOST_PROTOCOL_V1_NAV_TYPES = [
  "push",
  "pop",
  "ready",
] as const;

/** Media-cache kinds. Implemented on the iOS `lvNativeAudio` handler; no-op off-shell. */
export const HOST_PROTOCOL_V1_CACHE_KINDS = [
  "cacheFromUrl",
  "cacheHas",
  "cacheDelete",
  "cacheCount",
  "setAllowsCellular",
] as const;

/** App-shell + config routes under HOST_ORIGIN (future routes no-op on 404). */
export const HOST_PROTOCOL_V1_APPSHELL_ROUTES = [
  "/host-info",
  "/appshell/current",
  "/appshell/has",
  "/appshell/putFromUrl",
  "/appshell/activate",
  "/origins",
] as const;

export const HOST_PROTOCOL_V1_TAURI_COMMANDS = [
  HOST_CMD_APP_VERSION,
  HOST_CMD_OPEN_URL,
  HOST_CMD_HAPTIC_IMPACT,
  HOST_CMD_HAPTIC_NOTIFICATION,
  HOST_CMD_HAPTIC_SELECTION,
  HOST_CMD_HAPTIC_VIBRATE,
] as const;

/** LiveView-store kinds protocol v1 rejects. Native no longer implements them. */
export const LEGACY_AUDIO_STORE_KINDS = [
  "prefetch",
  "pin",
  "unpin",
  "reconcile",
  "setCap",
  "setWifiOnly",
  "audioStats",
] as const;

export type HostProtocolV1MediaKind =
  (typeof HOST_PROTOCOL_V1_MEDIA_KINDS)[number];
export type HostProtocolV1NavType = (typeof HOST_PROTOCOL_V1_NAV_TYPES)[number];
export type HostProtocolV1CacheKind =
  (typeof HOST_PROTOCOL_V1_CACHE_KINDS)[number];
export type LegacyAudioStoreKind = (typeof LEGACY_AUDIO_STORE_KINDS)[number];

export interface HostInfo {
  readonly protocol: number;
  readonly nativeVersion: string;
  readonly debugEmbedded: boolean;
}

export type HostCacheProgressEvent = {
  readonly type: "cacheProgress";
  readonly hash: string;
  readonly ok: boolean;
};

interface WebKitHandler {
  postMessage(message: unknown): void;
}

interface TauriInternals {
  readonly invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
}

const TAURI_INTERNALS_KEY = "__TAURI_INTERNALS__";

function webKitHandler(name: string): WebKitHandler | null {
  const w = globalThis as {
    webkit?: { messageHandlers?: Readonly<Record<string, WebKitHandler>> };
  };
  return w.webkit?.messageHandlers?.[name] ?? null;
}

function postWebKit(name: string, message: unknown): boolean {
  const h = webKitHandler(name);
  if (!h) return false;
  try {
    // WKScriptMessageHandler.postMessage (one-arg native bridge), NOT window.postMessage.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    h.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function tauriInvokeFn():
  | ((cmd: string, args?: unknown) => Promise<unknown>)
  | null {
  try {
    const internals = (globalThis as Record<string, unknown>)[
      TAURI_INTERNALS_KEY
    ] as TauriInternals | undefined;
    const invoke = internals?.invoke;
    return typeof invoke === "function" ? invoke : null;
  } catch {
    return null;
  }
}

function isAbsoluteUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

async function hostFetch(
  pathAndQuery: string,
  init?: RequestInit,
): Promise<Response | null> {
  try {
    return await fetch(`${HOST_ORIGIN}${pathAndQuery}`, {
      cache: "no-store",
      ...init,
    });
  } catch {
    return null;
  }
}

/** True when the Swift `lvNativeAudio` handler is registered. */
export function hostAudioAvailable(): boolean {
  return webKitHandler(HOST_AUDIO_HANDLER) !== null;
}

/** True when the Swift `lvNativeNav` handler is registered. */
export function hostNavAvailable(): boolean {
  return webKitHandler(HOST_NAV_HANDLER) !== null;
}

/** Post a WKScriptMessage to the audio bridge. No-op off-shell. */
export function postHostAudio(message: unknown): boolean {
  return postWebKit(HOST_AUDIO_HANDLER, message);
}

/** Post a WKScriptMessage to the nav bridge. No-op off-shell. */
export function postHostNav(message: unknown): boolean {
  return postWebKit(HOST_NAV_HANDLER, message);
}

/** Fire-and-forget Tauri invoke. Returns true if the IPC bridge exists so the
 *  caller can skip web fallbacks; plugin rejection is swallowed. */
export function invokeHost(command: string, args?: unknown): boolean {
  const invoke = tauriInvokeFn();
  if (!invoke) return false;
  void (async (): Promise<void> => {
    try {
      await invoke(command, args);
    } catch {
      // plugin or permission missing in the native build — silent
    }
  })();
  return true;
}

export async function hostAppVersion(): Promise<string | null> {
  const invoke = tauriInvokeFn();
  if (!invoke) return null;
  try {
    const version = await invoke(HOST_CMD_APP_VERSION);
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export async function hostOpenUrl(url: string): Promise<boolean> {
  const invoke = tauriInvokeFn();
  if (!invoke) return false;
  try {
    await invoke(HOST_CMD_OPEN_URL, { url });
    return true;
  } catch {
    return false;
  }
}

/** Raw `/origins` JSON, or null when the scheme is absent / the request fails. */
export async function fetchHostOrigins(): Promise<unknown> {
  const response = await hostFetch("/origins");
  if (response == null || !response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function hostInfo(): Promise<HostInfo | null> {
  const response = await hostFetch("/host-info");
  if (response == null || !response.ok) return null;
  try {
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (typeof o["protocol"] !== "number") return null;
    return {
      protocol: o["protocol"],
      nativeVersion: typeof o["nativeVersion"] === "string"
        ? o["nativeVersion"]
        : "",
      debugEmbedded: o["debugEmbedded"] === true,
    };
  } catch {
    return null;
  }
}

export async function appshellCurrent(): Promise<string> {
  const response = await hostFetch("/appshell/current");
  if (response == null || !response.ok) return "";
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

export async function appshellHas(path: string): Promise<boolean> {
  const qs = new URLSearchParams({ p: path });
  const response = await hostFetch(`/appshell/has?${qs}`);
  if (response == null || !response.ok) return false;
  try {
    const text = (await response.text()).trim();
    return text === "1" || text === "true";
  } catch {
    return false;
  }
}

/** Path-only overlay put. Never accepts a `u=` URL — native fetches from baked
 *  origins. Returns null when the route is absent. */
export async function putFromUrl(
  path: string,
  version?: string,
): Promise<"ok" | "skipped" | null> {
  if (path.includes("..")) return null;
  const qs = new URLSearchParams({ p: path });
  if (version !== undefined) qs.set("v", version);
  const response = await hostFetch(`/appshell/putFromUrl?${qs}`, {
    method: "POST",
  });
  if (response == null || !response.ok) return null;
  try {
    const text = (await response.text()).trim();
    if (text === "ok" || text === "skipped") return text;
    return null;
  } catch {
    return null;
  }
}

export async function appshellActivate(
  version: string,
  assets?: readonly string[],
): Promise<boolean> {
  const qs = new URLSearchParams({ v: version });
  const init: RequestInit = { method: "POST" };
  if (assets !== undefined) {
    init.body = JSON.stringify({ assets });
    init.headers = { "content-type": "application/json" };
  }
  const response = await hostFetch(`/appshell/activate?${qs}`, init);
  return response?.ok === true;
}

const hostPending = new Map<string, (json: string) => void>();
let hostResolverInstalled = false;
let hostSeq = 0;

function ensureHostResolver(): void {
  if (hostResolverInstalled) return;
  hostResolverInstalled = true;
  (globalThis as unknown as {
    __lvHostResolve?: (id: string, json: string) => void;
  }).__lvHostResolve = (id, json) => {
    const r = hostPending.get(id);
    if (r) {
      hostPending.delete(id);
      r(json);
    }
  };
}

function hostReply(id: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    hostPending.set(id, resolve);
    setTimeout(() => {
      if (hostPending.delete(id)) resolve("");
    }, timeoutMs);
  });
}

/** Enqueue a media-cache download. `url` must be absolute. */
export function cacheFromUrl(
  args: { url: string; hash: string; bytes?: number },
): boolean {
  if (!isAbsoluteUrl(args.url)) return false;
  return postHostAudio({ kind: "cacheFromUrl", data: args });
}

function abandonHostReply(id: string): void {
  const r = hostPending.get(id);
  if (!r) return;
  hostPending.delete(id);
  r("");
}

/** Play-path probe. `{ has: false }` when the handler is absent / times out. */
export async function cacheHas(
  args: { hash: string },
): Promise<{ has: boolean }> {
  if (!hostAudioAvailable()) return { has: false };
  ensureHostResolver();
  const id = `h${++hostSeq}`;
  const pending = hostReply(id, 5_000);
  if (!postHostAudio({ kind: "cacheHas", data: { id, hash: args.hash } })) {
    abandonHostReply(id);
    return { has: false };
  }
  const json = await pending;
  if (!json) return { has: false };
  try {
    const o = JSON.parse(json) as { has?: unknown };
    return { has: o.has === true };
  } catch {
    return { has: false };
  }
}

export function cacheDelete(args: { hash: string }): boolean {
  return postHostAudio({ kind: "cacheDelete", data: args });
}

/** Repair-only scalar. `{ count: 0 }` when the handler is absent / times out. */
export async function cacheCount(): Promise<{ count: number }> {
  if (!hostAudioAvailable()) return { count: 0 };
  ensureHostResolver();
  const id = `c${++hostSeq}`;
  const pending = hostReply(id, 8_000);
  if (!postHostAudio({ kind: "cacheCount", data: { id } })) {
    abandonHostReply(id);
    return { count: 0 };
  }
  const json = await pending;
  if (!json) return { count: 0 };
  try {
    const o = JSON.parse(json) as { count?: unknown };
    return { count: typeof o.count === "number" ? o.count : 0 };
  } catch {
    return { count: 0 };
  }
}

export function setAllowsCellular(args: { on: boolean }): boolean {
  return postHostAudio({ kind: "setAllowsCellular", data: args });
}
