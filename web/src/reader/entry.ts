// Which rendition, edition and chapter a book opens in. Pure: the shell feeds
// in the catalog, the per-book server preferences, the UI language and the
// recent-progress rows, and gets back a decision it can navigate to.

import type { Book, ProgressEntry, RenditionInfo } from "@/types";

/** The rendition a book opens in by default: its declared default, resolved to
 *  the matching entry, else the first rendition it offers. */
export function defaultRendition(book: Book): RenditionInfo | null {
  return book.renditions.find((r) => r.kind === book.default_rendition) ??
    book.renditions[0] ?? null;
}

/**
 * The rendition to open: an explicit request (a shelf card's read/listen
 * action, the in-book switch) wins, then the rendition the book was last
 * opened in (server-side preference), then the book's default. A request or
 * preference the book does not offer is ignored.
 */
export function resolveRendition(
  book: Book,
  explicitKind: string | undefined,
  preferredKind: string | undefined,
): RenditionInfo | null {
  const find = (kind: string | undefined): RenditionInfo | undefined =>
    kind ? book.renditions.find((r) => r.kind === kind) : undefined;
  return find(explicitKind) ?? find(preferredKind) ?? defaultRendition(book);
}

/** The edition a rendition opens in when nothing is remembered: the UI
 *  language if the rendition offers it, else the rendition's own default. */
export function pickInitialLang(r: RenditionInfo, uiLang: string): string {
  return r.langs.some((l) => l.lang === uiLang) ? uiLang : r.default_lang;
}

/** The edition to open: the remembered per-book language if this rendition
 *  still offers it, else {@link pickInitialLang}. */
export function entryLang(
  r: RenditionInfo,
  preferredLang: string | undefined,
  uiLang: string,
): string {
  return preferredLang && r.langs.some((l) => l.lang === preferredLang)
    ? preferredLang
    : pickInitialLang(r, uiLang);
}

/** The rendition a hash deep link opens: the explicit `&rendition=` token when
 *  the book offers it, else the book's default, else text. */
export function hashEntryRendition(
  book: Book | undefined,
  hashRendition: string | null,
): string {
  if (hashRendition && book?.renditions.some((r) => r.kind === hashRendition)) {
    return hashRendition;
  }
  return book?.default_rendition ?? "text";
}

/** The edition a hash deep link opens: the explicit `&lang=` token, else the
 *  rendition's preferred initial edition, else empty (unknown book). */
export function hashEntryLang(
  book: Book | undefined,
  kind: string,
  hashLang: string | null,
  uiLang: string,
): string {
  if (hashLang) return hashLang;
  const r = book?.renditions.find((x) => x.kind === kind);
  return r ? pickInitialLang(r, uiLang) : "";
}

/** The newest text chapter of `slug` in the recent-progress rows (newest
 *  first), ignoring audio (`.spoken.md`) rows; undefined when never read. */
export function resumeTextPath(
  recent: readonly ProgressEntry[],
  slug: string,
): string | undefined {
  return recent.find(
    (e) => e.path.startsWith(`${slug}/`) && !e.path.includes(".spoken"),
  )?.path;
}
