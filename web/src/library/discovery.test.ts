import { test } from "bun:test";
import assert from "node:assert/strict";
import type { BookSearchMatch } from "@/librarySearch";
import type { ShelfEntry } from "@/components/ShelfCard";
import type { Book, BookProgress } from "@/types";
import {
  activeFilterCount,
  type Discovery,
  discoveryActive,
  narrowShelf,
  sortShelf,
  toolbarBack,
} from "./discovery.ts";

const book = (slug: string, extra: Partial<Book> = {}): Book => ({
  label: slug.toUpperCase(),
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
  ...extra,
});
const entry = (b: Book, category: ShelfEntry["category"] = "book"): ShelfEntry => ({
  book: b,
  category,
  hasAudio: false,
  hasText: true,
});
const idle: Discovery = { query: "", kind: "all", reading: "all", tags: new Set() };
const hit = {} as BookSearchMatch;

test("discovery state drives the badge and the active flag", () => {
  assert.equal(discoveryActive(idle), false);
  assert.equal(discoveryActive({ ...idle, query: "  " }), false);
  assert.equal(discoveryActive({ ...idle, query: "x" }), true);
  assert.equal(activeFilterCount({ ...idle, query: "x" }), 0, "search is not a filter");
  assert.equal(activeFilterCount({ ...idle, kind: "docs", reading: "unread", tags: new Set(["a", "b"]) }), 4);
});

test("Back leaves discovery first, then climbs one level", () => {
  assert.deepEqual(toolbarBack({ ...idle, query: "x" }, "dir", "parent"), { kind: "exit-discovery", to: "dir" });
  assert.deepEqual(toolbarBack({ ...idle, query: "x" }, null, null), { kind: "exit-discovery", to: null });
  assert.deepEqual(toolbarBack(idle, "dir", "parent"), { kind: "up", to: "parent" });
  assert.deepEqual(toolbarBack(idle, "dir", null), { kind: "up", to: null });
  assert.equal(toolbarBack(idle, null, null), null);
});

test("sortShelf orders by content change, addition, name and last opened", () => {
  const a = entry(book("a", { created_at: 1, updated_at: 5 }));
  const b = entry(book("b", { created_at: 3, updated_at: 0 }));
  const c = entry(book("c", { created_at: 2, updated_at: 9 }));
  const slugs = (xs: ShelfEntry[]) => xs.map((e) => e.book.slug).join("");
  assert.equal(slugs(sortShelf([a, b, c], "updated", {}, "en")), "cab");
  assert.equal(slugs(sortShelf([a, b, c], "added", {}, "en")), "bca");
  assert.equal(slugs(sortShelf([c, b, a], "name", {}, "en")), "abc");
  const progress: Record<string, BookProgress> = {
    b: { text: { path: "b/1", chapterLabel: "", scroll: 0, fraction: 0, updatedAt: 50 } },
  };
  assert.equal(slugs(sortShelf([a, b, c], "read", progress, "en")), "bca", "unopened fall back to content recency");
});

test("narrowShelf scopes by directory unless searching, and applies every filter", () => {
  const a = entry(book("a", { tags: ["x"] }));
  const d = entry(book("d"), "docs");
  const z = entry(book("z"));
  const dirs: Record<string, string> = { a: "one", d: "one", z: "two" };
  const ctx = {
    directory: "one" as string | null,
    directoryOf: (b: Book) => dirs[b.slug] ?? null,
    progress: {},
    matches: new Map([["a", hit], ["d", hit], ["z", hit]]),
  };
  const slugs = (xs: { entry: ShelfEntry }[]) => xs.map((x) => x.entry.book.slug).join("");
  assert.equal(slugs(narrowShelf([a, d, z], idle, ctx)), "ad");
  assert.equal(slugs(narrowShelf([a, d, z], { ...idle, query: "q" }, ctx)), "adz", "search is global");
  assert.equal(slugs(narrowShelf([a, d, z], { ...idle, kind: "docs" }, ctx)), "d");
  assert.equal(slugs(narrowShelf([a, d, z], { ...idle, kind: "book" }, ctx)), "a");
  assert.equal(slugs(narrowShelf([a, d, z], { ...idle, tags: new Set(["x"]) }, ctx)), "a");
  assert.equal(slugs(narrowShelf([a, d, z], { ...idle, tags: new Set(["x"]) }, ctx, false)), "ad", "facet preview base ignores tags");
  const noZ = { ...ctx, directory: null, matches: new Map([["a", hit], ["d", hit], ["z", null]]) };
  assert.equal(slugs(narrowShelf([a, d, z], { ...idle, query: "q" }, noZ)), "ad", "non-matching titles drop out");
});
