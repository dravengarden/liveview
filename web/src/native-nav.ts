// Repository-owned native navigation bridge contract.

// Native iOS navigation bridge — drives a native snapshot push/pop transition in
// the iOS Tauri shell, with a graceful no-op fallback everywhere else.
//
// WHY: returning shelf←book froze ~480ms on real iOS devices — WebKit re-composites
// the whole view in a single frame on the swipe-back gesture (mc<<paint: main
// thread idle, the compositor stalls). No web-side change fixed it (opacity /
// visibility / display hide, ripple/focus cleanup, deferred reveal — all tried).
// The fix is the Hotwire-Native technique: the native shell snapshots the current
// WKWebView, slides it with a native (UIKit) animation, and HOLDS the snapshot
// until the web says the destination is painted — so the frozen web frame is never
// seen and the transition is GPU-native-smooth.
//
// This module is the WEB half of that bridge. The native half (iOS only) registers
// a WKScriptMessageHandler named "lvNativeNav" (see ./ios/). On the PWA / Android /
// a plain browser there is no such handler, so every call here is a no-op returning
// false and the caller keeps its existing web navigation — the PWA is completely
// untouched. Android intentionally rides the web path for now.

import { hostNavAvailable, postHostNav } from "./native-host.ts";

type OutMsg =
  | { readonly type: "push"; readonly id: string }
  | { readonly type: "pop" }
  | { readonly type: "ready" };

function send(message: OutMsg): boolean {
  return postHostNav(message);
}

/** True only inside the native iOS shell that carries the nav bridge. */
export function nativeNavAvailable(): boolean {
  return hostNavAvailable();
}

/**
 * Ask the native shell to begin a forward (push) transition: it snapshots the
 * current view and slides the (about-to-change) web view in from the trailing
 * edge. `id` tags the destination so a later pop can match it. Returns false
 * off-shell — the caller should then just do its normal in-app navigation.
 */
export function nativeNavPush(id: string): boolean {
  return send({ type: "push", id });
}

/**
 * Ask the native shell to begin a back (pop) transition: snapshot, then slide back
 * to reveal the previous view. Returns false off-shell.
 */
export function nativeNavPop(): boolean {
  return send({ type: "pop" });
}

/**
 * Tell the native shell the destination has finished rendering, so it can drop the
 * held snapshot and end the transition. Call AFTER the new route's content has
 * painted (e.g. in a double-rAF following the state change). No-op off-shell.
 */
export function nativeNavReady(): void {
  send({ type: "ready" });
}

/**
 * Subscribe to NATIVE-initiated back navigations (the interactive edge-swipe the
 * native shell owns once it takes over the gesture). The shell dispatches a
 * `lv-native-back` event on window when its gesture commits; the web should sync
 * its own route (go back) in response — WITHOUT calling nativeNavPop again (the
 * native transition already ran). Returns an unsubscribe. Safe everywhere: the
 * event simply never fires off the native shell.
 */
export function onNativeBack(handler: () => void): () => void {
  const listener = (): void => handler();
  globalThis.addEventListener("lv-native-back", listener);
  return () => globalThis.removeEventListener("lv-native-back", listener);
}
