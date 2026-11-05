import assert from "node:assert/strict";
import { test } from "node:test";
import { attachWebAudio, type WebAudioElement, type WebEngineHost } from "./web.ts";

class FakeAudio extends EventTarget {
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  playbackRate = 1;
  error: MediaError | null = null;
  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

function setup(over: Partial<WebEngineHost> = {}) {
  const calls: string[] = [];
  const host: WebEngineHost = {
    sourcePending: false,
    rate: 1.5,
    position: (p, d) => calls.push(`position(${p},${d})`),
    duration: (d) => calls.push(`duration(${d})`),
    startSleepSession: () => calls.push("startSleepSession"),
    setPlaying: (playing) => calls.push(`setPlaying(${playing})`),
    paused: (position) => calls.push(`paused(${position})`),
    ended: () => calls.push("ended"),
    failed: (message) => calls.push(`failed(${message})`),
    ...over,
  };
  const audio = new FakeAudio();
  const detach = attachWebAudio(audio as unknown as WebAudioElement, host);
  return { audio, calls, detach };
}

test("metadata applies the current rate and play starts the sleep session", () => {
  const { audio, calls } = setup();
  audio.duration = 90;
  audio.fire("loadedmetadata");
  assert.equal(audio.playbackRate, 1.5);
  audio.fire("play");
  audio.currentTime = 4;
  audio.fire("timeupdate");
  assert.deepEqual(calls, ["duration(90)", "startSleepSession", "setPlaying(true)", "position(4,90)"]);
});

test("a pause persists its position unless the source is being replaced", () => {
  const live = setup();
  live.audio.currentTime = 12;
  live.audio.fire("pause");
  assert.deepEqual(live.calls, ["setPlaying(false)", "paused(12)"]);

  const pending = setup({ sourcePending: true });
  pending.audio.currentTime = 12;
  pending.audio.fire("pause");
  assert.deepEqual(pending.calls, ["setPlaying(false)", "paused(null)"]);

  const unstarted = setup();
  unstarted.audio.fire("pause");
  assert.deepEqual(unstarted.calls, ["setPlaying(false)", "paused(null)"]);
});

test("a source change re-derives playing from the element, without a pause event", () => {
  const { audio, calls } = setup();
  audio.paused = false;
  audio.fire("playing");
  audio.paused = true;
  audio.fire("emptied");
  audio.fire("loadstart");
  assert.deepEqual(calls, ["setPlaying(true)", "setPlaying(false)", "setPlaying(false)"]);
});

test("media errors surface only for the current source", () => {
  const { audio, calls } = setup();
  audio.fire("error"); // no error object: ignored
  audio.error = { code: 4, message: "" } as MediaError;
  audio.fire("error");
  assert.deepEqual(calls, ["failed(media error 4)"]);
  const pending = setup({ sourcePending: true });
  pending.audio.error = { code: 2, message: "network" } as MediaError;
  pending.audio.fire("error");
  assert.deepEqual(pending.calls, []);
});

test("detaching removes every listener", () => {
  const { audio, calls, detach } = setup();
  detach();
  for (const type of ["play", "pause", "ended", "timeupdate", "playing", "error"]) audio.fire(type);
  assert.deepEqual(calls, []);
});
