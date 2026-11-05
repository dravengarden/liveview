import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Book, TreeNode } from "@/types";
import { latestProgress, shelfProgress, widgetItems } from "./progress.ts";

const file = (path: string, name: string, titles?: Record<string, string>): TreeNode => ({
  name,
  path,
  is_dir: false,
  children: [],
  ...(titles ? { titles } : {}),
});
const dir = (path: string, name: string, children: TreeNode[]): TreeNode => ({
  name,
  path,
  is_dir: true,
  children,
});

const textForest = [
  dir("book", "Book", [
    file("book/01.md", "One", { zh: "一" }),
    dir("book/part", "Part", [file("book/part/02.md", "Two"), file("book/part/03.md", "Three")]),
    file("book/04.md", "Four"),
  ]),
  dir("other", "Other", [file("other/a.md", "A")]),
];
const audioForest = [
  dir("book", "Book", [file("book/01.spoken.md", "One (audio)"), file("book/02.spoken.md", "Two (audio)")]),
];

test("shelfProgress places each rendition's newest row in its own spine", () => {
  const rows = [
    { path: "book/part/03.md", scroll: 0.5, updated_at: 30 },
    { path: "book/02.spoken.md", scroll: 0.25, updated_at: 20 },
    { path: "book/01.md", scroll: 0.9, updated_at: 10 }, // older text row: ignored
  ];
  const out = shelfProgress(rows, textForest, audioForest, "zh");
  assert.equal(out["book"]?.text?.chapterLabel, "Three");
  // chapter 3 of 4 (index 2) half read → (2 + 0.5) / 4
  assert.equal(out["book"]?.text?.fraction, 0.625);
  assert.equal(out["book"]?.text?.updatedAt, 30);
  assert.equal(out["book"]?.audio?.chapterLabel, "Two (audio)");
  assert.equal(out["book"]?.audio?.fraction, (1 + 0.25) / 2);
});

test("shelfProgress uses the UI edition title and falls back to the file name", () => {
  const rows = [
    { path: "book/01.md", scroll: 0, updated_at: 5 },
    { path: "ghost/99.md", scroll: 0.4, updated_at: 4 },
  ];
  const out = shelfProgress(rows, textForest, audioForest, "zh");
  assert.equal(out["book"]?.text?.chapterLabel, "一");
  // No spine for the book: label from the file name, fraction = raw scroll.
  assert.equal(out["ghost"]?.text?.chapterLabel, "99.md");
  assert.equal(out["ghost"]?.text?.fraction, 0.4);
  assert.equal(out["ghost"]?.audio, undefined);
});

test("shelfProgress clamps out-of-range scroll before computing the fraction", () => {
  const out = shelfProgress(
    [{ path: "book/04.md", scroll: 1.7, updated_at: 1 }],
    textForest,
    [],
    "en",
  );
  assert.equal(out["book"]?.text?.fraction, 1);
  assert.equal(out["book"]?.text?.scroll, 1.7);
});

const mkBook = (slug: string): Book => ({
  label: slug,
  slug,
  cover: false,
  backdrop: false,
  default_rendition: "text",
  renditions: [],
  default_lang: "en",
  langs: [],
  manifest: true,
  created_at: 0,
  updated_at: 0,
});
const entry = (path: string, fraction: number, updatedAt: number) => ({
  path,
  chapterLabel: path,
  scroll: 0,
  fraction,
  updatedAt,
});

test("latestProgress prefers the most recently touched rendition", () => {
  assert.equal(latestProgress(undefined), undefined);
  assert.equal(latestProgress({ text: entry("t", 0.1, 1) })?.path, "t");
  assert.equal(latestProgress({ text: entry("t", 0.1, 1), audio: entry("a", 0.2, 2) })?.path, "a");
  assert.equal(latestProgress({ text: entry("t", 0.1, 3), audio: entry("a", 0.2, 2) })?.path, "t");
});

test("widgetItems lists recent books first, then pads with unread ones", () => {
  const books = ["a", "b", "c", "d", "e", "f"].map(mkBook);
  const progress = {
    b: { text: entry("b/1", 0.5, 10) },
    d: { audio: entry("d/1", 0.75, 20) },
  };
  const items = widgetItems(books, progress);
  assert.deepEqual(
    items.map((i) => [i.book.slug, i.progress]),
    [["d", 0.75], ["b", 0.5], ["a", 0], ["c", 0]],
  );
  assert.equal(widgetItems(books.slice(0, 2), {}).length, 2);
});
