import { useCallback, useEffect } from "react";
import { persisted, useStore } from "@/_store/mod.ts";
import { DEFAULT_FONT_ID, getFontPreset } from "@/fonts";

const FONT_KEY = "lv-font";

// Device-LOCAL reading-font choice. A `persisted` store over localStorage (the
// font id is a bare string, so serialize/deserialize is identity — matching the
// pre-migration on-disk format so existing users keep their font). Cross-tab
// sync is free.
const fontStore = persisted<string>(FONT_KEY, DEFAULT_FONT_ID, {
  serialize: (v) => v,
  deserialize: (raw) => raw,
});

interface UseFontResult {
  fontId: string;
  setFont: (id: string) => void;
}

/**
 * Reading-font selection. Applies the chosen font to the reading surface via
 * the `--lv-reading-font` CSS variable and lazily loads its faces (the
 * @fontsource woff2 are fetched only when a font is first selected). The
 * choice persists in localStorage (device-local, like the other UI prefs).
 */
export function useFont(): UseFontResult {
  const fontId = useStore(fontStore);

  useEffect(() => {
    const preset = getFontPreset(fontId);
    document.documentElement.style.setProperty(
      "--lv-reading-font",
      preset.stack,
    );
    void preset.load();
  }, [fontId]);

  const setFont = useCallback((id: string) => {
    fontStore.set(id);
  }, []);

  return { fontId, setFont };
}
