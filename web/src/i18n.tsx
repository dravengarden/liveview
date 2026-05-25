import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Language = "en" | "zh";

const LANG_KEY = "lv-lang";

type Dict = Record<string, string>;

// UI chrome strings only. Proper nouns (theme names, file-type group names)
// stay untranslated. `{name}` placeholders are filled by `t(key, { name })`.
const STRINGS: Record<Language, Dict> = {
  en: {
    "landing.title": "Bookshelf",
    "landing.subtitle": "Pick one to start reading · {n} total",
    "landing.empty": "Nothing to read yet",
    "landing.noMounts": "No [[book]] in the liveview config — add one and it appears here.",
    "sidebar.back": "Back to bookshelf",
    "sidebar.expandAll": "Expand all",
    "sidebar.collapseAll": "Collapse all",
    "sidebar.reveal": "Reveal current file",
    "sidebar.settings": "Settings",
    "sidebar.close": "Close sidebar",
    "sidebar.language": "Language",
    "app.openSidebar": "Open sidebar",
    "app.settings": "Settings",
    "content.selectFile": "Select a file from the sidebar",
    "content.unsupported": "Unsupported file type: {type}",
    "content.untranslated": "Not translated to {lang} yet — showing {fallback}.",
    "settings.title": "Settings",
    "settings.language": "INTERFACE LANGUAGE",
    "settings.theme": "THEME",
    "settings.font": "READING FONT",
    "settings.opacity": "MENU BAR OPACITY",
  },
  zh: {
    "landing.title": "书架",
    "landing.subtitle": "选择一本开始阅读 · 共 {n} 本",
    "landing.empty": "暂无可阅读的内容",
    "landing.noMounts": "liveview 配置里没有 [[book]]——添加后会出现在这里。",
    "sidebar.back": "返回书架",
    "sidebar.expandAll": "全部展开",
    "sidebar.collapseAll": "全部折叠",
    "sidebar.reveal": "定位当前文件",
    "sidebar.settings": "设置",
    "sidebar.close": "收起侧边栏",
    "sidebar.language": "语言",
    "app.openSidebar": "打开侧边栏",
    "app.settings": "设置",
    "content.selectFile": "从侧边栏选择一个文件",
    "content.unsupported": "不支持的文件类型：{type}",
    "content.untranslated": "本页尚未翻译为{lang}——显示{fallback}。",
    "settings.title": "设置",
    "settings.language": "界面语言",
    "settings.theme": "主题",
    "settings.font": "阅读字体",
    "settings.opacity": "菜单栏不透明度",
  },
};

function detectLanguage(): Language {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored === "en" || stored === "zh") {
    return stored;
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [lang, setLangState] = useState<Language>(detectLanguage);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    localStorage.setItem(LANG_KEY, next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
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
    [lang]
  );

  const value = useMemo<I18nValue>(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}
