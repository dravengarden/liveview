import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLikelyOffline,
  nativeNetworkClass,
  nativeReportsOffline,
  onConnectivityChange,
  readingOffline,
  startConnectivity,
} from "./connectivity.ts";
import { replicaIsOffline } from "./replica/mod.ts";
import { noteServerReachable, noteServerUnreachable, resetServerReachability } from "./serverReachability.ts";

test("the shell's NWPathMonitor events drive every offline reader in one step", () => {
  const names = ["__TAURI_INTERNALS__", "webkit", "addEventListener", "removeEventListener"] as const;
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const bus = new EventTarget();
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  define("__TAURI_INTERNALS__", {});
  define("webkit", { messageHandlers: { lvNativeAudio: { postMessage(): void {} } } });
  define("addEventListener", bus.addEventListener.bind(bus));
  define("removeEventListener", bus.removeEventListener.bind(bus));
  const network = (net: string): void => {
    bus.dispatchEvent(new CustomEvent("lv-native-audio", { detail: { type: "network", net } }));
  };
  resetServerReachability();
  try {
    startConnectivity();
    const seen: boolean[] = [];
    const off = onConnectivityChange(() => seen.push(readingOffline()));
    seen.length = 0; // subscribing replays the current network class

    network("none");
    assert.equal(nativeNetworkClass(), "none");
    assert.equal(isLikelyOffline(), true);
    assert.equal(nativeReportsOffline(), true);
    assert.equal(replicaIsOffline(), true);
    // Listeners observe the new state, never the one before the event.
    assert.deepEqual(seen, [true]);

    network("wifi");
    assert.equal(isLikelyOffline(), false);
    assert.equal(replicaIsOffline(), false);
    assert.deepEqual(seen, [true, false]);

    // Online but the server does not answer: reading is offline, the replica
    // still probes the network.
    noteServerUnreachable();
    assert.equal(readingOffline(), true);
    assert.equal(replicaIsOffline(), false);
    noteServerReachable();
    assert.equal(readingOffline(), false);
    off();
  } finally {
    resetServerReachability();
    names.forEach((name, i) => {
      const descriptor = previous[i];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    });
  }
});
