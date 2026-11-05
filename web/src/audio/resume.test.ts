import assert from "node:assert/strict";
import { test } from "node:test";
import type { NowPlaying } from "./player";
import { parseServerPos, parseServerSession, posKey, serverResumeDecision, unitKey } from "./resume";
import type { PersistedSession } from "./stores";

const np = (over: Partial<NowPlaying> = {}): NowPlaying => ({
  bookSlug: "book",
  bookLabel: "Book",
  cover: false,
  chapterPath: "book/c1.spoken.md",
  chapterLabel: "One",
  lang: "en",
  rendition: "default",
  voice: "v1",
  marksHash: "m1",
  ...over,
});
const session = (over: Partial<NowPlaying> = {}): PersistedSession => ({ nowPlaying: np(over), queue: [], queueIndex: 0 });

test("position keys keep their stored format", () => {
  assert.equal(posKey("a/b.md", "en"), "lv-audio-pos:a/b.md:en");
  assert.equal(posKey("a/b.md", "en", "v", "h"), "lv-audio-pos:a/b.md:en:v:h");
  assert.equal(unitKey(np()), "lv-audio-unit:book/c1.spoken.md:default:en");
});

test("server blobs that are corrupt or partial parse to null", () => {
  assert.equal(parseServerSession(null), null);
  assert.equal(parseServerSession("{"), null);
  assert.equal(parseServerSession(JSON.stringify({ nowPlaying: np() })), null);
  assert.ok(parseServerSession(JSON.stringify(session())));
  assert.equal(parseServerPos("null"), null);
  assert.equal(parseServerPos(JSON.stringify({ path: "x", t: "1" })), null);
  assert.deepEqual(parseServerPos(JSON.stringify({ path: "x", t: 3 })), { path: "x", t: 3 });
});

test("a different chapter or an empty player adopts the server session", () => {
  const pos = { path: "book/c2.spoken.md", t: 30, voice: "v1", marksHash: "m1" };
  assert.deepEqual(serverResumeDecision(np(), 500, session({ chapterPath: "book/c2.spoken.md" }), pos), { adopt: true, serverT: 30 });
  assert.equal(serverResumeDecision(null, 0, session(), null).adopt, true);
  assert.equal(serverResumeDecision(np(), 0, session({ bookSlug: "other" }), null).adopt, true);
});

test("the same chapter adopts only when the server leads by more than the margin", () => {
  const at = (t: number) => ({ path: "book/c1.spoken.md", t, voice: "v1", marksHash: "m1" });
  assert.deepEqual(serverResumeDecision(np(), 100, session(), at(108)), { adopt: false, serverT: 108 });
  assert.deepEqual(serverResumeDecision(np(), 100, session(), at(109)), { adopt: true, serverT: 109 });
  assert.equal(serverResumeDecision(np(), 200, session(), at(150)).adopt, false);
});

test("a position for another voice or mark set is not a server position", () => {
  const other = { path: "book/c1.spoken.md", t: 900, voice: "v2", marksHash: "m1" };
  assert.deepEqual(serverResumeDecision(np(), 0, session(), other), { adopt: false, serverT: 0 });
  // A local voice change keeps the local choice even when the server is far ahead.
  const ahead = { path: "book/c1.spoken.md", t: 900, voice: "v1", marksHash: "m1" };
  assert.equal(serverResumeDecision(np({ voice: "v2" }), 0, session(), ahead).adopt, false);
});
