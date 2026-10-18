import assert from "node:assert/strict";
import { test } from "node:test";
import { markDuration } from "./contents";
import { selectPreferredVoice, type ChapterVoices } from "./speech";

test("contents follows article defaults and never borrows another voice's ready state", () => {
  const chapter: ChapterVoices = {
    id: "text/en/one.md", default_voice: "heart",
    voices: [
      { id: "heart", label: "Heart", status: "ready", audio_hash: "audio", marks_hash: "marks", bytes: 10 },
      { id: "bella", label: "Bella", status: "queued", audio_hash: null, marks_hash: null, bytes: null },
    ],
  };
  assert.equal(selectPreferredVoice(chapter, "bella")?.status, "queued");
  chapter.effective = { sources: { default_voice: "rendition.chapter" } };
  assert.equal(selectPreferredVoice(chapter, "bella")?.id, "heart");
  assert.equal(selectPreferredVoice(chapter, "bella", "bella")?.id, "bella");
});

test("duration uses actual sentence timing and omits missing or invalid data", () => {
  assert.equal(markDuration([{ end_ms: 1200 }, { end_ms: 92345 }]), 92.345);
  for (const value of [null, [], {}, [{ end_ms: -1 }], [{ end_ms: Infinity }], [{ end_ms: "100" }]]) {
    assert.equal(markDuration(value), undefined);
  }
});
