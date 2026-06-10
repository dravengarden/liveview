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
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-fatal: the app still works without offline support.
    });
  });
}
