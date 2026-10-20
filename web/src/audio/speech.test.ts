import assert from "node:assert/strict";
import { test } from "node:test";
import { preferredVoice, prepareVoice, speechCatalog, type SpeechPreparation, type VoiceChoice } from "./speech";
import { emitServerSettingPush, loadServerSetting } from "@/syncBackends";
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

test("server voice hydration notifies the book preloader when the local choice changes", async () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const dispatch = Object.getOwnPropertyDescriptor(globalThis, "dispatchEvent");
  const fetch = globalThis.fetch;
  const np = { bookSlug: "voice-hydration", rendition: "text", lang: "en" } as NowPlaying;
  const key = voicePreferenceKey(np);
  let local = "heart";
  const events: string[] = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => local, setItem: (_key: string, value: string) => { local = value; },
  } });
  Object.defineProperty(globalThis, "dispatchEvent", { configurable: true, value: (event: Event) => { events.push(event.type); return true; } });
  globalThis.fetch = async () => Response.json({});
  try {
    await loadServerSetting(key);
    emitServerSettingPush(key, "bella");
    const voices: VoiceChoice[] = ["heart", "bella"].map(id => ({
      id, label: id, status: "ready", audio_hash: id, marks_hash: `${id}-marks`, bytes: 10,
    }));
    const chapter = { id: "chapter", default_voice: "heart", voices };
    assert.equal((await preferredVoice(np, chapter))?.id, "bella");
    assert.equal(local, "bella");
    assert.deepEqual(events, ["lv-voice-preference"]);
    await preferredVoice(np, chapter);
    assert.equal(events.length, 1, "an unchanged choice does not restart the planner");
  } finally {
    globalThis.fetch = fetch;
    if (storage) Object.defineProperty(globalThis, "localStorage", storage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (dispatch) Object.defineProperty(globalThis, "dispatchEvent", dispatch);
    else Reflect.deleteProperty(globalThis, "dispatchEvent");
  }
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

test("preparation exposes server stages, survives a disconnect, and never resubmits while polling", async () => {
  const fetch = globalThis.fetch;
  const timeout = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => timeout(args[0], args[1] === 2000 ? 0 : args[1], ...args.slice(2))) as typeof setTimeout;
  const np = { bookSlug: "english", chapterPath: "english/01.md", rendition: "text", lang: "en" } as NowPlaying;
  const choice: VoiceChoice = { id: "kokoro:af_heart", label: "Heart", status: "available", audio_hash: null, marks_hash: null, bytes: null };
  const stages: (VoiceChoice["status"] | "offline")[] = ["queued", "queued", "running", "offline", "running", "ready"];
  let submissions = 0;
  globalThis.fetch = async (_input, options) => {
    if (options?.method === "POST") { submissions++; return Response.json({ status: "queued" }, { status: 202 }); }
    const status = stages.shift();
    if (status === "offline") throw new TypeError("Network connection lost");
    assert.ok(status, "polling stops when the audio is ready");
    return Response.json({ chapters: [{ id: "text/en/01.md", voices: [{ ...choice, status, audio_hash: status === "ready" ? "audio" : null, marks_hash: status === "ready" ? "marks" : null }] }] });
  };
  const progress: SpeechPreparation[] = [];
  try {
    const result = await prepareVoice(np, choice, () => true, value => progress.push(value));
    assert.equal(result.audio_hash, "audio");
    assert.equal(submissions, 1);
    assert.deepEqual(progress.map(p => p.phase), ["checking", "queued", "generating", "reconnecting", "generating", "loading"]);
    assert.equal(new Set(progress.map(p => p.startedAt)).size, 1, "reconnection preserves the waiting clock");
    assert.ok(progress.every(p => p.voice === choice.id));
  } finally {
    globalThis.fetch = fetch;
    globalThis.setTimeout = timeout;
  }
});

test("a cancelled chapter cannot report readiness or overwrite the next chapter's preparation", async () => {
  const fetch = globalThis.fetch;
  let current = true;
  const phases: string[] = [];
  globalThis.fetch = async (_input, options) => {
    if (options?.method === "POST") return Response.json({ status: "queued" }, { status: 202 });
    current = false;
    return Response.json({ chapters: [{ id: "text/en/01.md", voices: [{ id: "heart", status: "ready", audio_hash: "audio", marks_hash: "marks" }] }] });
  };
  try {
    await assert.rejects(prepareVoice(
      { bookSlug: "english", chapterPath: "english/01.md", rendition: "text", lang: "en" } as NowPlaying,
      { id: "heart", label: "Heart", status: "queued", audio_hash: null, marks_hash: null, bytes: null },
      () => current, p => phases.push(p.phase),
    ), /Cancelled/);
    assert.deepEqual(phases, ["checking", "queued"]);
  } finally { globalThis.fetch = fetch; }
});

test("a failed server job exits preparation with a retryable error", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (_input, options) => options?.method === "POST"
    ? Response.json({ status: "queued" }, { status: 202 })
    : Response.json({ chapters: [{ id: "text/en/01.md", voices: [{ id: "heart", status: "failed" }] }] });
  try {
    await assert.rejects(prepareVoice(
      { bookSlug: "english", chapterPath: "english/01.md", rendition: "text", lang: "en" } as NowPlaying,
      { id: "heart", label: "Heart", status: "available", audio_hash: null, marks_hash: null, bytes: null },
      () => true,
    ), /generation failed/);
  } finally { globalThis.fetch = fetch; }
});
