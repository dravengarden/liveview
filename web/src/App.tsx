import { rem } from "@/px";
import { nativeNavPop, nativeNavPush, nativeNavReady } from "@/native-nav";
import { contentFetch } from "@/native-sync";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  Alert,
  Box,
  Button,
  CssBaseline,
  IconButton,
  Snackbar,
  ThemeProvider,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import {
  Close as CloseIcon,
  Headphones as AudiobookIcon,
  RecordVoiceOver as ReadAloudIcon,
} from "@mui/icons-material";
import {
  AudiobookPlayer,
  ContentViewer,
  ChapterPager,
  FloatingBubble,
  Landing,
  PlaybackSheet,
  ReconnectBanner,
  SettingsButton,
  Sidebar,
  SyncIndicator,
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
import {
  prefetchAllBooks,
  prefetchBookAudio,
  prefetchBookText,
  prefetchTrees,
} from "@/prefetch";
import { loadAllServerSettings, putServerSetting } from "@/syncBackends";
import { type Track, useAudioPlayer } from "@/audio/player";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { useAutoUpdate } from "@/hooks/useAutoUpdate";
import { applyUpdate, useConnectionBanner } from "@/connectionStore";
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

// Device-local "resume where I left off". The native shell reopens the BASE url
// (no hash) on a cold relaunch, so a browser-style hash deep link isn't there to
// restore from — we stash the last reading location here and re-enter it on a
// hash-less load. (A normal in-browser reload keeps the hash and never needs
// this.) Cleared on return to the shelf, so relaunching from the shelf stays on
// the shelf. Scroll position within the chapter is restored separately from the
// server progress store.
const RESUME_KEY = "lv-resume";
interface ResumeLocation {
  path: string;
  lang: string | null;
  rendition: string | null;
}
function readResume(): ResumeLocation | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<ResumeLocation>) : null;
    return v && typeof v.path === "string" && v.path
      ? { path: v.path, lang: v.lang ?? null, rendition: v.rendition ?? null }
      : null;
  } catch {
    // Unavailable (private mode) or corrupt JSON — resume is best-effort.
    return null;
  }
}
function writeResume(loc: ResumeLocation | null): void {
  try {
    if (loc) localStorage.setItem(RESUME_KEY, JSON.stringify(loc));
    else localStorage.removeItem(RESUME_KEY);
  } catch {
    // Best-effort; ignore storage failures.
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
  // The reading location saved on this device, read ONCE at first render — before
  // the save-effect can clear it on the mount-time `currentPath === null` — so the
  // cold-relaunch resume (tryResumeLastLocation) sees it. Pure init, no re-read.
  const [initialResume] = useState<ResumeLocation | null>(() => readResume());
  // `lang` is the *selected* edition; `untranslated` records when a page is
  // missing there and we fell back to another edition's content.
  const [lang, setLang] = useState<string>("");
  const [untranslated, setUntranslated] = useState<UntranslatedNotice | null>(
    null,
  );
  const [currentFileType, setCurrentFileType] = useState<FileType>("markdown");
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  // A chapter fetch that failed instead of silently leaving the old page up:
  // "offline" (no cache for an unvisited page while disconnected) vs "failed"
  // (a server/transport error online). Drives a calm placeholder so offline
  // never reads as a blank/stale reader. Cleared on a successful load.
  const [fileError, setFileError] = useState<"offline" | "failed" | null>(null);
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
  // The unified playback-control sheet (transport + speed + sleep). Opened from
  // the navbar listen control (while reading text) and the floating bubble (while
  // browsing away) — one panel, one place for these controls.
  const [playbackSheetOpen, setPlaybackSheetOpen] = useState(false);
  const initializedRef = useRef(false);
  // Refs for matching live WebSocket updates against what's currently shown
  // (the shown edition may differ from `lang` when falling back).
  const currentPathRef = useRef<string | null>(null);
  const contentLangRef = useRef<string>("");
  // The rendition whose spine `tree` currently holds. Live tree updates (which
  // arrive as the default text spine) must not clobber a non-text spine.
  const renditionRef = useRef<string>("text");

  const { loadBook, loadBookRows, loadRecent, savedScroll, save: saveProgress } =
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
    void loadAllServerSettings().then((s) => {
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

  // Repaint the reading scrollers when the app returns from the background. iOS
  // WKWebView frees a backgrounded scroller's rasterized content to reclaim
  // memory, so on resume the read-along / text column shows BLANK or HALF-painted
  // (the content is still in the DOM, just not rasterized) until something forces
  // a repaint.
  //
  // We force it with a SYNCHRONOUS display reflow: hide → read layout → show →
  // read layout. It's fully synchronous, so no intermediate frame ever paints
  // (no visible blink) and it leaves NO lingering style. Deliberately NOT a
  // `transform: translateZ(0)` nudge — that promotes the scroller to a COMPOSITED
  // layer, which iOS rasterizes in TILES (only the visible top tile paints → the
  // rest stays blank, the "half shown" bug); and if the rAF that removes it is
  // deferred during the foreground transition, the tiled layer sticks. A plain
  // reflow re-rasterizes in the normal path. Run once now + once next frame (the
  // first can fire before the webview has fully foregrounded). Covers both readers
  // + the shelf (every `[data-lv-scroller]`); `pageshow` covers a bfcache restore.
  useEffect(() => {
    const reflow = (el: HTMLElement): void => {
      const top = el.scrollTop;
      el.style.display = "none";
      void el.offsetHeight;
      el.style.display = "";
      void el.offsetHeight;
      if (el.scrollTop !== top) el.scrollTop = top;
    };
    const repaint = (): void => {
      if (document.visibilityState !== "visible") return;
      const els = document.querySelectorAll<HTMLElement>("[data-lv-scroller]");
      els.forEach(reflow);
      requestAnimationFrame(() => els.forEach(reflow));
    };
    document.addEventListener("visibilitychange", repaint);
    window.addEventListener("pageshow", repaint);
    return () => {
      document.removeEventListener("visibilitychange", repaint);
      window.removeEventListener("pageshow", repaint);
    };
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
  // App-wide font-size: scale the root <html> font-size, so every rem/em surface
  // tracks the setting — the reading prose AND the MUI-Typography chrome — like
  // cowboy's useGlobalFontScale. Fixed-px chrome (nav/icon buttons, the settings
  // gear) stays put; px layout (spacing, safe-area insets) is unaffected, so the
  // responsive tiers hold.
  useEffect(() => {
    document.documentElement.style.fontSize = `${
      menuBarSettings.fontScale * 100
    }%`;
  }, [menuBarSettings.fontScale]);
  const { fontId, setFont } = useFont();
  // The root audio engine: playback + the popup live above every view, so
  // navigating never stops the audio nor closes the popup. We only need to seed
  // playback (`playChapter`) and raise the popup into focus (`setExpanded`).
  const {
    playChapter: audioPlayChapter,
    syncNotice,
    nowPlaying,
    stop: stopPlayback,
  } = useAudioPlayer();
  // Desktop keyboard shortcuts (Space/←/→/⌘±arrows/</>) + the `?` cheat-sheet.
  // Desktop-only (gated inside the hook); a no-op on touch.
  const { helpOpen, closeHelp } = useKeyboardShortcuts();
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

  // Make the update actually LAND on an installed iOS PWA. `useAutoUpdate` only
  // probes and raises the banner; the reload then depends on the shared overlay's
  // 3s countdown — which a resumed iOS PWA stalls, so the app sits on an old
  // bundle forever (observed: an iPad stuck several versions behind despite the
  // banner firing). When a redeploy is detected AND we're on the shelf (a reload
  // is seamless there — no reader/listener to yank), reload IMMEDIATELY instead of
  // waiting on the countdown. Mid-book we still leave the banner to handle it.
  const updateBanner = useConnectionBanner();
  useEffect(() => {
    if (updateBanner?.kind !== "update") return;
    if (currentPath === null) void applyUpdate();
  }, [updateBanner, currentPath]);

  // When a fresh load pulls a newer playback position from another device, the
  // audio engine raises `syncNotice`; surface it through the shared snackbar
  // ("已同步…"). Keyed on `seq` so an identical message re-fires the toast.
  useEffect(() => {
    if (syncNotice) setNotice(syncNotice.message);
  }, [syncNotice]);

  // The active book is the first path segment; null ⇒ the landing bookshelf.
  const activeSlug = currentPath ? (currentPath.split("/")[0] ?? null) : null;
  const activeBook = books.find((b) => b.slug === activeSlug) ?? null;
  // Opening a book quietly warms the rest of its chapters into the SW cache —
  // text (read-offline) AND any baked audio (listen-offline) — idle-scheduled +
  // once per book/session. Audio is opt-OUT-free now: just opening a book makes
  // its already-generated audio offline-available (a text-only book's audio
  // sweep is a no-op). Cheap on repeat opens: the SW short-circuits cache hits.
  useEffect(() => {
    if (!activeSlug) return;
    void prefetchBookText(activeSlug);
    void prefetchBookAudio(activeSlug);
  }, [activeSlug]);
  // Are we ON the playing book's inline audio page (where the read-along reader
  // already shows full controls)? If so the floating bubble hides; everywhere
  // else (text page, another book, the shelf) it shows as the now-playing handle.
  const onPlayingPage = nowPlaying != null &&
    activeSlug === nowPlaying.bookSlug && rendition === "audio";

  // Tap the BOTTOM nav bar's title to jump the reader to the BOTTOM (the bar sits
  // at the bottom, so down-to-the-end is the spatially natural direction; the
  // scroll-to-top FAB owns the other direction). The reader's scroll container is
  // the one tagged `data-lv-scroller="reader"` (MarkdownViewer / AudiobookPlayer);
  // query it lazily so a chapter remount (which swaps the node) never leaves a
  // stale ref.
  const scrollReaderBottom = useCallback(() => {
    const el = document.querySelector<HTMLElement>('[data-lv-scroller="reader"]');
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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
  // Wire the status-bar tap target (below) with NATIVE pointer events, not React
  // onClick: iOS WKWebView (standalone PWA / Tauri shell) does NOT reliably
  // deliver a synthetic `click` to a non-interactive div even with the
  // cursor:pointer heuristic — the status-bar tap-to-top silently no-op'd there
  // (the reported "tapping the top does nothing"). A real pointerdown→pointerup
  // tap, slop-gated (the same recogniser the figure lightbox uses, which is
  // verified to fire on iOS), is reliable. Bound to the element via a ref.
  const statusBarTapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = statusBarTapRef.current;
    if (!el) {
      return undefined;
    }
    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let tap = false;
    const travel = (e: PointerEvent): number =>
      Math.hypot(e.clientX - startX, e.clientY - startY);
    const down = (e: PointerEvent): void => {
      startX = e.clientX;
      startY = e.clientY;
      startedAt = e.timeStamp;
      tap = true;
    };
    const move = (e: PointerEvent): void => {
      if (tap && travel(e) > 12) tap = false;
    };
    const up = (e: PointerEvent): void => {
      if (tap && e.timeStamp - startedAt <= 700 && travel(e) <= 12) {
        scrollAllTop();
      }
      tap = false;
    };
    const cancel = (): void => {
      tap = false;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
    };
  }, [scrollAllTop]);
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
  // The current chapter's display title (current UI edition, falling back to the
  // node name, then the file name) — shown as the primary line of the in-book
  // bar so you always see WHERE you are, with the book name as the second line.
  const chapterLabel = useMemo(() => {
    if (!currentPath) return "";
    const node = findNode(tree, currentPath);
    return (node && ((uiLang && node.titles?.[uiLang]) || node.name)) ||
      currentPath.split("/").pop() || "";
  }, [currentPath, tree, uiLang]);
  // The renditions the active book offers, and the one currently active. The
  // language switcher shows the *active rendition's* languages (each rendition
  // carries its own lang list).
  const bookRenditions = activeBook?.renditions ?? [];
  const activeRendition = bookRenditions.find((r) => r.kind === rendition) ??
    bookRenditions.find((r) => r.kind === activeBook?.default_rendition) ??
    bookRenditions[0] ??
    null;
  const bookLangs = activeRendition?.langs ?? [];

  // Is the shared <PlaybackBar> transport currently mounted over the reader? It
  // is on the audio rendition page (AudiobookPlayer always shows it) AND while
  // text read-aloud narrates THIS chapter (MarkdownViewer mounts it then). When
  // it is, the transport draws ONE frosted slab spanning itself + the bottom nav
  // bar, so the nav bar must render bare (barTransparent) to avoid a second,
  // mismatched frosted layer.
  const transportShown = (activeRendition?.kind === "audio" &&
    currentPath != null) ||
    (nowPlaying?.rendition === "text" &&
      nowPlaying.chapterPath === currentPath);

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
        const res = await contentFetch("/api/books");
        const list = (await res.json()) as Book[];
        setBooks(list);
        // Warm the sidebar spines (both renditions) so a shelf card can be OPENED
        // offline — entering a book fetches its spine first; uncached, the tap
        // would do nothing. Cheap (2 fetches), runs on every load (lazy + eager).
        void prefetchTrees();
        // EAGER (native shell): pre-load the WHOLE library into the offline
        // caches so every book reads + plays with no network — the native app's
        // "almost no loading" promise. No-op on web/PWA (lazy = warm-on-open).
        // Idle-scheduled + session-deduped inside prefetch, so it's a background
        // trickle that never blocks the shelf.
        void prefetchAllBooks(list.map((b) => b.slug));
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
    // PERF: O(tree + rows), not O(rows × tree). The old code called findNode(tree,…)
    // AND flattenTracks(book) for EVERY recent-progress row — walking the whole
    // forest and re-flattening a book's spine per row. That's the return-from-book
    // freeze on a slow device (iPad: ~hundreds of ms; fast desktop hid it at a few
    // ms), and it's INDEPENDENT of how many books the shelf shows (why filtering
    // didn't help). Here we index only the books that actually have progress, each
    // flattened ONCE, then do O(1) lookups per row.
    const slugs = new Set(recentProgress.map((r) => r.path.split("/")[0] ?? ""));
    const nodeByPath = new Map<string, TreeNode>();
    const leavesBySlug = new Map<string, ReturnType<typeof flattenTracks>>();
    const indexNode = (n: TreeNode): void => {
      nodeByPath.set(n.path, n);
      n.children?.forEach(indexNode);
    };
    for (const top of tree) {
      if (!slugs.has(top.path)) continue; // only books with recent progress
      indexNode(top);
      leavesBySlug.set(top.path, flattenTracks(top.children, uiLang));
    }
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
      const node = nodeByPath.get(r.path);
      const chapterLabel =
        (node && ((uiLang && node.titles?.[uiLang]) || node.name)) ||
        r.path.split("/").pop() ||
        r.path;
      // Book-level progress: where this chapter sits in the book's ordered spine,
      // plus its in-chapter scroll, over the chapter count. (Audio resume paths
      // (.spoken.md) aren't in the text spine → idx < 0 → scroll fallback.)
      const scroll = Math.min(1, Math.max(0, r.scroll));
      const leaves = leavesBySlug.get(slug) ?? [];
      const idx = leaves.findIndex((l) => l.path === r.path);
      const fraction = leaves.length > 0 && idx >= 0
        ? (idx + scroll) / leaves.length
        : scroll;
      (out[slug] ??= {})[kind] = {
        path: r.path,
        chapterLabel,
        scroll: r.scroll,
        fraction,
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
      setFileError(null);
      try {
        const res = await contentFetch(
          `/api/file?path=${encodeURIComponent(path)}&lang=${
            encodeURIComponent(reqLang)
          }&rendition=${encodeURIComponent(reqRendition)}`,
        );
        if (!res.ok) {
          console.error("Failed to fetch file:", path, res.status);
          // Don't leave the previous chapter silently up — surface it. Offline +
          // uncached is the common cause on a lazy (web) install; otherwise a
          // genuine load failure.
          setFileError(navigator.onLine ? "failed" : "offline");
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
        setFileError(navigator.onLine ? "failed" : "offline");
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
      // ALWAYS pin the lang in the URL (never omit it when it equals the book
      // default). The restore path re-derives a missing lang from the UI language
      // (pickInitialLang), which differs from `default_lang` — so omitting the
      // token made a book whose default ≠ UI language flip languages on reload
      // (reading zh, the SW-update reload dropped you into en). The hash is the
      // source of truth across a reload; keep it explicit. (rendition still omits
      // its default — its restore default matches the omission, so it's safe.)
      const langForHash = langArg || null;
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

  // Sidebar / TOC navigation, within the current edition + mode. Logical-layer
  // history: the shelf is layer 0 and "reading" is a single layer-1 entry above
  // it. `enterBook` pushes that one entry on shelf→book; switching chapters from
  // the TOC is a *lateral* move that REPLACES it, so the browser/native Back from
  // any chapter returns to the shelf, not to the previously-read chapter. (The
  // `enteringFromShelf` guard is defensive — the sidebar only renders while
  // reading, so in practice this always replaces.)
  const handleSelect = useCallback(
    (path: string) => {
      const enteringFromShelf = currentPathRef.current === null;
      void openFile(path, lang, rendition, !enteringFromShelf);
    },
    [openFile, lang, rendition],
  );

  // In-content cross-reference links (a `.md` link in the prose, e.g. "see ch.4").
  // Unlike a TOC jump this is a drill-DOWN, not a lateral move: PUSH a history
  // entry so Back returns to the citing chapter where the link was, not to the
  // shelf.
  const handleNavigateLink = useCallback(
    (path: string) => {
      void openFile(path, lang, rendition, false);
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
      // Resume the newest read chapter THAT EXISTS IN THIS rendition's spine —
      // NOT the globally-newest row. Text + audio share one per-book progress
      // table with distinct chapter paths, so after listening, the newest row is
      // an audio chapter the text spine can't resolve; picking rows[0] then reset
      // the reader to the README and threw away the text reading position. Scan
      // newest-first for the first row whose path is in scope instead.
      const rows = await loadBookRows(slug);
      const resume = rows.find((r) => hasFilePath(scope, r.path))?.path ?? null;
      return resume ?? findReadme(scope) ?? findFirstFile(scope);
    },
    [loadBookRows],
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
          const res = await contentFetch(`/api/tree?rendition=audio`);
          const spine = (await res.json()) as TreeNode[];
          const root = spine.find((n) => n.path === slug);
          const scope = root ? [root] : spine;
          let target = chapterPath && hasFilePath(scope, chapterPath)
            ? chapterPath
            : null;
          if (!target) {
            // Resume the newest AUDIO chapter (the newest row whose path is in
            // the audio spine) — not the globally-newest row, which may be a
            // text chapter after reading. Symmetric with entryChapter.
            const rows = await loadBookRows(slug);
            target = rows.find((r) => hasFilePath(scope, r.path))?.path ??
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
          // Offline + the audio spine isn't cached: surface it instead of a dead
          // tap. (prefetchTrees warms both spines, so this is the rare fallback.)
          console.error("Failed to open audiobook:", e);
          setNotice(t("audiobook.empty"));
        }
      })();
    },
    [books, bookPrefs, loadBookRows, pickInitialLang, openFile, t],
  );

  // Enter a book from the landing page in a specific rendition (the bookshelf
  // shows a separate card per rendition, so it passes the kind to open). Falls
  // back to the book's default rendition. Resumes the last-read chapter if there
  // is one (and it still exists), else its README, else its first doc.
  const enterBook = useCallback(
    (slug: string, renditionKind?: string, replace = false) => {
      const book = books.find((b) => b.slug === slug);
      if (!book) return;
      // Native iOS shell only: snapshot the SHELF (the current view) as the pop
      // destination, but ONLY when entering FROM the shelf — chapter/rendition
      // switches inside a book keep the single shelf snapshot. No-op off-shell.
      if (currentPathRef.current === null) nativeNavPush(slug);
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
          // Offline + the spine isn't cached (or a transient error): DON'T leave
          // the tap dead. Enter the book anyway at its README so the reader shows
          // cached content or the calm offline placeholder — never nothing.
          console.error("Failed to enter book:", e);
          void openFile(`${slug}/README.md`, initialLang, r.kind, replace);
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
    // Native iOS shell only: snapshot the current book + reveal the held shelf
    // snapshot, so the shelf appears instantly and the shelf re-composite below
    // happens behind the snapshot. No-op (false) off-shell → unchanged web return.
    const native = nativeNavPop();
    writeHash(null, null, null, false);
    setCurrentPath(null);
    currentPathRef.current = null;
    setCurrentContent(null);
    setUntranslated(null);
    // Tell native the shelf has painted so it swaps the held snapshot for the live
    // webview. Double-rAF = through the first painted frame.
    if (native) {
      requestAnimationFrame(() => requestAnimationFrame(() => nativeNavReady()));
    }
  }, []);

  // iOS-style left-edge swipe → back to the shelf. A standalone PWA has no
  // browser back-swipe, so we synthesise it: a touch that STARTS within EDGE px
  // of the left edge and travels right past THRESH (more horizontal than
  // vertical) pops back to the bookshelf. Only while reading a book; skipped
  // when the touch begins inside an overlay (lightbox / sheet / modal — a fixed
  // element high in the z-stack, which owns its own horizontal gestures).
  // Passive listeners so normal vertical scrolling is never blocked.
  useEffect(() => {
    if (!currentPath) {
      return;
    }
    const EDGE = 28;
    const THRESH = 70;
    let sx = 0;
    let sy = 0;
    let tracking = false;
    let horiz = false;
    let decided = false;
    const inOverlay = (el: Element | null): boolean => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const s = globalThis.getComputedStyle(n);
        if (s.position === "fixed" && Number(s.zIndex) >= 1250) {
          return true;
        }
      }
      return false;
    };
    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (!t || t.clientX > EDGE || inOverlay(e.target as Element)) {
        return;
      }
      sx = t.clientX;
      sy = t.clientY;
      tracking = true;
      decided = false;
      horiz = false;
    };
    const onMove = (e: TouchEvent): void => {
      if (!tracking) {
        return;
      }
      const t = e.touches[0];
      if (!t) {
        return;
      }
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (!decided && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) {
        decided = true;
        horiz = dx > 0 && Math.abs(dx) > Math.abs(dy);
        if (!horiz) {
          tracking = false; // a vertical scroll — let it go
        }
      }
    };
    const onEnd = (e: TouchEvent): void => {
      if (!tracking) {
        return;
      }
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) {
        return;
      }
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (horiz && dx > THRESH && Math.abs(dx) > Math.abs(dy)) {
        backToLanding();
      }
    };
    globalThis.addEventListener("touchstart", onStart, { passive: true });
    globalThis.addEventListener("touchmove", onMove, { passive: true });
    globalThis.addEventListener("touchend", onEnd, { passive: true });
    globalThis.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      globalThis.removeEventListener("touchstart", onStart);
      globalThis.removeEventListener("touchmove", onMove);
      globalThis.removeEventListener("touchend", onEnd);
      globalThis.removeEventListener("touchcancel", onEnd);
    };
  }, [currentPath, backToLanding]);

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
        // Normalise the hash without a history entry: pin the resolved lang
        // explicitly (see the openFile note — a missing lang re-derives to the UI
        // language, not default_lang, so it must never be dropped) and drop a
        // redundant default-rendition token.
        const slug = path.split("/")[0] ?? "";
        const book = books.find((b) => b.slug === slug);
        const langForHash = entryLang || null;
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

  // Persist the last reading location on THIS device (see RESUME_KEY) whenever
  // it changes; clear it on the shelf. Drives the cold-relaunch resume below.
  useEffect(() => {
    writeResume(currentPath ? { path: currentPath, lang, rendition } : null);
  }, [currentPath, lang, rendition]);

  // Resume the last reading location saved on this device. Fault-tolerant: the
  // saved book may have been removed since — log a warning, clear the stale
  // entry, and fall back to the shelf rather than crashing. Returns whether it
  // resumed. Re-enters via the hash so the normal restore path does the spine
  // fetch + chapter load + scroll restore.
  const tryResumeLastLocation = useCallback(async (): Promise<boolean> => {
    // `initialResume` is captured at first render (below), BEFORE the save-effect
    // can clear the key on the mount-time `currentPath === null`.
    const saved = initialResume;
    if (!saved) return false;
    const slug = saved.path.split("/")[0] ?? "";
    if (!books.some((b) => b.slug === slug)) {
      console.warn(
        `liveview: saved book "${slug}" no longer exists; returning to the shelf`,
      );
      writeResume(null);
      return false;
    }
    try {
      writeHash(saved.path, saved.lang, saved.rendition, true);
      await restoreFromHash(true);
      return true;
    } catch (e) {
      console.warn(`liveview: failed to resume "${saved.path}":`, e);
      writeHash(null, null, null, true); // reset the URL so the shelf is clean
      return false;
    }
  }, [books, restoreFromHash, initialResume]);

  // Fetch the tree once, then restore any deep link from the hash. Waits for
  // `books` so deep-link rendition/language/fallback resolution works.
  useEffect(() => {
    if (initializedRef.current || books.length === 0) return;
    initializedRef.current = true;
    void (async () => {
      const { path } = getHashState();
      if (path) {
        await restoreFromHash(true);
        return;
      }
      // No deep link in the URL. A native-shell cold relaunch loads the base URL
      // (no hash), so try to RESUME the last book read on this device first.
      if (await tryResumeLastLocation()) return;
      // Nothing to resume (or the saved book is gone): seed the default (text)
      // sidebar spine for the bookshelf.
      try {
        const res = await contentFetch("/api/tree");
        setTree((await res.json()) as TreeNode[]);
      } catch (e) {
        console.error("Failed to fetch tree:", e);
      }
    })();
  }, [books, restoreFromHash, tryResumeLastLocation]);

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

  // Read aloud the CURRENT text document: hand the engine this chapter on the
  // `text` rendition (units-driven synth server-side) + the text spine as its
  // queue, so the in-place highlight (useInPlaceHighlight) lights up the spoken
  // sentence in the rich reader. Distinct from the audiobook path (effect A,
  // `rendition === "audio"`): this is opt-in via the reader's read-aloud button,
  // and keeps the reader view (no popup).
  const handleReadAloud = useCallback(() => {
    if (!activeBook || !currentPath) return;
    audioPlayChapter(
      {
        bookSlug: activeBook.slug,
        bookLabel: activeBook.label,
        cover: activeBook.cover,
        chapterPath: currentPath,
        lang,
        rendition: "text",
      },
      flattenTracks(activeTree, uiLang),
      true, // autoplay: one tap on the read-aloud button starts speaking
    );
  }, [activeBook, currentPath, lang, activeTree, uiLang, audioPlayChapter]);

  // B) engine → view: when the engine auto-advances into the next chapter while
  //    you're following along on THIS book's reader — the audio page OR text
  //    read-aloud — carry the page into the next chapter (so the in-place
  //    highlight / read-along continues there). Follow ONLY when we were already
  //    in sync (the engine advancing under us), never when we navigated somewhere
  //    the engine isn't (effect A brings the engine to us there). Away from the
  //    reader, the bubble tracks it.
  const syncedChapterRef = useRef<string | null>(null);
  useEffect(() => {
    const np = nowPlaying;
    // Only while viewing the playing book in the rendition it's playing.
    if (
      !np || activeSlug !== np.bookSlug || activeRendition?.kind !== np.rendition
    ) {
      syncedChapterRef.current = null;
      return;
    }
    if (currentPath === np.chapterPath) {
      syncedChapterRef.current = np.chapterPath;
      return;
    }
    if (syncedChapterRef.current !== currentPath) return; // we weren't in sync — don't hijack
    syncedChapterRef.current = np.chapterPath;
    if (np.rendition === "audio") {
      // Audio renders off the engine — just move the page (no body fetch).
      setCurrentPath(np.chapterPath);
      currentPathRef.current = np.chapterPath;
      setUntranslated(null);
      const langForHash = lang || null; // always pin lang (see openFile note)
      const renditionForHash =
        activeBook && rendition !== activeBook.default_rendition
          ? rendition
          : null;
      writeHash(np.chapterPath, langForHash, renditionForHash, true);
    } else {
      // Text read-aloud: load the next chapter's markdown so the in-place
      // highlight carries into it (sticky read-along across chapters).
      void openFile(np.chapterPath, np.lang, "text", true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    nowPlaying,
    activeRendition,
    activeSlug,
    currentPath,
    activeBook,
    rendition,
    lang,
    openFile,
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

  // Bottom prev/next chapter pager, shown under both the text reader and the
  // audiobook read-along. Built from the active rendition's ordered spine;
  // navigation is uniform — openFile(path, lang, rendition) loads the text
  // chapter, or seeds the audio read-along via the view→engine effect.
  const chapterPager = useMemo(() => {
    const spine = flattenTracks(activeTree, uiLang);
    const i = spine.findIndex((c) => c.path === currentPath);
    if (i < 0) return null;
    const prev = i > 0 ? spine[i - 1] : undefined;
    const next = i < spine.length - 1 ? spine[i + 1] : undefined;
    if (!prev && !next) return null;
    return (
      <ChapterPager
        prev={prev}
        next={next}
        onNavigate={(path) => void openFile(path, lang, rendition)}
      />
    );
  }, [activeTree, uiLang, currentPath, openFile, lang, rendition]);

  // Tapping the floating bubble's artwork returns to the playing book's inline
  // audio page (re-entering at the chapter it's on).
  const openPlayingAudio = useCallback(() => {
    if (nowPlaying) openAudiobook(nowPlaying.bookSlug, nowPlaying.chapterPath);
  }, [nowPlaying, openAudiobook]);

  // Navigate to whatever is playing, in its own mode: the audiobook page for an
  // audio rendition, or the text chapter for a read-aloud. Used by the playback
  // sheet's "go to current" (shown only when you've wandered off it).
  const goToNowPlaying = useCallback(() => {
    if (!nowPlaying) return;
    if (nowPlaying.rendition === "audio") openPlayingAudio();
    else openFile(nowPlaying.chapterPath, nowPlaying.lang, nowPlaying.rendition);
  }, [nowPlaying, openPlayingAudio, openFile]);

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

  // Read-aloud of THIS text chapter is "active" when the engine is on it (text
  // rendition, same path) — playing OR paused. Suppresses the floating bubble
  // (the in-place <PlaybackBar> already represents it: one listen handle, not two).
  const readingThisInPlace = nowPlaying?.rendition === "text" &&
    nowPlaying.chapterPath === currentPath;

  // Two ORTHOGONAL axes, never conflated into one button (the v181 mistake):
  //
  //  🗣 read-aloud — VOICE the current rich-text page in place (TTS + in-place
  //     highlight, the shared <PlaybackBar>). Always means exactly this; never
  //     navigates. Tapping while active stops it. Shown on any text edition, so a
  //     book that ALSO has a curated audiobook can still be read aloud in place.
  //
  //  🎧 audiobook — the EDITION switch text ⇄ curated audiobook page. Only when
  //     the book offers both renditions (the audiobook is a separate spine with
  //     its own audio; switching is navigation, not "voice this page").
  const onReadAloud = useCallback(() => {
    if (readingThisInPlace) stopPlayback();
    else handleReadAloud();
  }, [readingThisInPlace, stopPlayback, handleReadAloud]);

  const onAudiobookEdition = useCallback(() => {
    switchRendition(rendition === "audio" ? "text" : "audio");
  }, [rendition, switchRendition]);

  const bookActions = (
    <>
      {/* 🗣 Read this page aloud — only on a text edition (it voices the rich
          markdown in place). A dual-rendition book keeps this AND the 🎧 switch
          below, because they're two distinct features. */}
      {rendition === "text" && currentPath && hasText && (
        <IconButton
          aria-label={readingThisInPlace
            ? t("audiobook.stopReadAloud")
            : t("audiobook.readAloud")}
          aria-pressed={readingThisInPlace}
          onClick={onReadAloud}
          sx={{
            width: 40,
            height: 40,
            color: readingThisInPlace ? "primary.main" : "text.secondary",
          }}
        >
          <ReadAloudIcon sx={{ fontSize: rem(22) }} />
        </IconButton>
      )}
      {/* 🎧 Audiobook edition — text ⇄ curated audiobook (same glyph as the
          floating now-playing bubble). Only for books that offer both. Accent
          while you're on the audiobook page. */}
      {hasAudio && hasText && currentPath && (
        <IconButton
          aria-label={rendition === "audio"
            ? t("audiobook.read")
            : t("audiobook.open")}
          aria-pressed={rendition === "audio"}
          onClick={onAudiobookEdition}
          sx={{
            width: 40,
            height: 40,
            color: rendition === "audio" ? "primary.main" : "text.secondary",
          }}
        >
          <AudiobookIcon sx={{ fontSize: rem(22) }} />
        </IconButton>
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
          ref={statusBarTapRef}
          aria-hidden
          sx={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            // Span the status-bar strip. On a notched phone the safe-area inset
            // (~47px) is plenty, but a no-notch iPad reports ~0 — leaving NOTHING
            // to tap (the reported "tapping the top does nothing"). Floor it to a
            // real status-bar height so the gesture works there too. ONLY in
            // bottom-navbar mode: in top-navbar mode a fixed strip at this zIndex
            // would shadow the navbar's top edge and eat its button taps. (Desktop
            // is top-navbar, inset 0 → 0-height, unaffected.)
            height: navbarAtBottom
              ? "max(env(safe-area-inset-top, 0px), 24px)"
              : "env(safe-area-inset-top, 0px)",
            zIndex: (t) => t.zIndex.appBar + 1,
            // The tap is wired with NATIVE pointer events (statusBarTapRef effect
            // above), NOT React onClick: iOS WKWebView doesn't reliably deliver a
            // synthetic click to this non-interactive div even with cursor:pointer,
            // so the gesture silently no-op'd. cursor:pointer stays as the desktop
            // hover affordance.
            cursor: "pointer",
          }}
        />
        {
          /* Frosted-glass strip over the iOS status-bar / Dynamic Island. In the
            native shell (and a standalone PWA) the reader runs full-height with
            the navbar at the bottom, so content scrolls UNDER the status bar. A
            blurred + saturated strip over the safe-area-top fixes it the iOS way:
            the status bar sits on frosted glass and content scrolls under it (the
            reader scrollers' matching ::before inset — index.css — clears it at
            rest). `pointer-events:none` so the tap target above still works; only
            shown in bottom-navbar mode (top mode: the NavShell bar owns that
            edge); height collapses to 0 off-device, so it costs nothing there. */
        }
        {navbarAtBottom && (
          <Box
            aria-hidden
            sx={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              height: "env(safe-area-inset-top, 0px)",
              zIndex: (t) => t.zIndex.appBar,
              pointerEvents: "none",
              bgcolor: (t) => alpha(t.palette.background.default, 0.5),
              // No saturate() here: over the sepia/warm page the 1.8× boost
              // amplified the low-saturation content peeking through into a
              // visible cool/green cast that didn't match the flat page. Plain
              // blur keeps the frost without tinting. (lv-v203)
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
            }}
          />
        )}
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
              settingsSlot={settingsButton}
              navbarAtBottom={navbarAtBottom}
            />
          </Box>
          {activeSlug !== null && (
            <NavShell
              appKey="liveview"
              barPosition={navbarAtBottom ? "bottom" : "top"}
              // Frosted-overlay bar ONLY on the compact (bottom-bar) tier, where
              // the reader runs full-height and content scrolls under the bar
              // (iOS-style). On desktop the bar is a top sibling above a
              // persistent sidebar, so it stays the solid flex sibling — a
              // frosted desktop bar would also float over the sidebar. The
              // reader scroller pads itself by --shell-bar-h (index.css).
              barFrosted={navbarAtBottom}
              // While the transport is mounted it owns a single frosted slab
              // behind both itself and this bar, so the bar renders bare (one pane
              // of glass, no seam). Otherwise the bar keeps its own frost.
              barTransparent={navbarAtBottom && transportShown}
              title={
                <Box
                  role="button"
                  tabIndex={0}
                  aria-label={t("app.scrollBottom")}
                  onClick={scrollReaderBottom}
                  sx={{
                    minWidth: 0,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                  }}
                >
                  {
                    /* Line 1: where you ARE — the current chapter (bold). Line 2:
                      the book it belongs to (muted), shown only when it differs
                      so a doc whose chapter IS the book name doesn't repeat. */
                  }
                  <Typography
                    variant="subtitle2"
                    noWrap
                    sx={{ fontWeight: 700, lineHeight: 1.25 }}
                  >
                    {chapterLabel || bookLabel}
                  </Typography>
                  {chapterLabel && chapterLabel !== bookLabel && (
                    <Typography
                      variant="caption"
                      noWrap
                      color="text.secondary"
                      sx={{ lineHeight: 1.2 }}
                    >
                      {bookLabel}
                    </Typography>
                  )}
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
                    footer={chapterPager}
                  />
                )
                : fileError
                ? (
                  // Don't show a blank/stale reader when a chapter couldn't load.
                  // Offline + uncached (lazy/web) is calm guidance; a genuine
                  // failure offers a retry. (Native eager pre-caches everything,
                  // so it effectively never lands here.)
                  <Box
                    sx={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 1.5,
                      px: 4,
                      textAlign: "center",
                      color: "text.secondary",
                    }}
                  >
                    <Typography variant="body1">
                      {fileError === "offline"
                        ? t("content.offline")
                        : t("content.loadFailed")}
                    </Typography>
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() =>
                        void loadFile(currentPath ?? "", lang, rendition)}
                    >
                      {t("content.retry")}
                    </Button>
                  </Box>
                )
                : (
                  <ContentViewer
                    content={currentContent}
                    fileType={currentFileType}
                    currentPath={currentPath}
                    theme={theme}
                    onNavigate={handleNavigateLink}
                    contentMaxWidth={menuBarSettings.contentMaxWidth}
                    lineHeight={menuBarSettings.lineHeight}
                    savedScroll={savedScroll}
                    onSaveScroll={saveProgress}
                    navbarAtBottom={navbarAtBottom}
                    footer={chapterPager}
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
        suppressed={readingThisInPlace}
        onOpenControls={() => setPlaybackSheetOpen(true)}
      />
      {/* Ambient background-work indicator (audio generation + offline prefetch)
          → the Sync sheet. Low-weight; only shows while something is in flight. */}
      <SyncIndicator bookSlug={activeSlug} />
      {/* Desktop keyboard-shortcut cheat-sheet (opened with `?`). The Dialog
          renders nothing while closed; on touch it never opens (the `?` handler
          is desktop-gated). */}
      <ShortcutsDialog open={helpOpen} onClose={closeHelp} />
      <PlaybackSheet
        open={playbackSheetOpen}
        onClose={() => setPlaybackSheetOpen(false)}
        onGoToNowPlaying={nowPlaying &&
            (currentPath !== nowPlaying.chapterPath ||
              rendition !== nowPlaying.rendition)
          ? goToNowPlaying
          : undefined}
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
