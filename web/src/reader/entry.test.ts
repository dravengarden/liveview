import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Book, RenditionInfo } from "@/types";
import {
  defaultRendition,
  entryLang,
  hashEntryLang,
  hashEntryRendition,
  pickInitialLang,
  resolveRendition,
  resumeTextPath,
} from "./entry.ts";

const text: RenditionInfo = {
  kind: "text",
  label: "Read",
  default_lang: "en",
  langs: [{ lang: "en", label: "English" }, { lang: "zh", label: "中文" }],
};
const audio: RenditionInfo = {
  kind: "audio",
  label: "Listen",
  default_lang: "zh",
  langs: [{ lang: "zh", label: "中文" }],
};

function book(overrides: Partial<Book> = {}): Book {
  return {
    label: "Book",
    slug: "book",
    cover: false,
    backdrop: false,
    default_rendition: "text",
    renditions: [text, audio],
    default_lang: "en",
    langs: text.langs,
    manifest: true,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

test("defaultRendition resolves the declared default, else the first offered", () => {
  assert.equal(defaultRendition(book())?.kind, "text");
  assert.equal(defaultRendition(book({ default_rendition: "audio" }))?.kind, "audio");
  assert.equal(defaultRendition(book({ default_rendition: "video" }))?.kind, "text");
  assert.equal(defaultRendition(book({ renditions: [] })), null);
});

test("resolveRendition: explicit request, then remembered, then default", () => {
  assert.equal(resolveRendition(book(), "audio", "text")?.kind, "audio");
  assert.equal(resolveRendition(book(), undefined, "audio")?.kind, "audio");
  assert.equal(resolveRendition(book(), undefined, undefined)?.kind, "text");
  // Unavailable requests fall through instead of dead-ending.
  assert.equal(resolveRendition(book(), "video", "audio")?.kind, "audio");
  assert.equal(resolveRendition(book(), "video", "video")?.kind, "text");
});

test("editions: the UI language wins when offered, else the rendition default", () => {
  assert.equal(pickInitialLang(text, "zh"), "zh");
  assert.equal(pickInitialLang(text, "fr"), "en");
  assert.equal(pickInitialLang(audio, "en"), "zh");
  // A remembered edition is used only when this rendition still offers it.
  assert.equal(entryLang(text, "zh", "en"), "zh");
  assert.equal(entryLang(audio, "en", "en"), "zh");
  assert.equal(entryLang(text, undefined, "zh"), "zh");
});

test("hash deep links honour explicit tokens and fall back to book defaults", () => {
  assert.equal(hashEntryRendition(book(), "audio"), "audio");
  assert.equal(hashEntryRendition(book(), "video"), "text");
  assert.equal(hashEntryRendition(book({ default_rendition: "audio" }), null), "audio");
  assert.equal(hashEntryRendition(undefined, "audio"), "text");
  assert.equal(hashEntryLang(book(), "text", "zh", "en"), "zh");
  assert.equal(hashEntryLang(book(), "text", null, "zh"), "zh");
  assert.equal(hashEntryLang(book(), "audio", null, "en"), "zh");
  assert.equal(hashEntryLang(undefined, "text", null, "en"), "");
});

test("resumeTextPath skips audio rows and other books", () => {
  const rows = [
    { path: "other/01.md", scroll: 0.5, updated_at: 3 },
    { path: "book/03.spoken.md", scroll: 0.2, updated_at: 2 },
    { path: "book/02.md", scroll: 0.9, updated_at: 1 },
  ];
  assert.equal(resumeTextPath(rows, "book"), "book/02.md");
  assert.equal(resumeTextPath(rows, "none"), undefined);
});
