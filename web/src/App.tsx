import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  ThemeProvider,
  CssBaseline,
  Box,
  IconButton,
  Tooltip,
  SwipeableDrawer,
  Alert,
  useMediaQuery,
} from "@mui/material";
import {
  Menu as MenuIcon,
  Settings as SettingsIcon,
  Headphones as HeadphonesIcon,
  MenuBook as MenuBookIcon,
} from "@mui/icons-material";
import { Sidebar, SettingsDialog, ContentViewer, AudiobookPlayer, Landing } from "@/components";
import { useWebSocket, useTheme, useSettings, useFont, useProgress } from "@/hooks";
import { useI18n } from "@/i18n";
import { PortalLauncherButton, PortalProvider } from "./_shell";
import type {
  TreeNode,
  FileType,
  FileContent,
  Book,
  ProgressEntry,
  ReadingProgress,
} from "@/types";

const DEFAULT_SIDEBAR_WIDTH = 280;
// Below this width the sidebar becomes an overlay drawer (phones + portrait
// tablets). MUI's `md` breakpoint.
const MOBILE_QUERY = "(max-width:899.95px)";
// iOS needs the swipe-to-open discovery affordance but not the backdrop
// transition (perf); the inverse holds elsewhere. MUI's documented split.
const IS_IOS =
  typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);

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

interface HashState {
  path: string | null;
  lang: string | null;
}

// Hash scheme: `#<encoded-path>` for a file, optionally `&lang=<code>` to pin
// a non-default language edition. `encodeURIComponent` escapes `&`/`=`, so the
// path segment can never collide with the `&lang=` separator.
function getHashState(): HashState {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) {
    return { path: null, lang: null };
  }
  const body = hash.slice(1);
  if (!body) {
    return { path: null, lang: null };
  }
  const parts = body.split("&");
  const path = decodeURIComponent(parts[0] ?? "") || null;
  let lang: string | null = null;
  for (const seg of parts.slice(1)) {
    if (seg.startsWith("lang=")) {
      lang = decodeURIComponent(seg.slice(5)) || null;
    }
  }
  return { path, lang };
}

function buildHash(path: string | null, lang: string | null): string {
  if (!path) {
    return "";
  }
  let h = `#${encodeURIComponent(path)}`;
  if (lang) {
    h += `&lang=${encodeURIComponent(lang)}`;
  }
  return h;
}

function writeHash(path: string | null, lang: string | null, replace: boolean): void {
  const h = buildHash(path, lang);
  const url = h || window.location.pathname;
  if (replace) {
    window.history.replaceState(null, "", url);
  } else {
    window.history.pushState(null, "", url);
  }
}

interface FloatButtonProps {
  position: "left" | "right";
  floatOpacity: number;
  children: React.ReactNode;
}

function FloatButton({ position, floatOpacity, children }: FloatButtonProps): React.JSX.Element {
  const isLeft = position === "left";
  // Drive expand/collapse from state instead of pure CSS `:hover`. On iOS
  // there is no real pointer, so `:hover` sticks after the first tap and the
  // box can never fold back into the transparent triangle. State plus an
  // outside-tap listener makes the triangle reachable on touch, while mouse
  // enter/leave preserves the original desktop hover behaviour.
  const [expanded, setExpanded] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return undefined;
    const handleOutside = (e: Event): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("pointerdown", handleOutside);
    return () => {
      document.removeEventListener("pointerdown", handleOutside);
    };
  }, [expanded]);

  return (
    <Box
      ref={boxRef}
      onMouseEnter={() => {
        setExpanded(true);
      }}
      onMouseLeave={() => {
        setExpanded(false);
      }}
      onClick={() => {
        setExpanded((v) => !v);
      }}
      sx={{
        position: "absolute",
        top: 12,
        [position]: 0,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: isLeft ? "0 4px 4px 0" : "4px 0 0 4px",
        transition: "all 0.2s ease",
        height: 36,
        cursor: "pointer",
        ...(expanded
          ? {
              opacity: 1,
              bgcolor: "background.paper",
              boxShadow: isLeft ? "2px 0 8px rgba(0,0,0,0.1)" : "-2px 0 8px rgba(0,0,0,0.1)",
              width: "auto",
              px: 0.5,
            }
          : {
              opacity: floatOpacity,
              bgcolor: "rgba(128, 128, 128, 0.15)",
              width: 20,
            }),
      }}
    >
      {expanded ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0 }}>{children}</Box>
      ) : (
        <Box
          sx={{
            width: 0,
            height: 0,
            borderTop: "5px solid transparent",
            borderBottom: "5px solid transparent",
            ...(isLeft
              ? { borderLeft: "6px solid rgba(128, 128, 128, 0.5)" }
              : { borderRight: "6px solid rgba(128, 128, 128, 0.5)" }),
          }}
        />
      )}
    </Box>
  );
}

interface ReaderNavBarProps {
  position: "top" | "bottom";
  onOpenSidebar: () => void;
  onOpenSettings: () => void;
}

// Fixed (non-floating), full-width navigation bar for the reader chrome — used
// on every form factor when the sidebar's own header isn't carrying these
// controls (mobile drawer, or a collapsed desktop sidebar). It's a flex item in
// the content column (not an overlay), so it sits flush at the bottom (default)
// or top edge without ever covering the text — a floating overlay here hurt
// reading (conventions/ui.md §7). Layout: the sidebar-expand control on the
// left; settings then the portal launcher on the right (portal rightmost).
// Top/bottom edge safe-area insets clear the notch / home indicator; the parent
// already insets the side notches.
function ReaderNavBar({
  position,
  onOpenSidebar,
  onOpenSettings,
}: ReaderNavBarProps): React.JSX.Element {
  const { t } = useI18n();
  const isTop = position === "top";
  return (
    <Box
      component="nav"
      sx={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        px: 1,
        bgcolor: "background.paper",
        borderColor: "divider",
        ...(isTop
          ? { borderBottom: 1, pt: "calc(env(safe-area-inset-top, 0px) + 4px)", pb: 0.5 }
          : { borderTop: 1, pb: "calc(env(safe-area-inset-bottom, 0px) + 4px)", pt: 0.5 }),
      }}
    >
      {/* Left: expand the sidebar. */}
      <IconButton aria-label={t("app.openSidebar")} onClick={onOpenSidebar} sx={{ p: 1 }}>
        <MenuIcon />
      </IconButton>
      {/* Right: settings, then the portal launcher (self-hides when not hosted). */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <IconButton aria-label={t("app.settings")} onClick={onOpenSettings} sx={{ p: 1 }}>
          <SettingsIcon />
        </IconButton>
        <PortalLauncherButton />
      </Box>
    </Box>
  );
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
  // `isMobile` (width) drives the Drawer-vs-persistent sidebar layout.
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(MOBILE_QUERY).matches);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audiobookOpen, setAudiobookOpen] = useState(false);
  const initializedRef = useRef(false);
  // Refs for matching live WebSocket updates against what's currently shown
  // (the shown edition may differ from `lang` when falling back).
  const currentPathRef = useRef<string | null>(null);
  const contentLangRef = useRef<string>("");

  const { loadBook, loadRecent, savedScroll, save: saveProgress } = useProgress();
  // Latest-read chapter per book (newest first), for the landing "continue
  // reading" indicators. Refetched whenever the bookshelf is shown so it
  // reflects progress made since the last visit.
  const [recentProgress, setRecentProgress] = useState<ProgressEntry[]>([]);

  const { t, lang: uiLang } = useI18n();
  const { theme, muiTheme, setTheme } = useTheme();
  const { menuBarSettings, setFloatOpacity, setContentMaxWidth, setLineHeight, setNavBarPosition } =
    useSettings();
  const { fontId, setFont } = useFont();

  // Collapse the sidebar when shrinking to a phone/tablet width, reopen it
  // when growing back to desktop (also handles device rotation).
  useEffect(() => {
    setSidebarOpen(!isMobile);
  }, [isMobile]);

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
  const bookLangs = activeBook?.langs ?? [];

  // Initial edition for a book: prefer the UI locale if the book offers it
  // (axis A ↔ B default link), else the book's declared default.
  const pickInitialLang = useCallback(
    (book: Book): string =>
      book.langs.some((l) => l.lang === uiLang) ? uiLang : book.default_lang,
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
  // (initial load and every return from a book).
  useEffect(() => {
    if (activeSlug !== null) return;
    void (async () => {
      setRecentProgress(await loadRecent());
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
    setTree(newTree);
  }, []);

  useWebSocket({
    onContentUpdate: handleContentUpdate,
    onTreeUpdate: handleTreeUpdate,
  });

  // Fetch + render a file in `reqLang`. If the page is missing in that edition
  // (404) we transparently fall back to the book's default edition and surface
  // an "untranslated" notice. `reqLang` stays the selected edition regardless.
  const loadFile = useCallback(
    async (path: string, reqLang: string) => {
      setCurrentPath(path);
      currentPathRef.current = path;
      try {
        const res = await fetch(
          `/api/file?path=${encodeURIComponent(path)}&lang=${encodeURIComponent(reqLang)}`
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

  // Open a file in a given edition: sync state, URL hash, and content.
  const openFile = useCallback(
    async (path: string, langArg: string) => {
      const slug = path.split("/")[0] ?? "";
      const book = books.find((b) => b.slug === slug);
      const langForHash = book && langArg !== book.default_lang ? langArg : null;

      setLang(langArg);
      writeHash(path, langForHash, false);
      // On mobile the drawer overlays the content — close it so the file shows.
      if (isMobile) {
        setSidebarOpen(false);
      }
      await loadFile(path, langArg);
    },
    [books, isMobile, loadFile]
  );

  // Sidebar / markdown-link navigation stays within the current edition.
  const handleSelect = useCallback(
    (path: string) => {
      void openFile(path, lang);
    },
    [openFile, lang]
  );

  // Switch the active book to another language edition, keeping the page.
  const switchLang = useCallback(
    (newLang: string) => {
      if (currentPath) {
        void openFile(currentPath, newLang);
      }
    },
    [currentPath, openFile]
  );

  // Enter a book from the landing page: resume the last-read chapter if there
  // is one (and it still exists), else open its README, else its first doc.
  const enterBook = useCallback(
    (slug: string) => {
      const book = books.find((b) => b.slug === slug);
      const node = tree.find((n) => n.path === slug);
      if (!book || !node) return;
      void (async () => {
        const last = await loadBook(slug);
        const resume = last && hasFilePath([node], last.path) ? last.path : null;
        const entry = resume ?? findReadme([node]) ?? findFirstFile([node]);
        if (entry) {
          void openFile(entry, pickInitialLang(book));
        }
      })();
    },
    [books, tree, openFile, pickInitialLang, loadBook]
  );

  // Return to the landing bookshelf.
  const backToLanding = useCallback(() => {
    writeHash(null, null, false);
    setCurrentPath(null);
    currentPathRef.current = null;
    setCurrentContent(null);
    setUntranslated(null);
  }, []);

  useEffect(() => {
    document.title = currentPath ?? "liveview";
  }, [currentPath]);

  // The audiobook player is markdown-only; leave it when a non-markdown file or
  // the landing page is shown.
  useEffect(() => {
    if (currentFileType !== "markdown" || !currentPath) {
      setAudiobookOpen(false);
    }
  }, [currentFileType, currentPath]);

  const canAudiobook = Boolean(activeBook?.audio) && currentFileType === "markdown" && Boolean(currentPath);

  // Resolve which edition a hash deep-link should open: explicit `&lang=` wins,
  // else fall back to the book's preferred initial edition.
  const langForHashEntry = useCallback(
    (path: string, hashLang: string | null): string => {
      if (hashLang) return hashLang;
      const slug = path.split("/")[0] ?? "";
      const book = books.find((b) => b.slug === slug);
      return book ? pickInitialLang(book) : "";
    },
    [books, pickInitialLang]
  );

  // Fetch the tree once, then restore any deep link from the hash. Waits for
  // `books` so deep-link language/fallback resolution works.
  useEffect(() => {
    if (initializedRef.current || books.length === 0) return;
    const fetchTree = async (): Promise<void> => {
      try {
        const response = await fetch("/api/tree");
        const data = (await response.json()) as TreeNode[];
        setTree(data);

        initializedRef.current = true;
        const { path, lang: hashLang } = getHashState();
        if (path) {
          const entryLang = langForHashEntry(path, hashLang);
          setLang(entryLang);
          writeHash(path, hashLang, true);
          // Load the book's progress first so the doc restores its scroll.
          const slug = path.split("/")[0];
          if (slug) await loadBook(slug);
          void loadFile(path, entryLang);
        }
      } catch (e) {
        console.error("Failed to fetch tree:", e);
      }
    };
    void fetchTree();
  }, [books, loadFile, langForHashEntry, loadBook]);

  // Handle browser back/forward navigation.
  useEffect(() => {
    const handlePopState = (): void => {
      const { path, lang: hashLang } = getHashState();
      if (path) {
        const entryLang = langForHashEntry(path, hashLang);
        setLang(entryLang);
        const slug = path.split("/")[0];
        if (slug) void loadBook(slug);
        void loadFile(path, entryLang);
      } else {
        // back/forward to an empty hash returns to the landing bookshelf
        setCurrentPath(null);
        currentPathRef.current = null;
        setCurrentContent(null);
        setUntranslated(null);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [loadFile, langForHashEntry, loadBook]);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleOpenSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  // The reader chrome controls (sidebar toggle, settings, launcher) live in a
  // fixed edge nav bar — never a floating overlay over the text (that hurt
  // reading; see conventions/ui.md §7). The bar shows whenever those controls
  // aren't already in the sidebar header: on mobile (the sidebar is a drawer)
  // and on desktop whenever the persistent sidebar is collapsed.
  const showNavBar = isMobile || !sidebarOpen;

  const langLabel = (code: string): string =>
    bookLangs.find((l) => l.lang === code)?.label ?? code;

  const sidebarCommon = {
    tree: activeTree,
    currentPath,
    bookMode,
    bookLabel,
    langs: bookLangs,
    currentLang: lang,
    onSwitchLang: switchLang,
    onSelect: handleSelect,
    onClose: handleCloseSidebar,
    onOpenSettings: handleOpenSettings,
    onBackToLanding: backToLanding,
    onWidthChange: setSidebarWidth,
  };

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <PortalProvider appId="liveview">
      <Box sx={{ display: "flex", height: "100dvh", overflow: "hidden" }}>
        {activeSlug === null ? (
          <Landing
            books={books}
            progress={progressBySlug}
            onOpen={enterBook}
            onHome={backToLanding}
            onOpenSettings={handleOpenSettings}
          />
        ) : (
          <>
            {isMobile ? (
              <SwipeableDrawer
                // Swipe-to-dismiss + edge-swipe-to-open are what phone users
                // reach for; backdrop tap and the in-sidebar ✕ still close it.
                open={sidebarOpen}
                onOpen={handleOpenSidebar}
                onClose={handleCloseSidebar}
                disableBackdropTransition={!IS_IOS}
                disableDiscovery={IS_IOS}
                swipeAreaWidth={24}
                ModalProps={{ keepMounted: true }}
                slotProps={{
                  paper: { sx: { width: "min(85vw, 320px)", boxSizing: "border-box" } },
                }}
              >
                <Sidebar {...sidebarCommon} width={DEFAULT_SIDEBAR_WIDTH} isMobile />
              </SwipeableDrawer>
            ) : (
              sidebarOpen && <Sidebar {...sidebarCommon} width={sidebarWidth} />
            )}

            <Box
              sx={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                bgcolor: "background.default",
                position: "relative",
                // Keep content clear of the side notch in landscape on iPhone.
                pl: "env(safe-area-inset-left, 0px)",
                pr: "env(safe-area-inset-right, 0px)",
              }}
            >
              {showNavBar && menuBarSettings.navBarPosition === "top" && (
                <ReaderNavBar
                  position="top"
                  onOpenSidebar={handleOpenSidebar}
                  onOpenSettings={handleOpenSettings}
                />
              )}

              {canAudiobook && (
                <FloatButton position="right" floatOpacity={menuBarSettings.floatOpacity}>
                  <Tooltip title={audiobookOpen ? t("audiobook.close") : t("audiobook.open")}>
                    <IconButton
                      size="small"
                      onClick={() => {
                        setAudiobookOpen((v) => !v);
                      }}
                    >
                      {audiobookOpen ? (
                        <MenuBookIcon fontSize="small" />
                      ) : (
                        <HeadphonesIcon fontSize="small" />
                      )}
                    </IconButton>
                  </Tooltip>
                </FloatButton>
              )}

              <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {untranslated && (
                  <Alert severity="info" square sx={{ py: 0.25 }}>
                    {t("content.untranslated", {
                      lang: langLabel(untranslated.requested),
                      fallback: langLabel(untranslated.shown),
                    })}
                  </Alert>
                )}
                {audiobookOpen && currentPath ? (
                  <AudiobookPlayer
                    currentPath={currentPath}
                    lang={lang}
                    contentMaxWidth={menuBarSettings.contentMaxWidth}
                    lineHeight={menuBarSettings.lineHeight}
                  />
                ) : (
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
              </Box>

              {showNavBar && menuBarSettings.navBarPosition === "bottom" && (
                <ReaderNavBar
                  position="bottom"
                  onOpenSidebar={handleOpenSidebar}
                  onOpenSettings={handleOpenSettings}
                />
              )}
            </Box>
          </>
        )}

        <SettingsDialog
          open={settingsOpen}
          theme={theme}
          fontId={fontId}
          menuBarSettings={menuBarSettings}
          onClose={handleCloseSettings}
          onThemeChange={setTheme}
          onFontChange={setFont}
          onFloatOpacityChange={setFloatOpacity}
          onContentMaxWidthChange={setContentMaxWidth}
          onLineHeightChange={setLineHeight}
          onNavBarPositionChange={setNavBarPosition}
        />
      </Box>
      </PortalProvider>
    </ThemeProvider>
  );
}
