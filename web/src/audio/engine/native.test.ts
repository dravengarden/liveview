import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeAudioEvent, NativePlaybackSnapshot } from "../../native-audio.ts";
import { type NativeEngineHost, routeNativeEvent } from "./native.ts";

function fakeHost(over: Partial<NativeEngineHost> = {}): { host: NativeEngineHost; calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => (...args: unknown[]): void => {
    calls.push(args.length ? `${name}(${args.map((a) => JSON.stringify(a)).join(",")})` : name);
  };
  const host: NativeEngineHost = {
    sourcePending: false,
    queueId: "q",
    queueIndex: 2,
    playing: false,
    buffering: false,
    queueAuthoritative: true,
    adoptSnapshot: (s) => calls.push(`adopt(${s.index})`),
    goTo: record("goTo"),
    clearEnded: record("clearEnded"),
    observeSleep: record("observeSleep"),
    position: record("position"),
    duration: record("duration"),
    startSleepSession: record("startSleepSession"),
    resetPlaybackProof: record("resetPlaybackProof"),
    expectPlayback: record("expectPlayback"),
    transport: (patch) => calls.push(`transport(${JSON.stringify(patch)})`),
    paused: record("paused"),
    ended: record("ended"),
    stalled: record("stalled"),
    next: record("next"),
    prev: record("prev"),
    error: record("error"),
    ...over,
  };
  return { host, calls };
}

const snapshot = (over: Partial<NativePlaybackSnapshot> = {}): NativePlaybackSnapshot => ({
  type: "snapshot", queueVersion: 1, queueId: "q", index: 4, count: 9, context: "{}", position: 1, duration: 9,
  rate: 1, playing: true, waiting: false, sleepRemaining: 0, needsAdvance: false, ended: false, error: null,
  completed: [], ...over,
});

const route = (ev: NativeAudioEvent, over: Partial<NativeEngineHost> = {}): string[] => {
  const { host, calls } = fakeHost(over);
  routeNativeEvent(ev, host);
  return calls;
};

test("a snapshot is adopted only for the staged queue and outside an explicit load", () => {
  assert.deepEqual(route(snapshot()), ["adopt(4)"]);
  assert.deepEqual(route(snapshot({ needsAdvance: true })), ["adopt(4)", "goTo(5)"]);
  assert.deepEqual(route(snapshot({ queueId: "other" })), []);
  assert.deepEqual(route(snapshot(), { queueId: null }), []);
  assert.deepEqual(route(snapshot(), { sourcePending: true }), []);
});

test("events for another queue or track are dropped; untagged legacy events pass", () => {
  assert.deepEqual(route({ type: "paused", queueId: "old" }), []);
  assert.deepEqual(route({ type: "paused", queueId: "q", index: 1 }), []);
  assert.deepEqual(route({ type: "next", queueId: "q", index: 2 }), ["next"]);
  assert.deepEqual(route({ type: "prev" }), ["prev"]);
});

test("a queue-capable playing event is authoritative; a protocol-v1 one waits for media time", () => {
  assert.deepEqual(route({ type: "playing" }), [
    "startSleepSession",
    "clearEnded",
    "resetPlaybackProof",
    'transport({"playing":true,"buffering":false,"loading":false})',
  ]);
  assert.deepEqual(route({ type: "playing" }, { queueAuthoritative: false }), ["startSleepSession", "expectPlayback"]);
  assert.deepEqual(route({ type: "playing" }, { queueAuthoritative: false, playing: true }), ["startSleepSession"]);
});

test("a stall records its proof before showing the cancellable spinner", () => {
  assert.deepEqual(route({ type: "waiting" }), [
    "stalled",
    'transport({"playing":false,"buffering":true,"loading":true})',
  ]);
  // A stall is only ended by playback or a stop, not by `canplay`.
  assert.deepEqual(route({ type: "canplay" }, { buffering: true }), ["transport(null)"]);
});

test("the replaced item's pause and end are ignored during an explicit load", () => {
  assert.deepEqual(route({ type: "paused" }, { sourcePending: true }), []);
  assert.deepEqual(route({ type: "ended" }, { sourcePending: true }), []);
  assert.deepEqual(route({ type: "paused" }), [
    "resetPlaybackProof",
    'transport({"playing":false,"buffering":false,"loading":false})',
    "paused",
  ]);
  assert.deepEqual(route({ type: "ended" }), [
    "resetPlaybackProof",
    'transport({"buffering":false,"loading":false})',
    "ended",
  ]);
});

test("time re-arms the end, carries the sleep timer only from queue-capable shells", () => {
  assert.deepEqual(route({ type: "time", position: 3, duration: 9, sleepRemaining: 60 }), [
    "clearEnded",
    "observeSleep(60)",
    "position(3,9)",
  ]);
  assert.deepEqual(
    route({ type: "time", position: 9, duration: 9, sleepRemaining: 60 }, { queueAuthoritative: false }),
    ["position(9,9)"],
  );
});

test("an error stops the transport and connectivity events are not playback's", () => {
  assert.deepEqual(route({ type: "error", message: "offline" }), [
    'error("offline")',
    "resetPlaybackProof",
    'transport({"playing":false,"buffering":false,"loading":false})',
  ]);
  assert.deepEqual(route({ type: "network", net: "none" }), []);
});
