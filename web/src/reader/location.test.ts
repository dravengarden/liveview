import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  bookSlugOf,
  buildHash,
  hashTokens,
  parseHash,
  parseResume,
} from "./location.ts";

test("reader hash encodes the path so separators never collide", () => {
  assert.equal(buildHash(null, "zh", "audio"), "");
  assert.equal(buildHash("book/01.md", null, null), "#book%2F01.md");
  assert.equal(
    buildHash("book/Q&A lang=x.md", "zh-Hans", "audio"),
    "#book%2FQ%26A%20lang%3Dx.md&lang=zh-Hans&rendition=audio",
  );
});

test("parseHash inverts buildHash and tolerates missing or empty tokens", () => {
  const roundTrip = buildHash("book/Q&A lang=x.md", "zh-Hans", "audio");
  assert.deepEqual(parseHash(roundTrip), {
    path: "book/Q&A lang=x.md",
    lang: "zh-Hans",
    rendition: "audio",
  });
  assert.deepEqual(parseHash("#book%2F01.md"), {
    path: "book/01.md",
    lang: null,
    rendition: null,
  });
  assert.deepEqual(parseHash("#book%2F01.md&lang=&rendition=text"), {
    path: "book/01.md",
    lang: null,
    rendition: "text",
  });
  const empty = { path: null, lang: null, rendition: null };
  assert.deepEqual(parseHash(""), empty);
  assert.deepEqual(parseHash("#"), empty);
  assert.deepEqual(parseHash("no-hash"), empty);
});

test("hashTokens always pins the language and omits only the default rendition", () => {
  const book = { default_rendition: "text" };
  assert.deepEqual(hashTokens("zh", "text", book), { lang: "zh", rendition: null });
  assert.deepEqual(hashTokens("zh", "audio", book), { lang: "zh", rendition: "audio" });
  // No book (stale catalog): the rendition cannot be judged, so it is omitted.
  assert.deepEqual(hashTokens("en", "audio", undefined), { lang: "en", rendition: null });
  assert.deepEqual(hashTokens("", "text", book), { lang: null, rendition: null });
});

test("bookSlugOf takes the first path segment", () => {
  assert.equal(bookSlugOf("book/ch/01.md"), "book");
  assert.equal(bookSlugOf("book"), "book");
  assert.equal(bookSlugOf(""), "");
});

test("parseResume accepts only a stored location with a path", () => {
  assert.deepEqual(parseResume(JSON.stringify({ path: "b/1.md", lang: "zh" })), {
    path: "b/1.md",
    lang: "zh",
    rendition: null,
  });
  assert.equal(parseResume(JSON.stringify({ lang: "zh" })), null);
  assert.equal(parseResume("{not json"), null);
  assert.equal(parseResume(null), null);
});
