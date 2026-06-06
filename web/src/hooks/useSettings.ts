import { useCallback, useEffect, useState } from "react";
import {
  CONTENT_WIDTH_DEFAULT,
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  LINE_HEIGHT_DEFAULT,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
} from "@/types";
import type { MenuBarSettings } from "@/types";
import { getServerSettings, putServerSetting } from "@/serverSettings";

const SETTINGS_KEY = "lv-settings";
const CONTENT_WIDTH_SETTING_KEY = "ui.contentWidth";
const LINE_HEIGHT_SETTING_KEY = "ui.lineHeight";

function inRange(n: number, min: number, max: number): boolean {
  return Number.isFinite(n) && n >= min && n <= max;
}

const DEFAULT_SETTINGS: MenuBarSettings = {
  contentMaxWidth: CONTENT_WIDTH_DEFAULT,
  lineHeight: LINE_HEIGHT_DEFAULT,
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
      putServerSetting(CONTENT_WIDTH_SETTING_KEY, String(width));
    },
    [persist],
  );

  const setLineHeight = useCallback(
    (lh: number) => {
      persist({ ...getStoredSettings(), lineHeight: lh });
      putServerSetting(LINE_HEIGHT_SETTING_KEY, String(lh));
    },
    [persist],
  );

  // Reconcile to the server (cross-device truth) once on mount. Apply only the
  // keys that are present + within the documented bounds and that differ from
  // the current value, and write straight to localStorage (persist) so the
  // mount-apply path doesn't re-PUT the value we just read.
  useEffect(() => {
    void getServerSettings().then((s) => {
      const cur = getStoredSettings();
      const next = { ...cur };
      let changed = false;
      const w = Number(s[CONTENT_WIDTH_SETTING_KEY]);
      if (
        s[CONTENT_WIDTH_SETTING_KEY] !== undefined &&
        // 0 = "full width" (a valid choice, outside the slider's min/max band).
        (w === 0 || inRange(w, CONTENT_WIDTH_MIN, CONTENT_WIDTH_MAX)) &&
        w !== cur.contentMaxWidth
      ) {
        next.contentMaxWidth = w;
        changed = true;
      }
      const lh = Number(s[LINE_HEIGHT_SETTING_KEY]);
      if (
        s[LINE_HEIGHT_SETTING_KEY] !== undefined &&
        inRange(lh, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX) &&
        lh !== cur.lineHeight
      ) {
        next.lineHeight = lh;
        changed = true;
      }
      if (changed) persist(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    menuBarSettings,
    setContentMaxWidth,
    setLineHeight,
  };
}
