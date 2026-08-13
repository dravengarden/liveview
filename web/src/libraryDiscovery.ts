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

/** A weighted, dependency-free catalog search. Every query token must match at
 * least one field; strong identity fields outrank incidental prose matches. */
export function searchScore(book: Book, query: string): number | null {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const tagText = (book.tags ?? []).flatMap((id) => [id, tagLabel(id)]).map(
    normalize,
  );
  const fields: Array<[number, string[]]> = [
    [12, [book.label]],
    [9, tagText],
    [7, [book.collection ?? ""]],
    [5, [book.author ?? ""]],
    [3, [book.description ?? ""]],
    [2, [book.slug]],
  ].map((
    [weight, values],
  ) => [weight as number, (values as string[]).map(normalize)]);

  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const [weight, values] of fields) {
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
