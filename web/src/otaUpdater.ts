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
import { otaReloadUrl } from "./otaReloadUrl.ts";

let applying = false;

/** Probe + (if newer) incrementally download the app bundle, then reload into it.
 *  Called on load and on every server `AppVersion` WS push. Idempotent. */
export async function runOtaCheck(): Promise<void> {
  if (applying || !nativeSyncAvailable()) return;
  try {
    const r = await fetch("lvsync://localhost/ota-check");
    const status = (await r.text()).trim();
    if (status.startsWith("updated:")) {
      applying = true;
      // Download completed server-side + `current` flipped; reload picks it up. No
      // banner — the reload is brief and the app restores its state. Use a
      // versioned navigation URL instead of reload(): WKWebView may satisfy a
      // custom-scheme reload from its current navigation cache even after the
      // native `web/current` pointer has moved, leaving old JavaScript resident.
      const version = status.slice("updated:".length).split(" ", 1)[0] ??
        "updated";
      globalThis.location.replace(
        otaReloadUrl(globalThis.location.href, version),
      );
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
