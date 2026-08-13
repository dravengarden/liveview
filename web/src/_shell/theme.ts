// The shared MUI theme. Every app calls `createSharedTheme` with its own brand
// `primary` color: the design language (shape, typography, density, component
// overrides) is unified here so all apps look like one product, while the accent
// stays per-app so you always know which app you're in.

import { createTheme, type Theme } from "@mui/material/styles";

import type { ThemeMode } from "./theme-types.ts";

// A device whose primary input can't hover (phone/tablet). Read ONCE — pointer
// capability doesn't change at runtime. Drives the MuiTooltip default below.
const TOUCH_NO_HOVER = typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(hover: none)").matches;

export interface SharedThemeOptions {
  /** App brand accent → palette.primary.main. */
  readonly primary: string;
  readonly mode: ThemeMode;
}

export function createSharedTheme({ primary, mode }: SharedThemeOptions): Theme {
  return createTheme({
    palette: {
      mode,
      primary: { main: primary },
    },
    shape: { borderRadius: 10 },
    typography: {
      // UI font follows each OS via `system-ui` (SF on Apple, Segoe on Windows,
      // the GTK/Qt face on Linux) so every app reads as native on its platform
      // — including the portaled MUI Select/menu popups, which inherit this
      // through the theme context. Brand identity is carried by `palette.primary`,
      // NOT the font: a pinned brand face (was Inter-first here) looked foreign
      // on iPad/iPhone, where the native SF is expected. "Noto Sans" trails for
      // CJK coverage on platforms whose system face lacks it.
      fontFamily:
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
      button: { textTransform: "none", fontWeight: 600 },
    },
    components: {
      MuiPaper: { defaultProps: { variant: "outlined" } },
      MuiAppBar: { defaultProps: { elevation: 0, color: "default" } },
      // A tooltip is a POINTER-HOVER affordance — it has NO place on a touch
      // device, which can't hover. The bug: tapping a control that ALSO opens a
      // sheet (the nav ≡ "Menu") flashed its tooltip ON TOP of the sheet it had
      // just opened (tooltips portal at zIndex.tooltip = 1500, above the modal
      // band = 1300). disableTouchListener alone was NOT enough — it stops only
      // the long-press; a plain tap still FOCUSES the button and MUI's focus
      // listener then opens the tooltip. Root fix: on a device that can't hover
      // `(hover: none)`, disable EVERY trigger (hover + focus + touch) so no
      // tooltip can appear from any touch interaction — the whole "tooltip over
      // the sheet it opened" class is gone, one place. Desktop (fine pointer)
      // keeps full behaviour: hover + focus-visible a11y. Not a z-index/portal
      // problem (MUI already portals) — the fix is to stop the OPEN.
      MuiTooltip: {
        defaultProps: TOUCH_NO_HOVER
          ? {
            disableHoverListener: true,
            disableFocusListener: true,
            disableTouchListener: true,
          }
          : {},
      },
      // Touch ergonomics: on a coarse pointer (touch) NO interactive control
      // drops below the ~40px tap-target floor, even when an app asks for
      // size="small" for desktop density — "mobile never small". A fine pointer
      // (desktop mouse) keeps the requested compact size.
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          sizeSmall: { "@media (pointer: coarse)": { minHeight: 40 } },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          sizeSmall: { "@media (pointer: coarse)": { width: 40, height: 40 } },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          sizeSmall: { "@media (pointer: coarse)": { minHeight: 40, minWidth: 40 } },
        },
      },
    },
  });
}
