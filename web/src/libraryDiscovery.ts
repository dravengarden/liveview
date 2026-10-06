import type { Book, BookProgress } from "@/types";

export interface TaxonomyFacet {
  id: string;
  label: string;
}

export interface TaxonomyTag {
  id: string;
  facet: string;
  label: string;
}

export interface LibraryTaxonomy {
  facets: TaxonomyFacet[];
  tags: TaxonomyTag[];
}

const DEFAULT_TAG_FACET_ID = "tags";

function tagParts(id: string): { facet: string; value: string } {
  const separator = id.indexOf(".");
  return separator > 0 && separator < id.length - 1
    ? { facet: id.slice(0, separator), value: id.slice(separator + 1) }
    : { facet: DEFAULT_TAG_FACET_ID, value: id };
}

/** A tag value's words as authored. Tags are lowercase keywords full of
 *  acronyms and identifiers (`llm-agent`, `abi-stability`, `erc-4626`), so
 *  title-casing would print "Llm Agent"; LiveView keeps the author's casing. */
export function tagLabel(id: string): string {
  return words(tagParts(id).value).join(" ");
}

function words(value: string): string[] {
  return value.split(/[._-]+/).filter(Boolean);
}

/** A facet heading (`subject` → "Subject"): one sentence-cased phrase. */
function facetLabel(id: string): string {
  if (id === DEFAULT_TAG_FACET_ID) return "Tags";
  const label = words(id).join(" ");
  return label.charAt(0).toLocaleUpperCase() + label.slice(1);
}

/** Derive the available filters from author-owned catalog tags. A tag named
 * `facet.value` opts into that facet; unnamespaced tags share the generic Tags
 * facet. LiveView provides the convention and never ships a subject vocabulary. */
export function buildLibraryTaxonomy(
  books: readonly Book[],
): LibraryTaxonomy {
  const ids = [...new Set(books.flatMap((book) => book.tags ?? []))].sort();
  const facetIds = new Set<string>();
  const tags = ids.map((id): TaxonomyTag => {
    const { facet } = tagParts(id);
    facetIds.add(facet);
    const label = tagLabel(id);
    return {
      id,
      facet,
      label,
    };
  });
  const namedFacets = [...facetIds].filter((id) => id !== DEFAULT_TAG_FACET_ID)
    .sort();
  if (facetIds.has(DEFAULT_TAG_FACET_ID)) {
    namedFacets.push(DEFAULT_TAG_FACET_ID);
  }
  return {
    facets: namedFacets.map((id) => ({ id, label: facetLabel(id) })),
    tags,
  };
}

/** Facets with more values than this start folded in the filter sheet. A
 * catalog-wide tag facet can hold hundreds of chips that bury the reading-state
 * and sort controls; small facets stay open because folding them only adds a tap. */
export const FACET_FOLD_THRESHOLD = 12;

export function facetStartsFolded(valueCount: number): boolean {
  return valueCount > FACET_FOLD_THRESHOLD;
}

/** Exact tag IDs carried by a book. Collections remain an independent
 * editorial grouping and never implicitly classify content. */
export function discoveryTagIds(book: Book): Set<string> {
  return new Set(book.tags ?? []);
}

export function matchesTagFacets(
  book: Book,
  selected: ReadonlySet<string>,
): boolean {
  if (selected.size === 0) return true;
  const selectedByFacet = new Map<string, Set<string>>();
  for (const id of selected) {
    const { facet } = tagParts(id);
    const ids = selectedByFacet.get(facet) ?? new Set<string>();
    ids.add(id);
    selectedByFacet.set(facet, ids);
  }
  const bookTags = discoveryTagIds(book);
  // OR within a facet, AND across facets.
  return [...selectedByFacet.values()].every((ids) =>
    [...ids].some((id) => bookTags.has(id))
  );
}

/** Count the result of adding each candidate tag to the current selection.
 *
 * This is deliberately book-linear for the common no-selection case. The old
 * UI implementation tested every taxonomy tag against every book and repeated
 * the full text search inside that nested loop, freezing a large WKWebView
 * catalog on every keypress. */
export function countTagFacetMatches(
  books: readonly Book[],
  tags: readonly TaxonomyTag[],
  selected: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map(tags.map((tag) => [tag.id, 0]));
  const selectedByFacet = new Map<string, Set<string>>();
  for (const id of selected) {
    const { facet } = tagParts(id);
    const ids = selectedByFacet.get(facet) ?? new Set<string>();
    ids.add(id);
    selectedByFacet.set(facet, ids);
  }

  const increment = (id: string): void => {
    const current = counts.get(id);
    if (current != null) counts.set(id, current + 1);
  };

  let fullyMatchedBooks = 0;
  for (const book of books) {
    const bookTags = discoveryTagIds(book);
    const missingFacets: string[] = [];
    for (const [facet, ids] of selectedByFacet) {
      if (![...ids].some((id) => bookTags.has(id))) missingFacets.push(facet);
      if (missingFacets.length > 1) break;
    }

    // A candidate can repair at most its own facet. Two missing selected facets
    // therefore make this book ineligible for every single candidate.
    if (missingFacets.length > 1) continue;
    if (missingFacets.length === 1) {
      const missing = missingFacets[0]!;
      for (const id of bookTags) {
        if (tagParts(id).facet === missing) increment(id);
      }
      continue;
    }

    // All selected facets already match. Adding another value to a selected
    // facet preserves its OR match regardless of whether this book has that
    // value; adding a new facet requires the book to carry the candidate.
    fullyMatchedBooks += 1;
    for (const id of bookTags) {
      if (!selectedByFacet.has(tagParts(id).facet)) increment(id);
    }
  }

  // Every fully matching book contributes to every candidate in an already
  // selected facet. Apply that shared contribution once per tag instead of
  // revisiting the whole facet for every book.
  if (fullyMatchedBooks > 0) {
    for (const tag of tags) {
      if (selectedByFacet.has(tag.facet)) {
        counts.set(tag.id, counts.get(tag.id)! + fullyMatchedBooks);
      }
    }
  }

  return counts;
}

/** Locale-aware collection order without product-specific priority lists. */
export function sortCollectionNames(
  names: Iterable<string>,
  locale: string,
): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, locale));
}

export type ReadingFilter = "all" | "unread" | "progress" | "finished";

export function readingState(
  progress: BookProgress | undefined,
): Exclude<ReadingFilter, "all"> {
  const fractions = [progress?.text?.fraction, progress?.audio?.fraction]
    .filter((value): value is number => value != null);
  if (fractions.length === 0) return "unread";
  return Math.max(...fractions) >= 0.98 ? "finished" : "progress";
}
