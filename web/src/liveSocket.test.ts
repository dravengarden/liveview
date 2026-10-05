import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTED_POLL_INTERVAL_MS,
  dispatchLibraryUpdate,
  isLiveSocketConnected,
  onLibraryUpdate,
  onLiveSocketReconnect,
  pollTickDue,
  setLiveSocketConnected,
} from "./liveSocket.ts";

test("polls run every tick while disconnected and slowly while connected", () => {
  assert.equal(pollTickDue(false, 1_000, 1_001), true);
  assert.equal(pollTickDue(true, 1_000, 1_001), false);
  assert.equal(
    pollTickDue(true, 1_000, 1_000 + CONNECTED_POLL_INTERVAL_MS),
    true,
  );
});

test("only a reconnect, not the first connect, asks listeners to catch up", () => {
  let reconnects = 0;
  const off = onLiveSocketReconnect(() => reconnects++);
  setLiveSocketConnected(true);
  assert.equal(isLiveSocketConnected(), true);
  setLiveSocketConnected(true);
  assert.equal(reconnects, 0);
  setLiveSocketConnected(false);
  assert.equal(isLiveSocketConnected(), false);
  setLiveSocketConnected(true);
  assert.equal(reconnects, 1);
  off();
  setLiveSocketConnected(false);
  setLiveSocketConnected(true);
  assert.equal(reconnects, 1);
});

test("library pushes reach subscribers until they unsubscribe", () => {
  const seen: number[] = [];
  const off = onLibraryUpdate((revision) => seen.push(revision));
  dispatchLibraryUpdate(3);
  off();
  dispatchLibraryUpdate(4);
  assert.deepEqual(seen, [3]);
});
