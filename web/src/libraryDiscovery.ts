import taxonomyJson from "../../taxonomy.json" with { type: "json" };
import type { Book, BookProgress } from "@/types";

export interface TaxonomyFacet {
  id: string;
  labels: Record<"en" | "zh", string>;
}

export interface TaxonomyTag {
  id: string;
  facet: string;
  labels: Record<"en" | "zh", string>;
  aliases: string[];
}

export interface LibraryTaxonomy {
  facets: TaxonomyFacet[];
  tags: TaxonomyTag[];
}

export const LIBRARY_TAXONOMY = taxonomyJson as LibraryTaxonomy;
export const TAG_BY_ID = new Map(
  LIBRARY_TAXONOMY.tags.map((tag) => [tag.id, tag]),
);

const normalize = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase();

const tagKey = (value: string): string =>
  normalize(value).trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const TAXONOMY_ID_BY_KEY = new Map<string, string>();
for (const tag of LIBRARY_TAXONOMY.tags) {
  for (const value of [tag.id, ...tag.aliases]) {
    TAXONOMY_ID_BY_KEY.set(tagKey(value), tag.id);
  }
}

/** Map open-vocabulary manifest keywords onto the small, stable facet catalog. */
export function discoveryTagIds(book: Book): Set<string> {
  const ids = new Set<string>();
  const collectionSignals = book.collection
    ? [book.collection, ...book.collection.split(/[&/]/)]
    : [];
  for (const raw of [...(book.tags ?? []), ...collectionSignals]) {
    const id = TAG_BY_ID.has(raw) ? raw : TAXONOMY_ID_BY_KEY.get(tagKey(raw));
    if (id) ids.add(id);
  }
  return ids;
}

/** A weighted, dependency-free catalog search. Every query token must match at
 * least one field; strong identity fields outrank incidental prose matches. */
export function searchScore(book: Book, query: string): number | null {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const tagText = (book.tags ?? []).flatMap((id) => {
    const tag = TAG_BY_ID.get(id);
    return tag ? [id, tag.labels.en, tag.labels.zh, ...tag.aliases] : [id];
  }).map(normalize);
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
    const facet = TAG_BY_ID.get(id)?.facet ?? "unknown";
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

export type ReadingFilter = "all" | "unread" | "progress" | "finished";

export function readingState(
  progress: BookProgress | undefined,
): Exclude<ReadingFilter, "all"> {
  const fractions = [progress?.text?.fraction, progress?.audio?.fraction]
    .filter((value): value is number => value != null);
  if (fractions.length === 0) return "unread";
  return Math.max(...fractions) >= 0.98 ? "finished" : "progress";
}
