import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type Language,
  localeDescriptor,
  resolveLocale,
  UI_LOCALES,
} from "@/locales/registry";
import {
  type ShellLabels,
  ShellLabelsProvider,
} from "@/_shell/shell-labels.tsx";

export { type Language, UI_LOCALES as UI_LANGUAGES };

const LANG_KEY = "lv-lang";

type Dict = Record<string, string>;

// UI chrome strings only. Proper nouns (theme names, file-type group names)
// stay untranslated. `{name}` placeholders are filled by `t(key, { name })`.
const STRINGS: Record<Language, Dict> = {
  en: {
    "landing.noMounts":
      "No [[book]] in the liveview config — add one and it appears here.",
    "landing.noResults": "No matches",
    "landing.otherGroup": "Other",
    "landing.continue": "Continue: {chapter}",
    "landing.generatingAudio": "Generating audio…",
    "landing.added": "Added {date}",
    "landing.updated": "Updated {date}",
    "landing.search": "Search title, author, or tag",
    "landing.searchClear": "Clear search",
    "landing.searchHideKeyboard": "Hide keyboard",
    "landing.filter": "Filter",
    "landing.sortFilter": "Sort & Filter",
    "landing.sortBy": "Sort by",
    "landing.filtersN": "{n} filters",
    "landing.clearFilters": "Clear",
    "landing.selectedFilters": "Selected",
    "landing.showResults": "Show {n} books",
    "landing.readingState": "Reading status",
    "reading.all": "All",
    "reading.unread": "Unread",
    "reading.progress": "Reading",
    "reading.finished": "Finished",
    "landing.group": "Group",
    "landing.expandAllSeries": "Expand all",
    "landing.collapseAllSeries": "Collapse all",
    "landing.kind": "Show",
    "landing.kindAll": "All",
    "landing.tags": "Tags",
    "landing.facetSelected": "{n} of {total} selected",
    "sync.title": "Sync & offline",
    "sync.prefetching": "Saving for offline…",
    "sync.upToDate": "Up to date",
    "sync.generatingBook": "Generating this book's audio",
    "sync.generatingAmbient": "Generating audio…",
    "sync.failedCount": "{n} failed",
    "sync.offlineAuto":
      "Saved offline automatically — reading as you open, audio as you listen.",
    "offline.downloads": "Downloads",
    "offline.description":
      "Text and compressed audio download automatically within your storage budget for fully offline reading and listening.",
    "offline.wifiOnly": "Prefetch on WiFi only",
    "offline.wifiOnlyHint": "Don't auto-preload on cellular",
    "offline.maxStorage": "Max storage",
    "offline.maxStorageHint": "Evicts least-recently-used audio over budget",
    "offline.waitingWifi": "Waiting for WiFi",
    "offline.available": "Available offline",
    "offline.downloading": "Downloading",
    "offline.content": "Offline content",
    "offline.text": "Text",
    "offline.audio": "Audio",
    "offline.chapterAbbr": "ch",
    "offline.lowerLimit": "Lower storage limit",
    "offline.lowerLimitBody":
      "{used} in use exceeds the new {limit} GB limit. Confirming evicts least-recently-used audio to fit.",
    "offline.confirmDelete": "Confirm",
    "landing.filterBooks": "Books",
    "landing.filterDocs": "Docs",
    "landing.audiobookBadge": "Audiobook",
    "landing.bookBadge": "Book",
    "landing.docsBadge": "Docs",
    "sidebar.bookshelf": "Bookshelf",
    "sidebar.contents": "Contents",
    "sidebar.expandAll": "Expand all",
    "sidebar.collapseAll": "Collapse all",
    "sidebar.reveal": "Reveal current file",
    "sidebar.language": "Language",
    "app.scrollTop": "Scroll to top",
    "app.scrollBottom": "Scroll to bottom",
    "reader.prevPage": "Previous",
    "reader.nextPage": "Next",
    "content.selectFile": "Select a file from the sidebar",
    "content.offline":
      "This page isn't saved offline yet — reconnect to read it.",
    "content.loadFailed": "Couldn't load this page.",
    "content.retry": "Retry",
    "content.unsupported": "Unsupported file type: {type}",
    "content.untranslated":
      "Not translated to {lang} yet — showing {fallback}.",
    "audiobook.open": "Listen (audiobook)",
    "audiobook.read": "Read (text)",
    "audiobook.loading": "Synthesizing narration…",
    "audiobook.transcriptUnavailable":
      "Read-along text is unavailable. Audio playback can continue.",
    "audiobook.error": "Audio unavailable: {error}",
    "audiobook.seek": "Seek",
    "audiobook.speed": "Playback speed",
    "audiobook.play": "Play",
    "audiobook.pause": "Pause",
    "audiobook.readAloud": "Read this page aloud",
    "audiobook.stopReadAloud": "Stop reading aloud",
    "audiobook.skipBack": "Back 15 seconds",
    "audiobook.skipForward": "Forward 15 seconds",
    "audiobook.prevChapter": "Previous chapter",
    "audiobook.nextChapter": "Next chapter",
    "audiobook.follow": "Follow narration",
    "audiobook.following": "Following narration",
    "audiobook.goToCurrent": "Go to current chapter",
    "audiobook.nowPlaying": "Now playing — tap for controls",
    "audiobook.playback": "Playback",
    "audiobook.stop": "Stop & close",
    "audiobook.cancel": "Cancel",
    "audiobook.empty": "This audiobook has no chapters yet.",
    "audiobook.sleepTimer": "Sleep timer",
    "audiobook.sleepOff": "Off",
    "sync.audio": "Synced to {book} · {chapter} · {time}",
    "sync.settings": "Settings synced",
    "shortcut.title": "Keyboard shortcuts",
    "shortcut.group.playback": "Playback",
    "shortcut.group.chapter": "Chapters",
    "shortcut.group.speed": "Speed",
    "shortcut.group.general": "General",
    "shortcut.playPause": "Play / pause",
    "shortcut.back": "Back 15 seconds",
    "shortcut.forward": "Forward 15 seconds",
    "shortcut.prevChapter": "Previous chapter",
    "shortcut.nextChapter": "Next chapter",
    "shortcut.slower": "Slow down",
    "shortcut.faster": "Speed up",
    "shortcut.help": "Show this list",
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
    "settings.margin": "Margin",
    "settings.marginDesc": "Side gutter of the reading column",
    "settings.lineHeight": "Line height",
    "settings.lineHeightDesc": "Space between lines of text",
    "sort.updated": "Updated",
    "sort.read": "Read",
    "sort.added": "Added",
    "sort.name": "Name",
    "settings.group": "Group books",
    "group.none": "Don't group",
    "group.collection": "By series",
    "settings.about": "About",
    "settings.aboutText":
      "liveview — read and listen to your library, always up to date.",
    "shell.close": "Close",
    "shell.back": "Back",
    "shell.navigation": "Navigation",
    "shell.openNavigation": "Open navigation",
    "shell.closeNavigation": "Close navigation",
    "shell.collapseNavigation": "Collapse navigation",
    "shell.imagePreview": "Image preview",
    "shell.previousImage": "Previous image",
    "shell.nextImage": "Next image",
    "shell.zoomIn": "Zoom in",
    "shell.zoomOut": "Zoom out",
    "shell.connectionLost": "Connection lost — reconnecting…",
    "shell.reconnected": "Reconnected",
    "shell.updateReloading": "New version · reloading in {n}s",
  },
  zh: {
    "landing.noMounts": "liveview 配置里没有 [[book]]——添加后会出现在这里。",
    "landing.noResults": "没有匹配的结果",
    "landing.otherGroup": "其他",
    "landing.continue": "继续：{chapter}",
    "landing.generatingAudio": "正在生成音频…",
    "landing.added": "创建于 {date}",
    "landing.updated": "更新于 {date}",
    "landing.search": "搜索书名、作者或标签",
    "landing.searchClear": "清除搜索",
    "landing.searchHideKeyboard": "收起键盘",
    "landing.filter": "筛选",
    "landing.sortFilter": "排序与筛选",
    "landing.sortBy": "排序",
    "landing.filtersN": "{n} 个筛选",
    "landing.clearFilters": "清除",
    "landing.selectedFilters": "已选择",
    "landing.showResults": "显示 {n} 本",
    "landing.readingState": "阅读状态",
    "reading.all": "全部",
    "reading.unread": "未读",
    "reading.progress": "阅读中",
    "reading.finished": "已读完",
    "landing.group": "分组",
    "landing.expandAllSeries": "展开全部",
    "landing.collapseAllSeries": "折叠全部",
    "landing.kind": "显示",
    "landing.kindAll": "全部",
    "landing.tags": "标签",
    "landing.facetSelected": "已选 {n} / {total}",
    "sync.title": "同步与离线",
    "sync.prefetching": "正在保存离线…",
    "sync.upToDate": "已是最新",
    "sync.generatingBook": "正在生成本书音频",
    "sync.generatingAmbient": "正在生成音频…",
    "sync.failedCount": "{n} 个失败",
    "sync.offlineAuto": "已自动离线缓存——阅读随开随存,音频边听边存。",
    "offline.downloads": "下载",
    "offline.description":
      "文字与压缩音频会在存储上限内自动下载到本机，断网也能读和听。",
    "offline.wifiOnly": "仅 WiFi 预加载",
    "offline.wifiOnlyHint": "蜂窝网络下不自动预加载",
    "offline.maxStorage": "最大存储",
    "offline.maxStorageHint": "超出后淘汰最久未用的音频",
    "offline.waitingWifi": "等待 WiFi",
    "offline.available": "已离线",
    "offline.downloading": "下载中",
    "offline.content": "离线内容",
    "offline.text": "文字",
    "offline.audio": "音频",
    "offline.chapterAbbr": "章",
    "offline.lowerLimit": "降低存储上限",
    "offline.lowerLimitBody":
      "当前已用 {used}，超过新上限 {limit} GB。确认后会删除最久未用的音频直到符合上限。",
    "offline.confirmDelete": "确认删除",
    "landing.filterBooks": "书",
    "landing.filterDocs": "文档",
    "landing.audiobookBadge": "有声书",
    "landing.bookBadge": "书",
    "landing.docsBadge": "文档",
    "sidebar.bookshelf": "书架",
    "sidebar.contents": "目录",
    "sidebar.expandAll": "全部展开",
    "sidebar.collapseAll": "全部折叠",
    "sidebar.reveal": "定位当前文件",
    "sidebar.language": "语言",
    "app.scrollTop": "回到顶部",
    "app.scrollBottom": "滚动到底部",
    "reader.prevPage": "上一页",
    "reader.nextPage": "下一页",
    "content.selectFile": "从侧边栏选择一个文件",
    "content.offline": "本页尚未离线缓存——联网后即可阅读。",
    "content.loadFailed": "无法加载本页。",
    "content.retry": "重试",
    "content.unsupported": "不支持的文件类型：{type}",
    "content.untranslated": "本页尚未翻译为{lang}——显示{fallback}。",
    "audiobook.open": "听书",
    "audiobook.read": "阅读",
    "audiobook.loading": "正在合成朗读音频…",
    "audiobook.transcriptUnavailable": "朗读正文暂不可用，音频仍可继续播放。",
    "audiobook.error": "音频不可用：{error}",
    "audiobook.seek": "跳转",
    "audiobook.speed": "播放速度",
    "audiobook.play": "播放",
    "audiobook.pause": "暂停",
    "audiobook.readAloud": "朗读本页",
    "audiobook.stopReadAloud": "停止朗读",
    "audiobook.skipBack": "后退 15 秒",
    "audiobook.skipForward": "前进 15 秒",
    "audiobook.prevChapter": "上一章",
    "audiobook.nextChapter": "下一章",
    "audiobook.follow": "跟随朗读",
    "audiobook.following": "正在跟随朗读",
    "audiobook.goToCurrent": "回到当前章节",
    "audiobook.nowPlaying": "正在播放 — 点击展开控件",
    "audiobook.playback": "播放控制",
    "audiobook.stop": "停止播放并关闭",
    "audiobook.cancel": "取消",
    "audiobook.empty": "这本有声书还没有章节。",
    "audiobook.sleepTimer": "定时关闭",
    "audiobook.sleepOff": "关闭",
    "sync.audio": "已同步到《{book}》· {chapter} · {time}",
    "sync.settings": "已同步设置",
    "shortcut.title": "键盘快捷键",
    "shortcut.group.playback": "播放",
    "shortcut.group.chapter": "章节",
    "shortcut.group.speed": "速度",
    "shortcut.group.general": "通用",
    "shortcut.playPause": "播放 / 暂停",
    "shortcut.back": "后退 15 秒",
    "shortcut.forward": "前进 15 秒",
    "shortcut.prevChapter": "上一章",
    "shortcut.nextChapter": "下一章",
    "shortcut.slower": "减速",
    "shortcut.faster": "加速",
    "shortcut.help": "显示快捷键列表",
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
    "settings.margin": "页边距",
    "settings.marginDesc": "正文两侧的留白",
    "settings.lineHeight": "行距",
    "settings.lineHeightDesc": "行与行之间的间距",
    "sort.updated": "最近更新",
    "sort.read": "最近阅读",
    "sort.added": "最近添加",
    "sort.name": "名称",
    "settings.group": "书籍分组",
    "group.none": "不分组",
    "group.collection": "按系列",
    "settings.about": "关于",
    "settings.aboutText": "liveview —— 阅读与收听你的书库，内容自动更新。",
    "shell.close": "关闭",
    "shell.back": "返回",
    "shell.navigation": "导航",
    "shell.openNavigation": "打开导航",
    "shell.closeNavigation": "关闭导航",
    "shell.collapseNavigation": "收起导航",
    "shell.imagePreview": "图片预览",
    "shell.previousImage": "上一张",
    "shell.nextImage": "下一张",
    "shell.zoomIn": "放大",
    "shell.zoomOut": "缩小",
    "shell.connectionLost": "连接已断开，正在重连…",
    "shell.reconnected": "已重新连接",
    "shell.updateReloading": "有新版本 · {n} 秒后刷新",
  },
};

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
