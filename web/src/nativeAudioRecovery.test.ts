import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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
    /private func play\(\) \{[\s\S]*?\n  \}\n\n  private func pause/,
  )?.[0];
  assert.ok(play, "native play function exists");
  assert.doesNotMatch(play, /emit\("\{type:'playing'\}"\)/);

  const waiting = player.match(/case "waiting":[\s\S]*?\n\s*break;/)?.[0];
  assert.ok(waiting, "native waiting event handler exists");
  assert.match(waiting, /setBuffering\(true\)/);
  assert.match(waiting, /setLoading\(true\)/);
  assert.match(waiting, /setPlaying\(false\)/);
  assert.match(
    player,
    /const active = playingRef\.current \|\| bufferingRef\.current/,
  );
  assert.match(bar, /disabled=\{loading && !buffering\}/);
});
