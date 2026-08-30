import assert from "node:assert/strict";
import { test } from "node:test";
import { nativePositionConfirmsPlayback } from "./native-playback-truth.ts";

test("native playback requires advancing media time", () => {
  const previous = { position: 42, at: 1_000 };

  assert.equal(nativePositionConfirmsPlayback(previous, 42, 1_250), false);
  assert.equal(nativePositionConfirmsPlayback(previous, 42.5, 1_250), true);
  assert.equal(nativePositionConfirmsPlayback(previous, 41.9, 1_250), false);
});

test("a resume seek is a baseline, not playback proof", () => {
  assert.equal(
    nativePositionConfirmsPlayback({ position: 0, at: 1_000 }, 582, 1_250),
    false,
  );
});
