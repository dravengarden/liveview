// Library search: folding, query grammar, typo-tolerant matching, and a
// tie-breaking ranking. See docs/design/library-search.md.
import type { Book } from "@/types";
import { tagLabel } from "./libraryDiscovery.ts";

/** A half-open `[start, end)` span of UTF-16 offsets in the original,
 * un-normalized string, so UI code can emphasize it directly. */
export interface TextRange {
  start: number;
  end: number;
}

type FieldKey =
  | "label"
  | "tags"
  | "directory"
  | "collection"
  | "author"
  | "description"
  | "slug";

type HighlightKey = Exclude<FieldKey, "tags" | "slug">;

/** Attribute order: a word found in a stronger field ranks first. Tags and the
 * user's folder are equally deliberate classifications. */
const FIELD_RANK: Record<FieldKey, number> = {
  label: 0,
  tags: 1,
  directory: 1,
  collection: 2,
  author: 3,
  description: 4,
  slug: 5,
};

/** Typos in long prose or slugs are noise, and scanning every description word
 * would dominate the per-keystroke cost, so approximate matching skips them. */
const APPROXIMATE_FIELDS: ReadonlySet<FieldKey> = new Set([
  "label",
  "tags",
  "directory",
  "collection",
  "author",
]);

const HIGHLIGHT_KEYS: ReadonlySet<FieldKey> = new Set([
  "label",
  "directory",
  "collection",
  "author",
  "description",
]);

const MAX_TOKENS = 8;
const MAX_HIGHLIGHTS_PER_VALUE = 8;
/** Close matches are dropped once this many exact results exist. */
const EXACT_RESULTS_ENOUGH = 3;

const ASCII_PRINTABLE = /^[ -~]*$/;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const FIELD_PREFIXES: Record<string, FieldKey> = {
  title: "label",
  author: "author",
  tag: "tags",
  collection: "collection",
  dir: "directory",
  folder: "directory",
};
const QUERY_TOKEN =
  /(-)?(?:(title|author|tag|collection|dir|folder):)?(?:"([^"]*)"?|(\S+))/giu;

// ---------------------------------------------------------------------------
// Folding

const foldedChars = new Map<string, string>();

/** Width, case, and Latin-diacritic folding for one code point. Kana voiced
 * marks (U+3099) are outside the stripped block and recompose. */
function foldChar(char: string): string {
  let folded = foldedChars.get(char);
  if (folded === undefined) {
    folded = char.normalize("NFKC").toLowerCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "").normalize("NFC");
    foldedChars.set(char, folded);
  }
  return folded;
}

interface Folded {
  text: string;
  /** Folded index → source offset (length `text.length + 1`); null when both
   * strings share offsets, which is every ASCII string and most others. */
  origin: readonly number[] | null;
}

function foldText(source: string): Folded {
  if (ASCII_PRINTABLE.test(source)) {
    return { text: source.toLowerCase(), origin: null };
  }
  let text = "";
  const origin: number[] = [];
  let identity = true;
  let at = 0;
  for (const char of source) {
    const folded = foldChar(char);
    if (folded.length !== char.length) identity = false;
    text += folded;
    for (let i = 0; i < folded.length; i++) origin.push(at);
    at += char.length;
  }
  origin.push(at);
  return { text, origin: identity ? null : origin };
}

// ---------------------------------------------------------------------------
// Index

interface SearchValue extends Folded {
  words: ReadonlyArray<readonly [start: number, end: number]>;
  tagId?: string;
}

function buildValue(source: string, tagId?: string): SearchValue | null {
  const folded = foldText(source);
  if (!folded.text.trim()) return null;
  const words = [...folded.text.matchAll(WORD)].map((match) =>
    [match.index, match.index + match[0].length] as const
  );
  return tagId === undefined
    ? { ...folded, words }
    : { ...folded, words, tagId };
}

interface SearchField {
  key: FieldKey;
  values: readonly SearchValue[];
}

export interface BookSearchIndex {
  fields: readonly SearchField[];
}

function field(
  key: FieldKey,
  sources: ReadonlyArray<string | null | undefined>,
): SearchField {
  return {
    key,
    values: sources.flatMap((source) => {
      const value = source ? buildValue(source) : null;
      return value ? [value] : [];
    }),
  };
}

/** Fold every searchable field once per catalog revision, not per keypress.
 * `directoryPath` is the user's own folder path for the book, so searching a
 * folder name also surfaces what was filed in it. */
export function buildBookSearchIndex(
  book: Book,
  directoryPath?: string | null,
): BookSearchIndex {
  const tagValues = (book.tags ?? []).flatMap((id) => {
    const label = buildValue(tagLabel(id), id);
    const raw = buildValue(id, id);
    return [label, raw && raw.text !== label?.text ? raw : null].filter((
      value,
    ): value is SearchValue => value !== null);
  });
  return {
    fields: [
      field("label", [book.label]),
      { key: "tags", values: tagValues },
      field("directory", [directoryPath]),
      field("collection", [book.collection]),
      field("author", [book.author]),
      field("description", [book.description]),
      field("slug", [book.slug]),
    ],
  };
}

/** An index over one folder path, searched with the same grammar and ranking. */
export function buildDirectorySearchIndex(path: string): BookSearchIndex {
  return { fields: [field("directory", [path])] };
}

// ---------------------------------------------------------------------------
// Query

export interface QueryToken {
  /** Folded text; may contain spaces for a quoted phrase. */
  text: string;
  /** Restricts the token to one field (`tag:ecology`). */
  field: FieldKey | null;
  /** `-word` removes every book that matches it. */
  exclude: boolean;
  phrase: boolean;
  cjk: boolean;
  /** Edits tolerated when nothing matches literally; 0 disables typos. */
  maxTypos: number;
}

export interface SearchQuery {
  tokens: readonly QueryToken[];
  /** The plain words joined by a space, rewarded when found in the title. */
  phrase: string;
}

/** Parse the query grammar: bare words (all required, any order), `"quoted
 * phrases"`, `-excluded` words, and `title:`/`author:`/`tag:`/`collection:`/
 * `dir:` field scopes. Anything else is literal text. */
export function parseSearchQuery(query: string): SearchQuery {
  const tokens: QueryToken[] = [];
  for (const match of query.matchAll(QUERY_TOKEN)) {
    if (tokens.length >= MAX_TOKENS) break;
    const phrase = match[3] !== undefined;
    const text = foldText((match[3] ?? match[4] ?? "").trim()).text
      .replace(/\s+/g, " ").trim();
    if (!WORD_CHAR.test(text)) continue;
    const cjk = CJK.test(text);
    const exclude = match[1] === "-";
    const typoable = !phrase && !exclude && !cjk && !/\d/.test(text);
    tokens.push({
      text,
      field: match[2] ? FIELD_PREFIXES[match[2].toLowerCase()] ?? null : null,
      exclude,
      phrase,
      cjk,
      maxTypos: typoable && text.length >= 4 ? (text.length >= 8 ? 2 : 1) : 0,
    });
  }
  const plain = tokens.filter((token) =>
    !token.exclude && !token.phrase && token.field === null
  );
  return {
    tokens,
    phrase: plain.length > 1 ? plain.map((token) => token.text).join(" ") : "",
  };
}

/** Whether a query narrows anything. */
export function hasSearchTerms(query: SearchQuery): boolean {
  return query.tokens.length > 0;
}

// ---------------------------------------------------------------------------
// Matching one query word against one field value

interface Match {
  /** Edits, or 1 for an initials / character-pair approximation. */
  typos: number;
  /** Only found inside a Latin word ("gorithm" in "algorithms"). */
  infix: boolean;
  /** Bounded by non-word characters on both sides. */
  whole: boolean;
  ranges: ReadonlyArray<readonly [start: number, end: number]>;
}

/** Whether `a` is a better match than `b` for one word: fewer typos, then not
 * an infix, then a whole word. */
function betterMatch(a: Match, b: Match): boolean {
  if (a.typos !== b.typos) return a.typos < b.typos;
  if (a.infix !== b.infix) return !a.infix;
  return a.whole && !b.whole;
}

const isWordAt = (text: string, at: number): boolean =>
  at >= 0 && at < text.length && WORD_CHAR.test(text[at]!);

/** Literal containment, classified by its best occurrence. */
function matchLiteral(token: QueryToken, value: SearchValue): Match | null {
  const { text } = value;
  const needle = token.text;
  let infix = true;
  let whole = false;
  const ranges: Array<readonly [number, number]> = [];
  for (
    let at = text.indexOf(needle);
    at >= 0 && ranges.length < MAX_HIGHLIGHTS_PER_VALUE;
    at = text.indexOf(needle, at + 1)
  ) {
    const end = at + needle.length;
    const bounded = !isWordAt(text, at - 1);
    // CJK is written without spaces: any hit is a real word hit.
    if (bounded || token.cjk) infix = false;
    if (bounded && !isWordAt(text, end)) whole = true;
    ranges.push([at, end]);
  }
  return ranges.length ? { typos: 0, infix, whole, ranges } : null;
}

/** Optimal-string-alignment distance (insert, delete, substitute, transpose),
 * abandoned as soon as it must exceed `max`. */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let beforePrevious: number[] | null = null;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let cost = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (
        beforePrevious && i > 1 && j > 1 && a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) cost = Math.min(cost, beforePrevious[j - 2]! + 1);
      row.push(cost);
      if (cost < rowMin) rowMin = cost;
    }
    if (rowMin > max) return max + 1;
    beforePrevious = previous;
    previous = row;
  }
  return previous[b.length]!;
}

/** Typo tolerance against whole words and word prefixes, so a typo made while
 * still typing ("wetlnd") finds "wetlands". Typos rarely hit the first letter,
 * so a differing initial rules a word out cheaply. */
function matchTypo(token: QueryToken, value: SearchValue): Match | null {
  const max = token.maxTypos;
  if (max === 0) return null;
  const needle = token.text;
  let best: Match | null = null;
  for (const [start, end] of value.words) {
    if (value.text[start] !== needle[0]) continue;
    const word = value.text.slice(start, end);
    let typos = boundedEditDistance(needle, word, max);
    let length = word.length;
    for (
      let prefix = Math.max(1, needle.length - max);
      prefix <= needle.length + max && prefix < word.length;
      prefix++
    ) {
      const candidate = boundedEditDistance(needle, word.slice(0, prefix), max);
      // On equal typos, highlight the span closest to what was typed.
      if (
        candidate < typos ||
        (candidate === typos &&
          Math.abs(prefix - needle.length) < Math.abs(length - needle.length))
      ) {
        typos = candidate;
        length = prefix;
      }
    }
    if (typos > max) continue;
    const match: Match = {
      typos,
      infix: false,
      whole: length === word.length,
      ranges: [[start, start + length]],
    };
    if (!best || betterMatch(match, best)) best = match;
  }
  return best;
}

/** "ml" finds "Machine Learning": the word spells the initials of a title or
 * folder path. */
function matchInitials(token: QueryToken, value: SearchValue): Match | null {
  const { text } = token;
  if (token.cjk || token.phrase || text.length < 2) return null;
  if (value.words.length < text.length) return null;
  for (let i = 0; i < text.length; i++) {
    if (value.text[value.words[i]![0]] !== text[i]) return null;
  }
  return {
    typos: 1,
    infix: false,
    whole: false,
    ranges: value.words.slice(0, text.length).map(([start]) =>
      [start, start + 1] as const
    ),
  };
}

/** CJK has no words to compare, so approximate by adjacent character pairs:
 * "模型推论" still finds "大模型推理" through 模型 and 型推. */
function matchCharacterPairs(
  token: QueryToken,
  value: SearchValue,
): Match | null {
  if (!token.cjk || token.phrase) return null;
  const chars = [...token.text];
  if (chars.length < 3) return null;
  const pairs = chars.slice(0, -1).map((char, i) => char + chars[i + 1]!);
  const ranges: Array<readonly [number, number]> = [];
  for (const pair of pairs) {
    const at = value.text.indexOf(pair);
    if (at >= 0) ranges.push([at, at + pair.length]);
  }
  if (ranges.length / pairs.length < 0.6) return null;
  return {
    typos: pairs.length - ranges.length,
    infix: false,
    whole: false,
    ranges,
  };
}

function matchApproximately(
  token: QueryToken,
  key: FieldKey,
  value: SearchValue,
): Match | null {
  if (token.cjk) return matchCharacterPairs(token, value);
  return matchTypo(token, value) ??
    (key === "label" || key === "directory"
      ? matchInitials(token, value)
      : null);
}

// ---------------------------------------------------------------------------
// Ranges

function toSourceRange(
  value: SearchValue,
  [start, end]: readonly [number, number],
): TextRange {
  const { origin } = value;
  if (!origin) return { start, end };
  // A folded range can stop inside an expanded character ("㈱" → "(株)");
  // extend it to the end of that source character.
  let last = end;
  while (last < origin.length - 1 && origin[last] === origin[end - 1]) last++;
  return { start: origin[start]!, end: origin[last]! };
}

export function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else merged.push({ ...range });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Ranking one book

export interface BookSearchMatch {
  /** Tie-breaking sort key; compare with `compareSearchMatches`. Empty for an
   * empty query, which matches everything without reordering. */
  rank: readonly number[];
  /** True when some word only matched by typo, initials, or character pairs. */
  approximate: boolean;
  /** Spans to emphasize in the fields a card shows. */
  highlights: Partial<Record<HighlightKey, TextRange[]>>;
  /** Ids of the tags whose text matched. */
  tags: string[];
}

/** Match one book, or return null when a required word is missing or an
 * excluded word is present. The rank follows docs/design/library-search.md:
 * typos, infix words, attribute, title phrase, exactness, title coverage. */
export function matchBookSearch(
  index: BookSearchIndex,
  query: SearchQuery,
): BookSearchMatch | null {
  const highlights = new Map<HighlightKey, TextRange[]>();
  const tags = new Set<string>();
  let typos = 0;
  let infixWords = 0;
  let attribute = 0;
  let wholeWords = 0;
  let labelCovered = 0;

  for (const token of query.tokens) {
    let best: { match: Match; rank: number } | null = null;
    let labelMatch: Match | null = null;
    const consider = (
      key: FieldKey,
      value: SearchValue,
      match: Match,
    ): void => {
      const rank = FIELD_RANK[key];
      if (
        !best || betterMatch(match, best.match) ||
        (!betterMatch(best.match, match) && rank < best.rank)
      ) best = { match, rank };
      if (key === "label") labelMatch = match;
      if (token.exclude) return;
      if (value.tagId !== undefined) tags.add(value.tagId);
      if (HIGHLIGHT_KEYS.has(key)) {
        const list = highlights.get(key as HighlightKey) ?? [];
        for (const range of match.ranges) {
          list.push(toSourceRange(value, range));
        }
        highlights.set(key as HighlightKey, list);
      }
    };
    const eligible = index.fields.filter((candidate) =>
      !token.field || token.field === candidate.key
    );
    for (const candidate of eligible) {
      for (const value of candidate.values) {
        const match = matchLiteral(token, value);
        if (match) consider(candidate.key, value, match);
      }
    }
    if (token.exclude) {
      if (best) return null;
      continue;
    }
    if (!best) {
      for (const candidate of eligible) {
        if (!APPROXIMATE_FIELDS.has(candidate.key)) continue;
        for (const value of candidate.values) {
          const match = matchApproximately(token, candidate.key, value);
          if (match) consider(candidate.key, value, match);
        }
      }
    }
    const found = best as { match: Match; rank: number } | null;
    if (!found) return null;
    typos += found.match.typos;
    if (found.match.infix) infixWords += 1;
    attribute += found.rank;
    if (found.match.whole) wholeWords += 1;
    if (labelMatch) labelCovered += token.text.length;
  }

  if (query.tokens.length === 0) {
    return { rank: [], approximate: false, highlights: {}, tags: [] };
  }
  const label = index.fields.find((candidate) => candidate.key === "label")
    ?.values[0]?.text ?? "";
  const phrase = query.phrase !== "" && label.includes(query.phrase);
  const titleEqualsQuery = query.tokens.length === 1 &&
    label === query.tokens[0]!.text;
  return {
    rank: [
      typos,
      infixWords,
      attribute,
      phrase ? 0 : 1,
      -wholeWords,
      titleEqualsQuery ? 0 : 1,
      label ? -Math.min(1, labelCovered / label.length) : 0,
    ],
    approximate: typos > 0,
    highlights: Object.fromEntries(
      [...highlights].map(([key, ranges]) => [key, mergeRanges(ranges)]),
    ),
    tags: [...tags],
  };
}

/** Order two matches, best first. Callers add their own final tie-breakers
 * (recent reading, then the shelf's sort order). */
export function compareSearchMatches(
  a: BookSearchMatch,
  b: BookSearchMatch,
): number {
  const length = Math.max(a.rank.length, b.rank.length);
  for (let i = 0; i < length; i++) {
    const delta = (a.rank[i] ?? 0) - (b.rank[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Close matches rescue typos; they are not padding. Once a few exact results
 * exist ("wetl" while typing "wetlands"), drop the approximate ones. */
export function settleApproximateMatches(
  matches: Map<string, BookSearchMatch | null>,
): void {
  let exact = 0;
  for (const match of matches.values()) {
    if (match && !match.approximate) exact += 1;
  }
  if (exact < EXACT_RESULTS_ENOUGH) return;
  for (const [slug, match] of matches) {
    if (match?.approximate) matches.set(slug, null);
  }
}

/** One-off matching; hot paths keep the index and the parsed query. */
export function searchBook(book: Book, query: string): BookSearchMatch | null {
  return matchBookSearch(buildBookSearchIndex(book), parseSearchQuery(query));
}

// ---------------------------------------------------------------------------
// Presentation helpers

export interface HighlightSegment {
  text: string;
  mark: boolean;
}

/** Cut `text` into alternating plain and emphasized segments. */
export function splitHighlight(
  text: string,
  ranges: readonly TextRange[] | undefined,
): HighlightSegment[] {
  if (!ranges?.length) return [{ text, mark: false }];
  const segments: HighlightSegment[] = [];
  let at = 0;
  for (const { start, end } of mergeRanges(ranges)) {
    const from = Math.max(start, at);
    const to = Math.min(end, text.length);
    if (to <= from) continue;
    if (from > at) segments.push({ text: text.slice(at, from), mark: false });
    segments.push({ text: text.slice(from, to), mark: true });
    at = to;
  }
  if (at < text.length) segments.push({ text: text.slice(at), mark: false });
  return segments;
}

export interface MatchContext {
  kind: "description" | "tags";
  text: string;
  ranges: TextRange[];
}

const SNIPPET_LENGTH = 110;
const SNIPPET_LEAD = 28;

/** Why a book matched when its card does not show it: a description excerpt
 * around the first hit, or the matched tags. */
export function matchContext(
  book: Book,
  match: BookSearchMatch,
): MatchContext | null {
  const hits = match.highlights.description;
  if (hits?.length && book.description) {
    // Same length as the source, so the match offsets stay valid.
    const description = book.description.replace(/\s/g, " ");
    const start = Math.max(0, hits[0]!.start - SNIPPET_LEAD);
    const end = Math.min(description.length, start + SNIPPET_LENGTH);
    const lead = start > 0 ? "…" : "";
    const shift = lead.length - start;
    return {
      kind: "description",
      text: `${lead}${description.slice(start, end)}${
        end < description.length ? "…" : ""
      }`,
      ranges: hits.filter((range) => range.end > start && range.start < end)
        .map((range) => ({
          start: Math.max(range.start, start) + shift,
          end: Math.min(range.end, end) + shift,
        })),
    };
  }
  if (match.tags.length) {
    return {
      kind: "tags",
      text: match.tags.map((id) => `#${tagLabel(id)}`).join("  "),
      ranges: [],
    };
  }
  return null;
}
