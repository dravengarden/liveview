import { test } from "bun:test";
import assert from "node:assert/strict";
import { historyMode, type NavSource } from "./history.ts";

test("history policy matches the reader's layered back behaviour", () => {
  const expected: Record<NavSource, ["push" | "replace", "push" | "replace"]> = {
    // [inside a book, from the shelf]
    shelf: ["push", "push"],
    contents: ["replace", "push"],
    link: ["push", "push"],
    pager: ["push", "push"],
    lang: ["push", "push"],
    playing: ["push", "push"],
    rendition: ["replace", "replace"],
    redirect: ["replace", "replace"],
    engine: ["replace", "replace"],
  };
  for (const [source, [inBook, fromShelf]] of Object.entries(expected)) {
    assert.equal(historyMode(source as NavSource, false), inBook, `${source} in a book`);
    assert.equal(historyMode(source as NavSource, true), fromShelf, `${source} from the shelf`);
  }
});

// A model of the browser stack: back from any chapter reached by Contents
// returns to the shelf; back from a link returns to the citing chapter.
test("a session of navigations leaves the expected stack", () => {
  const stack: string[] = ["shelf"];
  let at = 0;
  const go = (url: string, source: NavSource): void => {
    const mode = historyMode(source, stack[at] === "shelf");
    if (mode === "push") {
      stack.splice(at + 1, stack.length, url);
      at += 1;
    } else {
      stack[at] = url;
    }
  };
  go("book/01", "shelf");
  go("book/05", "contents");
  go("book/06", "pager");
  go("book/09", "link");
  go("book/09#audio", "rendition");
  go("book/10#audio", "engine");
  assert.deepEqual(stack, ["shelf", "book/05", "book/06", "book/10#audio"]);
  at -= 1; // Back
  go("book/02", "contents");
  // A lateral move replaces the current entry and keeps the forward ones.
  assert.deepEqual(stack, ["shelf", "book/05", "book/02", "book/10#audio"]);
});
