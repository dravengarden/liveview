// App-bundle OTA updater (native shell only).
//
// The web bundle hot-updates without an app reinstall. The trigger is a SERVER PUSH:
// the server sends an `AppVersion` over the WebSocket on (re)connect (a deploy =
// server restart = reconnect, so it's effectively instant), and useWebSocket calls
// runOtaCheck() in response. runOtaCheck asks the plugin's lvsync://localhost/ota-check
// to do a cheap ETag probe + INCREMENTAL download (only changed assets) + flip the
// `current` version; on "updated" it reloads (silently — the webview re-fetches
// lvsync://localhost/app/ and gets the new bundle; native AVPlayer playback survives,
// the SPA restores session/scroll). A single on-load check covers first launch before
// the WS connects. Off the native shell this is inert.

import { nativeSyncAvailable } from "@/native-sync";

let applying = false;

/** Probe + (if newer) incrementally download the app bundle, then reload into it.
 *  Called on load and on every server `AppVersion` WS push. Idempotent. */
export async function runOtaCheck(): Promise<void> {
  if (applying || !nativeSyncAvailable()) return;
  try {
    const r = await fetch("lvsync://localhost/ota-check");
    if ((await r.text()).trim().startsWith("updated:")) {
      applying = true;
      // Download completed server-side + `current` flipped; reload picks it up. No
      // banner — the reload is brief and the app restores its state.
      globalThis.location.reload();
    }
  } catch {
    // offline / transient / not the native shell — ignore
  }
}

/** One on-load check (safety net before the WS connects). The live path is the
 *  server's AppVersion WS push → runOtaCheck. No-op off the native shell. */
export function startOtaUpdater(): void {
  if (!nativeSyncAvailable()) return;
  void runOtaCheck();
}
