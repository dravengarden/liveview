import { test } from "bun:test";
import assert from "node:assert/strict";
import { type ChapterDeps, chapterUrl, loadChapter } from "./chapter.ts";

const req = { path: "book/README.md", lang: "zh", rendition: "text" };
const body = (lang: string) =>
  Response.json({ path: req.path, lang, file_type: "markdown", content: "<p>x</p>" });

function deps(overrides: Partial<ChapterDeps> = {}): ChapterDeps {
  return {
    fetch: async () => body("zh"),
    offline: () => false,
    firstChapter: async () => "book/00-intro.md",
    current: () => true,
    ...overrides,
  };
}

test("chapterUrl encodes every query value", () => {
  assert.equal(
    chapterUrl({ path: "b/Q&A.md", lang: "zh-Hans", rendition: "text" }),
    "/api/file?path=b%2FQ%26A.md&lang=zh-Hans&rendition=text",
  );
});

test("a loaded chapter reports an untranslated fallback edition", async () => {
  const same = await loadChapter(req, deps());
  assert.equal(same.kind, "loaded");
  assert.equal(same.kind === "loaded" && same.untranslated, null);
  const fallback = await loadChapter(req, deps({ fetch: async () => body("en") }));
  assert.deepEqual(fallback.kind === "loaded" && fallback.untranslated, {
    requested: "zh",
    shown: "en",
  });
});

test("an online 404 redirects to the first chapter unless it is the same path", async () => {
  const missing = deps({ fetch: async () => new Response(null, { status: 404 }) });
  assert.deepEqual(await loadChapter(req, missing), {
    kind: "redirect",
    path: "book/00-intro.md",
  });
  assert.deepEqual(
    await loadChapter(req, { ...missing, firstChapter: async () => req.path }),
    { kind: "error", error: "failed" },
  );
  assert.deepEqual(
    await loadChapter(req, { ...missing, firstChapter: async () => null }),
    { kind: "error", error: "failed" },
  );
});

test("offline or transient failures never redirect", async () => {
  let firstChapterCalls = 0;
  const firstChapter = async () => {
    firstChapterCalls += 1;
    return "book/00-intro.md";
  };
  assert.deepEqual(
    await loadChapter(req, deps({
      fetch: async () => new Response(null, { status: 404 }),
      offline: () => true,
      firstChapter,
    })),
    { kind: "error", error: "offline" },
  );
  assert.deepEqual(
    await loadChapter(req, deps({
      fetch: async () => new Response(null, { status: 504 }),
      firstChapter,
    })),
    { kind: "error", error: "failed" },
  );
  assert.equal(firstChapterCalls, 0);
  assert.deepEqual(
    await loadChapter(req, deps({
      fetch: async () => {
        throw new TypeError("network");
      },
      offline: () => true,
    })),
    { kind: "error", error: "offline" },
  );
});

test("a superseded request reports stale at every await", async () => {
  let live = true;
  const afterFetch = deps({
    fetch: async () => {
      live = false;
      return body("zh");
    },
    current: () => live,
  });
  assert.deepEqual(await loadChapter(req, afterFetch), { kind: "stale" });

  live = true;
  const afterLookup = deps({
    fetch: async () => new Response(null, { status: 404 }),
    firstChapter: async () => {
      live = false;
      return "book/00-intro.md";
    },
    current: () => live,
  });
  assert.deepEqual(await loadChapter(req, afterLookup), { kind: "stale" });

  live = true;
  const afterThrow = deps({
    fetch: async () => {
      live = false;
      throw new TypeError("network");
    },
    current: () => live,
  });
  assert.deepEqual(await loadChapter(req, afterThrow), { kind: "stale" });
});
