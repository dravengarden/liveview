export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeNode[];
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
  file_type: FileType;
  content: string;
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
}
