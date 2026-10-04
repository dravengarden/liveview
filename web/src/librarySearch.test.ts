import {
  type BookSearchMatch,
  buildBookSearchIndex,
  buildDirectorySearchIndex,
  compareSearchMatches,
  matchBookSearch,
  matchContext,
  parseSearchQuery,
  searchBook,
  settleApproximateMatches,
  splitHighlight,
} from "./librarySearch.ts";
import type { Book } from "@/types";

declare const Deno: {
  test(name: string, body: () => void): void;
};

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function makeBook(slug: string, overrides: Partial<Book> = {}): Book {
  return {
    label: slug,
    slug,
    cover: false,
    backdrop: false,
    default_rendition: "text",
    renditions: [{
      kind: "text",
      label: "Read",
      default_lang: "en",
      langs: [],
    }],
    default_lang: "en",
    langs: [],
    manifest: true,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const wetlands = makeBook("wetlands-field-guide", {
  label: "Wetlands Field Guide",
  description: "Observations from a restored coastal habitat",
  collection: "Natural History",
  author: "A. Reader",
  tags: ["subject.ecology", "format.field-guide", "beginner"],
});

/** Slugs of every matching book, best first. */
function rank(books: readonly Book[], query: string): string[] {
  const parsed = parseSearchQuery(query);
  return books
    .flatMap((book) => {
      const match = matchBookSearch(buildBookSearchIndex(book), parsed);
      return match ? [{ slug: book.slug, match }] : [];
    })
    .sort((a, b) => compareSearchMatches(a.match, b.match))
    .map((entry) => entry.slug);
}

function matchOf(book: Book, query: string): BookSearchMatch {
  const match = matchBookSearch(
    buildBookSearchIndex(book),
    parseSearchQuery(query),
  );
  if (!match) throw new Error(`"${query}" should match ${book.slug}`);
  return match;
}

Deno.test("search covers title, tags, folder, series, author, description, and slug", () => {
  for (
    const query of [
      "wetlands",
      "ecology field",
      "natural",
      "reader",
      "coastal",
      "field-guide",
    ]
  ) assertEquals(searchBook(wetlands, query) != null, true);
  assertEquals(searchBook(wetlands, "astronomy"), null);
});

Deno.test("an empty query matches everything without narrowing", () => {
  const match = matchOf(wetlands, "   ");
  assertEquals(match.rank, []);
  assertEquals(match.highlights, {});
});

Deno.test("title matches outrank the same word in a description", () => {
  const inTitle = makeBook("a", { label: "Rust Programming" });
  const inDescription = makeBook("b", {
    label: "Systems",
    description: "A book about rust and memory",
  });
  assertEquals(rank([inDescription, inTitle], "rust"), ["a", "b"]);
});

Deno.test("exact and prefix matches outrank substrings inside a word", () => {
  const books = [
    makeBook("inner", { label: "Algorithms" }),
    makeBook("word", { label: "Graph Go Patterns" }),
    makeBook("prefix", { label: "Go in Practice" }),
    makeBook("exact", { label: "Go" }),
  ];
  assertEquals(rank(books, "go"), ["exact", "prefix", "word", "inner"]);
});

Deno.test("an in-order phrase beats the same words scattered", () => {
  const books = [
    makeBook("scattered", { label: "Learning Machine Design" }),
    makeBook("phrase", { label: "Machine Learning Design" }),
  ];
  assertEquals(rank(books, "machine learning"), ["phrase", "scattered"]);
});

Deno.test("typos still find the title", () => {
  const books = [wetlands, makeBook("other", { label: "Compilers" })];
  for (const query of ["wetlnds", "wetalnds", "wetlandz", "wetlnd"]) {
    assertEquals(rank(books, query), ["wetlands-field-guide"]);
  }
  assertEquals(matchOf(wetlands, "wetlnds").approximate, true);
  // The highlight covers as much of the word as was typed.
  assertEquals(
    matchOf(makeBook("algo", { label: "Algorithms" }), "algoritm").highlights
      .label,
    [{ start: 0, end: 8 }],
  );
  assertEquals(matchOf(wetlands, "wetlands").approximate, false);
  // Too short or numeric to guess at.
  assertEquals(rank(books, "wex"), []);
  assertEquals(
    rank([makeBook("gpt3", { label: "GPT3 Notes" })], "gpt4"),
    [],
  );
});

Deno.test("initials find a title", () => {
  const books = [
    makeBook("systems", { label: "Machine Learning Systems" }),
    makeBook("other", { label: "Compilers" }),
  ];
  assertEquals(rank(books, "mls"), ["systems"]);
  assertEquals(matchOf(books[0]!, "ml").highlights.label, [
    { start: 0, end: 1 },
    { start: 8, end: 9 },
  ]);
});

Deno.test("diacritics, width, and case fold away", () => {
  const books = [
    makeBook("cafe", { label: "Café Society" }),
    makeBook("wide", { label: "ＡＢＣ Primer" }),
  ];
  assertEquals(rank(books, "cafe"), ["cafe"]);
  assertEquals(rank(books, "CAFÉ"), ["cafe"]);
  assertEquals(rank(books, "abc"), ["wide"]);
  // Offsets stay in the original string even when folding changes length.
  assertEquals(matchOf(books[0]!, "society").highlights.label, [
    { start: 5, end: 12 },
  ]);
});

Deno.test("CJK matches contiguously and by character pairs", () => {
  const books = [
    makeBook("llm", { label: "大模型推理:第一性原理、前沿与未来" }),
    makeBook("other", { label: "编译原理" }),
  ];
  assertEquals(rank(books, "大模型"), ["llm"]);
  assertEquals(rank(books, "推理"), ["llm"]);
  assertEquals(rank(books, "模型推论"), ["llm"]);
  assertEquals(matchOf(books[0]!, "模型推论").approximate, true);
  assertEquals(rank(books, "原理"), ["other", "llm"]);
  assertEquals(rank(books, "天文"), []);
});

Deno.test("every plain token is required, in any order", () => {
  assertEquals(rank([wetlands], "guide wetlands"), ["wetlands-field-guide"]);
  assertEquals(rank([wetlands], "wetlands astronomy"), []);
});

Deno.test("quoted phrases, exclusions, and field scopes", () => {
  const books = [
    wetlands,
    makeBook("swamp", {
      label: "Guide to Wetlands",
      author: "B. Writer",
      tags: ["subject.geology"],
    }),
  ];
  assertEquals(rank(books, '"wetlands field"'), ["wetlands-field-guide"]);
  assertEquals(rank(books, "wetlands -field"), ["swamp"]);
  assertEquals(rank(books, "author:writer"), ["swamp"]);
  assertEquals(rank(books, "tag:ecology"), ["wetlands-field-guide"]);
  // A scope confines the token: "reader" is an author, not a tag.
  assertEquals(rank(books, "tag:reader"), []);
  // Unknown prefixes are literal text.
  assertEquals(rank(books, "subject:ecology"), []);
});

Deno.test("a folder name finds the books filed in it", () => {
  const filed = buildBookSearchIndex(wetlands, "Reading List / Biology");
  const parsed = parseSearchQuery("biology");
  assertEquals(matchBookSearch(filed, parsed) != null, true);
  assertEquals(
    matchBookSearch(buildBookSearchIndex(wetlands), parsed),
    null,
  );
  const folder = matchBookSearch(
    buildDirectorySearchIndex("Reading List / Biology"),
    parsed,
  );
  assertEquals(folder?.highlights.directory, [{ start: 15, end: 22 }]);
  assertEquals(
    matchBookSearch(
      buildDirectorySearchIndex("Machine Learning"),
      parseSearchQuery("ml"),
    ) != null,
    true,
  );
});

Deno.test("highlights cover every visible field that matched", () => {
  const match = matchOf(wetlands, "wetlands reader restored");
  assertEquals(match.highlights.label, [{ start: 0, end: 8 }]);
  assertEquals(match.highlights.author, [{ start: 3, end: 9 }]);
  assertEquals(match.highlights.description, [{ start: 20, end: 28 }]);
  assertEquals(
    splitHighlight("Wetlands Field Guide", [{ start: 0, end: 8 }]),
    [
      { text: "Wetlands", mark: true },
      { text: " Field Guide", mark: false },
    ],
  );
  assertEquals(splitHighlight("plain", undefined), [
    { text: "plain", mark: false },
  ]);
});

Deno.test("matches that hide behind the title explain themselves", () => {
  const description = matchContext(wetlands, matchOf(wetlands, "coastal"));
  assertEquals(description?.kind, "description");
  assertEquals(
    description?.ranges.map(({ start, end }) =>
      description.text.slice(start, end)
    ),
    ["coastal"],
  );
  const tags = matchContext(wetlands, matchOf(wetlands, "ecology"));
  assertEquals(tags, { kind: "tags", text: "#Ecology", ranges: [] });
  assertEquals(matchContext(wetlands, matchOf(wetlands, "wetlands")), null);

  const long = makeBook("long", {
    description: `${"intro ".repeat(30)}needle ${"outro ".repeat(30)}`,
  });
  const excerpt = matchContext(long, matchOf(long, "needle"));
  assertEquals(excerpt!.text.startsWith("…"), true);
  assertEquals(excerpt!.text.endsWith("…"), true);
  assertEquals(
    excerpt!.ranges.map(({ start, end }) => excerpt!.text.slice(start, end)),
    ["needle"],
  );
});

Deno.test("close matches yield once exact results are plentiful", () => {
  const exact = (approximate: boolean): BookSearchMatch => ({
    rank: [approximate ? 1 : 0],
    approximate,
    highlights: {},
    tags: [],
  });
  const scarce = new Map<string, BookSearchMatch | null>([
    ["a", exact(false)],
    ["b", exact(true)],
  ]);
  settleApproximateMatches(scarce);
  assertEquals(scarce.get("b")?.approximate, true);

  const plenty = new Map<string, BookSearchMatch | null>([
    ["a", exact(false)],
    ["b", exact(false)],
    ["c", exact(false)],
    ["d", exact(true)],
  ]);
  settleApproximateMatches(plenty);
  assertEquals(plenty.get("d"), null);
  assertEquals(plenty.get("a")?.approximate, false);
});

Deno.test("typos rank below every exact match, whatever the field", () => {
  const books = [
    makeBook("typo-title", { label: "Grape Notes" }),
    makeBook("exact-description", {
      label: "Discrete Math",
      description: "graph theory for programmers",
    }),
  ];
  assertEquals(rank(books, "graph"), ["exact-description", "typo-title"]);
});

Deno.test("a word start outranks a word infix even in a stronger field", () => {
  const books = [
    makeBook("infix-title", { label: "Algorithms" }),
    makeBook("word-author", { label: "Notes", author: "Gorithm Smith" }),
  ];
  assertEquals(rank(books, "gorithm"), ["word-author", "infix-title"]);
});
