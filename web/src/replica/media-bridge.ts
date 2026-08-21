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

export function enqueueCacheFromUrl(hash: string, url: string): boolean {
  if (!isAbsoluteUrl(url)) return false;
  return cacheFromUrl({ url, hash });
}

export function enqueueCacheDelete(hash: string): boolean {
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

/** Bind cacheProgress from the native audio event bus. No-op until PR 4. */
export function installMediaBridge(): () => void {
  const listener = (event: Event): void => {
    const { detail } = event as CustomEvent<unknown>;
    if (!isCacheProgress(detail)) return;
    void noteCacheProgress(detail.hash, detail.ok);
  };
  globalThis.addEventListener("lv-native-audio", listener);
  return () => globalThis.removeEventListener("lv-native-audio", listener);
}
