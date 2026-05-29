import { useState, useEffect, useCallback, useMemo } from "react";
import { createTheme, type Theme as MuiTheme } from "@mui/material/styles";
import type { Theme } from "@/types";

const THEME_KEY = "lv-theme";

const VALID_THEMES: Theme[] = ["light", "sepia", "dark", "night"];

function getStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored !== null && VALID_THEMES.includes(stored as Theme)) {
    return stored as Theme;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Explicit, not name-based: "sepia" is a light theme yet has no "light" in its
// name, so a substring test would misclassify it (and would mis-gate the
// dark-mode image plate in markdown.css). Keep this in sync with the dark
// `data-color-scheme` the effect sets below.
function isDarkTheme(theme: Theme): boolean {
  return theme === "dark" || theme === "night";
}

// Keep the iOS standalone status bar (and Android's) in sync with the active
// theme. With apple-mobile-web-app-status-bar-style="default", iOS paints the
// status bar background with this colour and auto-picks a contrasting glyph
// colour, so light themes get dark icons and vice versa.
function applyThemeColor(color: string): void {
  globalThis.document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
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
  }
}

interface UseThemeResult {
  theme: Theme;
  muiTheme: MuiTheme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

export function useTheme(): UseThemeResult {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem(THEME_KEY, newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
    // A theme-agnostic light/dark flag for CSS that only cares about the
    // scheme (e.g. the dark-mode image plate in markdown.css), so such rules
    // never have to enumerate theme names.
    document.documentElement.setAttribute(
      "data-color-scheme",
      isDarkTheme(newTheme) ? "dark" : "light"
    );
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(isDarkTheme(theme) ? "light" : "dark");
  }, [theme, setTheme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute(
      "data-color-scheme",
      isDarkTheme(theme) ? "dark" : "light"
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
      },
    });
  }, [theme]);

  return { theme, muiTheme, toggleTheme, setTheme };
}
