import { useState, useCallback } from "react";
import {
  CONTENT_WIDTH_DEFAULT,
  LINE_HEIGHT_DEFAULT,
} from "@/types";
import type { MenuBarSettings } from "@/types";

const SETTINGS_KEY = "lv-settings";

const DEFAULT_SETTINGS: MenuBarSettings = {
  floatOpacity: 0.3,
  contentMaxWidth: CONTENT_WIDTH_DEFAULT,
  lineHeight: LINE_HEIGHT_DEFAULT,
};

function getStoredSettings(): MenuBarSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<MenuBarSettings>;
      return {
        floatOpacity: parsed.floatOpacity ?? DEFAULT_SETTINGS.floatOpacity,
        contentMaxWidth: parsed.contentMaxWidth ?? DEFAULT_SETTINGS.contentMaxWidth,
        lineHeight: parsed.lineHeight ?? DEFAULT_SETTINGS.lineHeight,
      };
    }
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

interface UseSettingsResult {
  menuBarSettings: MenuBarSettings;
  setFloatOpacity: (opacity: number) => void;
  setContentMaxWidth: (width: number) => void;
  setLineHeight: (lh: number) => void;
}

export function useSettings(): UseSettingsResult {
  const [menuBarSettings, setMenuBarSettings] = useState<MenuBarSettings>(getStoredSettings);

  const persist = useCallback((next: MenuBarSettings) => {
    setMenuBarSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }, []);

  const setFloatOpacity = useCallback(
    (opacity: number) => {
      persist({ ...getStoredSettings(), floatOpacity: opacity });
    },
    [persist]
  );

  const setContentMaxWidth = useCallback(
    (width: number) => {
      persist({ ...getStoredSettings(), contentMaxWidth: width });
    },
    [persist]
  );

  const setLineHeight = useCallback(
    (lh: number) => {
      persist({ ...getStoredSettings(), lineHeight: lh });
    },
    [persist]
  );

  return {
    menuBarSettings,
    setFloatOpacity,
    setContentMaxWidth,
    setLineHeight,
  };
}
