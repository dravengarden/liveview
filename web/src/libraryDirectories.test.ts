import { libraryDirectories } from "./libraryDirectories.ts";
import type { Book } from "./types/index.ts";

declare const Deno: { test(name: string, body: () => void): void };
const book = (slug: string, collection: string): Book => ({
  slug,
  label: slug,
  collection,
  created_at: 0,
  updated_at: 0,
  description: "",
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
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}
Deno.test("directories use authored names and keep root titles out of named folders", () => {
  const books = [
    book("loose", ""),
    book("one", " Other "),
    book("two", "Other"),
    book("three", "A / B"),
    book("space", "  "),
  ];
  const before = JSON.stringify(books);
  equal(
    libraryDirectories(books, "en").map((dir) => [
      dir.name,
      dir.books.map((b) => b.slug),
    ]),
    [["A / B", ["three"]], ["Other", ["one", "two"]]],
  );
  equal(JSON.stringify(books), before);
});
Deno.test("directory counts include the whole catalog before content pagination", () => {
  const books = Array.from(
    { length: 81 },
    (_, i) => book(String(i), i < 80 ? "A" : "Z"),
  );
  equal(
    libraryDirectories(books, "en").map((dir) => [dir.name, dir.books.length]),
    [["A", 80], ["Z", 1]],
  );
});
