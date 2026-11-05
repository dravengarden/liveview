// Connectivity: the one place the UI and the replica learn whether the device
// has a network and whether the LiveView server answers.
//
// Two device signals, because `navigator.onLine` is unreliable in WKWebView (it
// often stays `true` in airplane mode):
//   - navigator.onLine + online/offline events: instant WHEN they fire;
//   - native NWPathMonitor `network` events: the reliable airplane-mode signal.
// Off the shell the browser's own signals are reliable and used directly.
// Server reachability (serverReachability.ts) is separate evidence: a device
// can be online on a network that does not lead to the server.

import { nativeAudioRequestState, onNativeAudioEvent } from "./native-audio.ts";
import { nativeSyncAvailable } from "./platform/shell.ts";
import { pwaNetworkAvailable } from "./pwa.ts";
import { setReplicaOfflineProbe } from "./replica/mod.ts";
import { onServerReachability, serverReachability } from "./serverReachability.ts";

export type NativeNetworkClass = "wifi" | "cell" | "none" | "unknown";

/** Last-known shell offline state from online/offline events and NWPathMonitor. */
let knownOffline = false;
let knownNetworkClass: NativeNetworkClass = "unknown";
const networkListeners = new Set<(net: NativeNetworkClass) => void>();

export function nativeNetworkClass(): NativeNetworkClass {
  if (!nativeSyncAvailable() && typeof navigator !== "undefined") {
    if (!pwaNetworkAvailable()) return "none";
    const type = (navigator as Navigator & { connection?: { type?: string } }).connection?.type;
    if (type === "wifi" || type === "ethernet") return "wifi";
    if (type === "cellular") return "cell";
    return "unknown";
  }
  return knownNetworkClass;
}

export function onNativeNetworkClass(
  listener: (net: NativeNetworkClass) => void,
): () => void {
  networkListeners.add(listener);
  listener(knownNetworkClass);
  return () => {
    networkListeners.delete(listener);
  };
}

/** Whether the device is (reliably) offline. On the shell this is the
 *  NWPathMonitor-derived flag; off-shell it is the browser's network state. */
export function isLikelyOffline(): boolean {
  if (nativeSyncAvailable()) return knownOffline;
  return !pwaNetworkAvailable();
}

/** Whether the shell reports no network. Browser online hints can be false
 *  while this origin is reachable, so only native reachability is
 *  authoritative enough to suppress replica network reads. */
export function nativeReportsOffline(): boolean {
  return nativeSyncAvailable() && (knownOffline || knownNetworkClass === "none");
}

/** Whether reads cannot reach the server: no network (airplane mode), or a
 *  network that does not lead to it (in-flight Wi-Fi before purchase, captive
 *  portals, an outage). Either way only downloaded content can open. */
export function readingOffline(): boolean {
  return isLikelyOffline() || serverReachability() === "unreachable";
}

/** Run `listener` whenever any connectivity signal may have changed. */
export function onConnectivityChange(listener: () => void): () => void {
  globalThis.addEventListener("online", listener);
  globalThis.addEventListener("offline", listener);
  const offNetwork = onNativeNetworkClass(listener);
  const offServer = onServerReachability(listener);
  return () => {
    globalThis.removeEventListener("online", listener);
    globalThis.removeEventListener("offline", listener);
    offNetwork();
    offServer();
  };
}

/** Wire the device signals and the replica's offline probe. Call once at boot. */
export function startConnectivity(): void {
  setReplicaOfflineProbe(nativeReportsOffline);
  if (!nativeSyncAvailable()) return;
  const applyNetwork = (net: NativeNetworkClass): void => {
    if (knownNetworkClass === net) return;
    knownNetworkClass = net;
    // Update the derived flag first: listeners read `isLikelyOffline()`.
    knownOffline = net === "none";
    for (const listener of networkListeners) listener(net);
  };
  knownOffline = !navigator.onLine;
  globalThis.addEventListener("online", () => {
    knownOffline = false;
  });
  globalThis.addEventListener("offline", () => {
    knownOffline = true;
  });
  // Native re-emits `network` on `state` so a listener installed after the
  // first NWPathMonitor fire still gets a snapshot.
  nativeAudioRequestState();
  onNativeAudioEvent((event) => {
    if (event.type === "network") applyNetwork(event.net);
  });
}
