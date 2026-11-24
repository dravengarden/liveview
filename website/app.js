const root = document.documentElement;
const header = document.querySelector(".site-header");
const themeColor = document.querySelector('meta[name="theme-color"]');
const navToggle = document.querySelector(".nav-toggle");
const navigation = document.querySelector(".site-navigation");
const preferencesControl = document.querySelector(".preferences-control");
const preferencesToggle = document.querySelector(".preferences-toggle");
const preferencesPopover = document.querySelector(".preferences-popover");
const backToTop = document.querySelector(".back-to-top");
const themeChoices = [...document.querySelectorAll("[data-theme-choice]")];
const languageChoices = [...document.querySelectorAll("[data-language-choice]")];
const colorSchemeQuery = globalThis.matchMedia("(prefers-color-scheme: dark)");

/* Theme */

let themeMode = ["system", "light", "dark"].includes(root.dataset.themeMode)
  ? root.dataset.themeMode
  : "system";

function resolvedTheme(mode) {
  if (mode === "system") return colorSchemeQuery.matches ? "dark" : "light";
  return mode;
}

function setThemeMode(mode, { persist = true } = {}) {
  if (!["system", "light", "dark"].includes(mode)) return;
  themeMode = mode;
  const theme = resolvedTheme(mode);
  const canvas = theme === "dark" ? "#0c1430" : "#f8f1e5";
  root.dataset.theme = theme;
  root.dataset.themeMode = mode;
  root.style.backgroundColor = canvas;
  themeColor?.setAttribute("content", canvas);
  // Artwork follows the chosen theme, not only the operating system.
  document.querySelectorAll("source[data-theme-art-dark]").forEach((source) => {
    source.setAttribute("media", theme === "dark" ? "all" : "not all");
  });
  themeChoices.forEach((choice) => {
    choice.setAttribute("aria-pressed", String(choice.dataset.themeChoice === mode));
  });
  if (!persist) return;
  try {
    localStorage.setItem("liveview-site-theme", mode);
  } catch (_) {
    // The choice stays session-local when storage is unavailable.
  }
}

setThemeMode(themeMode, { persist: false });
themeChoices.forEach((choice) => {
  choice.addEventListener("click", () => setThemeMode(choice.dataset.themeChoice ?? "system"));
});
colorSchemeQuery.addEventListener?.("change", () => {
  if (themeMode === "system") setThemeMode("system", { persist: false });
});

/* Language */

const zh = {
  "meta.title": "LiveView — 鲜活的技术书",
  "meta.description":
    "LiveView 将 Markdown 书籍与技术文档变成自托管书库：可阅读、可收听逐句同步的音频、可交互探索，并能经过校验后离线保存。",
  "meta.social": "让技术书既适合阅读，也同样适合收听与离线使用。",
  skip: "跳到正文",
  "brand.home": "LiveView 首页",
  "brand.github": "在 GitHub 上查看 LiveView",
  "nav.aria": "主导航",
  "nav.experience": "体验",
  "nav.formats": "格式",
  "nav.offline": "离线",
  "nav.architecture": "架构",
  "nav.start": "开始使用",
  "nav.docs": "文档",
  controls: "网站控制",
  "prefs.title": "偏好设置",
  "prefs.subtitle": "主题与语言",
  "prefs.appearance": "外观",
  "prefs.system": "跟随系统",
  "prefs.light": "浅色",
  "prefs.dark": "深色",
  "prefs.language": "语言",
  "hero.eyebrow": "自托管技术书库",
  "hero.read": "深入阅读。",
  "hero.listen": "自然收听。",
  "hero.offline": "离线留存。",
  "hero.lede":
    "LiveView 把 Markdown、技术资源、译本和音频组合成同一份出版物——在任意屏幕上阅读，用逐句同步的朗读收听，并以经过校验、内容寻址的副本保存在你的设备上。",
  "hero.ownership": "你的书。你的存储。你的离线副本。",
  "hero.run": "运行 LiveView",
  "hero.explore": "查看体验",
  "hero.signals": "LiveView 特性",
  "hero.signal.markdown": "原生 Markdown",
  "hero.signal.audio": "逐句同步音频",
  "hero.signal.merkle": "Merkle 离线",
  "hero.signal.platforms": "Web · PWA · iOS · macOS",
  "hero.imageAlt": "抽象的 LiveView 桌面书架，以及正在朗读并高亮句子、显示图表和音频播放器的手机阅读器",
  "hero.chip": "逐句同步",
  "facts.contract": "套内容契约，从预览到离线",
  "facts.formats": "种原生技术格式",
  "facts.services": "个外部服务即可预览文件夹",
  "facts.renditions": "种呈现：阅读 + 收听",
  "experience.eyebrow": "一份出版物，三种进入方式",
  "experience.title1": "读它。听它。",
  "experience.title2": "用它工作。",
  "experience.intro": "切换设备、语言或模式时，技术书不应变成另一个产品。LiveView 让出版物始终完整。",
  "experience.read": "阅读",
  "experience.readTitle": "为密集思想而生的从容排版。",
  "experience.readBody": "响应式排版、真实的章节、搜索，以及把书当作书——而不是文件夹——的书架。",
  "experience.listen": "收听",
  "experience.listenTitle": "知道读到哪一页的音频。",
  "experience.listenBody": "文本与有声书共享同一身份。句级时间轴让朗读与阅读位置同步——离线可用，也支持锁屏控制。",
  "experience.explore": "探索",
  "experience.exploreTitle": "技术内容保持技术性。",
  "experience.exploreBody": "图表、Mermaid、公式、Typst、数据、PDF 与交互视图保留原有语义，而不是被压平成图片。",
  "offline.eyebrow": "天生离线",
  "offline.title1": "可校验的离线。",
  "offline.title2": "属于你的基础设施。",
  "offline.addressed": "内容寻址",
  "offline.addressedBody": "文本、封面、背景图、文档与音频都是 Merkle DAG 资源。设备只保留它校验过的内容。",
  "offline.incremental": "增量同步",
  "offline.incrementalBody": "只有变化的路径会经过发布与同步——从不重建整个书库。",
  "offline.owned": "自托管",
  "offline.ownedBody": "源文件、PostgreSQL、S3 兼容存储与分发都运行在你控制的基础设施上。",
  "surfaces.eyebrow": "每块屏幕，完整深度",
  "surfaces.title1": "桌面端信息密集。",
  "surfaces.title2": "移动端触控优先。",
  "surfaces.intro": "桌面端展示书库结构；手机端单列、易于单手触达，且不简化内容。两者读取同一份出版物。",
  "surfaces.imageAlt": "三个抽象的 LiveView 手机界面：带进度的书架、带滑块和指标的交互图表、高亮当前句子的有声书播放器",
  "surfaces.discover": "发现",
  "surfaces.discoverBody": "合集、版本与进度",
  "surfaces.explore": "探索",
  "surfaces.exploreBody": "信号、控件与实时图表",
  "surfaces.listen": "收听",
  "surfaces.listenBody": "原生播放，逐句高亮",
  "cap.library": "书库",
  "cap.libraryBody": "合集、标签、版本与搜索",
  "cap.languages": "多语言",
  "cap.languagesBody": "译本之间共享同一身份",
  "cap.voices": "语音",
  "cap.voicesBody": "本地 Kokoro 或 Edge TTS，可按范围设置",
  "cap.progress": "进度",
  "cap.progressBody": "按设备记录，随处续读",
  "formats.eyebrow": "格式原生",
  "formats.title1": "不是所有内容",
  "formats.title2": "都是散文。",
  "formats.intro": "检查器与渲染器接受相同的格式；切换到音频时，每一种非散文资源都有专门的朗读方式。",
  "formats.filterAria": "筛选格式",
  "formats.all": "全部",
  "formats.group.text": "文本与公式",
  "formats.group.diagrams": "图表",
  "formats.group.data": "数据",
  "formats.group.media": "文档与媒体",
  "formats.group.interactive": "交互与音频",
  "formats.reference": "格式参考",
  "format.markdown": "章节、脚注与 GitHub 风格语法。",
  "format.math": "公式为页面渲染，也会被准确地朗读。",
  "format.typst": "排版块编译进章节。",
  "format.mermaid": "随明暗主题原生渲染的图表。",
  "format.svg": "发布前经过检查的矢量图。",
  "format.excalidraw": "保持清晰的手绘草图。",
  "format.csv-tsv": "表格保持为数据，而不是图片。",
  "format.json": "由检查器校验的结构化数据。",
  "format.images": "内容寻址的插图与配图。",
  "format.pdf-html": "嵌入的文档与独立页面，可离线阅读。",
  "format.interactive-views": "信号、控件、计算指标与图表。",
  "format.spoken-scripts": "带句级时间标记的有声书脚本。",
  "arch.eyebrow": "一套内容契约",
  "arch.title1": "从源文件到书架，",
  "arch.title2": "完整无损。",
  "arch.intro": "预览、检查、发布、网页阅读与原生同步共享同一套解析规则。你检查过的内容，就是读者收到的内容。",
  "arch.imageAlt": "LiveView 发布流水线：作者的书库文件夹、与渲染器一致的检查、只更新变化路径的增量内容寻址 DAG，以及带有校验过的离线副本的网页与原生阅读器",
  "arch.manifestAria": "LiveView 书籍清单示例",
  "arch.authored": "作者所有",
  "arch.authoredTitle": "书就是你已有的文件夹。",
  "arch.authoredBody": "章节、译本、插图与朗读脚本放在一个小小的清单旁边。标签归你所有——LiveView 从不强加分类体系。",
  "arch.checked": "先检查，再给读者",
  "arch.checkedTitle": "在关口拦下故障。",
  "arch.checkedBody": "<code>liveview check</code> 与 <code>gate</code> 使用与渲染器一致的解析器和警告基线，回归永远到不了书架。",
  "arch.delivered": "完整交付",
  "arch.deliveredTitle": "Web、PWA 与原生读取同一个 DAG。",
  "arch.deliveredBody": "阅读器更新通过 OTA 发布；原生外壳额外提供后台音频与锁屏控制。",
  "start.eyebrow": "开源，随时可构建",
  "start.title": "让你的书库鲜活起来。",
  "start.intro": "从一个文件夹开始，无需任何服务。当书库需要持久发布与可校验的离线访问时，再加入 PostgreSQL、S3 兼容存储和原生外壳。",
  "start.step1": "构建一次",
  "start.step1Body": "可复现的 Nix 包，固定版本工具链。",
  "start.step2": "预览任意文件夹",
  "start.step2Body": "需要书架时再添加 book.toml →",
  "start.step3": "持久发布",
  "start.step3Body": "PostgreSQL + S3，增量同步 →",
  "start.github": "阅读快速开始",
  "start.author": "编写交互视图",
  "start.terminal": "liveview — 快速开始",
  "start.copy": "复制",
  "footer.top": "返回顶部",
  "footer.tagline": "让技术书既适合阅读，也同样适合收听与离线使用。",
  "footer.product": "产品",
  "footer.experience": "阅读 · 收听 · 探索",
  "footer.formats": "格式",
  "footer.architecture": "架构",
  "footer.developers": "开发者",
  "footer.source": "源码",
  "footer.docs": "文档",
  "footer.requirements": "核心需求",
  "footer.contributing": "参与贡献",
  "footer.security": "安全",
  "footer.license": "MIT 许可 · 天生自托管",
};

const runtime = {
  en: {
    openNavigation: "Open navigation",
    closeNavigation: "Close navigation",
    openPreferences: "Open preferences",
    closePreferences: "Close preferences",
    shown: (count) => `${count} formats shown`,
    copy: "Copy",
    copied: "Copied",
  },
  zh: {
    openNavigation: "打开导航",
    closeNavigation: "关闭导航",
    openPreferences: "打开偏好设置",
    closePreferences: "关闭偏好设置",
    shown: (count) => `显示 ${count} 种格式`,
    copy: "复制",
    copied: "已复制",
  },
};

const originalHtml = new WeakMap();
const originalAttributes = new WeakMap();
let language = root.dataset.language === "zh" ? "zh" : "en";

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    if (!originalHtml.has(node)) originalHtml.set(node, node.innerHTML);
    const value = language === "zh" ? zh[node.dataset.i18n] : undefined;
    // Messages are static strings owned by this file; a few carry <code>.
    node.innerHTML = value ?? originalHtml.get(node);
  });
  for (const attribute of ["aria-label", "alt", "content"]) {
    document.querySelectorAll(`[data-i18n-${attribute}]`).forEach((node) => {
      let originals = originalAttributes.get(node);
      if (!originals) {
        originals = {};
        originalAttributes.set(node, originals);
      }
      if (!(attribute in originals)) originals[attribute] = node.getAttribute(attribute) ?? "";
      const value = language === "zh" ? zh[node.getAttribute(`data-i18n-${attribute}`)] : undefined;
      node.setAttribute(attribute, value ?? originals[attribute]);
    });
  }
}

function refreshControlLabels() {
  const messages = runtime[language];
  const navOpen = navToggle?.getAttribute("aria-expanded") === "true";
  const prefsOpen = preferencesToggle?.getAttribute("aria-expanded") === "true";
  navToggle?.setAttribute("aria-label", navOpen ? messages.closeNavigation : messages.openNavigation);
  preferencesToggle?.setAttribute(
    "aria-label",
    prefsOpen ? messages.closePreferences : messages.openPreferences,
  );
}

function setLanguage(next, { persist = true } = {}) {
  language = next === "zh" ? "zh" : "en";
  root.dataset.language = language;
  root.lang = language === "zh" ? "zh-CN" : "en";
  applyTranslations();
  languageChoices.forEach((choice) => {
    choice.setAttribute("aria-pressed", String(choice.dataset.languageChoice === language));
  });
  refreshControlLabels();
  if (!persist) return;
  try {
    localStorage.setItem("liveview-site-language", language);
  } catch (_) {
    // Session-local when storage is unavailable.
  }
}

setLanguage(language, { persist: false });
languageChoices.forEach((choice) => {
  choice.addEventListener("click", () => setLanguage(choice.dataset.languageChoice));
});

/* Navigation and preferences */

function setNavigation(open) {
  navToggle?.setAttribute("aria-expanded", String(open));
  navigation?.toggleAttribute("data-open", open);
  refreshControlLabels();
}

function setPreferences(open) {
  preferencesToggle?.setAttribute("aria-expanded", String(open));
  if (preferencesPopover) preferencesPopover.hidden = !open;
  refreshControlLabels();
}

navToggle?.addEventListener("click", () => {
  setPreferences(false);
  setNavigation(navToggle.getAttribute("aria-expanded") !== "true");
});
navigation?.addEventListener("click", (event) => {
  if (event.target instanceof HTMLAnchorElement) setNavigation(false);
});
preferencesToggle?.addEventListener("click", () => {
  setNavigation(false);
  setPreferences(preferencesToggle.getAttribute("aria-expanded") !== "true");
});
document.addEventListener("click", (event) => {
  if (preferencesControl && !preferencesControl.contains(event.target)) setPreferences(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (preferencesToggle?.getAttribute("aria-expanded") === "true") preferencesToggle.focus();
  setPreferences(false);
  setNavigation(false);
});

function onScroll() {
  header?.toggleAttribute("data-scrolled", globalThis.scrollY > 12);
  backToTop?.toggleAttribute("data-visible", globalThis.scrollY > 900);
}
globalThis.addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* Format filters */

const filterButtons = [...document.querySelectorAll("[data-filter]")];
const formatCards = [...document.querySelectorAll(".format-card")];
const filterStatus = document.querySelector("#format-filter-status");

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter ?? "all";
    filterButtons.forEach((candidate) => {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    });
    let visible = 0;
    formatCards.forEach((card) => {
      const show = filter === "all" || card.dataset.group === filter;
      card.hidden = !show;
      if (show) {
        visible += 1;
        card.classList.add("is-visible");
      }
    });
    if (filterStatus) filterStatus.textContent = runtime[language].shown(visible);
  });
});

/* Copy runnable commands only: prompts, comments, and sample output are presentation. */

const copyButton = document.querySelector("[data-copy-target]");
copyButton?.addEventListener("click", async () => {
  const source = document.getElementById(copyButton.dataset.copyTarget ?? "");
  const clone = source?.cloneNode(true);
  clone?.querySelectorAll("[data-copy-exclude]").forEach((node) => node.remove());
  const text = (clone?.textContent ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  copyButton.textContent = runtime[language].copied;
  globalThis.setTimeout(() => {
    copyButton.textContent = runtime[language].copy;
  }, 1600);
});

document.querySelectorAll("[data-current-year]").forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

/* Reveal */

const revealItems = [...document.querySelectorAll(".reveal")];
const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!("IntersectionObserver" in globalThis) || reducedMotion) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  revealItems.forEach((item) => observer.observe(item));
}
