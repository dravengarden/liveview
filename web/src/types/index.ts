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

export type WsMessage =
  | { type: "ContentUpdate"; path: string; lang: string; file_type: FileType; content: string }
  | { type: "TreeUpdate"; tree: TreeNode[] };

// Reading-oriented themes only (Day / Sepia / Dark / Night). The old
// code-editor schemes (solarized, dracula, nord, monokai, one-dark, gruvbox)
// were dropped — they read as IDE chrome, not a book.
export type Theme = "light" | "sepia" | "dark" | "night";

export interface ThemeOption {
  value: Theme;
  label: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { value: "light", label: "Light" },
  { value: "sepia", label: "Sepia" },
  { value: "dark", label: "Dark" },
  { value: "night", label: "Night" },
];

export interface MenuBarSettings {
  /** Max width of the markdown reading area in px. Smaller = bigger left/right
   *  margin (WeChat-style 页边距). 0 means "no limit" — use the viewport. */
  contentMaxWidth: number;
  /** Line height applied to markdown body content. */
  lineHeight: number;
}

// MIN is deliberately below phone-viewport width (~375px) so the slider visibly
// narrows the column (= bigger left/right margin, WeChat-style 页边距) even on
// mobile; with the old 640 floor every value exceeded the viewport and the
// control appeared to do nothing on a phone.
export const CONTENT_WIDTH_MIN = 320;
export const CONTENT_WIDTH_MAX = 1280;
export const CONTENT_WIDTH_STEP = 20;
export const CONTENT_WIDTH_DEFAULT = 960;

export const LINE_HEIGHT_MIN = 1.3;
export const LINE_HEIGHT_MAX = 2.2;
export const LINE_HEIGHT_STEP = 0.1;
export const LINE_HEIGHT_DEFAULT = 1.8;
