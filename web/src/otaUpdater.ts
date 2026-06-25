// App-bundle OTA updater (native shell only).
//
// The web bundle hot-updates without an app reinstall: this driver calls the plugin's
// lvsync://localhost/ota-check on load + on a timer. That endpoint does a cheap ETag
// probe (If-None-Match the current version) and, when the server has a newer bundle,
// INCREMENTALLY downloads only the changed assets (Vite content-hashes filenames, so
// unchanged chunks are reused), makes the new version `current`, and retains the last 3
// versions. On "updated:<version>" we show a brief banner and reload — the webview then
// re-fetches lvsync://localhost/app/ and gets the new bundle. Native AVPlayer playback
// survives the reload; the SPA restores its session/scroll from its persisted stores.
//
// Off the native shell (PWA/browser) this is inert.

import { nativeSyncAvailable } from "@/native-sync";

// Re-check on a relaxed cadence — the probe is a 304 (a few bytes) when unchanged.
const CHECK_MS = 5 * 60_000;
const BANNER_MS = 3000;

async function checkOnce(onUpdated: () => void): Promise<void> {
  try {
    const r = await fetch("lvsync://localhost/ota-check");
    if ((await r.text()).trim().startsWith("updated:")) onUpdated();
  } catch {
    // offline / transient / not the native shell — ignore
  }
}

function showBanner(): void {
  const el = document.createElement("div");
  el.textContent = "已更新到新版本，即将刷新…";
  el.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:calc(env(safe-area-inset-bottom, 0px) + 88px)",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "background:rgba(124,58,237,0.96)",
    "color:#fff",
    "padding:10px 18px",
    "border-radius:999px",
    "font:600 14px/1.2 system-ui, -apple-system, sans-serif",
    "box-shadow:0 6px 20px rgba(0,0,0,0.35)",
    "pointer-events:none",
  ].join(";");
  document.body.appendChild(el);
}

/** Start the app-bundle OTA updater. No-op off the native shell. */
export function startOtaUpdater(): void {
  if (!nativeSyncAvailable()) return;
  let applying = false;
  const onUpdated = (): void => {
    if (applying) return;
    applying = true;
    // Download already completed server-side + `current` flipped; reload picks it up.
    showBanner();
    globalThis.setTimeout(() => globalThis.location.reload(), BANNER_MS);
  };
  void checkOnce(onUpdated);
  globalThis.setInterval(() => {
    if (!applying) void checkOnce(onUpdated);
  }, CHECK_MS);
}
