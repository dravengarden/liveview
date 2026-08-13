import {
  buildLibraryTaxonomy,
  discoveryTagIds,
  matchesTagFacets,
  readingState,
  searchScore,
  sortCollectionNames,
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
