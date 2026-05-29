import { useState, useEffect, useCallback, useMemo } from "react";
import { createTheme, type Theme as MuiTheme } from "@mui/material/styles";
import type { Theme } from "@/types";

const THEME_KEY = "lv-theme";

// Solarized colors
const solarized = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  blue: "#268bd2",
};

// Dracula colors
const dracula = {
  background: "#282a36",
  currentLine: "#44475a",
  foreground: "#f8f8f2",
  comment: "#6272a4",
  cyan: "#8be9fd",
  purple: "#bd93f9",
};

// Nord colors
const nord = {
  polarNight0: "#2e3440",
  polarNight1: "#3b4252",
  polarNight2: "#434c5e",
  snowStorm0: "#d8dee9",
  snowStorm1: "#e5e9f0",
  snowStorm2: "#eceff4",
  frost0: "#8fbcbb",
  frost1: "#88c0d0",
  frost2: "#81a1c1",
  frost3: "#5e81ac",
};

// Monokai colors
const monokai = {
  background: "#272822",
  foreground: "#f8f8f2",
  comment: "#75715e",
  yellow: "#e6db74",
  orange: "#fd971f",
  pink: "#f92672",
};

// One Dark colors
const oneDark = {
  background: "#282c34",
  gutterBg: "#21252b",
  foreground: "#abb2bf",
  comment: "#5c6370",
  cyan: "#56b6c2",
  blue: "#61afef",
};

// Gruvbox colors
const gruvbox = {
  darkBg: "#282828",
  darkBg1: "#3c3836",
  darkFg: "#ebdbb2",
  darkGray: "#928374",
  lightBg: "#fbf1c7",
  lightBg1: "#ebdbb2",
  lightFg: "#3c3836",
  lightGray: "#928374",
  orange: "#d65d0e",
  blue: "#458588",
};

const VALID_THEMES: Theme[] = [
  "light",
  "dark",
  "solarized-light",
  "solarized-dark",
  "dracula",
  "nord",
  "monokai",
  "one-dark",
  "gruvbox-light",
  "gruvbox-dark",
];

function getStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored !== null && VALID_THEMES.includes(stored as Theme)) {
    return stored as Theme;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function isDarkTheme(theme: Theme): boolean {
  return !theme.includes("light");
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
    case "dark":
      return {
        primary: "#58a6ff",
        bgDefault: "#0d1117",
        bgPaper: "#161b22",
        textPrimary: "#e6edf3",
        textSecondary: "#8b949e",
        divider: "#30363d",
      };
    case "solarized-light":
      return {
        primary: solarized.blue,
        bgDefault: solarized.base3,
        bgPaper: solarized.base2,
        textPrimary: solarized.base00,
        textSecondary: solarized.base1,
        divider: solarized.base1,
      };
    case "solarized-dark":
      return {
        primary: solarized.blue,
        bgDefault: solarized.base03,
        bgPaper: solarized.base02,
        textPrimary: solarized.base0,
        textSecondary: solarized.base01,
        divider: solarized.base01,
      };
    case "dracula":
      return {
        primary: dracula.purple,
        bgDefault: dracula.background,
        bgPaper: dracula.currentLine,
        textPrimary: dracula.foreground,
        textSecondary: dracula.comment,
        divider: dracula.comment,
      };
    case "nord":
      return {
        primary: nord.frost1,
        bgDefault: nord.polarNight0,
        bgPaper: nord.polarNight1,
        textPrimary: nord.snowStorm2,
        textSecondary: nord.snowStorm0,
        divider: nord.polarNight2,
      };
    case "monokai":
      return {
        primary: monokai.orange,
        bgDefault: monokai.background,
        bgPaper: "#3e3d32",
        textPrimary: monokai.foreground,
        textSecondary: monokai.comment,
        divider: "#49483e",
      };
    case "one-dark":
      return {
        primary: oneDark.blue,
        bgDefault: oneDark.background,
        bgPaper: oneDark.gutterBg,
        textPrimary: oneDark.foreground,
        textSecondary: oneDark.comment,
        divider: "#3e4451",
      };
    case "gruvbox-light":
      return {
        primary: gruvbox.orange,
        bgDefault: gruvbox.lightBg,
        bgPaper: gruvbox.lightBg1,
        textPrimary: gruvbox.lightFg,
        textSecondary: gruvbox.lightGray,
        divider: "#d5c4a1",
      };
    case "gruvbox-dark":
      return {
        primary: gruvbox.orange,
        bgDefault: gruvbox.darkBg,
        bgPaper: gruvbox.darkBg1,
        textPrimary: gruvbox.darkFg,
        textSecondary: gruvbox.darkGray,
        divider: "#504945",
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
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(isDarkTheme(theme) ? "light" : "dark");
  }, [theme, setTheme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
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
