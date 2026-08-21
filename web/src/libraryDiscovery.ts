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

export interface BookSearchIndex {
  fields: ReadonlyArray<readonly [weight: number, values: readonly string[]]>;
}

const DEFAULT_TAG_FACET_ID = "tags";
const normalize = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase();

function tagParts(id: string): { facet: string; value: string } {
  const separator = id.indexOf(".");
  return separator > 0 && separator < id.length - 1
    ? { facet: id.slice(0, separator), value: id.slice(separator + 1) }
    : { facet: DEFAULT_TAG_FACET_ID, value: id };
}

export function tagLabel(id: string): string {
  const { value } = tagParts(id);
  return value
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toLocaleUpperCase() + word.slice(1))
    .join(" ");
}

function facetLabel(id: string): string {
  return id === DEFAULT_TAG_FACET_ID ? "Tags" : tagLabel(id);
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

/** Exact tag IDs carried by a book. Collections remain an independent
 * editorial grouping and never implicitly classify content. */
export function discoveryTagIds(book: Book): Set<string> {
  return new Set(book.tags ?? []);
}

/** Build the normalized fields once per catalog revision, not once per keypress. */
export function buildBookSearchIndex(book: Book): BookSearchIndex {
  const tagText = (book.tags ?? []).flatMap((id) => [id, tagLabel(id)]).map(
    normalize,
  );
  return {
    fields: [
      [12, [book.label]],
      [9, tagText],
      [7, [book.collection ?? ""]],
      [5, [book.author ?? ""]],
      [3, [book.description ?? ""]],
      [2, [book.slug]],
    ].map(([weight, values]) =>
      [weight as number, (values as string[]).map(normalize)] as const
    ),
  };
}

export function tokenizeSearchQuery(query: string): string[] {
  return normalize(query).trim().split(/\s+/).filter(Boolean);
}

/** Score a pre-normalized book index. Every token must match at least one field. */
export function scoreBookSearchIndex(
  index: BookSearchIndex,
  tokens: readonly string[],
): number | null {
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const [weight, values] of index.fields) {
      for (const value of values) {
        const at = value.indexOf(token);
        if (at >= 0) best = Math.max(best, weight + (at === 0 ? 2 : 0));
      }
    }
    if (best === 0) return null;
    total += best;
  }
  return total;
}

/** A weighted, dependency-free catalog search. Strong identity fields outrank
 * incidental prose matches. Callers handling repeated queries should retain the
 * index and use `scoreBookSearchIndex` directly. */
export function searchScore(book: Book, query: string): number | null {
  return scoreBookSearchIndex(
    buildBookSearchIndex(book),
    tokenizeSearchQuery(query),
  );
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
