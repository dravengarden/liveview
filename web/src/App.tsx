import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Alert,
  Box,
  CssBaseline,
  IconButton,
  Snackbar,
  ThemeProvider,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import {
  Close as CloseIcon,
  Headphones as AudiobookIcon,
  MenuBook as ReadIcon,
} from "@mui/icons-material";
import {
  AudiobookPlayer,
  ContentViewer,
  FloatingBubble,
  Landing,
  ReconnectBanner,
  SettingsButton,
  Sidebar,
} from "@/components";
import {
  useFont,
  useNavbarAtBottom,
  useProgress,
  useSettings,
  useTheme,
  useWebSocket,
} from "@/hooks";
import { useI18n } from "@/i18n";
import { getServerSettings, putServerSetting } from "@/serverSettings";
import { type Track, useAudioPlayer } from "@/audio/player";
import { useAutoUpdate } from "@/hooks/useAutoUpdate";
import { NavShell } from "./_shell";
import type {
  Book,
  BookProgress,
  FileContent,
  FileType,
  ProgressEntry,
  RenditionInfo,
  TreeNode,
} from "@/types";

function findReadme(nodes: TreeNode[]): string | null {
  for (const node of nodes) {
    if (!node.is_dir && node.name.toLowerCase() === "readme.md") {
      return node.path;
    }
  }
  for (const node of nodes) {
    if (node.is_dir && node.children.length > 0) {
      const found = findReadme(node.children);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function hasFilePath(nodes: TreeNode[], target: string): boolean {
  for (const node of nodes) {
    if (!node.is_dir && node.path === target) return true;
    if (node.is_dir && hasFilePath(node.children, target)) return true;
  }
  return false;
}

function findNode(nodes: TreeNode[], target: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === target) return node;
    if (node.is_dir) {
      const found = findNode(node.children, target);
      if (found !== null) return found;
    }
  }
  return null;
}

function findFirstFile(nodes: TreeNode[]): string | null {
  for (const node of nodes) {
    if (!node.is_dir) {
      return node.path;
    }
  }
  for (const node of nodes) {
    if (node.is_dir) {
      const found = findFirstFile(node.children);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** Flatten a rendition spine into ordered chapter tracks — the playback queue
 *  for next/prev + auto-advance. Leaf files in depth-first (reading) order. */
function flattenTracks(nodes: TreeNode[], uiLang: string): Track[] {
  const out: Track[] = [];
  const walk = (ns: TreeNode[]): void => {
    for (const n of ns) {
      if (n.is_dir) walk(n.children);
      else {out.push({
          path: n.path,
          label: (uiLang && n.titles?.[uiLang]) || n.name,
        });}
    }
  };
  walk(nodes);
  return out;
}

interface HashState {
  path: string | null;
  lang: string | null;
  rendition: string | null;
}

// Hash scheme: `#<encoded-path>` for a file, optionally `&lang=<code>` to pin a
// non-default language edition and `&rendition=<kind>` to pin a non-default
// reading mode. `encodeURIComponent` escapes `&`/`=`, so the path segment can
// never collide with the `&lang=`/`&rendition=` separators. Both are omitted
// when they equal the book's default, to keep URLs clean.
function getHashState(): HashState {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) {
    return { path: null, lang: null, rendition: null };
  }
  const body = hash.slice(1);
  if (!body) {
    return { path: null, lang: null, rendition: null };
  }
  const parts = body.split("&");
  const path = decodeURIComponent(parts[0] ?? "") || null;
  let lang: string | null = null;
  let rendition: string | null = null;
  for (const seg of parts.slice(1)) {
    if (seg.startsWith("lang=")) {
      lang = decodeURIComponent(seg.slice(5)) || null;
    } else if (seg.startsWith("rendition=")) {
      rendition = decodeURIComponent(seg.slice(10)) || null;
    }
  }
  return { path, lang, rendition };
}

function buildHash(
  path: string | null,
  lang: string | null,
  rendition: string | null,
): string {
  if (!path) {
    return "";
  }
  let h = `#${encodeURIComponent(path)}`;
  if (lang) {
    h += `&lang=${encodeURIComponent(lang)}`;
  }
  if (rendition) {
    h += `&rendition=${encodeURIComponent(rendition)}`;
  }
  return h;
}

function writeHash(
  path: string | null,
  lang: string | null,
  rendition: string | null,
  replace: boolean,
): void {
  const h = buildHash(path, lang, rendition);
  const url = h || window.location.pathname;
  if (replace) {
    window.history.replaceState(null, "", url);
  } else {
    window.history.pushState(null, "", url);
  }
}

/** A page missing in the selected edition; we render `shown` content instead. */
interface UntranslatedNotice {
  requested: string;
  shown: string;
}

export function App(): React.JSX.Element {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  // `lang` is the *selected* edition; `untranslated` records when a page is
  // missing there and we fell back to another edition's content.
  const [lang, setLang] = useState<string>("");
  const [untranslated, setUntranslated] = useState<UntranslatedNotice | null>(
    null,
  );
  const [currentFileType, setCurrentFileType] = useState<FileType>("markdown");
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  // The browse plane's reading mode. Audio is no longer a browse view (it's the
  // floating popup), so in practice this stays "text" — it still drives which
  // rendition's spine + language list the reading chrome shows, and is threaded
  // to /api/file. The audio rendition is reached via the popup, never here.
  const [rendition, setRendition] = useState<string>("text");
  // Transient toast, e.g. when a listen affordance resolves to no chapters.
  // Belt-and-suspenders: the backend already omits content-less audio
  // renditions (no card/button), so this only fires on a race (content removed
  // after the book list loaded) — never a silent dead tap.
  const [notice, setNotice] = useState<string | null>(null);
  const initializedRef = useRef(false);
  // Refs for matching live WebSocket updates against what's currently shown
  // (the shown edition may differ from `lang` when falling back).
  const currentPathRef = useRef<string | null>(null);
  const contentLangRef = useRef<string>("");
  // The rendition whose spine `tree` currently holds. Live tree updates (which
  // arrive as the default text spine) must not clobber a non-text spine.
  const renditionRef = useRef<string>("text");

  const { loadBook, loadRecent, savedScroll, save: saveProgress } =
    useProgress();
  // Latest-read chapter per book (newest first), for the landing "continue
  // reading" indicators. Refetched whenever the bookshelf is shown so it
  // reflects progress made since the last visit.
  const [recentProgress, setRecentProgress] = useState<ProgressEntry[]>([]);

  // Per-book card state, SERVER-side (cross-device, survives a reload): which
  // rendition (read/listen) and which language edition the book was last opened
  // in. Keyed by slug; hydrated from /api/settings (`book.<slug>.{rendition,lang}`)
  // and written on every switch. The per-rendition reading position is already
  // server-side (it's keyed by chapter path, and text vs audio chapters differ).
  const [bookPrefs, setBookPrefs] = useState<
    Record<string, { rendition?: string; lang?: string }>
  >({});
  useEffect(() => {
    void getServerSettings().then((s) => {
      const out: Record<string, { rendition?: string; lang?: string }> = {};
      for (const [k, v] of Object.entries(s)) {
        const m = /^book\.(.+)\.(rendition|lang)$/.exec(k);
        if (m?.[1] && m[2]) {
          (out[m[1]] ??= {})[m[2] as "rendition" | "lang"] = v;
        }
      }
      setBookPrefs(out);
    });
  }, []);
  const saveBookPref = useCallback(
    (slug: string, patch: { rendition?: string; lang?: string }) => {
      setBookPrefs((prev) => ({
        ...prev,
        [slug]: { ...prev[slug], ...patch },
      }));
      if (patch.rendition !== undefined) {
        putServerSetting(
          `book.${slug}.rendition`,
          patch.rendition,
        );
      }
      if (patch.lang !== undefined) {
        putServerSetting(
          `book.${slug}.lang`,
          patch.lang,
        );
      }
    },
    [],
  );

  const { t, lang: uiLang } = useI18n();
  const { theme, muiTheme, variant, mode, setVariant, setMode } = useTheme();
  const { menuBarSettings, setContentMaxWidth, setLineHeight, setFontScale } =
    useSettings();
  // On the compact tier with the "bottom" navbar preference, both the in-book
  // NavShell and the bookshelf bar drop to the bottom (mobile-browser style).
  const navbarAtBottom = useNavbarAtBottom();
  // Apply the font-size setting GLOBALLY: scale the root <html> font-size so
  // every rem/em surface — reading prose, MUI typography, AND icons — tracks it
  // together (cowboy's useGlobalFontScale). px layout (MUI spacing, safe-area
  // insets, breakpoints) is unaffected, so the responsive tiers stay put.
  useEffect(() => {
    document.documentElement.style.fontSize = `${
      menuBarSettings.fontScale * 100
    }%`;
  }, [menuBarSettings.fontScale]);
  const { fontId, setFont } = useFont();
  // The root audio engine: playback + the popup live above every view, so
  // navigating never stops the audio nor closes the popup. We only need to seed
  // playback (`playChapter`) and raise the popup into focus (`setExpanded`).
  const { playChapter: audioPlayChapter, syncNotice, nowPlaying } =
    useAudioPlayer();
  // Mirror of `nowPlaying` for the view→engine effect's guard. That effect must
  // react ONLY to view-led navigation (currentPath), never to engine-led chapter
  // changes — reading nowPlaying through a ref keeps it out of the dep array so
  // the two sync effects can't leapfrog (see the effect below for the full why).
  const nowPlayingRef = useRef(nowPlaying);
  nowPlayingRef.current = nowPlaying;

  // Detect a deploy when the tab returns to the foreground (an iOS home-screen
  // PWA otherwise resumes its frozen page and never picks one up) and raise the
  // blue "new version" banner instead of yanking the page out from under the
  // reader/listener. See connectionStore + ReconnectBanner.
  useAutoUpdate();

  // When a fresh load pulls a newer playback position from another device, the
  // audio engine raises `syncNotice`; surface it through the shared snackbar
  // ("已同步…"). Keyed on `seq` so an identical message re-fires the toast.
  useEffect(() => {
    if (syncNotice) setNotice(syncNotice.message);
  }, [syncNotice]);

  // The active book is the first path segment; null ⇒ the landing bookshelf.
  const activeSlug = currentPath ? (currentPath.split("/")[0] ?? null) : null;
  const activeBook = books.find((b) => b.slug === activeSlug) ?? null;
  // Are we ON the playing book's inline audio page (where the read-along reader
  // already shows full controls)? If so the floating bubble hides; everywhere
  // else (text page, another book, the shelf) it shows as the now-playing handle.
  const onPlayingPage = nowPlaying != null &&
    activeSlug === nowPlaying.bookSlug && rendition === "audio";

  // Tap the top bar to jump the reader back to the top — the iOS
  // "tap the status bar" gesture. The reader's scroll container is the one
  // tagged `data-lv-scroller="reader"` (MarkdownViewer); query it lazily so a
  // chapter remount (which swaps the node) never leaves a stale ref.
  const scrollReaderTop = useCallback(() => {
    document.querySelector<HTMLElement>('[data-lv-scroller="reader"]')
      ?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  // Scroll whichever view is showing back to the top. Every scrollable view
  // tags its container `data-lv-scroller` (the shelf, and the book/audiobook
  // reader), so scrolling them all is safe — the hidden one is a no-op. Drives
  // the status-bar tap target below.
  const scrollAllTop = useCallback(() => {
    for (
      const el of document.querySelectorAll<HTMLElement>("[data-lv-scroller]")
    ) {
      el.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);
  // "book" mode (book.toml-driven) renders a clean titled spine; "docs" mode
  // renders the raw filesystem tree. The flag also drives whether the root
  // folder node is shown (see below) and the per-row styling in the sidebar.
  const bookMode = activeBook?.manifest ?? false;
  const activeTree = useMemo(() => {
    if (!activeSlug) return [];
    const root = tree.find((n) => n.path === activeSlug);
    if (!root) return [];
    // Book mode: the book label already sits in the sidebar header, so the
    // single root folder ("第一层 dir") is redundant — surface its
    // chapters/sections directly. Docs mode keeps the root for context.
    return bookMode ? root.children : [root];
  }, [tree, activeSlug, bookMode]);
  const bookLabel = activeBook?.label ?? activeSlug ?? "";
  // The renditions the active book offers, and the one currently active. The
  // language switcher shows the *active rendition's* languages (each rendition
  // carries its own lang list).
  const bookRenditions = activeBook?.renditions ?? [];
  const activeRendition = bookRenditions.find((r) => r.kind === rendition) ??
    bookRenditions.find((r) => r.kind === activeBook?.default_rendition) ??
    bookRenditions[0] ??
    null;
  const bookLangs = activeRendition?.langs ?? [];

  // The rendition a book opens in: its declared default, resolved to the
  // matching RenditionInfo (falling back to the first).
  const defaultRendition = useCallback(
    (book: Book): RenditionInfo | null =>
      book.renditions.find((r) => r.kind === book.default_rendition) ??
        book.renditions[0] ?? null,
    [],
  );

  // Initial edition for a rendition: prefer the UI locale if that rendition
  // offers it (axis A ↔ B default link), else the rendition's declared default.
  const pickInitialLang = useCallback(
    (r: RenditionInfo): string =>
      r.langs.some((l) => l.lang === uiLang) ? uiLang : r.default_lang,
    [uiLang],
  );

  // Fetch the book list once, for the landing page + language switcher.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/books");
        setBooks((await res.json()) as Book[]);
      } catch (e) {
        console.error("Failed to fetch books:", e);
      }
    })();
  }, []);

  // Refresh the landing's reading-progress whenever the bookshelf is shown
  // (initial load and every return from a book). Skip the state update when the
  // fetched rows are identical to what we already hold: returning from a book
  // otherwise replaced the array with an equal-but-new reference, which churned
  // `progressBySlug` (per-entry tree walks) and re-rendered every shelf card —
  // part of the "scroll is dead for a beat after returning" stall.
  useEffect(() => {
    if (activeSlug !== null) return;
    void (async () => {
      const rows = await loadRecent();
      setRecentProgress((prev) =>
        prev.length === rows.length &&
          prev.every((p, i) => {
            const r = rows[i];
            return r !== undefined && p.path === r.path &&
              p.scroll === r.scroll;
          })
          ? prev
          : rows
      );
    })();
  }, [activeSlug, loadRecent]);

  // Resolve each book's latest-read chapter into a display-ready entry — chapter
  // title (current UI edition, falling back to the node name, then the file
  // name) plus the in-chapter scroll ratio — split by rendition. A text+audio
  // book carries BOTH its newest text position and its newest audio
  // (`.spoken.md`) position, so the shelf card shows reading and listening
  // progress side by side; within a rendition the most-recent chapter wins.
  // Keyed by book slug for the landing.
  const progressBySlug = useMemo(() => {
    const out: Record<string, BookProgress> = {};
    const at: Record<string, { text: number; audio: number }> = {};
    for (const r of recentProgress) {
      const slug = r.path.split("/")[0] ?? "";
      const kind: "text" | "audio" = r.path.endsWith(".spoken.md")
        ? "audio"
        : "text";
      const seen = (at[slug] ??= { text: 0, audio: 0 });
      // Backend already returns one row per (book, rendition), but guard anyway
      // so the newest chapter wins if that ever changes.
      if (seen[kind] && r.updated_at <= seen[kind]) continue;
      seen[kind] = r.updated_at;
      const node = findNode(tree, r.path);
      const chapterLabel =
        (node && ((uiLang && node.titles?.[uiLang]) || node.name)) ||
        r.path.split("/").pop() ||
        r.path;
      (out[slug] ??= {})[kind] = {
        path: r.path,
        chapterLabel,
        scroll: r.scroll,
        updatedAt: r.updated_at,
      };
    }
    return out;
  }, [recentProgress, tree, uiLang]);

  const handleContentUpdate = useCallback(
    (path: string, msgLang: string, fileType: FileType, content: string) => {
      if (
        path === currentPathRef.current && msgLang === contentLangRef.current
      ) {
        setCurrentFileType(fileType);
        setCurrentContent(content);
      }
    },
    [],
  );

  const handleTreeUpdate = useCallback((newTree: TreeNode[]) => {
    // Live tree updates carry the default (text) spine. Don't let one clobber a
    // non-text spine the user is currently browsing.
    if (renditionRef.current === "text") {
      setTree(newTree);
    }
  }, []);

  useWebSocket({
    onContentUpdate: handleContentUpdate,
    onTreeUpdate: handleTreeUpdate,
  });

  // Fetch + render a file in `reqLang`. If the page is missing in that edition
  // (404) we transparently fall back to the book's default edition and surface
  // an "untranslated" notice. `reqLang` stays the selected edition regardless.
  const loadFile = useCallback(
    async (path: string, reqLang: string, reqRendition: string) => {
      setCurrentPath(path);
      currentPathRef.current = path;
      try {
        const res = await fetch(
          `/api/file?path=${encodeURIComponent(path)}&lang=${
            encodeURIComponent(reqLang)
          }&rendition=${encodeURIComponent(reqRendition)}`,
        );
        if (!res.ok) {
          console.error("Failed to fetch file:", path, res.status);
          return;
        }
        const data = (await res.json()) as FileContent;
        // The server resolves overlay → base and reports the edition it served.
        // If that differs from what we asked for, the page isn't translated yet.
        contentLangRef.current = data.lang;
        const apply = (): void => {
          setCurrentFileType(data.file_type);
          setCurrentContent(data.content);
          setUntranslated(
            data.lang !== reqLang
              ? { requested: reqLang, shown: data.lang }
              : null,
          );
        };
        // Cross-fade the reader between chapters where supported (the content
        // element carries `view-transition-name: lv-content`, so only it
        // animates — not the sidebar/chrome). flushSync applies the swap
        // synchronously inside the transition so it captures the new DOM.
        // Feature-detected + skipped under prefers-reduced-motion; instant swap
        // otherwise.
        const doc = document as Document & {
          startViewTransition?: (cb: () => void) => unknown;
        };
        const reduceMotion = window.matchMedia?.(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        if (!reduceMotion && typeof doc.startViewTransition === "function") {
          doc.startViewTransition(() => {
            flushSync(apply);
          });
        } else {
          apply();
        }
      } catch (e) {
        console.error("Failed to fetch file:", e);
      }
    },
    [],
  );

  // Open a file in a given edition + rendition: sync state, URL hash, and (for
  // the text rendition) content. The audio rendition renders in the player off
  // `currentPath`, so it needs no /api/file fetch — just the path + hash.
  const openFile = useCallback(
    async (
      path: string,
      langArg: string,
      renditionArg: string,
      replace = false,
    ) => {
      const slug = path.split("/")[0] ?? "";
      const book = books.find((b) => b.slug === slug);
      const rInfo = book?.renditions.find((r) => r.kind === renditionArg);
      // Omit lang/rendition from the URL when they equal the book/rendition
      // default, keeping deep links clean (mirrors how `lang` already behaves).
      const langForHash = rInfo && langArg !== rInfo.default_lang
        ? langArg
        : null;
      const renditionForHash = book && renditionArg !== book.default_rendition
        ? renditionArg
        : null;

      setLang(langArg);
      setRendition(renditionArg);
      renditionRef.current = renditionArg;
      // `replace` for an in-place rendition switch (read ↔ listen) so it doesn't
      // stack a back-button entry per toggle.
      writeHash(path, langForHash, renditionForHash, replace);
      if (renditionArg === "audio") {
        // Audio renders the read-along off the engine (seeded by the
        // view→engine effect from `currentPath`), so there's no /api/file body
        // to fetch — just set the path.
        setCurrentPath(path);
        currentPathRef.current = path;
      } else {
        await loadFile(path, langArg, renditionArg);
      }
    },
    [books, loadFile],
  );

  // Sidebar / markdown-link navigation stays within the current edition + mode.
  const handleSelect = useCallback(
    (path: string) => {
      void openFile(path, lang, rendition);
    },
    [openFile, lang, rendition],
  );

  // Switch the active book to another language edition, keeping the page +
  // rendition.
  const switchLang = useCallback(
    (newLang: string) => {
      if (currentPath) {
        if (activeSlug) saveBookPref(activeSlug, { lang: newLang });
        void openFile(currentPath, newLang, rendition);
      }
    },
    [currentPath, openFile, rendition, activeSlug, saveBookPref],
  );

  // The entry chapter of a rendition: resume the last-read chapter if it still
  // exists in that rendition's spine, else its README, else its first doc.
  const entryChapter = useCallback(
    async (slug: string, spine: TreeNode[]): Promise<string | null> => {
      const root = spine.find((n) => n.path === slug);
      const scope = root ? [root] : spine;
      const last = await loadBook(slug);
      const resume = last && hasFilePath(scope, last.path) ? last.path : null;
      return resume ?? findReadme(scope) ?? findFirstFile(scope);
    },
    [loadBook],
  );

  // Open a book's AUDIO rendition INLINE (a normal NavShell page with the audio
  // spine in the sidebar and the read-along in the content area — not a popup).
  // Fetches the audio spine, makes it the active tree, and opens the target
  // chapter; the view→engine effect then seeds playback. Target: an explicit
  // chapter (deep link / resume from the bubble), else this rendition's resume
  // chapter, else the first. Audio chapter ids differ from text, so we never map
  // a text position across — it lands on the audio rendition's own chapter.
  const openAudiobook = useCallback(
    (slug: string, chapterPath?: string, replace = false) => {
      const book = books.find((b) => b.slug === slug);
      const r = book?.renditions.find((x) => x.kind === "audio");
      if (!book || !r) {
        setNotice(t("audiobook.empty"));
        return;
      }
      void (async () => {
        try {
          const res = await fetch(`/api/tree?rendition=audio`);
          const spine = (await res.json()) as TreeNode[];
          const root = spine.find((n) => n.path === slug);
          const scope = root ? [root] : spine;
          let target = chapterPath && hasFilePath(scope, chapterPath)
            ? chapterPath
            : null;
          if (!target) {
            const last = await loadBook(slug);
            target =
              (last && hasFilePath(scope, last.path) ? last.path : null) ??
                findFirstFile(scope);
          }
          if (!target) {
            setNotice(t("audiobook.empty"));
            return;
          }
          setTree(spine);
          renditionRef.current = "audio";
          const prefLang = bookPrefs[slug]?.lang;
          const audioLang = prefLang && r.langs.some((l) => l.lang === prefLang)
            ? prefLang
            : pickInitialLang(r);
          void openFile(target, audioLang, "audio", replace);
        } catch (e) {
          console.error("Failed to open audiobook:", e);
        }
      })();
    },
    [books, bookPrefs, loadBook, pickInitialLang, openFile, t],
  );

  // Enter a book from the landing page in a specific rendition (the bookshelf
  // shows a separate card per rendition, so it passes the kind to open). Falls
  // back to the book's default rendition. Resumes the last-read chapter if there
  // is one (and it still exists), else its README, else its first doc.
  const enterBook = useCallback(
    (slug: string, renditionKind?: string, replace = false) => {
      const book = books.find((b) => b.slug === slug);
      if (!book) return;
      // No explicit kind (a shelf-card tap) ⇒ open in the rendition last used for
      // this book (server-side pref), else its default. An explicit kind (the
      // navbar switch) wins.
      const pref = bookPrefs[slug];
      const r =
        (renditionKind
          ? book.renditions.find((x) => x.kind === renditionKind)
          : undefined) ??
          (pref?.rendition
            ? book.renditions.find((x) => x.kind === pref.rendition)
            : undefined) ??
          defaultRendition(book);
      if (!r) return;
      // Restore the last-used edition for this book if it still exists in the
      // rendition, else this rendition's preferred initial edition.
      const initialLang =
        pref?.lang && r.langs.some((l) => l.lang === pref.lang)
          ? pref.lang
          : pickInitialLang(r);
      // Audio opens its inline read-along page (sidebar = audio spine).
      if (r.kind === "audio") {
        openAudiobook(slug, undefined, replace);
        return;
      }
      void (async () => {
        // Always fetch the default rendition's spine on entry: the cached
        // `tree` may hold another rendition's spine (we just left an audio
        // book) or be stale, so we can't trust it for resume/README lookup.
        try {
          const res = await fetch(
            `/api/tree?rendition=${encodeURIComponent(r.kind)}`,
          );
          const spine = (await res.json()) as TreeNode[];
          setTree(spine);
          renditionRef.current = r.kind;
          const entry = await entryChapter(slug, spine);
          if (entry) {
            void openFile(entry, initialLang, r.kind, replace);
          }
        } catch (e) {
          console.error("Failed to enter book:", e);
        }
      })();
    },
    [
      books,
      bookPrefs,
      defaultRendition,
      entryChapter,
      openFile,
      pickInitialLang,
      openAudiobook,
    ],
  );

  // Return to the landing bookshelf.
  const backToLanding = useCallback(() => {
    writeHash(null, null, null, false);
    setCurrentPath(null);
    currentPathRef.current = null;
    setCurrentContent(null);
    setUntranslated(null);
  }, []);

  useEffect(() => {
    document.title = currentPath ?? "liveview";
  }, [currentPath]);

  // Resolve which (rendition, lang) a hash deep-link should open: explicit
  // `&rendition=`/`&lang=` win; else the book's default rendition and that
  // rendition's preferred initial edition.
  const renditionForHashEntry = useCallback(
    (path: string, hashRendition: string | null): string => {
      const slug = path.split("/")[0] ?? "";
      const book = books.find((b) => b.slug === slug);
      if (
        hashRendition && book?.renditions.some((r) => r.kind === hashRendition)
      ) {
        return hashRendition;
      }
      return book?.default_rendition ?? "text";
    },
    [books],
  );

  const langForHashEntry = useCallback(
    (path: string, kind: string, hashLang: string | null): string => {
      if (hashLang) return hashLang;
      const slug = path.split("/")[0] ?? "";
      const book = books.find((b) => b.slug === slug);
      const rInfo = book?.renditions.find((r) => r.kind === kind);
      return rInfo ? pickInitialLang(rInfo) : "";
    },
    [books, pickInitialLang],
  );

  // Restore the view (path, lang, rendition) encoded in the hash. Fetches the
  // matching rendition's spine, sets state, and loads the chapter (audio
  // chapters route to the player off `currentPath`). Shared by initial load and
  // browser back/forward.
  const restoreFromHash = useCallback(
    async (replaceHash: boolean): Promise<void> => {
      const { path, lang: hashLang, rendition: hashRendition } = getHashState();
      if (!path) {
        // empty hash → the landing bookshelf
        setCurrentPath(null);
        currentPathRef.current = null;
        setCurrentContent(null);
        setUntranslated(null);
        return;
      }
      const kind = renditionForHashEntry(path, hashRendition);
      const entryLang = langForHashEntry(path, kind, hashLang);
      setLang(entryLang);
      setRendition(kind);
      renditionRef.current = kind;
      if (replaceHash) {
        // Normalise the hash to canonical form (drop a redundant default-rendition
        // or default-lang token) without adding a history entry.
        const slug = path.split("/")[0] ?? "";
        const book = books.find((b) => b.slug === slug);
        const rInfo = book?.renditions.find((r) => r.kind === kind);
        const langForHash = rInfo && entryLang !== rInfo.default_lang
          ? entryLang
          : null;
        const renditionForHash = book && kind !== book.default_rendition
          ? kind
          : null;
        writeHash(path, langForHash, renditionForHash, true);
      }
      try {
        const res = await fetch(
          `/api/tree?rendition=${encodeURIComponent(kind)}`,
        );
        setTree((await res.json()) as TreeNode[]);
      } catch (e) {
        console.error("Failed to fetch rendition tree:", e);
      }
      // Load the book's progress first so the doc restores its scroll.
      const slug = path.split("/")[0];
      if (slug) await loadBook(slug);
      if (kind === "audio") {
        // Audio renders off the engine (seeded by the view→engine effect).
        setCurrentPath(path);
        currentPathRef.current = path;
      } else {
        void loadFile(path, entryLang, kind);
      }
    },
    [books, loadFile, langForHashEntry, renditionForHashEntry, loadBook],
  );

  // Fetch the tree once, then restore any deep link from the hash. Waits for
  // `books` so deep-link rendition/language/fallback resolution works.
  useEffect(() => {
    if (initializedRef.current || books.length === 0) return;
    initializedRef.current = true;
    void (async () => {
      const { path } = getHashState();
      if (path) {
        await restoreFromHash(true);
      } else {
        // No deep link: seed the default (text) sidebar spine for the bookshelf.
        try {
          const res = await fetch("/api/tree");
          setTree((await res.json()) as TreeNode[]);
        } catch (e) {
          console.error("Failed to fetch tree:", e);
        }
      }
    })();
  }, [books, restoreFromHash]);

  // Handle browser back/forward navigation.
  useEffect(() => {
    const handlePopState = (): void => {
      void restoreFromHash(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [restoreFromHash]);

  // ── Inline audio: two effects keep the view and the playback engine in sync ──
  // A) view → engine: viewing an audio chapter makes the engine play it,
  //    seeding the queue from the loaded audio spine. A no-op once it's already
  //    that chapter, so re-opening / auto-advancing never restarts it.
  //
  //    Triggers on VIEW-led changes only (`currentPath`): opening a book, a
  //    sidebar/TOC tap, a deep link, browser back/forward. It must NOT depend on
  //    `nowPlaying`, or an ENGINE-led chapter change (transport next/prev, or
  //    auto-advance) would re-fire it mid-transition — while `currentPath` still
  //    points at the old chapter — and drag the engine back. That fights effect
  //    B (which is moving `currentPath` forward), and the two leapfrog forever:
  //    `replaceState` hammers the history API, Chrome throttles it, and the tab
  //    freezes/crashes. So the guard reads `nowPlaying` through a ref, keeping it
  //    out of the dep array; engine-led changes are effect B's job, not this one.
  useEffect(() => {
    if (
      rendition !== "audio" || !currentPath || !activeBook ||
      activeTree.length === 0
    ) return;
    if (nowPlayingRef.current?.chapterPath === currentPath) return;
    audioPlayChapter(
      {
        bookSlug: activeBook.slug,
        bookLabel: activeBook.label,
        cover: activeBook.cover,
        chapterPath: currentPath,
        lang,
        rendition,
      },
      flattenTracks(activeTree, uiLang),
    );
  }, [
    rendition,
    currentPath,
    activeBook,
    activeTree,
    lang,
    uiLang,
    audioPlayChapter,
  ]);

  // B) engine → view: when the engine auto-advances into the next chapter while
  //    you're watching THIS book's audio page, follow it (URL + sidebar). Follow
  //    ONLY when we were already in sync (so it's the engine advancing under us),
  //    never when we just navigated somewhere the engine isn't (effect A brings
  //    the engine to us there). Away from the audio page, the bubble tracks it.
  const syncedChapterRef = useRef<string | null>(null);
  useEffect(() => {
    const np = nowPlaying;
    if (
      !np || activeRendition?.kind !== "audio" || activeSlug !== np.bookSlug
    ) {
      syncedChapterRef.current = null;
      return;
    }
    if (currentPath === np.chapterPath) {
      syncedChapterRef.current = np.chapterPath;
      return;
    }
    if (syncedChapterRef.current !== currentPath) return; // we weren't in sync — don't hijack
    setCurrentPath(np.chapterPath);
    currentPathRef.current = np.chapterPath;
    setUntranslated(null);
    syncedChapterRef.current = np.chapterPath;
    const rInfo = activeBook?.renditions.find((r) => r.kind === rendition);
    const langForHash = rInfo && lang !== rInfo.default_lang ? lang : null;
    const renditionForHash =
      activeBook && rendition !== activeBook.default_rendition
        ? rendition
        : null;
    writeHash(np.chapterPath, langForHash, renditionForHash, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    nowPlaying,
    activeRendition,
    activeSlug,
    currentPath,
    activeBook,
    rendition,
    lang,
  ]);

  // One settings affordance reused in both chrome contexts (bookshelf header +
  // in-book NavShell actions). The shared SettingsSheet owns the gear and the
  // responsive surface — a bottom sheet on mobile, a dialog on desktop — so we
  // just hand it liveview's settings rows.
  const settingsButton = (
    <SettingsButton
      variant={variant}
      mode={mode}
      fontId={fontId}
      menuBarSettings={menuBarSettings}
      onVariantChange={setVariant}
      onModeChange={setMode}
      onFontChange={setFont}
      onContentMaxWidthChange={setContentMaxWidth}
      onLineHeightChange={setLineHeight}
      onFontScaleChange={setFontScale}
    />
  );

  const langLabel = (code: string): string =>
    bookLangs.find((l) => l.lang === code)?.label ?? code;

  // Whether the active book offers an audio rendition — gates the "listen"
  // affordances (the in-book top-bar headphones + the sidebar button), both of
  // which open the global listening popup for this book.
  const hasAudio = bookRenditions.some((r) => r.kind === "audio");
  const hasText = bookRenditions.some((r) => r.kind === "text");
  // Show the read/listen switch only when the book offers both renditions.
  const showRenditionToggle = hasAudio && hasText;

  // Tapping the floating bubble's artwork returns to the playing book's inline
  // audio page (re-entering at the chapter it's on).
  const openPlayingAudio = useCallback(() => {
    if (nowPlaying) openAudiobook(nowPlaying.bookSlug, nowPlaying.chapterPath);
  }, [nowPlaying, openAudiobook]);

  // Switch the active book between its text and audio renditions, in place.
  // Persisted per book so re-opening it from the shelf lands in the same mode.
  const switchRendition = useCallback(
    (kind: string) => {
      if (!activeSlug || kind === rendition) return;
      saveBookPref(activeSlug, { rendition: kind });
      // replace (not push): switching read ↔ listen is in place, not a new page.
      if (kind === "audio") openAudiobook(activeSlug, undefined, true);
      else enterBook(activeSlug, kind, true);
    },
    [activeSlug, rendition, openAudiobook, enterBook, saveBookPref],
  );

  // In-book top-bar actions: the read/listen switch (when the book has both
  // renditions) + the shared settings affordance.
  const bookActions = (
    <>
      {showRenditionToggle && (
        <ToggleButtonGroup
          size="small"
          exclusive
          value={rendition}
          onChange={(_, value: string | null) => {
            if (value) switchRendition(value);
          }}
        >
          <ToggleButton value="text" aria-label={t("audiobook.read")}>
            <ReadIcon fontSize="small" />
          </ToggleButton>
          <ToggleButton value="audio" aria-label={t("audiobook.open")}>
            <AudiobookIcon fontSize="small" />
          </ToggleButton>
        </ToggleButtonGroup>
      )}
      {settingsButton}
    </>
  );

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      {
        /* The persistent themed backdrop. Returning from a book unmounts the
            NavShell + its ~900 markdown nodes in one commit; while reading,
            `.markdown-body`'s own opaque background covers the viewport, so
            without a themed colour here the bare body showed through for the
            frame of the swap as a white flash. Painting background.default on
            the always-mounted container means the swap happens over a stable,
            theme-correct surface. */
      }
      <Box
        sx={{
          height: "100dvh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          bgcolor: "background.default",
        }}
      >
        {
          /* iOS "tap the status bar to scroll to top" gesture. The app scrolls
              an inner overflow container, not the document/window, so the native
              gesture (which only drives the window's scroll view) does nothing
              here. This invisible tap target spans the status-bar / notch strip
              (the safe-area top inset) and, when tapped, scrolls whichever view
              is showing — shelf, book, or audiobook read-along — back to the
              top. It's exactly the inset tall, so off-notch (desktop) it's
              zero-height and catches nothing. Sits just above the app bar so it
              wins over the navbar's notch background, but below the modal sheets
              (settings / now-playing), whose own top strip stays interactive. */
        }
        <Box
          aria-hidden
          onClick={scrollAllTop}
          sx={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: "env(safe-area-inset-top, 0px)",
            zIndex: (t) => t.zIndex.appBar + 1,
          }}
        />
        {
          /* Connection / version banner, above everything so it spans the width
              and pushes the view stack + mini-player down when shown. */
        }
        <ReconnectBanner />
        {
          /* The view stack (bookshelf + open book) fills the space above the
              persistent mini-player, which takes its own row below so it pushes
              content up instead of covering it. */
        }
        <Box sx={{ position: "relative", flex: 1, minHeight: 0 }}>
          {
            /* The bookshelf stays mounted (just hidden) while a book is open, so
              its scroll position survives the round trip — no remount, no
              restore jump. We hide it with opacity:0 (NOT visibility:hidden):
              a visibility-hidden subtree is "not relevant to the user", so the
              cards' `content-visibility:auto` skips rendering them, and on the
              way back they must render in for a frame (empty intrinsic-size
              boxes → content pops) — a whole-page flash. opacity:0 keeps the
              in-viewport cards rendered (just transparent), so returning is a
              compositor-only opacity flip: instant, flash-free. (Off-screen
              cards are still skipped by content-visibility, and the scroll
              offset is preserved.) */
          }
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              opacity: activeSlug === null ? 1 : 0,
              pointerEvents: activeSlug === null ? "auto" : "none",
            }}
          >
            <Landing
              books={books}
              progress={progressBySlug}
              onOpen={enterBook}
              onHome={backToLanding}
              settingsSlot={settingsButton}
              navbarAtBottom={navbarAtBottom}
            />
          </Box>
          {activeSlug !== null && (
            <NavShell
              appKey="liveview"
              barPosition={navbarAtBottom ? "bottom" : "top"}
              title={
                <Box
                  component="span"
                  role="button"
                  tabIndex={0}
                  aria-label={t("app.scrollTop")}
                  onClick={scrollReaderTop}
                  sx={{
                    display: "block",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {bookLabel}
                </Box>
              }
              nav={(api) => (
                <Sidebar
                  tree={activeTree}
                  currentPath={currentPath}
                  bookMode={bookMode}
                  langs={bookLangs}
                  currentLang={lang}
                  onSwitchLang={switchLang}
                  onSelect={(path) => {
                    handleSelect(path);
                    api.closeMobile();
                  }}
                  onBackToLanding={backToLanding}
                  createdAt={activeBook?.created_at}
                  updatedAt={activeBook?.updated_at}
                />
              )}
              actions={bookActions}
            >
              {untranslated && (
                <Alert severity="info" square sx={{ py: 0.25 }}>
                  {t("content.untranslated", {
                    lang: langLabel(untranslated.requested),
                    fallback: langLabel(untranslated.shown),
                  })}
                </Alert>
              )}
              {activeRendition?.kind === "audio" && currentPath
                ? (
                  // Audio rendition: the read-along reader, inline in the NavShell
                  // (its own page with the audio spine in the sidebar + history back).
                  <AudiobookPlayer
                    contentMaxWidth={menuBarSettings.contentMaxWidth}
                    lineHeight={menuBarSettings.lineHeight}
                    navbarAtBottom={navbarAtBottom}
                    onSaveScroll={saveProgress}
                  />
                )
                : (
                  <ContentViewer
                    content={currentContent}
                    fileType={currentFileType}
                    currentPath={currentPath}
                    theme={theme}
                    onNavigate={handleSelect}
                    contentMaxWidth={menuBarSettings.contentMaxWidth}
                    lineHeight={menuBarSettings.lineHeight}
                    savedScroll={savedScroll}
                    onSaveScroll={saveProgress}
                  />
                )}
            </NavShell>
          )}
        </Box>
      </Box>
      {
        /* The floating bubble — the now-playing handle shown when audio is
            playing but you're browsing AWAY from its inline page. A fixed
            overlay; tapping its artwork navigates back to that page. */
      }
      <FloatingBubble
        onPlayingPage={onPlayingPage}
        onOpenPlayer={openPlayingAudio}
      />
      <Snackbar
        open={notice !== null}
        autoHideDuration={3000}
        // MUI close-button pattern: the explicit close action and the
        // auto-hide timeout dismiss; a click-away does NOT, so the toast
        // can't vanish on an unrelated tap mid-read.
        onClose={(_event, reason) => {
          if (reason === "clickaway") return;
          setNotice(null);
        }}
        message={notice}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        // Theme-adaptive surface: MUI's default snackbar is a fixed inverted
        // grey that clashes with sepia/night. Paint it as a themed paper
        // surface (border + elevation to stay distinct) so it matches the
        // bars/cards in every theme.
        ContentProps={{
          sx: {
            bgcolor: "background.paper",
            color: "text.primary",
            border: 1,
            borderColor: "divider",
            boxShadow: 6,
          },
        }}
        action={
          <IconButton
            size="small"
            aria-label="close"
            color="inherit"
            onClick={() => setNotice(null)}
          >
            <CloseIcon fontSize="medium" />
          </IconButton>
        }
      />
    </ThemeProvider>
  );
}
