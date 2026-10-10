import { test } from "bun:test";
import { recentLibraryBooks, resumableLibraryBooks } from "./libraryHome.ts";
import type { Book, ReadingProgress } from "./types/index.ts";

const book = (slug: string, created_at = 0, updated_at = 0): Book => ({
  slug,
  label: slug,
  created_at,
  updated_at,
  description: "",
  collection: "",
  author: "",
  tags: [],
  cover: false,
  backdrop: false,
  manifest: true,
  renditions: [],
  langs: [],
  default_lang: "en",
  default_rendition: "text",
});
const track = (updatedAt: number, fraction: number): ReadingProgress => ({
  path: "chapter",
  chapterLabel: "Chapter",
  scroll: 0,
  fraction,
  updatedAt,
});
function equal(actual: Book[], expected: string[]): void {
  if (
    JSON.stringify(actual.map((book) => book.slug)) !== JSON.stringify(expected)
  ) {
    throw new Error(`Unexpected titles: ${actual.map((book) => book.slug)}`);
  }
}
test("Home resumes each latest unfinished rendition and excludes unopened and removed titles", () => {
  const books = [book("text"), book("audio"), book("finished"), book("new")];
  const progress = {
    text: { text: track(20, 0.3), audio: track(10, 1) },
    audio: { text: track(10, 1), audio: track(30, 0.2) },
    finished: { text: track(40, 0.98), audio: track(5, 0.2) },
    removed: { text: track(100, 0.5) },
  };
  equal(resumableLibraryBooks(books, progress, 4), [
    "audio",
    "text",
    "finished",
  ]);
  equal(resumableLibraryBooks(books, progress, 1), ["audio"]);
  equal(books, ["text", "audio", "finished", "new"]);
});
test("recent content uses change time with creation fallback without mutating the catalog", () => {
  const books = [book("old", 10), book("edited", 5, 40), book("added", 30)];
  equal(recentLibraryBooks(books, 2), ["edited", "added"]);
  equal(books, ["old", "edited", "added"]);
  equal(recentLibraryBooks([], 8), []);
});

test("documents remain resumable at the end of a document collection", () => {
  const docs = { ...book("docs"), manifest: false };
  equal(resumableLibraryBooks([docs], { docs: { text: track(80, 1) } }, 4), [
    "docs",
  ]);
});
