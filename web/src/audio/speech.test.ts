import assert from "node:assert/strict";
import { test } from "node:test";
import { speechCatalog } from "./speech";
import type { NowPlaying } from "./player";
import { sentencePosition, voicePreferenceKey } from "./voice-model";
import { parseMediaResource } from "@/audioMediaIndex";

test("voice switching follows a sentence rather than elapsed seconds", () => {
  const slower = [{ idx: 0, start_ms: 0, end_ms: 4000 }, { idx: 1, start_ms: 4000, end_ms: 9000 }];
  assert.equal(sentencePosition(slower, 1), 4);
  assert.equal(sentencePosition(slower, -1), 0);
  assert.equal(sentencePosition(slower, 100), 4);
});

test("voice preferences distinguish rendition and language", () => {
  const base = { bookSlug: "english", bookLabel: "English", cover: false, chapterPath: "english/22.md", chapterLabel: "Practice", lang: "en", rendition: "text" };
  assert.notEqual(voicePreferenceKey(base), voicePreferenceKey({ ...base, rendition: "audio" }));
  assert.notEqual(voicePreferenceKey(base), voicePreferenceKey({ ...base, lang: "zh" }));
  assert.equal(voicePreferenceKey(base), voicePreferenceKey({ ...base, chapterPath: "english/23.md" }));
});

test("variant DAG entries cannot overwrite default chapter audio", () => {
  const resource = { kind: "audio", hash: "bella", path: "english/text/en/22.md#audio@profile" };
  assert.equal(parseMediaResource(resource), undefined);
  assert.equal(parseMediaResource({ ...resource, path: "english/text/en/22.md#audio" })?.hash, "bella");
});

test("fresh speech settings bypass the immutable offline DAG snapshot", async () => {
  const previous = globalThis.fetch;
  const expected = { chapters: [], policies: {}, installed_voices: [], bitrates_kbps: [96, 128] };
  let calls = 0;
  globalThis.fetch = async (input, options) => {
    calls += 1;
    assert.ok(String(input).endsWith("/api/speech/example"));
    assert.equal(options?.cache, "no-store");
    return Response.json(expected);
  };
  try {
    // No IndexedDB is available here. A replica read would return an offline
    // miss instead of the newly saved settings / newly ready voice.
    const result = await speechCatalog({ bookSlug: "example" } as NowPlaying, true);
    assert.deepEqual(result, expected);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
  }
});
