# Library search

Status: implemented in `web/src/librarySearch.ts`.

## Problem

Library search was a weighted substring test: every query word had to appear
verbatim somewhere in a book's fields, and books were ordered by a sum of field
weights. It had four shortcomings:

1. A single typo ("wetlnds") returned nothing.
2. Ranking was a sum of magic weights, so order was hard to predict or explain.
   A short exact title could lose to a long title that repeated a word.
3. Results did not say why they matched. A hit inside a description or a tag
   looked like an unrelated title.
4. Folder search used a separate, case-folded `includes` test with no ranking.

Separately, focusing the search field zoomed the page on iPhone. iOS WebKit
zooms any focused text field whose computed font size is under 16 px and never
zooms back out. The field used `1rem`, and the app-wide font scale (presets
55%–125%) applies to the root font size, so every scale under 100% triggered the
zoom.

## Research

- **Confluence quick search** returns results while typing, highlights matched
  terms in titles and excerpts, shows the space (location) of each result, and
  lists spaces and people next to pages. Its advanced search adds filters and
  CQL field queries (`title ~`, `creator =`, `label =`). LiveView already has
  the location (user folder path), facet filters, and folder results. What it
  was missing is the highlight and the excerpt.
- **Algolia** documents a tie-breaking ranking. Results are sorted by a fixed
  sequence of criteria (typos, matched words, proximity, attribute, exactness,
  then a custom business signal). Each criterion only separates results that tie
  on every earlier one. Its typo tolerance allows one typo from four characters
  and two from eight, disables typos on numbers, treats the query's last word as
  a prefix, and can return typo matches only when no exact match exists.
- **Apple HIG (search fields)** recommends live results, a visible scope, and
  keeping the field usable with the keyboard up. LiveView's bottom search bar
  already rises above the keyboard.
- **Client libraries** (Fuse.js, MiniSearch, FlexSearch) were considered. Fuse's
  Bitap score is hard to reason about and slow on large lists. MiniSearch and
  FlexSearch tokenize on whitespace and handle CJK poorly without plugins. Each
  one also adds bundle weight under `tools/check-bundle-budget.ts`. The catalog
  is metadata only (title, tags, folder, collection, author, description, slug),
  so a small purpose-built matcher is both cheaper and better for mixed Chinese
  and English.

## Design

### Normalization

Each field is folded once per catalog or folder revision: NFKC (full-width
letters and compatibility forms), lowercase, and Latin diacritics removed
(`café` → `cafe`). Kana voiced marks are kept. Folding keeps an offset map to
the original string so highlights land on the original characters even when
folding changes length.

### Query grammar

Plain words are all required (AND) and may appear in any order. The grammar also
supports `"quoted phrase"` for literal adjacency, `-word` to exclude, and the
field scopes `title:`, `author:`, `tag:`, `collection:`, and `dir:` / `folder:`.
An unknown prefix is literal text. No syntax is required for ordinary use.

### Matching, per query word

1. **Literal**: the word is contained in the field. Each hit is classified as a
   whole word, a word start (prefix), or an infix (inside a Latin word). CJK has
   no spaces, so a CJK hit is never an infix.
2. **Approximate**, only when no field matched literally:
   - Latin typo: optimal-string-alignment edit distance to a word or a word
     prefix. One edit is allowed from 4 characters and two from 8. Words with
     digits, quoted phrases, and excluded words are never approximated. The
     first letter must match. That rule cuts noise and keeps the scan cheap.
   - Initials: `ml` matches "Machine Learning" (titles only).
   - CJK character pairs: at least 60% of the word's adjacent character pairs
     appear in the field, so `模型推论` finds `大模型推理`.
   - Approximation skips description and slug. Typos in prose are noise, and
     scanning every description word would dominate keystroke cost.

### Ranking

Results sort by these criteria in order, each breaking the previous tie:

1. **Typos**: total edits (initials and CJK pair matches count as approximate).
2. **Infix words**: query words that only matched inside a Latin word.
3. **Attribute**: sum of each word's best field rank: title, then tags and
   folder, then collection, then author, then description, then slug.
4. **Phrase**: the plain words appear in order and adjacent in the title.
5. **Exactness**: more whole-word matches first, then a title equal to the
   query.
6. **Coverage**: the share of the title covered by the query, so "编译原理"
   beats a long title that merely mentions "原理".
7. **Recently opened**: the latest reading or listening time.
8. The shelf's own sort order (stable sort).

Typo matches are a rescue, not padding. Once three or more exact results exist
(for example while "wetl" is being typed toward "wetlands"), approximate results
are dropped, and the result summary says when close matches are shown.

### Presentation

- Matched spans are highlighted in titles, folder paths, collections, and
  authors with a flat primary tint. There is no filter or blend mode, per the
  scrolling-surface material rules.
- When a match is not visible on the card, one line explains it: a description
  excerpt around the first hit, or the matched tags.
- Folders use the same engine and are ranked and highlighted the same way.
- A book is also searchable by the path of the user folder it is filed in.

### Performance

Indexes are memoized per catalog and folder revision. The query is passed
through `useDeferredValue`, so typing and IME composition are never blocked by
result rendering. On 5,000 synthetic books, matching takes about 5–20 ms per
query and indexing about 100 ms once per catalog.

### Text-field zoom

On coarse pointers, every MUI input has `font-size: max(16px, 1rem)`. The field
never drops under iOS's zoom threshold, and larger font scales still apply.
Disabling zoom in the viewport meta was rejected because it removes pinch zoom
for accessibility.

## Not in scope

- **Pinyin search** (`dmx` → 大模型). It needs a character-to-pinyin dictionary
  (hundreds of KB on the client). A better place is a server-generated catalog
  field, which is a protocol addition and should be its own change.
- **Full-text search inside chapters.** It needs a server or replica index; the
  catalog currently carries metadata only.
- **Recent queries and suggestions on focus.** The Continue section already
  covers recently opened content.
