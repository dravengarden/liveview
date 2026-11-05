// What the library shows: the shelf order, the discovery narrowing (search,
// kind, reading state, tags) and the toolbar's Back behaviour. Pure; the
// screen owns the state and renders the result.

import type { BookSearchMatch } from "@/librarySearch";
import { matchesTagFacets, type ReadingFilter, readingState } from "@/libraryDiscovery";
import type { ShelfSort } from "@/hooks/useShelfSort";
import type { ShelfEntry } from "@/components/ShelfCard";
import type { Book, BookProgress } from "@/types";

/** The kind narrowing: everything, book-like titles, or raw docs trees.
 *  Audio-only titles share the book card, so they are "book". */
export type FilterKind = "all" | "book" | "docs";

export interface Discovery {
  query: string;
  kind: FilterKind;
  reading: ReadingFilter;
  tags: ReadonlySet<string>;
}

export function matchesKind(e: ShelfEntry, k: Exclude<FilterKind, "all">): boolean {
  return k === "docs" ? e.category === "docs" : e.category !== "docs";
}

/** Search or any filter is narrowing the library. */
export function discoveryActive(d: Discovery): boolean {
  return d.query.trim().length > 0 || d.tags.size > 0 || d.kind !== "all" ||
    d.reading !== "all";
}

/** Filters (not search) currently applied, for the toolbar badge. */
export function activeFilterCount(d: Discovery): number {
  return d.tags.size + (d.kind === "all" ? 0 : 1) + (d.reading === "all" ? 0 : 1);
}

/** When a title was last opened in either rendition (0 if never). */
export const openedAt = (bp: BookProgress | undefined): number =>
  Math.max(bp?.text?.updatedAt ?? 0, bp?.audio?.updatedAt ?? 0);

/** Order the shelf by the chosen sort. "updated" is content recency (the last
 *  sync that changed a title, else its first appearance); "read" puts the most
 *  recently opened first and never-opened titles last. Stable. */
export function sortShelf(
  entries: ShelfEntry[],
  sort: ShelfSort,
  progress: Record<string, BookProgress>,
  locale: string,
): ShelfEntry[] {
  const changedAt = (b: Book): number => b.updated_at || b.created_at || 0;
  const cmp: Record<ShelfSort, (a: ShelfEntry, z: ShelfEntry) => number> = {
    updated: (a, z) => changedAt(z.book) - changedAt(a.book),
    added: (a, z) => (z.book.created_at || 0) - (a.book.created_at || 0),
    name: (a, z) => a.book.label.localeCompare(z.book.label, locale),
    read: (a, z) =>
      openedAt(progress[z.book.slug]) - openedAt(progress[a.book.slug]) ||
      changedAt(z.book) - changedAt(a.book),
  };
  return [...entries].sort(cmp[sort]);
}

export interface NarrowContext {
  /** The selected directory, or null at the root. */
  directory: string | null;
  directoryOf: (book: Book) => string | null;
  progress: Record<string, BookProgress>;
  /** Each title's search match; null when the query excludes it. */
  matches: ReadonlyMap<string, BookSearchMatch | null>;
}

/**
 * The entries discovery shows. Searching is global; otherwise the selected
 * directory scopes the list. `withTags: false` computes the base set that tag
 * facet counts preview against (facet values OR within a facet, other
 * filters AND).
 */
export function narrowShelf(
  entries: readonly ShelfEntry[],
  d: Discovery,
  ctx: NarrowContext,
  withTags = true,
): { entry: ShelfEntry; match: BookSearchMatch }[] {
  const searching = d.query.trim().length > 0;
  const out: { entry: ShelfEntry; match: BookSearchMatch }[] = [];
  for (const entry of entries) {
    if (!searching && ctx.directory !== null && ctx.directoryOf(entry.book) !== ctx.directory) continue;
    if (d.kind !== "all" && !matchesKind(entry, d.kind)) continue;
    if (d.reading !== "all" && readingState(ctx.progress[entry.book.slug]) !== d.reading) continue;
    if (withTags && !matchesTagFacets(entry.book, d.tags)) continue;
    const match = ctx.matches.get(entry.book.slug);
    if (!match) continue;
    out.push({ entry, match });
  }
  return out;
}

/** What the toolbar's Back does: leave search/filters first (staying in the
 *  selected directory), else go up one level; nothing at an idle root. */
export function toolbarBack(
  d: Discovery,
  directory: string | null,
  parent: string | null,
): { kind: "exit-discovery"; to: string | null } | { kind: "up"; to: string | null } | null {
  if (discoveryActive(d)) return { kind: "exit-discovery", to: directory };
  if (directory !== null) return { kind: "up", to: parent };
  return null;
}
