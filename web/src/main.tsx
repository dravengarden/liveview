import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { AudioPlayerProvider } from "./audio/player";
import { installHaptics } from "./_shell";
import {
  BUNDLED,
  installApiShim,
  onRemoteChange,
  REMOTE,
  selectRemote,
} from "./apiBase";
import { startOfflineFlagSync } from "./native-sync";
import { startSyncQueue } from "./syncQueue";
import { startApm } from "./apm";
import { startOtaUpdater } from "./otaUpdater";
import {
  disableReplica,
  initReplica,
  replicaFlag,
  requestPersistentStorage,
  setReplicaRemote,
} from "./replica/mod.ts";
import { installedPwa } from "./pwa.ts";
import { connectionStore } from "./connectionStore.ts";
import "./styles/index.css";

// Choose the native endpoint before any subsystem captures/uses REMOTE. With a
// remembered winner this returns at once and re-probes in the background, so an
// offline cold launch never waits on the probe; the first launch still waits.
await selectRemote();

// When bundled into the native shell (local origin), point relative /api/* fetches
// at the remote server so the app works; reader CONTENT still resolves offline via
// the TypeScript IDB replica (contentFetch). No-op on the remote origin / PWA.
// Install FIRST, before any module fires a fetch.
installApiShim();

// Mirror connectivity into the replica fail-fast probe (BEFORE any content
// fetch) so an offline cold launch never hangs a miss. Native only.
startOfflineFlagSync();

// Drain any cross-device writes (settings / progress) left pending from a prior
// offline session. AFTER the shim so relative /api/* hits the remote origin.
startSyncQueue();

// Optional client APM. This remains a complete no-op unless VITE_APM_ENABLED=true;
// deployments choose their own server-side sink explicitly.
startApm();

// App-bundle hot-update: check the server for a newer web bundle (incremental,
// content-addressed) and reload into it when ready. Native shell only.
startOtaUpdater();

// IDB replica is the content store. Await so the first contentFetch can hit
// the hydrated path index instead of a cold miss. An IndexedDB failure (private
// mode, quota, a corrupt store) must not blank the app: log it and continue
// with the replica disabled, so reads fall back to the network.
if (replicaFlag() === "idb") {
  try {
    // Browser replicas must use their own origin, not a native compile-time
    // endpoint (whose default is loopback on the user's device).
    const replicaOrigin = BUNDLED ? REMOTE : globalThis.location.origin;
    await initReplica(undefined, {
      remoteBase: replicaOrigin,
      origins: [replicaOrigin],
    });
    // A background re-probe may pick a different native route after launch.
    if (BUNDLED) onRemoteChange((origin) => setReplicaRemote(origin, [origin]));
    // Installed apps hold an offline library worth protecting from eviction. A
    // plain browser tab does not ask (Firefox would show a permission prompt).
    if (BUNDLED || installedPwa()) void requestPersistentStorage();
  } catch (error) {
    console.error("Replica init failed; continuing network-only:", error);
    disableReplica();
  }
}

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
  (globalThis as typeof globalThis & { __LV_BOOTED__?: boolean }).__LV_BOOTED__ = true;
  sessionStorage.removeItem("lv-boot-heal");
} catch {
  // sessionStorage may be unavailable (private mode / sandbox) — non-fatal.
}

// Browser/remote shells use a versioned SW. The bundled native shell owns its
// overlay and never registers one. Installation and foreground checks announce
// updates without interrupting reading or playback; activation needs a tap.
if (import.meta.env.PROD && !BUNDLED && "serviceWorker" in navigator) {
  // Another tab closing can allow natural activation. The reader still decides
  // when to replace this in-memory UI.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      connectionStore.updateAvailable();
    });
  }
  const registerWorker = (): void => {
    void navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        const announce = (): void => {
          if (reg.waiting && navigator.serviceWorker.controller) connectionStore.updateAvailable();
        };
        announce();
        reg.addEventListener("updatefound", () => {
          reg.installing?.addEventListener("statechange", announce);
        });
        // iOS standalone PWAs RESUME the old in-memory page when reopened (even
        // after a swipe-kill) and skip the SW update check — so a deployed fix
        // can sit on the server forever while the device keeps running the old
        // bundle. Force an update check every time the app returns to the
        // foreground. An installed update waits for the banner action.
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
  };
  // Replica boot awaits IDB. The document may already have fired load by then.
  if (document.readyState === "complete") registerWorker();
  else window.addEventListener("load", registerWorker, { once: true });
}
