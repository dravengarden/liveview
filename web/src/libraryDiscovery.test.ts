import {
  discoveryTagIds,
  matchesTagFacets,
  readingState,
  searchScore,
} from "./libraryDiscovery.ts";
import type { Book } from "@/types";

declare const Deno: {
  test(name: string, body: () => void): void;
};

function assertEquals<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

const book: Book = {
  label: "Rig: Building LLM Agents in Rust",
  slug: "rig-for-engineers",
  description: "A production agent framework",
  collection: "AI & Agents",
  author: "Codex",
  tags: ["topic.agents", "technology.rust", "audience.intermediate"],
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

Deno.test("weighted search covers title, aliases, series, author, and description", () => {
  assertEquals(
    (searchScore(book, "rig") ?? 0) > (searchScore(book, "production") ?? 0),
    true,
  );
  assertEquals(searchScore(book, "agent rust") != null, true);
  assertEquals(searchScore(book, "blockchain"), null);
});

Deno.test("tag matching is OR within facets and AND across facets", () => {
  assertEquals(
    matchesTagFacets(book, new Set(["topic.agents", "topic.ai"])),
    true,
  );
  assertEquals(
    matchesTagFacets(book, new Set(["topic.agents", "technology.rust"])),
    true,
  );
  assertEquals(
    matchesTagFacets(book, new Set(["topic.agents", "technology.julia"])),
    false,
  );
});

Deno.test("open manifest keywords map onto stable discovery facets", () => {
  const legacy = {
    ...book,
    tags: ["llm-agents", "rust", "architecture"],
  };
  assertEquals(discoveryTagIds(legacy).has("topic.agents"), true);
  assertEquals(discoveryTagIds(legacy).has("technology.rust"), true);
  assertEquals(
    matchesTagFacets(legacy, new Set(["audience.intermediate"])),
    true,
  );
  assertEquals(
    discoveryTagIds({ ...book, tags: [], collection: "Systems & Infra" }).has(
      "topic.systems",
    ),
    true,
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
