// Connection / version banner store — now sourced from the shared @shared-utils/ui
// module (web/src/_shell/connection-banner.tsx). liveview is the canonical
// behavior; cowboy shares the same instance factory. This file just creates
// liveview's singleton (probing "/api/version") and re-exports the bound API the
// rest of the app already imports from "@/connectionStore", so no caller changes.
//
// The live-reload WebSocket (web/src/hooks/useWebSocket.ts) drives the reconnect
// side; the version side is probed after each reconnect and on foreground
// (web/src/hooks/useAutoUpdate.ts). Only the banner is shared React state (read
// via useConnectionBanner); the WebSocket stays in the single useWebSocket hook.

import { type Banner, type BannerKind, createConnectionStore } from "@/_shell";

export type { Banner, BannerKind };

export const connectionStore = createConnectionStore({
  versionUrl: "/api/version",
  // Offline-first reconnect policy (design §6): be CONSERVATIVE about surfacing
  // an outage — a few dropped frames recover silently — and never hammer the
  // server on a long outage. Show the offline state only after ~4 consecutive
  // failed (re)connect cycles; cap the exponential backoff at 60s (retries stay
  // unbounded). Because the reader is fully usable offline, an outage only needs
  // a calm warning, not an alarm.
  reconnectBannerThreshold: 4,
  reconnectBackoffMaxMs: 60_000,
});

// Bound re-exports — same named bindings the rest of liveview imports today, so
// useWebSocket / useAutoUpdate / ReconnectBanner are untouched.
export const connectionReady = (): void => connectionStore.connectionReady();
export const connectionLost = (): number => connectionStore.connectionLost();
export const applyUpdate = (): Promise<void> => connectionStore.applyUpdate();
export const watchForegroundVersion = (): () => void =>
  connectionStore.watchForegroundVersion();
export const useConnectionBanner = (): Banner | undefined =>
  connectionStore.useConnectionBanner();
