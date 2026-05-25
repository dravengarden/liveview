// Self-hosted, lazy-loaded reading fonts.
//
// Every preset is a bundled web font (via @fontsource) — we never rely on the
// reader's system fonts. Faces are loaded on demand: each preset's `load()`
// dynamically imports its @fontsource CSS, so Vite emits the woff2 in separate
// async chunks that the browser only fetches when that font is selected.
//
// Each preset pairs a Latin reading face with a CJK companion (Noto SC) so
// mixed English / 中文 books render fully. The CJK CSS uses `unicode-range`
// per glyph slice, so only the slices a page actually uses are downloaded.

export interface FontPreset {
  /** Stable id persisted in localStorage. */
  id: string;
  /** Display name (proper noun — not translated). */
  label: string;
  /** Short descriptor shown under the name. */
  note: string;
  /** CSS `font-family` value applied to the reading surface. */
  stack: string;
  /** Lazily inject the font faces. Resolves once the CSS is registered. */
  load: () => Promise<unknown>;
}

const GENERIC_SANS =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const GENERIC_SERIF = "Georgia, Cambria, 'Times New Roman', serif";

// Shared CJK companions — imported once, then cached by the bundler/browser,
// so multiple presets that share a companion don't re-download it.
const loadNotoSansSC = (): Promise<unknown> =>
  Promise.all([
    import("@fontsource/noto-sans-sc/chinese-simplified-400.css"),
    import("@fontsource/noto-sans-sc/chinese-simplified-700.css"),
  ]);

const loadNotoSerifSC = (): Promise<unknown> =>
  Promise.all([
    import("@fontsource/noto-serif-sc/chinese-simplified-400.css"),
    import("@fontsource/noto-serif-sc/chinese-simplified-700.css"),
  ]);

export const FONT_PRESETS: FontPreset[] = [
  {
    id: "inter",
    label: "Inter",
    note: "Sans · 无衬线",
    stack: `'Inter Variable', 'Noto Sans SC', ${GENERIC_SANS}`,
    load: () =>
      Promise.all([import("@fontsource-variable/inter/wght.css"), loadNotoSansSC()]),
  },
  {
    id: "ibm-plex-sans",
    label: "IBM Plex Sans",
    note: "Humanist · 人文无衬线",
    stack: `'IBM Plex Sans Variable', 'Noto Sans SC', ${GENERIC_SANS}`,
    load: () =>
      Promise.all([
        import("@fontsource-variable/ibm-plex-sans/wght.css"),
        loadNotoSansSC(),
      ]),
  },
  {
    id: "atkinson",
    label: "Atkinson Hyperlegible",
    note: "Legibility · 易读",
    stack: `'Atkinson Hyperlegible', 'Noto Sans SC', ${GENERIC_SANS}`,
    load: () =>
      Promise.all([
        import("@fontsource/atkinson-hyperlegible/400.css"),
        import("@fontsource/atkinson-hyperlegible/700.css"),
        loadNotoSansSC(),
      ]),
  },
  {
    id: "source-serif-4",
    label: "Source Serif 4",
    note: "Serif · 衬线",
    stack: `'Source Serif 4 Variable', 'Noto Serif SC', ${GENERIC_SERIF}`,
    load: () =>
      Promise.all([
        import("@fontsource-variable/source-serif-4/wght.css"),
        loadNotoSerifSC(),
      ]),
  },
  {
    id: "lora",
    label: "Lora",
    note: "Literary · 文学衬线",
    stack: `'Lora Variable', 'Noto Serif SC', ${GENERIC_SERIF}`,
    load: () =>
      Promise.all([import("@fontsource-variable/lora/wght.css"), loadNotoSerifSC()]),
  },
  {
    id: "newsreader",
    label: "Newsreader",
    note: "Long-form · 长文阅读",
    stack: `'Newsreader Variable', 'Noto Serif SC', ${GENERIC_SERIF}`,
    load: () =>
      Promise.all([
        import("@fontsource-variable/newsreader/wght.css"),
        loadNotoSerifSC(),
      ]),
  },
  {
    id: "system",
    label: "System",
    note: "No web font · 系统字体",
    stack: GENERIC_SANS,
    load: () => Promise.resolve(),
  },
];

export const DEFAULT_FONT_ID = "inter";

const DEFAULT_PRESET: FontPreset = FONT_PRESETS[0] ?? {
  id: "system",
  label: "System",
  note: "",
  stack: GENERIC_SANS,
  load: () => Promise.resolve(),
};

export function getFontPreset(id: string): FontPreset {
  return FONT_PRESETS.find((p) => p.id === id) ?? DEFAULT_PRESET;
}
