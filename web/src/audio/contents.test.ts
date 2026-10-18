import assert from "node:assert/strict";
import { test } from "node:test";
import { contentsAudio, loadContentsTree } from "./contents";
import type { TreeNode } from "@/types";
import { selectPreferredVoice, type ChapterVoices } from "./speech";

test("contents returns titles and metadata with one request and keeps refresh failures explicit", async () => {
  const original = globalThis.fetch;
  const expected = [{ name: "One", path: "book/one.md", children: [], is_dir: false, audio: { en: { id: "text/en/one.md", default_voice: "heart", voices: [] } } }];
  const calls: string[] = [];
  globalThis.fetch = async (input, options) => {
    calls.push(String(input));
    if (options?.signal) assert.equal(options.cache, "no-store");
    return Response.json(expected);
  };
  try {
    assert.deepEqual(await loadContentsTree("book", "text"), expected);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.endsWith("/api/contents/book?rendition=text"));
    calls.length = 0;
    assert.deepEqual(await loadContentsTree("book", "text", true), expected);
    assert.deepEqual(calls, ["/api/contents/book?rendition=text"]);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(loadContentsTree("book", "text", true), /refresh unavailable/);
  } finally {
    globalThis.fetch = original;
  }
});

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

test("title snapshots synchronously supply language and voice-specific durations", () => {
  const heart = { id: "heart", label: "Heart", status: "ready" as const, audio_hash: "a", marks_hash: "m", bytes: 10, seconds: 92.345 };
  const bella = { ...heart, id: "bella", seconds: 80 };
  const tree: TreeNode[] = [{ name: "Book", path: "book", is_dir: true, children: [
    { name: "One", path: "book/one.md", is_dir: false, children: [], audio: { en: { id: "text/en/one.md", default_voice: "heart", voices: [heart, bella] } } },
  ] }];
  assert.equal(contentsAudio(tree, "en", null).get("book/one.md")?.seconds, 92.345);
  assert.equal(contentsAudio(tree, "en", "bella").get("book/one.md")?.seconds, 80);
  assert.equal(contentsAudio(tree, "en", "bella", "heart", "book/one.md").get("book/one.md")?.seconds, 92.345);
  assert.equal(contentsAudio(tree, "fr", null).size, 0);
  assert.equal(contentsAudio([{ name: "Old", path: "old", is_dir: false, children: [] }], "en", null).size, 0);
});
