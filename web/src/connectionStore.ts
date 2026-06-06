// Shared connection / version banner store. liveview's live-reload WebSocket
// (web/src/hooks/useWebSocket.ts) drives the reconnect side; the version side is
// probed after each reconnect and whenever the tab returns to the foreground.
// Mirrors cowboy's store.ts policy so the two apps behave identically:
//   - red "down"          — reconnect has failed RECONNECT_BANNER_THRESHOLD
//                           times in a row (a blip that recovers on the first
//                           retry stays silent);
//   - green "reconnected" — the socket came back after a surfaced outage;
//                           auto-dismissed after RECONNECTED_DISMISS_MS;
//   - blue "update"       — a redeploy was detected; sticky, click force-reloads.
//
// Only the banner is shared React state (read via useConnectionBanner); the
// WebSocket itself stays in the single useWebSocket hook, which just reports
// open/close here and reads back the backoff delay.

import { useSyncExternalStore } from "react";

export type BannerKind = "down" | "reconnected" | "update";
export interface Banner {
  kind: BannerKind;
}

// Surface the red banner once this many consecutive (re)connect cycles fail.
const RECONNECT_BANNER_THRESHOLD = 2;
// Cap the exponential backoff so a long outage doesn't hammer the server.
const RECONNECT_BACKOFF_MAX_MS = 15_000;
// How long the green "reconnected" flash lingers before auto-dismissing.
const RECONNECTED_DISMISS_MS = 4_000;

let banner: Banner | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setBanner(next: Banner | undefined): void {
  banner = next;
  emit();
}

// Consecutive failed (re)connect cycles; reset to 0 on a successful open.
let attempts = 0;
// Whether the current outage actually surfaced the red banner — so the reopen
// only flashes green for outages the user was told about, not a sub-threshold
// blip.
let outageSurfaced = false;
let reconnectedTimer: ReturnType<typeof setTimeout> | undefined;

// The build id this tab loaded against; re-probed after each reconnect and on
// foreground. A change means the server was redeployed under a now-stale tab.
let knownVersion: string | undefined;

async function probeVersion(): Promise<void> {
  let version: string;
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return;
    ({ version } = (await res.json()) as { version: string });
  } catch {
    return; // network hiccup mid-probe; try again on the next trigger
  }
  if (knownVersion === undefined) {
    knownVersion = version;
    return;
  }
  if (version !== knownVersion) setBanner({ kind: "update" });
}

// Called by the WS hook on a successful (re)open. Clears the failure count,
// flashes green if a red banner was up, then probes for a new build first thing.
export function connectionReady(): void {
  const recovered = outageSurfaced;
  attempts = 0;
  outageSurfaced = false;
  // Recovered from a surfaced outage → flash green, but never stomp a sticky
  // blue update banner (it outranks everything). The async probe may replace
  // the green with blue moments later.
  if (recovered && banner?.kind !== "update") {
    setBanner({ kind: "reconnected" });
    if (reconnectedTimer) clearTimeout(reconnectedTimer);
    reconnectedTimer = setTimeout(() => {
      reconnectedTimer = undefined;
      // Only clear if still green — don't stomp an update banner the probe
      // raised in the meantime.
      if (banner?.kind === "reconnected") setBanner(undefined);
    }, RECONNECTED_DISMISS_MS);
  }
  void probeVersion();
}

// Called by the WS hook on close. Raises the red banner once retries have failed
// past the threshold (never stomping a sticky update banner) and returns the
// backoff delay the hook should wait before the next attempt.
export function connectionLost(): number {
  attempts += 1;
  if (attempts >= RECONNECT_BANNER_THRESHOLD && banner?.kind !== "update") {
    outageSurfaced = true;
    setBanner({ kind: "down" });
  }
  return Math.min(RECONNECT_BACKOFF_MAX_MS, 1000 * 2 ** Math.max(0, attempts - 1));
}

// The blue banner's confirm action: clear every cache (so a service worker can't
// re-serve the old bundle) then hard-reload into the new build. Ported from the
// old useAutoUpdate hardRefresh.
export async function applyUpdate(): Promise<void> {
  try {
    if ("caches" in globalThis) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // non-fatal — the reload still pulls fresh content-hashed assets.
  }
  globalThis.location.reload();
}

// Probe for a new build whenever the tab returns to the foreground. An installed
// iOS PWA resumes its frozen page instead of re-navigating, so a deploy is
// otherwise invisible until a manual reload (and the WS may never have dropped).
// Unlike the old auto-refresh this only raises the (non-intrusive) update banner,
// so it never yanks the page out from under someone mid-read/mid-listen. Returns
// a cleanup fn for the effect.
export function watchForegroundVersion(): () => void {
  const onVisible = (): void => {
    if (document.visibilityState === "visible") void probeVersion();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useConnectionBanner(): Banner | undefined {
  return useSyncExternalStore(
    subscribe,
    () => banner,
    () => banner,
  );
}
