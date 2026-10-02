/** Browser capabilities, deliberately separate from native host availability. */
export function pwaOfflineAvailable(): boolean {
  return !("__TAURI_INTERNALS__" in globalThis) &&
    typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    "caches" in globalThis && typeof Worker !== "undefined";
}

let backendConnected = false;
/** A live same-origin socket is stronger evidence than Safari's online hint. */
export function pwaNetworkAvailable(): boolean {
  return backendConnected || typeof navigator === "undefined" ||
    navigator.onLine !== false;
}

export function setPwaBackendConnected(connected: boolean): void {
  if (!pwaOfflineAvailable() || backendConnected === connected) return;
  backendConnected = connected;
  globalThis.dispatchEvent?.(new Event("lv-download-policy"));
}

export function pwaDownloadsEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem("lv.offline.pwaEnabled") === "1";
  } catch {
    return false;
  }
}

export function pwaAudioSupported(): boolean {
  return typeof document !== "undefined" &&
    document.createElement("audio").canPlayType("audio/x-caf") !== "";
}

export function setPwaDownloadsEnabled(on: boolean): void {
  globalThis.localStorage?.setItem("lv.offline.pwaEnabled", on ? "1" : "0");
  globalThis.dispatchEvent(new Event("lv-download-policy"));
}

export function installedPwa(): boolean {
  return globalThis.matchMedia?.("(display-mode: standalone)").matches ===
      true ||
    (typeof navigator !== "undefined" &&
      (navigator as Navigator & { standalone?: boolean }).standalone === true);
}
