/** True only inside the native shell (thin `lvsync://` host is registered). */
export function nativeSyncAvailable(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}
