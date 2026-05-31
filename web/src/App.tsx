import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  ThemeProvider,
  CssBaseline,
  Box,
  Alert,
  IconButton,
  Tooltip,
  Snackbar,
} from "@mui/material";
import { Headphones as AudiobookIcon } from "@mui/icons-material";
import { Sidebar, SettingsButton, ContentViewer, NowPlayingPopup, MiniPlayer, Landing } from "@/components";
import { useWebSocket, useTheme, useSettings, useFont, useProgress } from "@/hooks";
import { useI18n } from "@/i18n";
import { useAudioPlayer, type Track } from "@/audio/player";
import { NavShell, PortalProvider } from "./_shell";
import type {
  TreeNode,
  FileType,
  FileContent,
  Book,
  RenditionInfo,
  ProgressEntry,
  ReadingProgress,
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
      else out.push({ path: n.path, label: (uiLang && n.titles?.[uiLang]) || n.name });
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

function buildHash(path: string | null, lang: string | null, rendition: string | null): string {
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
  replace: boolean
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
  const [untranslated, setUntranslated] = useState<UntranslatedNotice | null>(null);
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

  const { loadBook, loadRecent, savedScroll, save: saveProgress } = useProgress();
  // Latest-read chapter per book (newest first), for the landing "continue
  // reading" indicators. Refetched whenever the bookshelf is shown so it
  // reflects progress made since the last visit.
  const [recentProgress, setRecentProgress] = useState<ProgressEntry[]>([]);

  const { t, lang: uiLang } = useI18n();
  const { theme, muiTheme, setTheme } = useTheme();
  const { menuBarSettings, setContentMaxWidth, setLineHeight } = useSettings();
  const { fontId, setFont } = useFont();
  // The root audio engine: playback + the popup live above every view, so
  // navigating never stops the audio nor closes the popup. We only need to seed
  // playback (`playChapter`) and raise the popup into focus (`setExpanded`).
  const { playChapter: audioPlayChapter, setExpanded: setPlayerExpanded } = useAudioPlayer();

  // The active book is the first path segment; null ⇒ the landing bookshelf.
  const activeSlug = currentPath ? (currentPath.split("/")[0] ?? null) : null;
  const activeBook = books.find((b) => b.slug === activeSlug) ?? null;
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
  const activeRendition =
    bookRenditions.find((r) => r.kind === rendition) ??
    bookRenditions.find((r) => r.kind === activeBook?.default_rendition) ??
    bookRenditions[0] ??
    null;
  const bookLangs = activeRendition?.langs ?? [];

  // The rendition a book opens in: its declared default, resolved to the
  // matching RenditionInfo (falling back to the first).
  const defaultRendition = useCallback(
    (book: Book): RenditionInfo | null =>
      book.renditions.find((r) => r.kind === book.default_rendition) ?? book.renditions[0] ?? null,
    []
  );

  // Initial edition for a rendition: prefer the UI locale if that rendition
  // offers it (axis A ↔ B default link), else the rendition's declared default.
  const pickInitialLang = useCallback(
    (r: RenditionInfo): string =>
      r.langs.some((l) => l.lang === uiLang) ? uiLang : r.default_lang,
    [uiLang]
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
          return r !== undefined && p.path === r.path && p.scroll === r.scroll;
        })
          ? prev
          : rows
      );
    })();
  }, [activeSlug, loadRecent]);

  // Resolve each book's latest-read chapter into a display-ready entry: chapter
  // title (current UI edition, falling back to the node name, then the file
  // name) plus the in-chapter scroll ratio. Keyed by book slug for the landing.
  const progressBySlug = useMemo(() => {
    const out: Record<string, ReadingProgress> = {};
    for (const r of recentProgress) {
      const slug = r.path.split("/")[0] ?? "";
      const node = findNode(tree, r.path);
      const chapterLabel =
        (node && ((uiLang && node.titles?.[uiLang]) || node.name)) ||
        r.path.split("/").pop() ||
        r.path;
      out[slug] = { path: r.path, chapterLabel, scroll: r.scroll };
    }
    return out;
  }, [recentProgress, tree, uiLang]);

  const handleContentUpdate = useCallback(
    (path: string, msgLang: string, fileType: FileType, content: string) => {
      if (path === currentPathRef.current && msgLang === contentLangRef.current) {
        setCurrentFileType(fileType);
        setCurrentContent(content);
      }
    },
    []
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
          `/api/file?path=${encodeURIComponent(path)}&lang=${encodeURIComponent(reqLang)}&rendition=${encodeURIComponent(reqRendition)}`
        );
        if (!res.ok) {
          console.error("Failed to fetch file:", path, res.status);
          return;
        }
        const data = (await res.json()) as FileContent;
        // The server resolves overlay → base and reports the edition it served.
        // If that differs from what we asked for, the page isn't translated yet.
        contentLangRef.current = data.lang;
        setCurrentFileType(data.file_type);
        setCurrentContent(data.content);
        setUntranslated(data.lang !== reqLang ? { requested: reqLang, shown: data.lang } : null);
      } catch (e) {
        console.error("Failed to fetch file:", e);
      }
    },
    []
  );

  // Open a file in a given edition + rendition: sync state, URL hash, and (for
  // the text rendition) content. The audio rendition renders in the player off
  // `currentPath`, so it needs no /api/file fetch — just the path + hash.
  const openFile = useCallback(
    async (path: string, langArg: string, renditionArg: string) => {
      const slug = path.split("/")[0] ?? "";
      const book = books.find((b) => b.slug === slug);
      const rInfo = book?.renditions.find((r) => r.kind === renditionArg);
      // Omit lang/rendition from the URL when they equal the book/rendition
      // default, keeping deep links clean (mirrors how `lang` already behaves).
      const langForHash = rInfo && langArg !== rInfo.default_lang ? langArg : null;
      const renditionForHash = book && renditionArg !== book.default_rendition ? renditionArg : null;

      setLang(langArg);
      setRendition(renditionArg);
      renditionRef.current = renditionArg;
      writeHash(path, langForHash, renditionForHash, false);
      await loadFile(path, langArg, renditionArg);
    },
    [books, loadFile]
  );

  // Sidebar / markdown-link navigation stays within the current edition + mode.
  const handleSelect = useCallback(
    (path: string) => {
      void openFile(path, lang, rendition);
    },
    [openFile, lang, rendition]
  );

  // Switch the active book to another language edition, keeping the page +
  // rendition.
  const switchLang = useCallback(
    (newLang: string) => {
      if (currentPath) {
        void openFile(currentPath, newLang, rendition);
      }
    },
    [currentPath, openFile, rendition]
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
    [loadBook]
  );

  // Open a book's AUDIO rendition in the listening popup. This is the listen
  // plane, fully decoupled from the browse plane: the page you're reading stays
  // put — we only seed the engine's queue from the audio spine and raise the
  // popup. Target chapter: an explicit one (deep link), else the resume chapter,
  // else the first. Audio chapter ids differ from text, so we never map the
  // current text position across — the popup opens at the audio rendition's own
  // resume/first chapter.
  const openAudiobook = useCallback(
    (slug: string, chapterPath?: string) => {
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
          const tracks = flattenTracks(scope, uiLang);
          let target = chapterPath && hasFilePath(scope, chapterPath) ? chapterPath : null;
          if (!target) {
            const last = await loadBook(slug);
            target = (last && hasFilePath(scope, last.path) ? last.path : null) ?? findFirstFile(scope);
          }
          if (!target) {
            setNotice(t("audiobook.empty"));
            return;
          }
          audioPlayChapter(
            {
              bookSlug: book.slug,
              bookLabel: book.label,
              cover: book.cover,
              chapterPath: target,
              lang: pickInitialLang(r),
              rendition: "audio",
            },
            tracks
          );
          setPlayerExpanded(true);
        } catch (e) {
          console.error("Failed to open audiobook:", e);
        }
      })();
    },
    [books, uiLang, loadBook, pickInitialLang, audioPlayChapter, setPlayerExpanded, t]
  );

  // Enter a book from the landing page in a specific rendition (the bookshelf
  // shows a separate card per rendition, so it passes the kind to open). Falls
  // back to the book's default rendition. Resumes the last-read chapter if there
  // is one (and it still exists), else its README, else its first doc.
  const enterBook = useCallback(
    (slug: string, renditionKind?: string) => {
      const book = books.find((b) => b.slug === slug);
      if (!book) return;
      const r =
        (renditionKind ? book.renditions.find((x) => x.kind === renditionKind) : undefined) ??
        defaultRendition(book);
      if (!r) return;
      // An audiobook card opens the listening popup (the listen plane), never a
      // reading view — the browse plane stays on the shelf behind it.
      if (r.kind === "audio") {
        openAudiobook(slug);
        return;
      }
      void (async () => {
        // Always fetch the default rendition's spine on entry: the cached
        // `tree` may hold another rendition's spine (we just left an audio
        // book) or be stale, so we can't trust it for resume/README lookup.
        try {
          const res = await fetch(`/api/tree?rendition=${encodeURIComponent(r.kind)}`);
          const spine = (await res.json()) as TreeNode[];
          setTree(spine);
          renditionRef.current = r.kind;
          const entry = await entryChapter(slug, spine);
          if (entry) {
            void openFile(entry, pickInitialLang(r), r.kind);
          }
        } catch (e) {
          console.error("Failed to enter book:", e);
        }
      })();
    },
    [books, defaultRendition, entryChapter, openFile, pickInitialLang, openAudiobook]
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
      if (hashRendition && book?.renditions.some((r) => r.kind === hashRendition)) {
        return hashRendition;
      }
      return book?.default_rendition ?? "text";
    },
    [books]
  );

  const langForHashEntry = useCallback(
    (path: string, kind: string, hashLang: string | null): string => {
      if (hashLang) return hashLang;
      const slug = path.split("/")[0] ?? "";
      const book = books.find((b) => b.slug === slug);
      const rInfo = book?.renditions.find((r) => r.kind === kind);
      return rInfo ? pickInitialLang(rInfo) : "";
    },
    [books, pickInitialLang]
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
      // Audio is no longer a browse view: a legacy `&rendition=audio` deep link
      // opens the listening popup at that chapter and leaves the browse plane on
      // the shelf (the engine carries its own resume, so this is just re-entry).
      if (kind === "audio") {
        const audioSlug = path.split("/")[0];
        setCurrentPath(null);
        currentPathRef.current = null;
        setCurrentContent(null);
        setUntranslated(null);
        writeHash(null, null, null, true);
        if (audioSlug) openAudiobook(audioSlug, path);
        return;
      }
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
        const langForHash = rInfo && entryLang !== rInfo.default_lang ? entryLang : null;
        const renditionForHash = book && kind !== book.default_rendition ? kind : null;
        writeHash(path, langForHash, renditionForHash, true);
      }
      try {
        const res = await fetch(`/api/tree?rendition=${encodeURIComponent(kind)}`);
        setTree((await res.json()) as TreeNode[]);
      } catch (e) {
        console.error("Failed to fetch rendition tree:", e);
      }
      // Load the book's progress first so the doc restores its scroll.
      const slug = path.split("/")[0];
      if (slug) await loadBook(slug);
      void loadFile(path, entryLang, kind);
    },
    [books, loadFile, langForHashEntry, renditionForHashEntry, loadBook, openAudiobook]
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

  // The listen plane (popup + bar) is fully decoupled from the browse plane:
  // the engine plays, the popup is the focus view, and navigating the browse
  // plane never touches either. So there is no longer any currentPath ⇄ engine
  // syncing to do here — opening an audiobook seeds the engine directly
  // (`openAudiobook`) and the popup reads it off the root.

  // One settings affordance reused in both chrome contexts (bookshelf header +
  // in-book NavShell actions). The shared SettingsSheet owns the gear and the
  // responsive surface — a bottom sheet on mobile, a dialog on desktop — so we
  // just hand it liveview's settings rows.
  const settingsButton = (
    <SettingsButton
      theme={theme}
      fontId={fontId}
      menuBarSettings={menuBarSettings}
      onThemeChange={setTheme}
      onFontChange={setFont}
      onContentMaxWidthChange={setContentMaxWidth}
      onLineHeightChange={setLineHeight}
    />
  );

  const langLabel = (code: string): string =>
    bookLangs.find((l) => l.lang === code)?.label ?? code;

  // Whether the active book offers an audio rendition — gates the "listen"
  // affordances (the in-book top-bar headphones + the sidebar button), both of
  // which open the global listening popup for this book.
  const hasAudio = bookRenditions.some((r) => r.kind === "audio");
  const openActiveAudiobook = useCallback(() => {
    if (activeSlug) openAudiobook(activeSlug);
  }, [activeSlug, openAudiobook]);

  // In-book top-bar actions: a listen button (when the book has audio) + the
  // shared settings affordance.
  const bookActions = (
    <>
      {hasAudio && (
        <Tooltip title={t("audiobook.open")}>
          <IconButton size="small" onClick={openActiveAudiobook} aria-label={t("audiobook.open")}>
            <AudiobookIcon />
          </IconButton>
        </Tooltip>
      )}
      {settingsButton}
    </>
  );

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <PortalProvider appId="liveview">
        {/* The persistent themed backdrop. Returning from a book unmounts the
            NavShell + its ~900 markdown nodes in one commit; while reading,
            `.markdown-body`'s own opaque background covers the viewport, so
            without a themed colour here the bare body showed through for the
            frame of the swap as a white flash. Painting background.default on
            the always-mounted container means the swap happens over a stable,
            theme-correct surface. */}
        <Box sx={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
          {/* The view stack (bookshelf + open book) fills the space above the
              persistent mini-player, which takes its own row below so it pushes
              content up instead of covering it. */}
          <Box sx={{ position: "relative", flex: 1, minHeight: 0 }}>
          {/* The bookshelf stays mounted (just hidden) while a book is open, so
              its scroll position survives the round trip — no remount, no
              restore jump. We hide it with opacity:0 (NOT visibility:hidden):
              a visibility-hidden subtree is "not relevant to the user", so the
              cards' `content-visibility:auto` skips rendering them, and on the
              way back they must render in for a frame (empty intrinsic-size
              boxes → content pops) — a whole-page flash. opacity:0 keeps the
              in-viewport cards rendered (just transparent), so returning is a
              compositor-only opacity flip: instant, flash-free. (Off-screen
              cards are still skipped by content-visibility, and the scroll
              offset is preserved.) */}
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
            />
          </Box>
          {activeSlug !== null && (
            <NavShell
            appKey="liveview"
            title={bookLabel}
            nav={(api) => (
              <Sidebar
                tree={activeTree}
                currentPath={currentPath}
                bookMode={bookMode}
                langs={bookLangs}
                currentLang={lang}
                onSwitchLang={switchLang}
                hasAudio={hasAudio}
                onOpenAudiobook={() => {
                  openActiveAudiobook();
                  api.closeMobile();
                }}
                onSelect={(path) => {
                  handleSelect(path);
                  api.closeMobile();
                }}
                onBackToLanding={backToLanding}
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
            </NavShell>
          )}
          </Box>
          <MiniPlayer />
        </Box>
        {/* The listening popup (focus state of the listen plane) floats above
            every browse view, mounted at the root so it survives all navigation
            and is never owned by a book's chrome. */}
        <NowPlayingPopup
          contentMaxWidth={menuBarSettings.contentMaxWidth}
          lineHeight={menuBarSettings.lineHeight}
        />
        <Snackbar
          open={notice !== null}
          autoHideDuration={3000}
          onClose={() => setNotice(null)}
          message={notice}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        />
      </PortalProvider>
    </ThemeProvider>
  );
}
