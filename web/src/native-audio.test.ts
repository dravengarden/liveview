import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeAudioProbeState, nativeAudioQueueTracks, nativeAudioQueueGo, nativeAudioSleep, type NativePlaybackSnapshot } from "./native-audio.ts";

test("queue commands require the additive snapshot capability; legacy state probes stay compatible", async () => {
  const names = ["webkit", "addEventListener", "removeEventListener"] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const bus = new EventTarget();
  const sent: unknown[] = [];
  let modern = false;
  const snapshot: NativePlaybackSnapshot = {
    type: "snapshot", queueVersion: 1, queueId: "current", index: 3, count: 9,
    context: "{}", position: 123, duration: 300, rate: 1.5, playing: true,
    waiting: false, sleepRemaining: 40, needsAdvance: false, ended: false, error: null, completed: [],
  };
  Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: bus.addEventListener.bind(bus) });
  Object.defineProperty(globalThis, "removeEventListener", { configurable: true, value: bus.removeEventListener.bind(bus) });
  Object.defineProperty(globalThis, "webkit", { configurable: true, value: { messageHandlers: { lvNativeAudio: {
    postMessage(message: { kind: string }): void {
      sent.push(message);
      if (message.kind !== "state") return;
      if (modern) bus.dispatchEvent(new CustomEvent("lv-native-audio", {
        detail: { type: "time", queueId: "current", index: 3, position: 124, duration: 300 },
      }));
      bus.dispatchEvent(new CustomEvent("lv-native-audio", { detail: modern ? snapshot : { type: "time", position: 0, duration: 0 } }));
    },
  } } } });
  try {
    assert.equal(nativeAudioQueueTracks("x", 0, []), false);
    assert.equal(nativeAudioQueueGo("x", 1), false);
    assert.equal(nativeAudioSleep(30), false);
    assert.equal(await nativeAudioProbeState(), null);
    assert.deepEqual(sent, [{ kind: "state" }]);
    modern = true;
    assert.deepEqual(await nativeAudioProbeState(), snapshot);
    assert.equal(nativeAudioQueueTracks("current", 4, [null]), true);
    assert.equal(nativeAudioQueueTracks("current", 4, Array.from({ length: 17 }, () => null)), false);
    assert.equal(nativeAudioQueueGo("current", 4), true);
    assert.equal(nativeAudioSleep(30), true);
    assert.deepEqual(sent.slice(2), [
      { kind: "queueTracks", data: { queueId: "current", start: 4, tracks: [null] } },
      { kind: "queueGo", data: { queueId: "current", index: 4 } },
      { kind: "sleep", data: { seconds: 30 } },
    ]);
  } finally {
    names.forEach((name, i) => {
      const descriptor = previous[i];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
