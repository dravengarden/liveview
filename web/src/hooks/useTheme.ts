import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTheme, type Theme as MuiTheme } from "@mui/material/styles";
import { persisted, useStore } from "@/_store/mod.ts";
import type { Theme, ThemeMode, ThemeVariant } from "@/types";
import { THEME_VARIANTS } from "@/types";

// Theme is two axes: a colour VARIANT (classic/warm/purple) and a MODE
// (auto/light/dark). The flat theme value is derived from them. Persisted
// device-local in localStorage (not server-synced — only progress is): two
// `persisted` stores, one per axis, each storing a bare enum string (matching
// the pre-migration on-disk format so existing installs keep their look).
const VARIANT_KEY = "lv-theme-variant";
const MODE_KEY = "lv-theme-mode";
const LEGACY_THEME_KEY = "lv-theme";

const VALID_VARIANTS: ThemeVariant[] = ["classic", "warm", "purple"];
const VALID_MODES: ThemeMode[] = ["auto", "light", "dark"];

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve the (variant, mode) pair to one of the 4 flat themes. */
function resolveTheme(
  variant: ThemeVariant,
  mode: ThemeMode,
  sysDark: boolean,
): Theme {
  const effective = mode === "auto" ? (sysDark ? "dark" : "light") : mode;
  return THEME_VARIANTS[variant][effective];
}

/** Map a legacy flat-theme choice onto the new (variant, mode) axes, so an
 *  existing install keeps its look on first load after the upgrade. */
function migrateLegacy(): { variant: ThemeVariant; mode: ThemeMode } | null {
  switch (localStorage.getItem(LEGACY_THEME_KEY)) {
    case "light":
      return { variant: "classic", mode: "light" };
    case "dark":
      return { variant: "classic", mode: "dark" };
    case "sepia":
      return { variant: "warm", mode: "light" };
    case "night":
      return { variant: "warm", mode: "dark" };
    default:
      return null;
  }
}

// The legacy single-key migration, resolved ONCE at module load. Each axis store
// uses its legacy half as `initial` (the value `persisted` returns when the new
// per-axis key is absent), so an existing install keeps its look on first load
// after the upgrade. Once the user touches either axis, the new key is written
// and the legacy fallback no longer applies — exactly the pre-migration per-axis
// behaviour.
const legacyMigration = migrateLegacy();

// Two device-LOCAL `persisted` stores, one per axis. `deserialize` validates the
// stored enum string, snapping an unknown value back to `initial` (= the legacy
// fallback). Bare-string format, so serialize is identity.
const variantStore = persisted<ThemeVariant>(
  VARIANT_KEY,
  legacyMigration?.variant ?? "classic",
  {
    serialize: (v) => v,
    deserialize: (raw) =>
      VALID_VARIANTS.includes(raw as ThemeVariant)
        ? (raw as ThemeVariant)
        : (legacyMigration?.variant ?? "classic"),
  },
);
const modeStore = persisted<ThemeMode>(
  MODE_KEY,
  legacyMigration?.mode ?? "auto",
  {
    serialize: (v) => v,
    deserialize: (raw) =>
      VALID_MODES.includes(raw as ThemeMode)
        ? (raw as ThemeMode)
        : (legacyMigration?.mode ?? "auto"),
  },
);

// Explicit, not name-based: "sepia" is a light theme yet has no "light" in its
// name, so a substring test would misclassify it (and would mis-gate the
// dark-mode image plate in markdown.css). Keep this in sync with the dark
// `data-color-scheme` the effect sets below.
function isDarkTheme(theme: Theme): boolean {
  return theme === "dark" || theme === "night" || theme === "plum";
}

// Keep the iOS standalone status bar (and Android's) in sync with the active
// theme. With apple-mobile-web-app-status-bar-style="default", iOS paints the
// status bar background with this colour and auto-picks a contrasting glyph
// colour, so light themes get dark icons and vice versa.
function applyThemeColor(color: string): void {
  // iOS standalone PWAs frequently ignore an in-place `content` mutation of an
  // existing <meta name="theme-color"> — the status bar keeps the colour it read
  // at launch. REPLACING the node (remove every copy, insert a fresh one) is the
  // workaround that nudges iOS to re-read it on a runtime theme switch. (On a
  // hard-limit iOS build the status bar still only updates on relaunch; the rest
  // of the chrome recolours instantly via the MUI theme regardless.)
  const head = globalThis.document.head;
  head.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.remove();
  });
  const meta = globalThis.document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", color);
  head.appendChild(meta);
}

interface ThemeColors {
  primary: string;
  bgDefault: string;
  bgPaper: string;
  textPrimary: string;
  textSecondary: string;
  divider: string;
}

function getThemeColors(theme: Theme): ThemeColors {
  switch (theme) {
    case "light":
      return {
        primary: "#0969da",
        bgDefault: "#ffffff",
        bgPaper: "#f6f8fa",
        textPrimary: "#1f2328",
        textSecondary: "#656d76",
        divider: "#d0d7de",
      };
    case "sepia":
      // Warm cream for long-form reading (~25% lower radiance than white).
      // Brown text on cream keeps ~7:1 contrast without the glare of black.
      return {
        primary: "#9a5b3d",
        bgDefault: "#f4ecd8",
        bgPaper: "#ece0c8",
        textPrimary: "#5b4636",
        textSecondary: "#7d6b58",
        divider: "#ddd0b8",
      };
    case "dark":
      return {
        primary: "#58a6ff",
        bgDefault: "#0d1117",
        bgPaper: "#161b22",
        textPrimary: "#e6edf3",
        textSecondary: "#8b949e",
        divider: "#30363d",
      };
    case "night":
      // Warm, low-blue-light dark for night reading; off-white (not pure
      // white) text to avoid halation, amber accent instead of cool blue.
      return {
        primary: "#d9a066",
        bgDefault: "#1b1714",
        bgPaper: "#241f1a",
        textPrimary: "#d6cbbd",
        textSecondary: "#9a8f80",
        divider: "#3a322b",
      };
    case "lavender":
      // Soft lavender light theme (cowboy's palette): a desaturated pinkish
      // violet page with a violet-600 accent — calm for long reading.
      return {
        primary: "#7c3aed",
        bgDefault: "#f4ecf7",
        bgPaper: "#faf6fd",
        textPrimary: "#1c1428",
        textSecondary: "#6b5b8a",
        divider: "#e2d6f0",
      };
    case "plum":
      // Deep purple-black dark theme (cowboy's): reads as purple, not black,
      // with a violet-400 accent and soft off-white text.
      return {
        primary: "#a78bfa",
        bgDefault: "#15111d",
        bgPaper: "#1f1a2c",
        textPrimary: "#ede9fe",
        textSecondary: "#a899c4",
        divider: "#322a44",
      };
  }
}

interface UseThemeResult {
  /** The resolved flat theme (variant + mode → one of the 4 palettes). */
  theme: Theme;
  muiTheme: MuiTheme;
  variant: ThemeVariant;
  mode: ThemeMode;
  setVariant: (v: ThemeVariant) => void;
  setMode: (m: ThemeMode) => void;
}

export function useTheme(): UseThemeResult {
  const variant = useStore(variantStore);
  const mode = useStore(modeStore);
  const [sysDark, setSysDark] = useState<boolean>(systemPrefersDark);

  const theme = resolveTheme(variant, mode, sysDark);
  // Latest resolved theme for the foreground re-check below (runs from a
  // listener registered once, so it can't close over the render-time value).
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const setVariant = useCallback((v: ThemeVariant) => {
    variantStore.set(v);
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    modeStore.set(m);
  }, []);

  // While mode = auto, follow the OS scheme live (re-resolves to the variant's
  // light/dark half on system change).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent): void => setSysDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // When the app returns to the foreground, re-check the OS scheme AND re-assert
  // the status-bar colour. A system theme change that happens WHILE the PWA is
  // backgrounded never fires the `change` listener above (the JS is suspended),
  // so without this the theme stays stale until some other re-render — the
  // navbar/status bar lag behind the OS. Re-applying theme-color on resume also
  // nudges iOS to re-read it (a standalone PWA routinely drops the runtime value
  // across a background/foreground, leaving the status bar on the launch colour).
  useEffect(() => {
    const onResume = (): void => {
      if (document.visibilityState !== "visible") return;
      setSysDark(systemPrefersDark());
      applyThemeColor(getThemeColors(themeRef.current).bgPaper);
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("pageshow", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("pageshow", onResume);
    };
  }, []);

  // Apply the resolved theme to the document (data attrs + iOS status-bar colour).
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    // A theme-agnostic light/dark flag for CSS that only cares about the scheme
    // (e.g. the dark-mode image plate in markdown.css).
    document.documentElement.setAttribute(
      "data-color-scheme",
      isDarkTheme(theme) ? "dark" : "light",
    );
    // bgPaper is the mobile top nav-bar surface, so the status bar reads as a
    // seamless extension of it.
    applyThemeColor(getThemeColors(theme).bgPaper);
  }, [theme]);

  const muiTheme = useMemo(() => {
    const colors = getThemeColors(theme);
    return createTheme({
      palette: {
        mode: isDarkTheme(theme) ? "dark" : "light",
        primary: {
          main: colors.primary,
        },
        background: {
          default: colors.bgDefault,
          paper: colors.bgPaper,
        },
        text: {
          primary: colors.textPrimary,
          secondary: colors.textSecondary,
        },
        divider: colors.divider,
      },
      typography: {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            body: {
              backgroundColor: colors.bgDefault,
            },
          },
        },
        // Touch ergonomics (ui.md §7): on a coarse pointer no interactive control
        // drops below the ~40px tap-target floor, even when size="small" is asked
        // for desktop density — "mobile never small". Desktop keeps the compact size.
        MuiIconButton: {
          styleOverrides: {
            sizeSmall: {
              "@media (pointer: coarse)": { width: 40, height: 40 },
            },
          },
        },
        MuiButton: {
          styleOverrides: {
            sizeSmall: { "@media (pointer: coarse)": { minHeight: 40 } },
          },
        },
        MuiToggleButton: {
          styleOverrides: {
            sizeSmall: {
              "@media (pointer: coarse)": { minHeight: 40, minWidth: 40 },
            },
            // Selected state must be unmistakable in EVERY theme. MUI's default
            // selected look is only a ~8–16% action tint, which all but vanishes
            // on the dark/night palettes — the read/listen toggle (and the
            // language / theme-mode toggles) read almost the same whether on or
            // off. Give the selected segment a solid accent fill with a computed
            // contrast-text glyph, against a muted (text.secondary) unselected
            // segment: clearly "you-are-here", contrast-safe on all four
            // palettes, without becoming a saturated bar (ui.md §6 — the accent
            // already encodes which app you're in). MUI derives `primary.dark`
            // and `primary.contrastText` from the per-theme `primary.main`, so
            // this stays correct as the palette changes.
            root: ({ theme }) => ({
              color: theme.palette.text.secondary,
              "&.Mui-selected": {
                color: theme.palette.primary.contrastText,
                backgroundColor: theme.palette.primary.main,
                "&:hover": {
                  backgroundColor: theme.palette.primary.dark,
                },
              },
            }),
          },
        },
      },
    });
  }, [theme]);

  return { theme, muiTheme, variant, mode, setVariant, setMode };
}
