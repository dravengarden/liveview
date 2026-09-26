import {
  buildBookSearchIndex,
  buildLibraryTaxonomy,
  countTagFacetMatches,
  discoveryTagIds,
  FACET_FOLD_THRESHOLD,
  facetStartsFolded,
  matchesTagFacets,
  readingState,
  scoreBookSearchIndex,
  searchScore,
  sortCollectionNames,
  tokenizeSearchQuery,
} from "./libraryDiscovery.ts";
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

const book: Book = {
  label: "Wetlands Field Guide",
  slug: "wetlands-field-guide",
  description: "Observations from a restored coastal habitat",
  collection: "Natural History",
  author: "A. Reader",
  tags: ["subject.ecology", "format.field-guide", "beginner"],
  cover: false,
  backdrop: false,
  default_rendition: "text",
  renditions: [{ kind: "text", label: "Read", default_lang: "en", langs: [] }],
  default_lang: "en",
  langs: [],
  manifest: true,
  created_at: 0,
  updated_at: 0,
};

Deno.test("weighted search covers title, tags, series, author, and description", () => {
  assertEquals(
    (searchScore(book, "wetlands") ?? 0) >
      (searchScore(book, "restored") ?? 0),
    true,
  );
  assertEquals(searchScore(book, "ecology field") != null, true);
  assertEquals(searchScore(book, "astronomy"), null);
  const index = buildBookSearchIndex(book);
  assertEquals(
    scoreBookSearchIndex(index, tokenizeSearchQuery("ecology field")),
    searchScore(book, "ecology field"),
  );
});

Deno.test("facet preview counts preserve OR-within and AND-across semantics", () => {
  const books = [
    book,
    {
      ...book,
      slug: "forest-notes",
      tags: ["subject.botany", "format.reference"],
    },
    {
      ...book,
      slug: "coastal-reference",
      tags: ["subject.ecology", "format.reference"],
    },
  ];
  const tags = buildLibraryTaxonomy(books).tags;
  for (
    const selected of [
      new Set<string>(),
      new Set(["subject.ecology"]),
      new Set(["subject.ecology", "format.field-guide"]),
    ]
  ) {
    const expected = new Map(tags.map((tag) => [
      tag.id,
      books.filter((entry) =>
        matchesTagFacets(entry, new Set([...selected, tag.id]))
      ).length,
    ]));
    assertEquals(
      [...countTagFacetMatches(books, tags, selected)],
      [...expected],
    );
  }
});

Deno.test("large sparse facet counts read each book's tags once", () => {
  let tagReads = 0;
  const tags = Array.from({ length: 1_533 }, (_, i) => `tag-${i}`);
  const books = Array.from({ length: 150 }, (_, i) => {
    const values = [tags[i % tags.length]!, tags[(i * 7) % tags.length]!];
    const entry = { ...book, slug: `book-${i}` };
    Object.defineProperty(entry, "tags", {
      enumerable: true,
      get: () => {
        tagReads += 1;
        return values;
      },
    });
    return entry;
  });
  const taxonomy = tags.map((id) => ({ id, facet: "tags", label: id }));
  const counts = countTagFacetMatches(books, taxonomy, new Set());
  assertEquals(tagReads, books.length);
  assertEquals(counts.size, tags.length);
});

Deno.test("tag matching is OR within facets and AND across facets", () => {
  assertEquals(
    matchesTagFacets(book, new Set(["subject.ecology", "subject.botany"])),
    true,
  );
  assertEquals(
    matchesTagFacets(book, new Set(["subject.ecology", "format.field-guide"])),
    true,
  );
  assertEquals(
    matchesTagFacets(book, new Set(["subject.ecology", "format.reference"])),
    false,
  );
});

Deno.test("catalog tags derive generic facets without aliases or collection inference", () => {
  const taxonomy = buildLibraryTaxonomy([
    book,
    {
      ...book,
      slug: "forest-notes",
      tags: ["subject.botany", "format.reference"],
    },
  ]);
  assertEquals(
    taxonomy.facets.map((facet) => facet.id),
    ["format", "subject", "tags"],
  );
  assertEquals(
    taxonomy.tags.map((tag) => [tag.id, tag.facet, tag.label]),
    [
      ["beginner", "tags", "Beginner"],
      ["format.field-guide", "format", "Field Guide"],
      ["format.reference", "format", "Reference"],
      ["subject.botany", "subject", "Botany"],
      ["subject.ecology", "subject", "Ecology"],
    ],
  );
  assertEquals(
    [...discoveryTagIds({ ...book, tags: [], collection: "Natural History" })],
    [],
  );
});

// Shared with `tag_fixtures_match_web_facet_derivation` in `src/tags.rs` —
// keep both lists aligned. The server accepts exactly the tags whose derived
// facet and label survive intact here.
Deno.test("server-accepted tags derive an intact facet and label", () => {
  const derive = (id: string): [string, string] => {
    const tag = buildLibraryTaxonomy([{ ...book, tags: [id] }]).tags[0]!;
    return [tag.facet, tag.label];
  };
  const accepted: [string, string, string][] = [
    ["beginner", "tags", "Beginner"],
    ["subject.history", "subject", "History"],
    ["format.field-guide", "format", "Field Guide"],
    ["主题.生态学", "主题", "生态学"],
    ["a.b.c", "a", "B C"],
    ["x_y", "tags", "X Y"],
    ["2024", "tags", "2024"],
  ];
  for (const [id, facet, label] of accepted) {
    assertEquals([id, ...derive(id)], [id, facet, label]);
  }
  // Rejected by the server: each would lose its facet, split a facet by case,
  // or render an empty label if it ever reached the reader.
  const rejected: [string, string, string][] = [
    [".", "tags", ""],
    ["-", "tags", ""],
    ["a.", "tags", "A"],
    [".a", "tags", "A"],
    ["a..b", "a", "B"],
    ["a.-", "a", ""],
    ["Subject.history", "Subject", "History"],
    ["École", "tags", "École"],
  ];
  for (const [id, facet, label] of rejected) {
    assertEquals([id, ...derive(id)], [id, facet, label]);
  }
});

Deno.test("collection ordering is locale-aware and has no curated priorities", () => {
  assertEquals(
    sortCollectionNames(["Zoology", "Architecture", "Botany"], "en"),
    ["Architecture", "Botany", "Zoology"],
  );
});

Deno.test("reading state uses the furthest rendition", () => {
  assertEquals(readingState(undefined), "unread");
  assertEquals(
    readingState({
      text: {
        path: "x",
        chapterLabel: "x",
        scroll: 0,
        fraction: 0.4,
        updatedAt: 1,
      },
    }),
    "progress",
  );
  assertEquals(
    readingState({
      audio: {
        path: "x",
        chapterLabel: "x",
        scroll: 1,
        fraction: 1,
        updatedAt: 1,
      },
    }),
    "finished",
  );
});

Deno.test("only large facets start folded in the filter sheet", () => {
  assertEquals(facetStartsFolded(0), false);
  assertEquals(facetStartsFolded(FACET_FOLD_THRESHOLD), false);
  assertEquals(facetStartsFolded(FACET_FOLD_THRESHOLD + 1), true);
});
