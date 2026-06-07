import { useCallback, useState } from "react";
import {
  CONTENT_WIDTH_DEFAULT,
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  FONT_SCALE_DEFAULT,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  LINE_HEIGHT_DEFAULT,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
} from "@/types";
import type { MenuBarSettings } from "@/types";

// Reading-layout preferences. Device-LOCAL on purpose: these (margin, line
// height, reading font-size) are legitimately per-device — a phone and a tablet
// want different values — and they're trivially re-set, so they live only in
// localStorage and are NOT synced to the server. Only reading/playback PROGRESS
// is cross-device truth.
const SETTINGS_KEY = "lv-settings";

function inRange(n: number, min: number, max: number): boolean {
  return Number.isFinite(n) && n >= min && n <= max;
}

const DEFAULT_SETTINGS: MenuBarSettings = {
  contentMaxWidth: CONTENT_WIDTH_DEFAULT,
  lineHeight: LINE_HEIGHT_DEFAULT,
  fontScale: FONT_SCALE_DEFAULT,
};

/** Coerce a stored value into a valid setting, falling back to `def` when it's
 *  missing or out of range. Crucial for migration: `contentMaxWidth` used to be
 *  an absolute reading-column width (hundreds–thousands of px) and is now a
 *  small left/right MARGIN (0–64). A stale large value (e.g. 1000) applied as
 *  `px` padding collapses the reading column to ~1 glyph wide, so any
 *  out-of-band value must snap back to the default rather than be trusted. */
function sanitize(n: unknown, min: number, max: number, def: number): number {
  const v = Number(n);
  return inRange(v, min, max) ? v : def;
}

function getStoredSettings(): MenuBarSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<MenuBarSettings>;
      return {
        contentMaxWidth: sanitize(
          parsed.contentMaxWidth,
          CONTENT_WIDTH_MIN,
          CONTENT_WIDTH_MAX,
          DEFAULT_SETTINGS.contentMaxWidth,
        ),
        lineHeight: sanitize(
          parsed.lineHeight,
          LINE_HEIGHT_MIN,
          LINE_HEIGHT_MAX,
          DEFAULT_SETTINGS.lineHeight,
        ),
        fontScale: sanitize(
          parsed.fontScale,
          FONT_SCALE_MIN,
          FONT_SCALE_MAX,
          DEFAULT_SETTINGS.fontScale,
        ),
      };
    }
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

interface UseSettingsResult {
  menuBarSettings: MenuBarSettings;
  setContentMaxWidth: (width: number) => void;
  setLineHeight: (lh: number) => void;
  setFontScale: (scale: number) => void;
}

export function useSettings(): UseSettingsResult {
  const [menuBarSettings, setMenuBarSettings] = useState<MenuBarSettings>(
    getStoredSettings,
  );

  const persist = useCallback((next: MenuBarSettings) => {
    setMenuBarSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }, []);

  const setContentMaxWidth = useCallback(
    (width: number) => {
      persist({ ...getStoredSettings(), contentMaxWidth: width });
    },
    [persist],
  );

  const setLineHeight = useCallback(
    (lh: number) => {
      persist({ ...getStoredSettings(), lineHeight: lh });
    },
    [persist],
  );

  const setFontScale = useCallback(
    (scale: number) => {
      persist({ ...getStoredSettings(), fontScale: scale });
    },
    [persist],
  );

  return {
    menuBarSettings,
    setContentMaxWidth,
    setLineHeight,
    setFontScale,
  };
}
