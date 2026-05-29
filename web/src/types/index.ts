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

/** A book as shown on the landing "bookshelf". */
export interface Book {
  label: string;
  slug: string;
  description?: string | null;
  default_lang: string;
  langs: LangInfo[];
  /** `[features].audio` — whether to offer the audiobook read-along player. */
  audio: boolean;
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

export type Theme =
  | "light"
  | "dark"
  | "solarized-light"
  | "solarized-dark"
  | "dracula"
  | "nord"
  | "monokai"
  | "one-dark"
  | "gruvbox-light"
  | "gruvbox-dark";

export interface ThemeOption {
  value: Theme;
  label: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "solarized-light", label: "Solarized Light" },
  { value: "solarized-dark", label: "Solarized Dark" },
  { value: "dracula", label: "Dracula" },
  { value: "nord", label: "Nord" },
  { value: "monokai", label: "Monokai" },
  { value: "one-dark", label: "One Dark" },
  { value: "gruvbox-light", label: "Gruvbox Light" },
  { value: "gruvbox-dark", label: "Gruvbox Dark" },
];

export interface MenuBarSettings {
  floatOpacity: number;
  /** Max width of the markdown reading area in px. Smaller = bigger left/right
   *  margin (WeChat-style 页边距). 0 means "no limit" — use the viewport. */
  contentMaxWidth: number;
  /** Line height applied to markdown body content. */
  lineHeight: number;
}

export const CONTENT_WIDTH_MIN = 640;
export const CONTENT_WIDTH_MAX = 1280;
export const CONTENT_WIDTH_STEP = 40;
export const CONTENT_WIDTH_DEFAULT = 960;

export const LINE_HEIGHT_MIN = 1.3;
export const LINE_HEIGHT_MAX = 2.2;
export const LINE_HEIGHT_STEP = 0.1;
export const LINE_HEIGHT_DEFAULT = 1.5;
