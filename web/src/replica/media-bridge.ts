// Window-only: WKScriptMessage handlers are not visible inside a Worker.

import {
  cacheDelete,
  cacheFromUrl,
  type HostCacheProgressEvent,
  hostAudioAvailable,
  setAllowsCellular,
} from "../native-host.ts";
import { setPresent } from "./blobs.ts";
import { pwaAudioSupported, pwaDownloadsEnabled, pwaNetworkAvailable, pwaOfflineAvailable } from "../pwa.ts";

let nativeCacheProbe = hostAudioAvailable;

/** Whether an audio payload store can drain the replica's evictions. The test
 *  seam overrides native availability; supported browsers use Cache Storage. */
export function nativeAudioCacheAvailable(): boolean {
  return nativeCacheProbe() || pwaOfflineAvailable();
}

let pwaWorker: Worker | null = null;
function browserWorker(): Worker | null {
  if (!pwaOfflineAvailable()) return null;
  if (pwaWorker) return pwaWorker;
  try {
    pwaWorker = new Worker(new URL("./pwa-audio-worker.ts", import.meta.url), {
      type: "module", name: "lv-pwa-audio",
    });
    pwaWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
      globalThis.dispatchEvent(new CustomEvent("lv-native-audio", { detail: event.data }));
    });
    pwaWorker.addEventListener("error", () => {
      pwaWorker?.terminate();
      pwaWorker = null;
      for (const hash of [...posted]) cacheSettled(hash, false);
    });
    updateBrowserPolicy();
    return pwaWorker;
  } catch {
    return null;
  }
}

function updateBrowserPolicy(): void {
  // Network Information is absent on iOS. Unknown means no automatic WiFi
  // permission; the user can explicitly permit downloads on this connection.
  const wifiOnly = (globalThis.localStorage?.getItem("lv.offline.wifiOnly") ?? "0") === "1";
  const connection = (navigator as Navigator & { connection?: { type?: string } }).connection;
  const capBytes = (Number(globalThis.localStorage?.getItem("lv.offline.maxGB") ?? "20") || 20) * 1_073_741_824;
  // The worker reports terminal events for cancelled work on a cap change.
  // Keep hashes tracked until then, including if the worker itself fails.
  pwaWorker?.postMessage({
    type: "policy",
    capBytes,
    allowed: pwaDownloadsEnabled() && pwaAudioSupported() && pwaNetworkAvailable() &&
      (!wifiOnly || connection?.type === "wifi" || connection?.type === "ethernet"),
  });
}

/** Test seam: override the native-host availability probe. */
export function setNativeAudioCacheProbe(probe: () => boolean): void {
  nativeCacheProbe = probe;
}

function isAbsoluteUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Session-local set of hashes already handed to the active audio store. */
const posted = new Set<string>();
const settled = new Set<(hash: string, ok: boolean) => void>();

export function onCacheSettled(listener: (hash: string, ok: boolean) => void): () => void {
  settled.add(listener);
  return () => { settled.delete(listener); };
}

export function forgetCacheQueued(hash: string): void { posted.delete(hash); }

function cacheSettled(hash: string, ok: boolean): void {
  posted.delete(hash);
  for (const listener of settled) listener(hash, ok);
}

export function isCacheQueued(hash: string): boolean {
  return posted.has(hash);
}

export function enqueueCacheFromUrl(
  hash: string,
  url: string,
  bytes?: number,
): boolean {
  if (!isAbsoluteUrl(url)) return false;
  if (posted.has(hash)) return true;
  const expectedBytes = typeof bytes === "number" && Number.isFinite(bytes) &&
      bytes > 0
    ? Math.floor(bytes)
    : undefined;
  const browser = nativeCacheProbe() ? null : browserWorker();
  if (browser) {
    browser.postMessage({ type: "cache", hash, url, ...(expectedBytes ? { bytes: expectedBytes } : {}) });
    posted.add(hash);
    return true;
  }
  const ok = cacheFromUrl({
    url,
    hash,
    ...(expectedBytes ? { bytes: expectedBytes } : {}),
  });
  if (ok) posted.add(hash);
  return ok;
}

export function enqueueCacheDelete(hash: string): boolean {
  posted.delete(hash);
  cacheSettled(hash, false);
  const browser = nativeCacheProbe() ? null : browserWorker();
  if (browser) {
    browser.postMessage({ type: "delete", hash });
    return true;
  }
  return cacheDelete({ hash });
}

export function applyCellularPolicy(on: boolean): boolean {
  if (pwaOfflineAvailable()) {
    updateBrowserPolicy();
    return true;
  }
  return setAllowsCellular({ on });
}

export async function noteCacheProgress(
  hash: string,
  ok: boolean,
): Promise<void> {
  if (!ok) posted.delete(hash);
  await setPresent(hash, ok ? 1 : 0);
}

function isCacheProgress(detail: unknown): detail is HostCacheProgressEvent {
  if (!detail || typeof detail !== "object") return false;
  const rec = detail as Record<string, unknown>;
  return rec["type"] === "cacheProgress" &&
    typeof rec["hash"] === "string" &&
    typeof rec["ok"] === "boolean";
}

/** cacheProgress is a window CustomEvent; workers cannot see WKScriptMessage. */
export function installMediaBridge(onCached?: () => void): () => void {
  const listener = (event: Event): void => {
    const { detail } = event as CustomEvent<unknown>;
    if (!isCacheProgress(detail)) return;
    if (pwaOfflineAvailable()) {
      // Browser audio already committed replica bookkeeping in its worker.
      cacheSettled(detail.hash, detail.ok);
      if (detail.ok) onCached?.();
      return;
    }
    void noteCacheProgress(detail.hash, detail.ok).then(
      () => {
        cacheSettled(detail.hash, detail.ok);
        if (detail.ok) onCached?.();
      },
      (error: unknown) => {
        cacheSettled(detail.hash, false);
        console.warn("replica: cacheProgress bookkeeping failed", error);
      },
    );
  };
  globalThis.addEventListener("lv-native-audio", listener);
  const policyEvents = ["online", "offline", "lv-download-policy"];
  const connection = typeof navigator === "undefined" ? undefined
    : (navigator as Navigator & { connection?: EventTarget }).connection;
  if (pwaOfflineAvailable()) {
    for (const name of policyEvents) globalThis.addEventListener(name, updateBrowserPolicy);
    connection?.addEventListener("change", updateBrowserPolicy);
  }
  return () => {
    globalThis.removeEventListener("lv-native-audio", listener);
    for (const name of policyEvents) globalThis.removeEventListener(name, updateBrowserPolicy);
    connection?.removeEventListener("change", updateBrowserPolicy);
  };
}
