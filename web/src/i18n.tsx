import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type Dict,
  type Language,
  localeDescriptor,
  resolveLocale,
  UI_LOCALES,
} from "@/locales/registry";
import { en } from "@/locales/en.ts";
import { zh } from "@/locales/zh.ts";
import {
  type ShellLabels,
  ShellLabelsProvider,
} from "@/_shell/shell-labels.tsx";

export { type Language, UI_LOCALES as UI_LANGUAGES };

const LANG_KEY = "lv-lang";

const STRINGS: Record<Language, Dict> = { en, zh };

function detectLanguage(): Language {
  const stored = localStorage.getItem(LANG_KEY);
  return resolveLocale(stored) ?? resolveLocale(navigator.language) ?? "en";
}

export type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface I18nValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider(
  { children }: { children: React.ReactNode },
): React.JSX.Element {
  const [lang, setLangState] = useState<Language>(detectLanguage);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    localStorage.setItem(LANG_KEY, next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = localeDescriptor(lang).htmlLang;
  }, [lang]);

  const t = useCallback<Translate>(
    (key, vars) => {
      let s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replace(`{${k}}`, String(v));
        }
      }
      return s;
    },
    [lang],
  );

  const value = useMemo<I18nValue>(() => ({ lang, setLang, t }), [
    lang,
    setLang,
    t,
  ]);

  // The shell primitives (sheets, navigation, lightbox, connection banner) are
  // app-agnostic and default to English; hand them the active language here.
  const shellLabels = useMemo<ShellLabels>(() => ({
    close: t("shell.close"),
    back: t("shell.back"),
    navigation: t("shell.navigation"),
    openNavigation: t("shell.openNavigation"),
    closeNavigation: t("shell.closeNavigation"),
    collapseNavigation: t("shell.collapseNavigation"),
    imagePreview: t("shell.imagePreview"),
    previousImage: t("shell.previousImage"),
    nextImage: t("shell.nextImage"),
    zoomIn: t("shell.zoomIn"),
    zoomOut: t("shell.zoomOut"),
    connectionLost: t("shell.connectionLost"),
    reconnected: t("shell.reconnected"),
    updateReloading: (n) => t("shell.updateReloading", { n }),
  }), [t]);

  return (
    <I18nContext.Provider value={value}>
      <ShellLabelsProvider labels={shellLabels}>{children}</ShellLabelsProvider>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}
