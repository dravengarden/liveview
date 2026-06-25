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

// Safety-net interval (ms) while the app is FOREGROUNDED — the main triggers are
// WS-reconnect (instant on a deploy) + foreground-resume, so this just covers an app
// left open across a deploy. The probe is a cheap 304 when unchanged. Paused when
// backgrounded (no point polling a hidden app).
const CHECK_MS = 30_000;
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
  // TOP banner. Font + padding in `rem` so it scales with Settings → Font size
  // (App sets the root html font-size from `fontScale`, so rem tracks it).
  el.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:calc(env(safe-area-inset-top, 0px) + 12px)",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "background:rgba(124,58,237,0.96)",
    "color:#fff",
    "padding:0.6rem 1.1rem",
    "border-radius:999px",
    "font:600 0.95rem/1.2 system-ui, -apple-system, sans-serif",
    "box-shadow:0 6px 20px rgba(0,0,0,0.35)",
    "pointer-events:none",
    "max-width:90vw",
    "text-align:center",
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
  const check = (): void => {
    if (!applying) void checkOnce(onUpdated);
  };
  // Triggers, fastest first:
  // 1. WS reconnect — a deploy restarts the server → the WS reconnects → instant check.
  globalThis.addEventListener("lv-ws-open", check);
  // 2. Foreground resume — catch a deploy that happened while the app was backgrounded.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  // 3. On load.
  check();
  // 4. Safety-net interval, ONLY while visible (don't poll a hidden app).
  globalThis.setInterval(() => {
    if (document.visibilityState === "visible") check();
  }, CHECK_MS);
}
