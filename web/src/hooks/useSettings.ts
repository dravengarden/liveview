import { useState, useCallback } from "react";
import type { MenuBarSettings } from "@/types";

const SETTINGS_KEY = "lv-settings";

const DEFAULT_SETTINGS: MenuBarSettings = {
  floatOpacity: 0.3,
};

function getStoredSettings(): MenuBarSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<MenuBarSettings>;
      return {
        floatOpacity: parsed.floatOpacity ?? DEFAULT_SETTINGS.floatOpacity,
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
}

export function useSettings(): UseSettingsResult {
  const [menuBarSettings, setMenuBarSettings] = useState<MenuBarSettings>(getStoredSettings);

  const setFloatOpacity = useCallback((opacity: number) => {
    const next: MenuBarSettings = { floatOpacity: opacity };
    setMenuBarSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }, []);

  return {
    menuBarSettings,
    setFloatOpacity,
  };
}
