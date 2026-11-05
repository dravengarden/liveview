// Loading one reader chapter: the request URL, the response decision, and the
// stale-request guard. React-free so every outcome is testable; the hook in
// useChapterContent.ts applies the outcome to state.

import { bookSlugOf } from "./location.ts";
import type { FileContent } from "@/types";

/** A page missing in the selected edition; `shown` is rendered instead. */
export interface UntranslatedNotice {
  requested: string;
  shown: string;
}

export type ChapterError = "offline" | "failed";

export type ChapterOutcome =
  /** A newer navigation claimed the reader while this request was in flight. */
  | { kind: "stale" }
  /** The path does not exist; open the book's real first chapter instead. */
  | { kind: "redirect"; path: string }
  | { kind: "error"; error: ChapterError }
  | { kind: "loaded"; data: FileContent; untranslated: UntranslatedNotice | null };

export interface ChapterRequest {
  path: string;
  lang: string;
  rendition: string;
}

export interface ChapterDeps {
  /** Fetch the chapter body (with its own transient retry). */
  fetch: (url: string) => Promise<Response>;
  /** Reads cannot reach the server right now. */
  offline: () => boolean;
  /** The book's first spine chapter for a rendition, if known. */
  firstChapter: (slug: string, rendition: string) => Promise<string | null>;
  /** Whether this request still owns the reader. */
  current: () => boolean;
}

export function chapterUrl({ path, lang, rendition }: ChapterRequest): string {
  return `/api/file?path=${encodeURIComponent(path)}&lang=${
    encodeURIComponent(lang)
  }&rendition=${encodeURIComponent(rendition)}`;
}

/**
 * Fetch a chapter and decide what the reader shows.
 *
 * A real 404 online is most often the `<slug>/README.md` entry guess for a
 * book without a README, or a stale resume path: redirect to the book's first
 * chapter rather than dead-ending. Any other failure (and every failure while
 * offline) is surfaced, never by leaving the previous chapter silently up. A
 * 504 is a transient or offline miss that already had its bounded retry; it
 * never redirects a valid chapter to the first page.
 */
export async function loadChapter(
  req: ChapterRequest,
  deps: ChapterDeps,
): Promise<ChapterOutcome> {
  try {
    const res = await deps.fetch(chapterUrl(req));
    if (!deps.current()) return { kind: "stale" };
    if (!res.ok) {
      const offline = deps.offline();
      if (!offline && res.status === 404) {
        const first = await deps.firstChapter(bookSlugOf(req.path), req.rendition);
        if (!deps.current()) return { kind: "stale" };
        if (first && first !== req.path) return { kind: "redirect", path: first };
      }
      return { kind: "error", error: offline ? "offline" : "failed" };
    }
    const data = (await res.json()) as FileContent;
    if (!deps.current()) return { kind: "stale" };
    // The server resolves overlay → base and reports the edition it served.
    return {
      kind: "loaded",
      data,
      untranslated: data.lang !== req.lang ? { requested: req.lang, shown: data.lang } : null,
    };
  } catch {
    if (!deps.current()) return { kind: "stale" };
    return { kind: "error", error: deps.offline() ? "offline" : "failed" };
  }
}
