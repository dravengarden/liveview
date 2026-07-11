import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { AudioPlayerProvider } from "./audio/player";
import { installHaptics } from "./_shell";
import { BUNDLED, installApiShim, selectRemote } from "./apiBase";
import { startOfflineFlagSync } from "./native-sync";
import { startSyncQueue } from "./syncQueue";
import { startApm } from "./apm";
import { startOtaUpdater } from "./otaUpdater";
import "./styles/index.css";

// Choose a reachable native endpoint before any subsystem captures/uses REMOTE.
// This races the public/tailnet route with the direct LAN route and is a no-op in
// the PWA, where relative same-origin URLs remain authoritative.
await selectRemote();

// When bundled into the native shell (local origin), point relative /api/* fetches
// at the remote server so the app works; reader CONTENT still resolves offline via
// the native plugin (contentFetch). No-op on the remote origin / PWA. Install
// FIRST, before any module fires a fetch.
installApiShim();

// Mirror connectivity into the native fetcher's fast-fail flag (BEFORE any content
// fetch) so an offline cold launch never eats the 4s-per-miss connect timeout —
// network-first reads fail instantly offline, cache hits are untouched. Native only.
startOfflineFlagSync();

// Drain any cross-device writes (settings / progress) left pending from a prior
// offline session. AFTER the shim so relative /api/* hits the remote origin.
startSyncQueue();

// Client APM: buffer operation/perf/error events in the native SQLite outbox and
// batch-flush them to the server (→ VictoriaLogs) when the network is good. Native
// shell only; installs app-wide error capture. AFTER the shim so /api/ingest hits
// the remote origin.
startApm();

// App-bundle hot-update: check the server for a newer web bundle (incremental,
// content-addressed) and reload into it when ready. Native shell only.
startOtaUpdater();

// Global haptic delegation: ONE listener set buzzes every MUI control (button /
// toggle / card / chip / Select), custom `cursor:pointer` clickable, text input,
// and popup app-wide — the "don't miss any" baseline, with coalescing so an
// explicit haptic() never double-buzzes. On iOS only the native Tauri haptics
// plugin fires (Safari/PWA has no reliable web haptic); a harmless no-op
// elsewhere. See _shell/haptic-delegation.
installHaptics();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <AudioPlayerProvider>
        <App />
      </AudioPlayerProvider>
    </I18nProvider>
  </StrictMode>,
);

// Reaching this line means the entry chunk loaded and React initialized — i.e.
// the shell booted fine. Clear the one-shot boot-heal guard (set by the inline
// recovery script in index.html) so a future stale-cache failure can self-heal
// again rather than being suppressed for the rest of the session.
try {
  sessionStorage.removeItem("lv-boot-heal");
} catch {
  // sessionStorage may be unavailable (private mode / sandbox) — non-fatal.
}

// Register the service worker — IN THE NATIVE SHELL TOO (not only PWA/browser).
//
// The shell loads the REMOTE origin in a WKWebView with NO bundled SPA, so the
// app's index.html + JS/CSS chunks can only load OFFLINE if something serves them
// from cache — and that something is THIS service worker (navigate = cache-first
// shell, assets = stale-while-revalidate). It's also exactly what the bundled
// native shell probes for on a cold offline launch: it loads
// REMOTE/favicon.svg as an <img>, which the SW serves from cache with zero
// network, then hands off to the SW-served SPA. We previously UNREGISTERED the SW
// on the shell to always load fresh — but that left the shell with no offline
// copy of itself, so a cold offline launch dead-ended on the connection screen (this
// bug). Freshness is preserved without sacrificing offline: the SW is VERSION-
// stamped (a UI change invalidates its caches), the navigate handler revalidates
// in the background, and the controllerchange listener below auto-reloads once a
// newer SW activates. (Reader CONTENT still also resolves through the native
// lvSync bridge; native AUDIO still plays from the native AVPlayer store. The SW
// owns the APP SHELL — the piece that was missing offline.)
if (import.meta.env.PROD && !BUNDLED && "serviceWorker" in navigator) {
  // Auto-reload once when a freshly-deployed SW takes control. The SW already
  // calls skipWaiting()+clients.claim() on a VERSION bump, which fires
  // `controllerchange` — without this listener the page keeps running the old
  // in-memory bundle until the user manually relaunches (twice, on iOS PWAs).
  // Guarded two ways: only when a controller already existed (so the very
  // first install on a fresh visit doesn't reload), and reload at most once.
  if (navigator.serviceWorker.controller) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      globalThis.location.reload();
    });
  }
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // iOS standalone PWAs RESUME the old in-memory page when reopened (even
        // after a swipe-kill) and skip the SW update check — so a deployed fix
        // can sit on the server forever while the device keeps running the old
        // bundle. Force an update check every time the app returns to the
        // foreground; if a newer SW is found it installs (skipWaiting) →
        // activates → controllerchange → the reload above. This is what makes a
        // deploy actually reach an installed PWA without a manual cache wipe.
        const checkForUpdate = (): void => {
          if (globalThis.document.visibilityState === "visible") {
            void reg.update().catch(() => {
              // Offline / transient — try again on the next foreground.
            });
          }
        };
        globalThis.document.addEventListener(
          "visibilitychange",
          checkForUpdate,
        );
      })
      .catch(() => {
        // Non-fatal: the app still works without offline support.
      });
  });
}
