import { useCallback, useEffect, useState } from "react";
import { DEFAULT_FONT_ID, getFontPreset } from "@/fonts";

const FONT_KEY = "lv-font";

function getStoredFontId(): string {
  return localStorage.getItem(FONT_KEY) ?? DEFAULT_FONT_ID;
}

interface UseFontResult {
  fontId: string;
  setFont: (id: string) => void;
}

/**
 * Reading-font selection. Applies the chosen font to the reading surface via
 * the `--lv-reading-font` CSS variable and lazily loads its faces (the
 * @fontsource woff2 are fetched only when a font is first selected). The
 * choice persists in localStorage.
 */
export function useFont(): UseFontResult {
  const [fontId, setFontId] = useState<string>(getStoredFontId);

  useEffect(() => {
    const preset = getFontPreset(fontId);
    document.documentElement.style.setProperty("--lv-reading-font", preset.stack);
    void preset.load();
    localStorage.setItem(FONT_KEY, fontId);
  }, [fontId]);

  const setFont = useCallback((id: string) => {
    setFontId(id);
  }, []);

  return { fontId, setFont };
}
