import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  engineShouldLoad,
  followEngine,
  type PlayingChapter,
  type ReaderView,
} from "./readAlong.ts";

const audioView = (path: string | null): ReaderView => ({ slug: "book", rendition: "audio", path });
const playing = (chapterPath: string, rendition = "audio"): PlayingChapter => ({
  bookSlug: "book",
  rendition,
  chapterPath,
  lang: "en",
});

test("the engine loads the audiobook chapter the reader opens, once", () => {
  assert.equal(engineShouldLoad(audioView("book/1"), true, null), true);
  assert.equal(engineShouldLoad(audioView("book/1"), true, "book/1"), false);
  assert.equal(engineShouldLoad(audioView("book/1"), false, null), false, "waits for the spine");
  assert.equal(engineShouldLoad({ ...audioView("book/1"), rendition: "text" }, true, null), false,
    "text read-aloud stays opt-in");
  assert.equal(engineShouldLoad(audioView(null), true, null), false);
});

test("the reader follows the engine only while it was in sync", () => {
  // In sync on chapter 1.
  let step = followEngine(audioView("book/1"), playing("book/1"), null);
  assert.deepEqual(step, { synced: "book/1", follow: null });
  // The engine advances: follow.
  step = followEngine(audioView("book/1"), playing("book/2"), step.synced);
  assert.deepEqual(step.follow?.chapterPath, "book/2");
  assert.equal(step.synced, "book/2");
  // The reader navigated to chapter 7 while the engine stays on 2: no hijack.
  step = followEngine(audioView("book/7"), playing("book/2"), "book/2");
  assert.deepEqual(step, { synced: "book/2", follow: null });
  // ...and when the engine then advances, the reader still stays on 7.
  step = followEngine(audioView("book/7"), playing("book/3"), step.synced);
  assert.equal(step.follow, null);
});

test("another book or rendition clears the sync", () => {
  assert.deepEqual(
    followEngine({ slug: "other", rendition: "audio", path: "other/1" }, playing("book/1"), "book/1"),
    { synced: null, follow: null },
  );
  assert.deepEqual(
    followEngine({ slug: "book", rendition: "text", path: "book/1" }, playing("book/1"), "book/1"),
    { synced: null, follow: null },
  );
  assert.deepEqual(followEngine(audioView("book/1"), null, "book/1"), { synced: null, follow: null });
});

test("text read-aloud carries the reader into the next chapter", () => {
  const view: ReaderView = { slug: "book", rendition: "text", path: "book/1.md" };
  const first = followEngine(view, playing("book/1.md", "text"), null);
  const next = followEngine(view, playing("book/2.md", "text"), first.synced);
  assert.equal(next.follow?.chapterPath, "book/2.md");
});

// Both rules together, with the caller contract that the view → engine rule
// re-runs only when the view moves: an engine-led advance followed by the view
// never makes the engine reload (the historical feedback loop).
test("following the engine does not trigger a reload back", () => {
  let view = audioView("book/1");
  let enginePath: string | null = null;
  let synced: string | null = null;
  let checkedPath: string | null = null;
  const loads: string[] = [];
  const settle = (): void => {
    for (let i = 0; i < 5; i++) {
      const viewMoved = view.path !== checkedPath;
      checkedPath = view.path;
      if (viewMoved && engineShouldLoad(view, true, enginePath)) {
        loads.push(view.path!);
        enginePath = view.path;
      }
      const step = followEngine(view, enginePath ? playing(enginePath) : null, synced);
      synced = step.synced;
      if (step.follow) view = audioView(step.follow.chapterPath);
    }
  };
  settle();
  enginePath = "book/2"; // auto-advance
  settle();
  enginePath = "book/3";
  settle();
  view = audioView("book/9"); // user navigation
  settle();
  assert.deepEqual(loads, ["book/1", "book/9"]);
  assert.equal(view.path, "book/9");
});
