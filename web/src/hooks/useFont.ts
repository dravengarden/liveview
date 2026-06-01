import { useCallback, useEffect, useState } from "react";
import { DEFAULT_FONT_ID, FONT_PRESETS, getFontPreset } from "@/fonts";
import { getServerSettings, putServerSetting } from "@/serverSettings";

const FONT_KEY = "lv-font";
const FONT_SETTING_KEY = "ui.font";

function isKnownFontId(id: string): boolean {
  return FONT_PRESETS.some((p) => p.id === id);
}

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

  // Reconcile to the server (cross-device truth) once on mount. Only apply a
  // known font id that differs from the current one; ignore an unknown value
  // and don't echo it back (setFontId, not setFont).
  useEffect(() => {
    void getServerSettings().then((s) => {
      const v = s[FONT_SETTING_KEY];
      if (v !== undefined && isKnownFontId(v) && v !== fontId) {
        setFontId(v);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setFont = useCallback((id: string) => {
    setFontId(id);
    putServerSetting(FONT_SETTING_KEY, id);
  }, []);

  return { fontId, setFont };
}
