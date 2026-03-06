import { useState, useCallback, useMemo } from "react";
import type { MenuBarSettings, ExtensionSettings } from "@/types";
import { ALL_EXTENSION_GROUP_NAMES, EXTENSION_GROUPS } from "@/types";

const SETTINGS_KEY = "lv-settings";
const EXTENSION_SETTINGS_KEY = "lv-extension-settings";

const DEFAULT_SETTINGS: MenuBarSettings = {
  floatOpacity: 0.3,
};

const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  enabledGroups: ALL_EXTENSION_GROUP_NAMES,
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

function getStoredExtensionSettings(): ExtensionSettings {
  try {
    const stored = localStorage.getItem(EXTENSION_SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ExtensionSettings>;
      return {
        enabledGroups: parsed.enabledGroups ?? DEFAULT_EXTENSION_SETTINGS.enabledGroups,
      };
    }
  } catch {
    // ignore
  }
  return DEFAULT_EXTENSION_SETTINGS;
}

interface UseSettingsResult {
  menuBarSettings: MenuBarSettings;
  setFloatOpacity: (opacity: number) => void;
  extensionSettings: ExtensionSettings;
  toggleExtensionGroup: (groupName: string) => void;
  enableAllExtensions: () => void;
  disableAllExtensions: () => void;
  enabledExtensions: Set<string>;
}

export function useSettings(): UseSettingsResult {
  const [menuBarSettings, setMenuBarSettings] = useState<MenuBarSettings>(getStoredSettings);
  const [extensionSettings, setExtensionSettings] = useState<ExtensionSettings>(getStoredExtensionSettings);

  const saveSettings = useCallback((settings: MenuBarSettings) => {
    setMenuBarSettings(settings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, []);

  const saveExtensionSettings = useCallback((settings: ExtensionSettings) => {
    setExtensionSettings(settings);
    localStorage.setItem(EXTENSION_SETTINGS_KEY, JSON.stringify(settings));
  }, []);

  const setFloatOpacity = useCallback(
    (opacity: number) => {
      saveSettings({ floatOpacity: opacity });
    },
    [saveSettings]
  );

  const toggleExtensionGroup = useCallback(
    (groupName: string) => {
      const newEnabled = extensionSettings.enabledGroups.includes(groupName)
        ? extensionSettings.enabledGroups.filter((g) => g !== groupName)
        : [...extensionSettings.enabledGroups, groupName];
      saveExtensionSettings({ enabledGroups: newEnabled });
    },
    [extensionSettings, saveExtensionSettings]
  );

  const enableAllExtensions = useCallback(() => {
    saveExtensionSettings({ enabledGroups: ALL_EXTENSION_GROUP_NAMES });
  }, [saveExtensionSettings]);

  const disableAllExtensions = useCallback(() => {
    saveExtensionSettings({ enabledGroups: [] });
  }, [saveExtensionSettings]);

  const enabledExtensions = useMemo(() => {
    const extensions = new Set<string>();
    for (const group of EXTENSION_GROUPS) {
      if (extensionSettings.enabledGroups.includes(group.name)) {
        for (const ext of group.extensions) {
          extensions.add(ext);
        }
      }
    }
    return extensions;
  }, [extensionSettings.enabledGroups]);

  return {
    menuBarSettings,
    setFloatOpacity,
    extensionSettings,
    toggleExtensionGroup,
    enableAllExtensions,
    disableAllExtensions,
    enabledExtensions,
  };
}
