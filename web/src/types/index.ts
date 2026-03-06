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

export type WsMessage =
  | { type: "ContentUpdate"; path: string; file_type: FileType; content: string }
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

export interface ExtensionGroup {
  name: string;
  extensions: string[];
}

export const EXTENSION_GROUPS: ExtensionGroup[] = [
  { name: "Markdown", extensions: ["md", "markdown"] },
  { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp", "ico", "tiff", "tif"] },
  { name: "PDF", extensions: ["pdf"] },
  { name: "HTML", extensions: ["html", "htm"] },
  { name: "Data", extensions: ["csv", "tsv", "json", "jsonc", "json5"] },
  { name: "Excalidraw", extensions: ["excalidraw"] },
  { name: "LaTeX", extensions: ["tex", "latex"] },
  { name: "Typst", extensions: ["typ", "typst"] },
];

export interface ExtensionSettings {
  enabledGroups: string[];
}

export const ALL_EXTENSION_GROUP_NAMES = EXTENSION_GROUPS.map(g => g.name);
