import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { AudioPlayerProvider } from "./audio/player";
import { installHaptics } from "./_shell";
import "./styles/index.css";

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

// Register the PWA service worker (production builds only — in dev the Vite
// server owns the page and a SW would serve stale modules).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
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
        globalThis.document.addEventListener("visibilitychange", checkForUpdate);
      })
      .catch(() => {
        // Non-fatal: the app still works without offline support.
      });
  });
}
