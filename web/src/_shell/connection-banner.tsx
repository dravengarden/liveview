// ConnectionBanner — the unified connection / version banner.
//
// One floating top bar + one store policy for any app that lives behind a
// long-lived socket and ships its own build id.
//
// The store side is a FACTORY (createConnectionStore) returning a fresh,
// self-contained instance — each app holds its own singleton. The app's own
// socket layer drives the reconnect side (connectionReady / connectionLost); the
// version side is probed after each reconnect and whenever the tab returns to
// the foreground. The three states:
//   - red "down"          — reconnect has failed reconnectBannerThreshold times
//                           in a row (a blip that recovers on the first retry
//                           stays silent);
//   - green "reconnected" — the socket came back after a surfaced outage;
//                           auto-dismissed after reconnectedDismissMs;
//   - blue "update"       — a redeploy was detected; the floating overlay counts
//                           down and clears caches + hard-reloads on its own.
//
// Only the banner is shared React state (read via useConnectionBanner); the
// socket itself stays in the app, which just reports open/close here and reads
// back the backoff delay.

import { Box, CircularProgress } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

export type BannerKind = "down" | "reconnected" | "update";
export interface Banner {
  readonly kind: BannerKind;
}

export interface ConnectionStoreOptions {
  /** Build-id probe endpoint, for example "/api/version". */
  readonly versionUrl: string;
  /** Surface the red banner once this many consecutive (re)connect cycles fail.
   *  Default 2 — a single dropped frame that recovers on the first retry stays
   *  silent; only a real outage raises the banner. */
  readonly reconnectBannerThreshold?: number;
  /** Cap the exponential backoff so a long outage doesn't hammer the server.
   *  Default 15000ms. */
  readonly reconnectBackoffMaxMs?: number;
  /** How long the green "reconnected" flash lingers before auto-dismissing.
   *  Default 4000ms. */
  readonly reconnectedDismissMs?: number;
}

export interface ConnectionStore {
  /** Call from the app's socket on a successful (re)open. Clears the failure
   *  count, flashes green if a red banner was up, then probes for a new build. */
  connectionReady(): void;
  /** Call from the app's socket on close. Raises the red banner once retries
   *  have failed past the threshold and returns the backoff delay (ms) the app
   *  should wait before its next attempt. */
  connectionLost(): number;
  /** A Service Worker with a fresh shell took control. Surface the same visible
   *  countdown used by build-id probes instead of reloading immediately. */
  updateAvailable(): void;
  /** The update overlay's reload action: clear EVERY cache (so a service worker
   *  can't re-serve the old bundle) then hard-reload into the new build. */
  applyUpdate(): Promise<void>;
  /** Probe for a new build whenever the tab returns to the foreground. Returns a
   *  cleanup fn for the effect. */
  watchForegroundVersion(): () => void;
  /** useSyncExternalStore over this instance's banner. */
  useConnectionBanner(): Banner | undefined;
  /** The current known build id — for cache-busting fetches keyed on the build. */
  version(): string | undefined;
}

// Surface the red banner once this many consecutive (re)connect cycles fail.
const DEFAULT_RECONNECT_BANNER_THRESHOLD = 2;
// Cap the exponential backoff so a long outage doesn't hammer the server.
const DEFAULT_RECONNECT_BACKOFF_MAX_MS = 15_000;
// How long the green "reconnected" flash lingers before auto-dismissing.
const DEFAULT_RECONNECTED_DISMISS_MS = 4000;

// The update overlay's reload action (fired when its countdown elapses): clear
// every cache (so a service worker can't re-serve the old bundle) then hard-reload
// into the new build. Ported from liveview's useAutoUpdate hardRefresh. Captures
// no per-instance state, so it lives at module scope (shared across instances).
async function applyUpdate(): Promise<void> {
  try {
    if ("caches" in globalThis) {
      const keys = await globalThis.caches.keys();
      await Promise.all(keys.map((k) => globalThis.caches.delete(k)));
    }
  } catch {
    // non-fatal — the reload still pulls fresh content-hashed assets.
  }
  globalThis.location.reload();
}

export function createConnectionStore(opts: ConnectionStoreOptions): ConnectionStore {
  const { versionUrl } = opts;
  const reconnectBannerThreshold = opts.reconnectBannerThreshold ?? DEFAULT_RECONNECT_BANNER_THRESHOLD;
  const reconnectBackoffMaxMs = opts.reconnectBackoffMaxMs ?? DEFAULT_RECONNECT_BACKOFF_MAX_MS;
  const reconnectedDismissMs = opts.reconnectedDismissMs ?? DEFAULT_RECONNECTED_DISMISS_MS;

  // ─── Per-instance closure state (was module-level in liveview's store) ─────
  let banner: Banner | undefined = undefined;
  const listeners = new Set<() => void>();
  // Consecutive failed (re)connect cycles; reset to 0 on a successful open.
  let attempts = 0;
  // Whether the current outage actually surfaced the red banner — so the reopen
  // only flashes green for outages the user was told about, not a sub-threshold
  // blip.
  let outageSurfaced = false;
  let reconnectedTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  // The build id this tab loaded against; re-probed after each reconnect and on
  // foreground. A change means the server was redeployed under a now-stale tab.
  let knownVersion: string | undefined = undefined;

  function emit(): void {
    for (const l of listeners) {
      l();
    }
  }

  function setBanner(next: Banner | undefined): void {
    banner = next;
    emit();
  }

  async function probeVersion(): Promise<void> {
    let probed: string | undefined = undefined;
    try {
      const res = await globalThis.fetch(versionUrl, { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      ({ version: probed } = (await res.json()) as { version: string });
    } catch {
      return; // network hiccup mid-probe; try again on the next trigger
    }
    if (knownVersion === undefined) {
      knownVersion = probed;
      return;
    }
    if (probed !== knownVersion) {
      setBanner({ kind: "update" });
    }
  }

  // Called by the app on a successful (re)open. Clears the failure count,
  // flashes green if a red banner was up, then probes for a new build first thing.
  function connectionReady(): void {
    const recovered = outageSurfaced;
    attempts = 0;
    outageSurfaced = false;
    // Recovered from a surfaced outage → flash green, but never stomp a sticky
    // blue update banner (it outranks everything). The async probe may replace
    // the green with blue moments later.
    if (recovered && banner?.kind !== "update") {
      setBanner({ kind: "reconnected" });
      if (reconnectedTimer) {
        clearTimeout(reconnectedTimer);
      }
      reconnectedTimer = setTimeout(() => {
        reconnectedTimer = undefined;
        // Only clear if still green — don't stomp an update banner the probe
        // raised in the meantime.
        if (banner?.kind === "reconnected") {
          setBanner(undefined);
        }
      }, reconnectedDismissMs);
    }
    void probeVersion();
  }

  // Called by the app on close. Raises the red banner once retries have failed
  // past the threshold (never stomping a sticky update banner) and returns the
  // backoff delay the app should wait before the next attempt.
  function connectionLost(): number {
    attempts += 1;
    if (attempts >= reconnectBannerThreshold && banner?.kind !== "update") {
      outageSurfaced = true;
      setBanner({ kind: "down" });
    }
    // Probe the build on EVERY drop, not just on a successful reconnect. A deploy
    // restarts the server, which is often WHY we just disconnected — and if the WS
    // reconnect then wedges, connectionReady (the only other probe trigger besides
    // tab-foreground) never fires, so the new build would otherwise stay invisible
    // and the tab sits on "reconnecting…" forever. Probing here means: once the
    // server is back as a new build, the next drop detects it → update banner →
    // auto-reload onto the fresh bundle. The fetch just fails (no-op) while the
    // server is still down mid-restart.
    void probeVersion();
    return Math.min(reconnectBackoffMaxMs, 1000 * 2 ** Math.max(0, attempts - 1));
  }

  function updateAvailable(): void {
    setBanner({ kind: "update" });
  }

  // Probe for a new build whenever the tab returns to the foreground. An installed
  // iOS PWA resumes its frozen page instead of re-navigating, so a deploy is
  // otherwise invisible until a manual reload (and the WS may never have dropped).
  // Unlike a silent auto-refresh this only raises the (non-intrusive) update
  // banner, so it never yanks the page out from under someone mid-read/mid-listen.
  // Returns a cleanup fn for the effect.
  function watchForegroundVersion(): () => void {
    const onVisible = (): void => {
      if (globalThis.document.visibilityState === "visible") {
        void probeVersion();
      }
    };
    globalThis.document.addEventListener("visibilitychange", onVisible);
    return () => globalThis.document.removeEventListener("visibilitychange", onVisible);
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function useConnectionBanner(): Banner | undefined {
    return useSyncExternalStore(
      subscribe,
      () => banner,
      () => banner,
    );
  }

  function version(): string | undefined {
    return knownVersion;
  }

  // Capture knownVersion NOW, at store creation = page load. The bundle we're
  // running was just served by the current server, so /version at this instant
  // matches it. Capturing here (instead of waiting for the first WS connect, which
  // can land AFTER a redeploy — the tab then records the NEW build id while running
  // the OLD bundle and never detects a change → "reconnected but didn't reload")
  // closes that race: any later /version change is a genuine redeploy → reload.
  void probeVersion();

  return {
    connectionReady,
    connectionLost,
    updateAvailable,
    applyUpdate,
    watchForegroundVersion,
    useConnectionBanner,
    version,
  };
}

// Seconds the update bar counts down before reloading on its own.
const DEFAULT_UPDATE_COUNTDOWN_SECS = 3;

// MUI palette per banner kind: an outage is a calm WARNING (yellow), not an
// alarm — the app stays fully usable offline and retries are unbounded, so red
// would overstate it. Green recovery flash; blue (info) update.
function bannerPalette(kind: BannerKind): "warning" | "success" | "info" {
  if (kind === "down") {
    return "warning";
  }
  if (kind === "reconnected") {
    return "success";
  }
  return "info";
}

// Liveview's exact English labels. The update line shows its live 3→0 countdown.
function bannerLabel(kind: BannerKind, secs: number): string {
  if (kind === "down") {
    return "Connection lost — reconnecting…";
  }
  if (kind === "reconnected") {
    return "Reconnected";
  }
  return `New version · reloading in ${Math.max(0, secs)}s`;
}

export interface ConnectionBannerProps {
  readonly store: ConnectionStore;
  /** Seconds the update bar counts down before reloading. Default 3. */
  readonly countdownSecs?: number;
}

// Full-width overlay bar tracking the app's socket + build version. All three
// states are the SAME bar — `position: fixed` keeps it on top of everything and
// out of the layout flow, so it never pushes content down or disturbs whatever
// the user is doing (`pointer-events: none` also lets taps fall through to the
// chrome it floats over):
//   - red "down"          — a sustained reconnect failure (spinner);
//   - green "reconnected"  — recovery, auto-dismissed (check);
//   - blue "update"        — a redeploy was detected; counts 3→0 and then clears
//                            caches + hard-reloads into the new build on its own.
export function ConnectionBanner(props: ConnectionBannerProps): ReactNode {
  const { store, countdownSecs = DEFAULT_UPDATE_COUNTDOWN_SECS } = props;
  const banner = store.useConnectionBanner();
  const isUpdate = banner?.kind === "update";
  const [secs, setSecs] = useState(countdownSecs);

  // Drive the update countdown (and only it). Resets whenever we're not on the
  // update state so a later redeploy starts a fresh 3→0.
  useEffect(() => {
    if (!isUpdate) {
      setSecs(countdownSecs);
      return;
    }
    // 3 means three real seconds: show 3, 2, 1, then apply as the counter reaches
    // zero. Waiting for -1 made the nominal three-second countdown last four.
    if (secs <= 0) {
      void store.applyUpdate();
      return;
    }
    const t = setTimeout(() => setSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [isUpdate, secs, countdownSecs, store]);

  if (!banner) {
    return null;
  }

  const palette = bannerPalette(banner.kind);
  const label = bannerLabel(banner.kind, secs);

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        px: 2,
        py: 0.75,
        // Owns the notch when shown (it's the topmost element).
        pt: "calc(env(safe-area-inset-top, 0px) + 6px)",
        bgcolor: `${palette}.main`,
        color: `${palette}.contrastText`,
        fontSize: "0.8125rem",
        fontWeight: 500,
        // Purely informational — never eat taps meant for the UI underneath.
        pointerEvents: "none",
        zIndex: (t) => t.zIndex.tooltip + 1,
      }}
    >
      {banner.kind === "down" && <CircularProgress size={14} color="inherit" thickness={5} />}
      {banner.kind === "reconnected" && <CheckIcon sx={{ fontSize: "1.125rem" }} />}
      <span>{label}</span>
    </Box>
  );
}
