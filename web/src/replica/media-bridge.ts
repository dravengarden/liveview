// Window-only: WKScriptMessage handlers are not visible inside a Worker.

import {
  cacheDelete,
  cacheFromUrl,
  setAllowsCellular,
  type HostCacheProgressEvent,
} from "../native-host.ts";
import { setPresent } from "./blobs.ts";

function isAbsoluteUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Session-local set of hashes already posted to native this process. */
const posted = new Set<string>();

export function isCacheQueued(hash: string): boolean {
  return posted.has(hash);
}

export function enqueueCacheFromUrl(hash: string, url: string): boolean {
  if (!isAbsoluteUrl(url)) return false;
  if (posted.has(hash)) return true;
  const ok = cacheFromUrl({ url, hash });
  if (ok) posted.add(hash);
  return ok;
}

export function enqueueCacheDelete(hash: string): boolean {
  posted.delete(hash);
  return cacheDelete({ hash });
}

export function applyCellularPolicy(on: boolean): boolean {
  return setAllowsCellular({ on });
}

export async function noteCacheProgress(
  hash: string,
  ok: boolean,
): Promise<void> {
  if (!ok) return;
  await setPresent(hash, 1);
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
    void noteCacheProgress(detail.hash, detail.ok).then(() => {
      if (detail.ok) onCached?.();
    });
  };
  globalThis.addEventListener("lv-native-audio", listener);
  return () => globalThis.removeEventListener("lv-native-audio", listener);
}
