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
    "landing.home": "Back to bookshelf",
    "landing.subtitle": "Pick one to start reading · {n} total",
    "landing.empty": "Nothing to read yet",
    "landing.noMounts":
      "No [[book]] in the liveview config — add one and it appears here.",
    "landing.noResults": "No matches",
    "landing.otherGroup": "Other",
    "landing.continue": "Continue: {chapter}",
    "landing.added": "Added {date}",
    "landing.updated": "Updated {date}",
    "landing.addedRel": "Added {time}",
    "landing.updatedRel": "Updated {time}",
    "landing.search": "Search by name",
    "landing.searchClear": "Clear search",
    "landing.filter": "Filter",
    "landing.filterAll": "All kinds",
    "landing.filterBooks": "Books",
    "landing.filterAudiobooks": "Audiobooks",
    "landing.filterDocs": "Docs",
    "landing.audiobookBadge": "Audiobook",
    "landing.bookBadge": "Book",
    "landing.docsBadge": "Docs",
    "sidebar.back": "Back to bookshelf",
    "sidebar.expandAll": "Expand all",
    "sidebar.collapseAll": "Collapse all",
    "sidebar.reveal": "Reveal current file",
    "sidebar.settings": "Settings",
    "sidebar.close": "Close sidebar",
    "sidebar.language": "Language",
    "sidebar.rendition": "Mode",
    "app.openSidebar": "Open sidebar",
    "app.settings": "Settings",
    "app.scrollTop": "Scroll to top",
    "action.share": "Share",
    "content.selectFile": "Select a file from the sidebar",
    "content.unsupported": "Unsupported file type: {type}",
    "content.untranslated":
      "Not translated to {lang} yet — showing {fallback}.",
    "audiobook.open": "Listen (audiobook)",
    "audiobook.read": "Read (text)",
    "audiobook.close": "Back to reading",
    "audiobook.loading": "Synthesizing narration…",
    "audiobook.error": "Audio unavailable: {error}",
    "audiobook.seek": "Seek",
    "audiobook.speed": "Playback speed",
    "audiobook.play": "Play",
    "audiobook.pause": "Pause",
    "audiobook.readAloud": "Read this page aloud",
    "audiobook.skipBack": "Back 15 seconds",
    "audiobook.skipForward": "Forward 15 seconds",
    "audiobook.prevChapter": "Previous chapter",
    "audiobook.nextChapter": "Next chapter",
    "audiobook.follow": "Follow narration",
    "audiobook.following": "Following narration",
    "audiobook.openPlayer": "Open player",
    "audiobook.goToCurrent": "Go to current chapter",
    "audiobook.nowPlaying": "Now playing — tap for controls",
    "audiobook.collapse": "Minimize player",
    "audiobook.stop": "Stop & close",
    "audiobook.cancel": "Cancel",
    "audiobook.stopConfirmTitle": "Stop this audiobook?",
    "audiobook.stopConfirmBody":
      "Playback stops and the floating player closes. You can reopen it from the shelf anytime.",
    "audiobook.chapters": "Chapters",
    "audiobook.empty": "This audiobook has no chapters yet.",
    "audiobook.sleepTimer": "Sleep timer",
    "audiobook.sleepOff": "Off",
    "audiobook.playingElsewhere": "Playing on {device}",
    "audiobook.playHere": "Play here",
    "sync.audio": "Synced to {book} · {chapter} · {time}",
    "sync.settings": "Settings synced",
    "settings.title": "Settings",
    "settings.language": "Language",
    "settings.theme": "Theme",
    "settings.palette": "Palette",
    "settings.mode": "Mode",
    "theme.classic": "Classic",
    "theme.warm": "Warm",
    "theme.purple": "Purple",
    "mode.auto": "Auto",
    "mode.light": "Light",
    "mode.dark": "Dark",
    "settings.font": "Reading font",
    "settings.reading": "Reading",
    "settings.fontSize": "Font size",
    "settings.fontSizeDesc": "Scales all text in the app",
    "settings.contentWidth": "CONTENT WIDTH",
    "settings.margin": "Margin",
    "settings.marginDesc": "Side gutter of the reading column",
    "settings.contentWidthFull": "Full width",
    "settings.lineHeight": "Line height",
    "settings.lineHeightDesc": "Space between lines of text",
    "settings.layout": "Layout",
    "settings.sort": "Sort books",
    "settings.sortDesc": "Order of the bookshelf",
    "settings.compact": "Compact cards",
    "settings.compactDesc": "Hide the coloured cover band to fit more books",
    "sort.updated": "Updated",
    "sort.read": "Read",
    "sort.added": "Added",
    "sort.name": "Name",
    "settings.group": "Group books",
    "settings.groupDesc": "Group the shelf into collapsible series",
    "group.none": "Don't group",
    "group.collection": "By series",
    "settings.device": "This device",
    "settings.deviceName": "Device name",
    "settings.deviceNameDesc":
      "A label other devices show when audio plays here. The device keeps a stable id underneath, so renaming it doesn't make it a new device.",
    "settings.about": "About",
    "settings.aboutText":
      "liveview — read and listen to your library, always up to date.",
  },
  zh: {
    "landing.title": "书架",
    "landing.home": "返回书架",
    "landing.subtitle": "选择一本开始阅读 · 共 {n} 本",
    "landing.empty": "暂无可阅读的内容",
    "landing.noMounts": "liveview 配置里没有 [[book]]——添加后会出现在这里。",
    "landing.noResults": "没有匹配的结果",
    "landing.otherGroup": "其他",
    "landing.continue": "继续：{chapter}",
    "landing.added": "创建于 {date}",
    "landing.updated": "更新于 {date}",
    "landing.addedRel": "创建于 {time}",
    "landing.updatedRel": "更新于 {time}",
    "landing.search": "按名称搜索",
    "landing.searchClear": "清除搜索",
    "landing.filter": "筛选",
    "landing.filterAll": "全部类型",
    "landing.filterBooks": "书",
    "landing.filterAudiobooks": "有声书",
    "landing.filterDocs": "文档",
    "landing.audiobookBadge": "有声书",
    "landing.bookBadge": "书",
    "landing.docsBadge": "文档",
    "sidebar.back": "返回书架",
    "sidebar.expandAll": "全部展开",
    "sidebar.collapseAll": "全部折叠",
    "sidebar.reveal": "定位当前文件",
    "sidebar.settings": "设置",
    "sidebar.close": "收起侧边栏",
    "sidebar.language": "语言",
    "sidebar.rendition": "模式",
    "app.openSidebar": "打开侧边栏",
    "app.settings": "设置",
    "app.scrollTop": "回到顶部",
    "action.share": "分享",
    "content.selectFile": "从侧边栏选择一个文件",
    "content.unsupported": "不支持的文件类型：{type}",
    "content.untranslated": "本页尚未翻译为{lang}——显示{fallback}。",
    "audiobook.open": "听书",
    "audiobook.read": "阅读",
    "audiobook.close": "返回阅读",
    "audiobook.loading": "正在合成朗读音频…",
    "audiobook.error": "音频不可用：{error}",
    "audiobook.seek": "跳转",
    "audiobook.speed": "播放速度",
    "audiobook.play": "播放",
    "audiobook.pause": "暂停",
    "audiobook.readAloud": "朗读本页",
    "audiobook.skipBack": "后退 15 秒",
    "audiobook.skipForward": "前进 15 秒",
    "audiobook.prevChapter": "上一章",
    "audiobook.nextChapter": "下一章",
    "audiobook.follow": "跟随朗读",
    "audiobook.following": "正在跟随朗读",
    "audiobook.openPlayer": "打开播放器",
    "audiobook.goToCurrent": "回到当前章节",
    "audiobook.nowPlaying": "正在播放 — 点击展开控件",
    "audiobook.collapse": "收起播放器",
    "audiobook.stop": "停止播放并关闭",
    "audiobook.cancel": "取消",
    "audiobook.stopConfirmTitle": "停止这本有声书？",
    "audiobook.stopConfirmBody":
      "播放会停止，悬浮窗关闭。可随时从书架重新打开。",
    "audiobook.chapters": "章节",
    "audiobook.empty": "这本有声书还没有章节。",
    "audiobook.sleepTimer": "定时关闭",
    "audiobook.sleepOff": "关闭",
    "audiobook.playingElsewhere": "正在「{device}」播放",
    "audiobook.playHere": "在此播放",
    "sync.audio": "已同步到《{book}》· {chapter} · {time}",
    "sync.settings": "已同步设置",
    "settings.title": "设置",
    "settings.language": "界面语言",
    "settings.theme": "主题",
    "settings.palette": "配色",
    "settings.mode": "模式",
    "theme.classic": "经典",
    "theme.warm": "暖色",
    "theme.purple": "紫色",
    "mode.auto": "自动",
    "mode.light": "浅色",
    "mode.dark": "深色",
    "settings.font": "阅读字体",
    "settings.reading": "阅读",
    "settings.fontSize": "字号",
    "settings.fontSizeDesc": "缩放应用内所有文字",
    "settings.contentWidth": "内容宽度",
    "settings.margin": "页边距",
    "settings.marginDesc": "正文两侧的留白",
    "settings.contentWidthFull": "整页",
    "settings.lineHeight": "行距",
    "settings.lineHeightDesc": "行与行之间的间距",
    "settings.layout": "布局",
    "settings.sort": "书架排序",
    "settings.sortDesc": "书架的排列顺序",
    "settings.compact": "紧凑卡片",
    "settings.compactDesc": "隐藏顶部彩色封面条,一屏显示更多书",
    "sort.updated": "最近更新",
    "sort.read": "最近阅读",
    "sort.added": "最近添加",
    "sort.name": "名称",
    "settings.group": "书籍分组",
    "settings.groupDesc": "按系列分组,可折叠",
    "group.none": "不分组",
    "group.collection": "按系列",
    "settings.device": "本设备",
    "settings.deviceName": "设备名称",
    "settings.deviceNameDesc":
      "在此设备播放时其他设备显示的名称（只是别名）。设备底层有稳定的 id，改名不会变成一台新设备。",
    "settings.about": "关于",
    "settings.aboutText": "liveview —— 阅读与收听你的书库，内容自动更新。",
  },
};

function detectLanguage(): Language {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored === "en" || stored === "zh") {
    return stored;
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
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
    [lang],
  );

  const value = useMemo<I18nValue>(() => ({ lang, setLang, t }), [
    lang,
    setLang,
    t,
  ]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}
