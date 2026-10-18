import { test } from "node:test";
import assert from "node:assert/strict";
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
