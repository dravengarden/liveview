import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { nativeTransportPatch } from "./audio/engine/transport.ts";

const ROOT = new URL("./", import.meta.url);

async function source(path: string): Promise<string> {
  return await readFile(new URL(path, ROOT), "utf8");
}

test("native audio rejects partial cache bodies before playback", async () => {
  const swift = await source(
    "../../app/src-tauri/gen/apple/Sources/liveview-app/NativeAudioController.swift",
  );
  const bridge = await source("replica/media-bridge.ts");
  assert.match(swift, /expectedBytes <= 0 \|\| actual == expectedBytes/);
  assert.match(swift, /emitCacheProgress\(key, false\)/);
  assert.match(
    swift,
    /publish\(tmp, key, expectedBytes: expectedBytes\)/,
  );
  assert.match(swift, /replaceItemAt\(dest, withItemAt: part\)/);
  assert.match(bridge, /if \(!ok\) posted\.delete\(hash\)/);
  assert.match(bridge, /setPresent\(hash, ok \? 1 : 0\)/);
});

test("native waiting is observable, cancellable, and bounded", async () => {
  const swift = await source(
    "../../app/src-tauri/gen/apple/Sources/liveview-app/NativeAudioController.swift",
  );
  const player = await source("audio/player.tsx");
  const bar = await source("components/PlaybackBar.tsx");

  assert.match(swift, /player\.observe\(\\\.timeControlStatus/);
  assert.match(swift, /AVPlayerItemPlaybackStalled/);
  assert.match(swift, /private static let maxRecoveryAttempts = 2/);
  assert.match(swift, /guard recoveryAttempts < Self\.maxRecoveryAttempts/);
  const play = swift.match(
    /private func play\(\) \{[\s\S]*?\n {2}\}\n\n {2}private func pause/,
  )?.[0];
  assert.ok(play, "native play function exists");
  assert.doesNotMatch(play, /emit\("\{type:'playing'\}"\)/);

  // A stall keeps `playing` truthful while the spinner remembers play intent.
  const state = { buffering: false, queueAuthoritative: true };
  assert.deepEqual(nativeTransportPatch("waiting", state), { playing: false, buffering: true, loading: true });
  // Only real playback or a stop ends a stall; `canplay` does not.
  assert.equal(nativeTransportPatch("canplay", { ...state, buffering: true }), null);
  assert.deepEqual(nativeTransportPatch("canplay", state), { loading: false });
  for (const stop of ["paused", "error"] as const) {
    assert.deepEqual(nativeTransportPatch(stop, { ...state, buffering: true }), { playing: false, buffering: false, loading: false });
  }
  assert.deepEqual(nativeTransportPatch("ended", { ...state, buffering: true }), { buffering: false, loading: false });
  assert.match(
    player,
    /const active = playingRef\.current \|\| bufferingRef\.current/,
  );
  assert.match(bar, /disabled=\{loading && !buffering\}/);
});

test("protocol-v1 playing events require advancing media time", async () => {
  const player = await source("audio/player.tsx");

  // Only the advertised native capability makes `playing` authoritative.
  assert.deepEqual(
    nativeTransportPatch("playing", { buffering: true, queueAuthoritative: true }),
    { playing: true, buffering: false, loading: false },
  );
  assert.equal(nativeTransportPatch("playing", { buffering: false, queueAuthoritative: false }), null);
  // The routing itself (protocol-v1 `playing` → expectPlayback) is covered by
  // audio/engine/native.test.ts; the proof that ends the wait lives here.
  assert.match(
    player,
    /nativePositionConfirmsPlayback\([\s\S]*?setPlaying\(true\)/,
  );
  assert.match(player, /nativeAudioPause\(\);[\s\S]*?audio_play_unconfirmed/);
});

test("a waiting snapshot stays provable and startup adoption resyncs", async () => {
  const player = await source("audio/player.tsx");

  const adopt = player.match(/const adoptNativeSnapshot = useCallback[\s\S]*?sourcePendingRef\.current = false;/)?.[0];
  assert.ok(adopt, "snapshot adoption exists");
  assert.match(adopt, /resetNativePlaybackProof\(\);[\s\S]*?if \(snapshot\.waiting\) \{[\s\S]*?nativePlaybackUnconfirmedRef\.current = true;/);
  assert.match(player, /adoptNativeSnapshot\(nativeState\);[\s\S]*?nativeAudioRequestState\(\);/);
});

test("buffering with a known timeline keeps the scrubber in place", async () => {
  const preparation = await source("components/PlaybackPreparation.tsx");
  const bar = await source("components/PlaybackBar.tsx");
  const sheet = await source("components/PlaybackSheet.tsx");

  assert.match(preparation, /\(!loading \|\| timeline\)/);
  assert.match(bar, /<PlaybackPreparation timeline=\{duration > 0\}>/);
  assert.match(sheet, /<PlaybackPreparation active=\{open\} timeline=\{duration > 0\}>/);
  assert.match(bar, /disabled=\{duration === 0\}/);
});
