export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeNode[];
  /** Per-language sidebar titles (lang code → title) for `book.toml` spine
   *  chapters whose H1 differs by edition. The sidebar shows
   *  `titles[currentLang] ?? name`. Absent for plain file-tree nodes. */
  titles?: Record<string, string> | null;
}

export type FileType =
  | "markdown"
  | "image"
  | "pdf"
  | "html"
  | "csv"
  | "json"
  | "excalidraw"
  | "latex"
  | "typst"
  | "interactive-view"
  | "unknown";

export interface FileContent {
  path: string;
  /** Language edition actually served (may differ from the requested lang when
   *  the page is missing there and the server fell back to the base edition). */
  lang: string;
  file_type: FileType;
  content: string;
}

/** A document's saved reading position (scroll as a 0..1 ratio of scrollable
 *  height). `updated_at` is Unix epoch ms; rows arrive newest-first per book. */
export interface ProgressEntry {
  path: string;
  scroll: number;
  updated_at: number;
}

/** A book's "continue reading" state for the landing page: which chapter the
 *  reader last opened, a human label for it, and how far into it (0..1). */
export interface ReadingProgress {
  /** Virtual doc path (`<slug>/<chapter>`) to resume. */
  path: string;
  /** Display title of that chapter (current UI edition, falling back to name). */
  chapterLabel: string;
  /** Scroll position within the chapter, 0..1. */
  scroll: number;
  /** Book-level progress, 0..1: (resume chapter's index in the spine + its
   *  in-chapter scroll) / total chapters. This is what the shelf meter shows —
   *  "how far through the whole book" — so being at the top of chapter 11 of 14
   *  reads ~71%, not the 0% the in-chapter `scroll` alone would give. Falls back
   *  to `scroll` when the chapter isn't found in the loaded spine. */
  fraction: number;
  /** When this position was last written (Unix epoch ms) — drives the shelf's
   *  "last opened" stamp and its default most-recent-first ordering. */
  updatedAt: number;
}

/** A book's continue state split by rendition, for the shelf card. A text+audio
 *  book carries BOTH (read 35% / listen 13%) so the card shows them side by
 *  side; a text-only or audio-only book carries just the one. Either side is
 *  absent when that rendition was never opened. */
export interface BookProgress {
  text?: ReadingProgress;
  audio?: ReadingProgress;
}

/** A language edition of a book, for the in-book language switcher. */
export interface LangInfo {
  lang: string;
  label: string;
}

/** A reading mode of a book (text vs audio), for the rendition switcher. Each
 *  rendition carries its own default language + language list — the lang
 *  switcher shows the *active* rendition's `langs`. */
export interface RenditionInfo {
  kind: "text" | "audio";
  /** Mode-toggle label (e.g. "阅读" / "听书"). */
  label: string;
  default_lang: string;
  langs: LangInfo[];
}

/** A book as shown on the landing "bookshelf". */
export interface Book {
  label: string;
  slug: string;
  description?: string | null;
  /** The series/collection this book belongs to (e.g. "AI & Agents"), used by
   *  the shelf's optional group-by-series view. Null/empty ⇒ ungrouped. */
  collection?: string | null;
  /** Optional credit line shown on the shelf card (book.toml `author`): the
   *  authoring agent, or "<original author> · Claude Code 修订" for a converted/
   *  translated book. Null/empty ⇒ no byline. */
  author?: string | null;
  /** Whether a cover image is available at `/api/cover?book=<slug>`. */
  cover: boolean;
  /** Which rendition kind the book opens in. */
  default_rendition: string;
  /** Every reading mode the book offers (always ≥1). */
  renditions: RenditionInfo[];
  /** Mirrors the default rendition's languages, for back-compat. Prefer the
   *  active rendition's `langs` from {@link renditions}. */
  default_lang: string;
  langs: LangInfo[];
  /** `true` for a `book.toml`-driven book → "book" mode: the sidebar is a
   *  clean, titled spine (no root folder, no file icons). `false` for a plain
   *  `[[book]]`/`[[mount]]` → "docs" mode: the raw filesystem tree. */
  manifest: boolean;
  /** Deploy-time stamps (unix ms): when the book first appeared on the shelf,
   *  and the last sync that changed its content. 0 ⇒ never stamped (hide). */
  created_at: number;
  updated_at: number;
}

/** Read-along narration text: the chapter stripped to speakable sentences.
 *  Sentence index = the `data-sent` anchor and the {@link Mark} index. */
export interface SpokenContent {
  lang: string;
  sentences: string[];
}

/** One sentence's time range into the concatenated chapter audio (ms). */
export interface Mark {
  idx: number;
  start_ms: number;
  end_ms: number;
}

/** Kind of a read-along unit (`/api/units`). Non-prose kinds carry no spoken
 *  text yet (narrated later, or skipped); they let the highlight step over /
 *  outline the block in place. */
export type UnitKind = "prose" | "image" | "math" | "code" | "table" | "html";

/** One read-along unit: a prose sentence or a classified non-prose block.
 *  `idx` matches the {@link Mark} index; `blk` is the ordinal of the top-level
 *  rendered block it lives in (the in-place-highlight anchor). */
export interface Unit {
  idx: number;
  kind: UnitKind;
  blk: number;
  /** 1-based source line of the unit's top-level block — the stable highlight
   *  anchor, matching the `data-sourcepos="<line>:…"` the server emits on that
   *  block. Preferred over `blk` (which relies on counting `body.children`). */
  line: number;
  text: string;
}

/** Response of `/api/units` — the richer sibling of {@link SpokenContent}. */
export interface SpokenUnits {
  lang: string;
  units: Unit[];
}

export type WsMessage =
  | {
    type: "ContentUpdate";
    path: string;
    lang: string;
    file_type: FileType;
    content: string;
  }
  | { type: "TreeUpdate"; tree: TreeNode[] }
  | { type: "SettingUpdate"; key: string; value: string }
  // Server push of the current app-bundle version (sent on WS connect). The
  // native shell reacts by running the OTA check; the web/PWA ignores it.
  | { type: "AppVersion"; version: string };

// Reading-oriented themes only (Day / Sepia / Dark / Night). The old
// code-editor schemes (solarized, dracula, nord, monokai, one-dark, gruvbox)
// were dropped — they read as IDE chrome, not a book.
export type Theme =
  | "light"
  | "sepia"
  | "lavender"
  | "dark"
  | "night"
  | "plum";

/** The two independent theme axes (settings exposes them as two controls):
 *  a colour-palette VARIANT, each a light+dark pair, and a MODE that picks
 *  which half of the pair to use (auto = follow the OS). */
export type ThemeVariant = "classic" | "warm" | "purple";
export type ThemeMode = "auto" | "light" | "dark";

/** variant → its light/dark pair (the 6 flat themes are derived from these). */
export const THEME_VARIANTS: Record<
  ThemeVariant,
  { light: Theme; dark: Theme }
> = {
  classic: { light: "light", dark: "dark" },
  warm: { light: "sepia", dark: "night" },
  purple: { light: "lavender", dark: "plum" },
};

export interface VariantOption {
  value: ThemeVariant;
  label: string;
}

export const VARIANT_OPTIONS: VariantOption[] = [
  { value: "classic", label: "Classic" },
  { value: "warm", label: "Warm" },
  { value: "purple", label: "Purple" },
];

export interface MenuBarSettings {
  /** Horizontal reading MARGIN in px (left/right padding of the reading
   *  column). Unlike the old max-width this also works on a phone, where the
   *  viewport is already narrower than any sensible max-width. (Field name kept
   *  for storage back-compat; it no longer means a width.) */
  contentMaxWidth: number;
  /** Line height applied to markdown body content. */
  lineHeight: number;
  /** App-wide font-size multiplier (1 = unchanged). Applied as the root <html>
   *  font-size, so every rem/em surface scales together — the reading prose AND
   *  the MUI-Typography chrome — like cowboy. Fixed-px chrome (nav/icon buttons,
   *  the settings gear) stays put. */
  fontScale: number;
}

// Reading MARGIN range (px of left/right padding). A fixed column cap
// (READING_COLUMN_MAX) keeps desktop line-length comfortable; the margin then
// just adds side gutter, and on a phone it directly controls the side whitespace.
// Band matches cowboy's reading padding (8–48px).
export const CONTENT_WIDTH_MIN = 8;
export const CONTENT_WIDTH_MAX = 48;
export const CONTENT_WIDTH_STEP = 4;
export const CONTENT_WIDTH_DEFAULT = 16;
/** Fixed max width of the reading column (not user-controlled). */
export const READING_COLUMN_MAX = 900;

// Reading line-height band (matches cowboy 1.3–2).
export const LINE_HEIGHT_MIN = 1.3;
export const LINE_HEIGHT_MAX = 2.0;
export const LINE_HEIGHT_STEP = 0.1;
export const LINE_HEIGHT_DEFAULT = 1.8;

// App-wide font-size multiplier (1 = unchanged), applied as the root <html>
// font-size so every rem/em surface scales together — reading prose AND the
// MUI-Typography chrome — exactly like cowboy's useGlobalFontScale. Fixed-px
// chrome (nav/icon buttons, the settings gear) stays put by design. The clamp
// band is wider than the picker's presets so a hand-edited value is honoured
// while garbage snaps back to the default.
export const FONT_SCALE_MIN = 0.5;
export const FONT_SCALE_MAX = 2.0;
export const FONT_SCALE_DEFAULT = 1.0;
