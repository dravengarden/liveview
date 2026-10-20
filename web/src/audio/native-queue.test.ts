import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeEventMatches, nativeNowPlaying, nativeSessionQueue, nativeTrack, queuedNativeTrack } from "./native-queue.ts";
import type { NowPlaying } from "./player.tsx";
import type { ChapterVoices, VoiceChoice } from "./speech.ts";
import type { NativePlaybackSnapshot } from "../native-audio.ts";

const base: NowPlaying = {
  bookSlug: "book", bookLabel: "Book", chapterPath: "book/1.md", chapterLabel: "One",
  rendition: "text", lang: "en", cover: true, voice: "heart", marksHash: "old",
};
const voice = (id: string): VoiceChoice => ({
  id, label: id, status: "ready", audio_hash: `${id}-audio`, marks_hash: `${id}-marks`, bytes: 123,
});
const chapter: ChapterVoices = {
  id: "text/en/2.md", default_voice: "heart", voices: [voice("heart"), voice("bella")],
};
const track = { path: "book/2.md", label: "Two" };
const make = (value: ChapterVoices, preference = "bella") =>
  queuedNativeTrack(base, track, new Map([[value.id, value]]), preference, 1.5, "https://example.test", true);

test("native queue resolves each chapter's voice, hash, timing identity, and integrity bytes together", () => {
  const queued = make(chapter)!;
  assert.equal(queued.url, "https://example.test/api/blob/bella-audio");
  assert.equal(queued.hash, "bella-audio");
  assert.equal(queued.bytes, 123);
  assert.equal(queued.position, 0);
  assert.equal(queued.rate, 1.5);
  assert.deepEqual(nativeNowPlaying(queued.context), {
    ...base, chapterPath: track.path, chapterLabel: track.label, voice: "bella", marksHash: "bella-marks",
  });
});

test("explicit chapter policy wins; unready selected voices leave a hole without skipping chapters", () => {
  assert.equal(make({
    ...chapter, effective: { sources: { default_voice: "book.chapter" } },
  })?.hash, "heart-audio");
  assert.equal(make({ ...chapter, voices: [voice("heart"), { ...voice("bella"), status: "running" }] }), null);
  assert.equal(make({ ...chapter, id: "audio/en/2.md" }), null, "renditions never share a track accidentally");
});

test("resume hints are resolved for the selected voice and timing identity", () => {
  const queued = queuedNativeTrack(base, track, new Map([[chapter.id, chapter]]), "bella", 1, "https://example.test", false,
    np => np.voice === "bella" && np.marksHash === "bella-marks" ? 27 : 0);
  assert.equal(queued?.position, 27);
});

test("last chapter uses the same cached payload; metadata is opaque JSON", () => {
  const np = { ...base, chapterLabel: `Quote ' and \\ and </script>` };
  const loaded = nativeTrack(np, { audioHash: "cached", audioBytes: 42 }, 19, 2, "https://example.test", true);
  assert.equal(loaded.url, "https://example.test/api/blob/cached");
  assert.deepEqual(nativeNowPlaying(loaded.context), np);
  assert.equal(nativeNowPlaying('{"chapterPath":"wrong"}'), null);
  assert.equal(nativeNowPlaying("bad JSON"), null);
});

test("native event ownership prevents stale clocks and duplicate advancement", () => {
  assert.equal(nativeEventMatches({}, null, 0), true, "old shells remain compatible");
  assert.equal(nativeEventMatches({ queueId: "old", index: 1 }, "new", 1), false);
  assert.equal(nativeEventMatches({ queueId: "new", index: 1 }, "new", 2), false);
  assert.equal(nativeEventMatches({ queueId: "new", index: 2 }, "new", 2), true);
});

test("page reload uses the native current chapter with this device's matching spine", () => {
  const q = [{ path: base.chapterPath, label: base.chapterLabel }, track];
  const snapshot = { context: JSON.stringify({ ...base, chapterPath: track.path }), index: 1 } as NativePlaybackSnapshot;
  assert.deepEqual(nativeSessionQueue(snapshot, { nowPlaying: base, queue: q }), q);
  assert.deepEqual(nativeSessionQueue(snapshot, { nowPlaying: { ...base, lang: "zh" }, queue: q }), []);
  assert.deepEqual(nativeSessionQueue({ ...snapshot, index: 3 }, { nowPlaying: base, queue: q }), []);
});
