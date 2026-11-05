import { rem } from "@/px";
import { loadContentsTree } from "@/audio/contents";
import { remoteUrl } from "@/apiBase";
import { nativeWidgetPublish } from "@/native-audio";
import {
  contentFetch,
  ensureAutoSync,
  nativeRefreshManifest,
} from "@/native-sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  Close as CloseIcon,
  Headphones as AudiobookIcon,
  RecordVoiceOver as ReadAloudIcon,
} from "@mui/icons-material";
import {
  AudiobookPlayer,
  ChapterPager,
  ContentViewer,
  Landing,
  PlaybackSheet,
  ReconnectBanner,
  SettingsButton,
  Sidebar,
  SpatialPlaybackPreview,
  SyncIndicator,
} from "@/components";
import { NowPlayingRow } from "@/components/NowPlayingRow";
import {
  useFont,
  useNavbarAtBottom,
  useProgress,
  useSettings,
  useTheme,
  useWebSocket,
} from "@/hooks";
import { useI18n } from "@/i18n";
import { prefetchTrees } from "@/prefetch";
import { useAudioPlayer } from "@/audio/player";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { useAutoUpdate } from "@/hooks/useAutoUpdate";
import { useAudioPreloadDriver } from "@/hooks/useAudioPreloadDriver";
import { useBookAudioPreload } from "@/hooks/useBookAudioPreload";
import { useBookPrefs } from "@/hooks/useBookPrefs";
import { useForegroundRepaint } from "@/hooks/useForegroundRepaint";
import { useShelfRootRefresh } from "@/hooks/useShelfRootRefresh";
import { useStatusBarScroll } from "@/hooks/useStatusBarScroll";
import {
  useReadingOffline,
  useStoredTextPaths,
} from "@/hooks/useOfflineReading";
import { NativeReleaseUpdatePrompt, NavShell } from "./_shell";
import { findNode, flattenTracks } from "./readerTree";
import { bookSlugOf } from "@/reader/location";
import { shelfProgress, widgetItems } from "@/reader/progress";
import { useReaderNavigation } from "@/reader/useReaderNavigation";
import { engineShouldLoad, followEngine } from "@/reader/readAlong";
import type {
  Book,
  FileType,
  ProgressEntry,
  TreeNode,
} from "@/types";

const NATIVE_RELEASE_APP_ID = (
  import.meta.env["VITE_NATIVE_RELEASE_APP_ID"] as string | undefined
)?.trim();
const NATIVE_RELEASE_MANIFEST_URL = (
  import.meta.env["VITE_NATIVE_RELEASE_MANIFEST_URL"] as string | undefined
)?.trim();

/**
 * A state updater that keeps the previous value when a revalidated response is
 * structurally identical, so memoized shelf cards and progress meters do not
 * re-render on every refresh that changed nothing.
 */
function keepIfSame<T>(next: T): (prev: T) => T {
  return (prev) => {
    if (prev === next) return prev;
    try {
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    } catch {
      return next;
    }
  };
}

export function App(): React.JSX.Element {
  // The shelf's two whole-library forests: text and audio. Shelf progress
  // meters index text rows against the first and `.spoken.md` rows against the
  // second (the text spine omits spoken chapters).
  const [shelfForest, setShelfForest] = useState<TreeNode[]>([]);
  const [audioForest, setAudioForest] = useState<TreeNode[]>([]);
  // Per-book contents spines keyed `slug:rendition`. A keyed entry is never
  // wrong for its key, so late loads cannot clobber another book or rendition.
  const [spines, setSpines] = useState<Record<string, TreeNode[]>>({});
  const putSpine = useCallback((slug: string, kind: string, nodes: TreeNode[]) => {
    setSpines((prev) => {
      const key = `${slug}:${kind}`;
      return prev[key] === nodes ? prev : { ...prev, [key]: nodes };
    });
  }, []);
  const [books, setBooks] = useState<Book[]>([]);
  // Transient toast, e.g. when a listen affordance resolves to no chapters.
  // Belt-and-suspenders: the backend already omits content-less audio
  // renditions (no card/button), so this only fires on a race (content removed
  // after the book list loaded) — never a silent dead tap.
  const [notice, setNotice] = useState<string | null>(null);

  const {
    loadBook,
    loadBookRows,
    loadRecent,
    savedScroll,
    save: saveProgress,
  } = useProgress();
  // Latest-read chapter per book (newest first), for the landing "continue
  // reading" indicators. Refetched whenever the bookshelf is shown so it
  // reflects progress made since the last visit.
  const [recentProgress, setRecentProgress] = useState<ProgressEntry[]>([]);

  const { bookPrefs, saveBookPref } = useBookPrefs();

  useForegroundRepaint();

  const { t, lang: uiLang } = useI18n();
  // Offline (airplane mode, or a network that cannot reach the server) only
  // downloaded chapters open.
  const offline = useReadingOffline();
  const {
    currentPath,
    currentPathRef,
    lang,
    rendition,
    chapter,
    loadFile,
    openFile,
    enterBook,
    openAudiobook,
    backToLanding,
    handleSelect,
    handleNavigateLink,
    switchLang,
    switchRendition,
    followAudioChapter,
  } = useReaderNavigation({
    books,
    bookPrefs,
    saveBookPref,
    recentProgress,
    loadBook,
    loadBookRows,
    putSpine,
    offline,
    notify: setNotice,
  });
  const { applyLive: applyLiveChapter } = chapter;
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
  // The root audio engine: playback lives above every view, so navigating never
  // stops the audio. The shell only seeds playback (`playChapter`) and reads the
  // session identity; the per-sentence read-along state lives in a separate
  // context so it never re-renders this whole tree.
  const {
    playChapter: audioPlayChapter,
    syncNotice,
    nowPlaying,
    playing: audioPlaying,
    stop: stopPlayback,
  } = useAudioPlayer();
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
  // Drive the offline audio fill from app level, so it runs the moment the app
  // opens (not only while the Settings → Downloads panel is mounted).
  useAudioPreloadDriver();

  // When a fresh load pulls a newer playback position from another device, the
  // audio engine raises `syncNotice`; surface it through the shared snackbar
  // ("已同步…"). Keyed on `seq` so an identical message re-fires the toast.
  useEffect(() => {
    if (syncNotice) setNotice(syncNotice.message);
  }, [syncNotice]);

  // The active book is the first path segment; null ⇒ the landing bookshelf.
  const activeSlug = currentPath ? bookSlugOf(currentPath) : null;
  const activeBook = books.find((b) => b.slug === activeSlug) ?? null;
  // Are we ON the playing book's inline audio page (where the read-along reader
  // already shows full controls)? If so the floating bubble hides; everywhere
  // else (text page, another book, the shelf) it shows as the now-playing handle.
  const onPlayingPage = nowPlaying != null &&
    activeSlug === nowPlaying.bookSlug && rendition === "audio";
  // Desktop keyboard shortcuts (Space/←/→/⌘±arrows/</>) + the `?` cheat-sheet.
  // Desktop-only (gated inside the hook); a no-op on touch. Playback keys apply
  // only while audio plays or its read-along page is open.
  const { helpOpen, closeHelp } = useKeyboardShortcuts(onPlayingPage);

  const { scrollReaderBottom, statusBarTapRef } = useStatusBarScroll();
  // "book" mode (book.toml-driven) renders a clean titled spine; "docs" mode
  // renders the raw filesystem tree. The flag also drives whether the root
  // folder node is shown (see below) and the per-row styling in the sidebar.
  const bookMode = activeBook?.manifest ?? false;
  const activeSpine = activeSlug ? spines[`${activeSlug}:${rendition}`] : undefined;
  const activeTree = useMemo(() => {
    if (!activeSlug || !activeSpine) return [];
    const root = activeSpine.find((n) => n.path === activeSlug);
    if (!root) return [];
    // Book mode: the book label already sits in the sidebar header, so the
    // single root folder ("第一层 dir") is redundant — surface its
    // chapters/sections directly. Docs mode keeps the root for context.
    return bookMode ? root.children : [root];
  }, [activeSpine, activeSlug, bookMode]);
  const contentsTree = useBookAudioPreload(activeTree, activeSlug, rendition, lang, currentPath, nowPlaying, audioPlaying);
  const bookLabel = activeBook?.label ?? activeSlug ?? "";
  // The current chapter's display title (current UI edition, falling back to the
  // node name, then the file name) — shown as the primary line of the in-book
  // bar so you always see WHERE you are, with the book name as the second line.
  const chapterLabel = useMemo(() => {
    if (!currentPath) return "";
    const node = findNode(activeSpine ?? shelfForest, currentPath);
    const resolved = node && ((uiLang && node.titles?.[uiLang]) || node.name);
    // No spine node (offline before a new book's spine is cached): the book
    // title says where you are better than a raw "README.md".
    return resolved || bookLabel || currentPath.split("/").pop() || "";
  }, [currentPath, activeSpine, shelfForest, uiLang, bookLabel]);
  // The renditions the active book offers, and the one currently active. The
  // language switcher shows the *active rendition's* languages (each rendition
  // carries its own lang list).
  const bookRenditions = activeBook?.renditions ?? [];
  const activeRendition = bookRenditions.find((r) => r.kind === rendition) ??
    bookRenditions.find((r) => r.kind === activeBook?.default_rendition) ??
    bookRenditions[0] ??
    null;
  const bookLangs = activeRendition?.langs ?? [];
  // Offline, mark the chapters that were not downloaded so the reader can see
  // where to go instead of discovering it one tap at a time.
  const storedTextPaths = useStoredTextPaths(offline);
  const textDefaultLang = activeBook?.renditions.find((r) => r.kind === "text")
    ?.default_lang;
  const chapterUnavailable = useMemo(() => {
    if (!storedTextPaths || rendition !== "text") return undefined;
    return (path: string): boolean => {
      const slash = path.indexOf("/");
      if (slash < 0) return false;
      const slug = path.slice(0, slash);
      const rel = path.slice(slash + 1);
      // The server falls back to the default edition for an untranslated page.
      return !storedTextPaths.has(`${slug}/text/${lang}/${rel}`) &&
        !(textDefaultLang &&
          storedTextPaths.has(`${slug}/text/${textDefaultLang}/${rel}`));
    };
  }, [storedTextPaths, rendition, lang, textDefaultLang]);
  const booksUnavailableOffline = useMemo(() => {
    if (!storedTextPaths) return undefined;
    const readable = new Set<string>();
    for (const path of storedTextPaths) {
      readable.add(path.slice(0, path.indexOf("/")));
    }
    // Only text can be judged from here; an audio-only book stays as is.
    return new Set(
      books
        .filter((b) =>
          b.renditions.some((r) => r.kind === "text") && !readable.has(b.slug)
        )
        .map((b) => b.slug),
    );
  }, [storedTextPaths, books]);
  // The chapter the ENGINE is actually playing in THIS book — the sidebar's
  // now-playing marker. The audiobook reader is "a window onto the engine"
  // (AudiobookPlayer renders `nowPlaying.chapterPath`), but the list highlight
  // has historically tracked `currentPath` (the VIEWED chapter). Those two only
  // stay coupled via the guarded engine→view effect, which stops carrying
  // `currentPath` forward the moment you fall out of sync (auto-advance while
  // backgrounded, navigating away and back). Then the reader shows the playing
  // chapter while the list highlights a stale/absent `currentPath`. Marking the
  // engine's chapter directly keeps the list honest regardless of that sync.
  const playingPath = nowPlaying != null &&
      nowPlaying.bookSlug === activeSlug &&
      nowPlaying.rendition === activeRendition?.kind
    ? nowPlaying.chapterPath
    : null;

  // Fetch the book list once, for the landing page + language switcher.
  useEffect(() => {
    void (async () => {
      try {
        // STALE-WHILE-REVALIDATE. CACHE-FIRST render = instant shelf, online OR
        // offline, never a network wait (the fix for "断网点不开" — every open path
        // now resolves from cache, never a network-first fetch that hangs/fails
        // offline). Then a background network revalidate updates the shelf if a new
        // book deployed since the cache was written — so freshness costs nothing on
        // the critical path. (The root-watcher below keeps it fresh thereafter.)
        const res = await contentFetch("/api/books");
        const list = (await res.json()) as Book[];
        setBooks(list);
        // Background revalidate (online only; offline this falls back to the same
        // cache → no-op). Don't await — the shelf is already showing.
        void (async () => {
          try {
            const fresh = (await (
              await contentFetch("/api/books", { fresh: true })
            ).json()) as Book[];
            setBooks(keepIfSame(fresh));
          } catch {
            /* offline / transient — the cached shelf stands */
          }
        })();
        // Warm the sidebar spines (both renditions) so a shelf card can be OPENED
        // offline — entering a book fetches its spine first; uncached, the tap
        // would do nothing. Cheap (2 fetches), runs on every load (lazy + eager).
        void prefetchTrees();
        // Seed the shelf forests for the progress meters, cache-first so it is
        // instant offline; refreshShelf re-seeds them on deploy.
        for (const [url, set] of [
          ["/api/tree", setShelfForest],
          ["/api/tree?rendition=audio", setAudioForest],
        ] as const) {
          void (async () => {
            try {
              set(keepIfSame((await (await contentFetch(url)).json()) as TreeNode[]));
            } catch {
              /* offline / transient — the cached meter stands */
            }
          })();
        }
        // Native shell: bulk-download the whole corpus into the offline content
        // cache (auto-download, default on, WiFi-only by default). Runs with
        // bounded concurrency native-side; no-op on web/PWA and when the user
        // turned auto-download off in settings.
        void ensureAutoSync();
      } catch (e) {
        console.error("Failed to fetch books:", e);
      }
    })();
  }, []);

  // Refresh the shelf to a NEW deploy. The KEY native-shell subtlety: the offline
  // content manifest (`by_url`) is served STORE-FIRST and only refreshed on
  // cold-launch/foreground, so `/api/books` resolves to the STALE deploy until we
  // refresh the manifest FIRST — that's the "deploy 了新书得关掉 liveview 再打开"
  // bug. `nativeRefreshManifest()` re-pulls the replica manifest to the new root
  // on every platform (the PWA also serves chapters from the IDB replica). Only THEN do
  // the FRESH re-fetches resolve to the new content. Then re-warm BOTH spines +
  // re-seed the shelf tree so the new/changed book opens and meters correctly.
  const refreshShelf = useCallback(async (): Promise<void> => {
    await nativeRefreshManifest();
    try {
      const list = (await (await contentFetch("/api/books", { fresh: true }))
        .json()) as Book[];
      setBooks(keepIfSame(list));
    } catch {
      /* offline / transient — the cached shelf stands */
    }
    const [bareTree, , audioTree] = await Promise.all([
      // The bare key seeds the shelf forest; the rendition keys are what the
      // open-book entry paths read. All three are revalidated, or one stays
      // stale across a deploy.
      contentFetch("/api/tree", { fresh: true }).catch(() => undefined),
      contentFetch("/api/tree?rendition=text", { fresh: true }).catch(() =>
        undefined
      ),
      contentFetch("/api/tree?rendition=audio", { fresh: true }).catch(() =>
        undefined
      ),
    ]);
    // Re-seed both shelf forests so the meters index against the new spines.
    for (const [res, set] of [[bareTree, setShelfForest], [audioTree, setAudioForest]] as const) {
      if (!res) continue;
      try {
        set(keepIfSame((await res.json()) as TreeNode[]));
      } catch {
        /* malformed — keep the prior forest, next deploy retries */
      }
    }
  }, []);

  useShelfRootRefresh(refreshShelf);

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
  const progressBySlug = useMemo(
    () => shelfProgress(recentProgress, shelfForest, audioForest, uiLang),
    [recentProgress, shelfForest, audioForest, uiLang],
  );

  // Keep WidgetKit's offline snapshot aligned with the shelf. The native bridge
  // is absent in browsers and becomes a no-op on Personal Team builds without
  // App Group access; the extension retains its direct server fallback there.
  useEffect(() => {
    nativeWidgetPublish({
      serverURL: remoteUrl(""),
      items: widgetItems(books, progressBySlug).map(({ book, progress }) => ({
        label: book.label,
        slug: book.slug,
        progress,
        coverURL: remoteUrl(`/api/cover?book=${encodeURIComponent(book.slug)}`),
      })),
    });
  }, [books, progressBySlug]);

  const handleContentUpdate = useCallback(
    (path: string, msgLang: string, fileType: FileType, content: string) => {
      if (path === currentPathRef.current) {
        applyLiveChapter(msgLang, fileType, content);
      }
    },
    [applyLiveChapter],
  );

  const handleTreeUpdate = useCallback((newTree: TreeNode[]) => {
    // Live tree updates carry the text forest; the open book's text contents
    // (titles + audio metadata) are refreshed from their own endpoint.
    setShelfForest(keepIfSame(newTree));
    const path = currentPathRef.current;
    if (path) {
      const slug = bookSlugOf(path);
      void loadContentsTree(slug, "text", true)
        .then((next) => putSpine(slug, "text", next))
        .catch(() => undefined);
    }
    // A TreeUpdate is the server's post-`sync` broadcast — the corpus just changed
    // (new or edited book). This is the PRIMARY live-refresh path: refresh the
    // shelf immediately so a newly-deployed book appears WITHOUT restarting the
    // app (the "得关掉 liveview 再打开才能看到" bug). On the native shell this also
    // re-pulls the offline manifest first, so the FRESH /api/books resolves to the
    // new deploy instead of the stale store. Fire-and-forget.
    void refreshShelf();
  }, [refreshShelf, putSpine]);

  useWebSocket({
    onContentUpdate: handleContentUpdate,
    onTreeUpdate: handleTreeUpdate,
  });

  // Name the window after what is being read: it shows in the browser tab,
  // history, and the iOS app switcher, where a raw `<slug>/<file>.md` path
  // means nothing.
  useEffect(() => {
    document.title = !currentPath
      ? "LiveView"
      : chapterLabel && chapterLabel !== bookLabel
      ? `${chapterLabel} · ${bookLabel}`
      : chapterLabel || bookLabel || "LiveView";
  }, [currentPath, chapterLabel, bookLabel]);

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
    const view = { slug: activeSlug, rendition, path: currentPath };
    if (
      !activeBook || !currentPath ||
      !engineShouldLoad(view, activeTree.length > 0, nowPlayingRef.current?.chapterPath ?? null)
    ) return;
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
    activeSlug,
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
    const step = followEngine(
      { slug: activeSlug, rendition: activeRendition?.kind, path: currentPath },
      nowPlaying,
      syncedChapterRef.current,
    );
    syncedChapterRef.current = step.synced;
    const np = step.follow;
    if (!np) return;
    if (np.rendition === "audio") {
      // Audio renders off the engine — just move the page (no body fetch).
      followAudioChapter(np.chapterPath);
    } else {
      // Text read-aloud: load the next chapter's markdown so the in-place
      // highlight carries into it (sticky read-along across chapters).
      void openFile(np.chapterPath, np.lang, "text", "engine");
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
        onNavigate={(path) => void openFile(path, lang, rendition, "pager")}
      />
    );
  }, [activeTree, uiLang, currentPath, openFile, lang, rendition]);

  // Tapping the floating bubble's artwork returns to the playing book's inline
  // audio page (re-entering at the chapter it's on).
  const openPlayingAudio = useCallback(() => {
    if (nowPlaying) openAudiobook(nowPlaying.bookSlug, nowPlaying.chapterPath, "playing");
  }, [nowPlaying, openAudiobook]);

  // Navigate to whatever is playing, in its own mode: the audiobook page for an
  // audio rendition, or the text chapter for a read-aloud. Used by the playback
  // sheet's "go to current" (shown only when you've wandered off it).
  const goToNowPlaying = useCallback(() => {
    if (!nowPlaying) return;
    if (nowPlaying.rendition === "audio") openPlayingAudio();
    else {
      void openFile(nowPlaying.chapterPath, nowPlaying.lang, nowPlaying.rendition, "playing");
    }
  }, [nowPlaying, openPlayingAudio, openFile]);

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
      {
        /* 🗣 Read this page aloud — only on a text edition (it voices the rich
          markdown in place). A dual-rendition book keeps this AND the 🎧 switch
          below, because they're two distinct features. */
      }
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
      {
        /* 🎧 Audiobook edition — text ⇄ curated audiobook (same glyph as the
          floating now-playing bubble). Only for books that offer both. Accent
          while you're on the audiobook page. */
      }
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
          /* Static material strip under the iOS status-bar / Dynamic Island. In the
            native shell (and a standalone PWA) the reader runs full-height with
            the navbar at the bottom, so content scrolls UNDER the status bar. A
            near-opaque strip keeps system chrome legible while content scrolls
            underneath (the
            reader scrollers' matching ::before inset — index.css — clears it at
            rest). `pointer-events:none` so the tap target above still works; only
            shown in bottom-navbar mode (top mode: the NavShell bar owns that
            edge); height collapses to 0 off-device, so it costs nothing there. */
        }
        {navbarAtBottom && (
          <Box
            aria-hidden
            data-lv-status-bar-material
            sx={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              height: "env(safe-area-inset-top, 0px)",
              zIndex: (t) => t.zIndex.appBar,
              pointerEvents: "none",
              // Opaque and deliberately unblurred (a 6% tint still let shelf
              // titles ghost behind the clock). A fixed backdrop-filter
              // forces WKWebView to re-rasterize every frame of the scroller
              // underneath it, even though the result is barely visible.
              // The spatial Contents rail extends behind this fixed strip. A
              // physical WKWebView may keep the old compositor raster when only
              // a CSS variable repaints this layer, even though computed styles
              // already expose the new colour. Remove the fixed layer while the
              // drawer is open so the drawer and translated reader each paint
              // their own part of the safe area. Recreate it on close to retain
              // the original near-opaque reading material while scrolling.
              bgcolor: "background.default",
              "html[data-lv-spatial-drawer-open] &": {
                display: "none",
              },
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
            /* Keep the bookshelf MOUNTED while a book is open so its inner
              scroller retains scrollTop, but remove the hidden tree from layout
              and paint entirely. opacity:0 was visually hidden yet left ~5,200
              DOM nodes, hundreds of SVGs/shadows, and their WebKit backing-store
              resources alive behind every reader page; that GPU/tile pressure
              janked both reader scrolling and any full-screen sheet composite
              on physical iOS. display:none preserves descendant scrollTop (the
              nodes are not unmounted) without retaining those rendering costs.
              On native iOS, nativeNavPop already holds the current-page snapshot
              until the shelf has painted through double-rAF, so re-enabling the
              shelf cannot flash. Desktop renders its content-visibility:auto
              cards synchronously, with off-screen cards still skipped. */
          }
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: activeSlug === null ? "flex" : "none",
              flexDirection: "column",
            }}
          >
            <Landing
              isVisible={activeSlug === null}
              books={books}
              progress={progressBySlug}
              onOpen={enterBook}
              settingsSlot={settingsButton}
              navbarAtBottom={navbarAtBottom}
              unavailableOffline={booksUnavailableOffline}
              accessory={
                <NowPlayingRow hidden={activeSlug !== null} onGoTo={goToNowPlaying} />
              }
            />
          </Box>
          {activeSlug !== null && (
            <NavShell
              appKey="liveview"
              breakpoint={1000}
              // Contents is a Cowboy-style full-height side rail on touch
              // layouts. It is navigation, not a transient bottom sheet.
              mobilePresentation="sidebar"
              navTitle={t("sidebar.contents")}
              backLabel={t("sidebar.bookshelf")}
              onBack={backToLanding}
              // Compact tier: the bar is the last row of the reader's bottom
              // dock, sharing its material with the strip and transport.
              barPosition={navbarAtBottom ? "bottom" : "top"}
              // The translated reader leaves only a narrow trailing rail while
              // Contents is open. Keep one stationary playback entry there even
              // when no player session is loaded yet; the full transport remains
              // inside the reader for the ordinary closed-drawer view.
              spatialAccessory={currentPath &&
                  (rendition === "text" || nowPlaying !== null)
                ? (
                  <SpatialPlaybackPreview
                    onStartCurrent={handleReadAloud}
                  />
                )
                : undefined}
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
                    color="text.primary"
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
                  tree={contentsTree}
                  bookSlug={activeSlug ?? undefined}
                  rendition={rendition}
                  visible={api.visible}
                  currentPath={currentPath}
                  playingPath={playingPath}
                  bookMode={bookMode}
                  langs={bookLangs}
                  currentLang={lang}
                  showHeader={!api.isMobile}
                  unavailable={chapterUnavailable}
                  onSwitchLang={switchLang}
                  onSelect={(path) => {
                    handleSelect(path);
                    api.closeMobile();
                  }}
                  createdAt={activeBook?.created_at}
                  updatedAt={activeBook?.updated_at}
                />
              )}
              actions={bookActions}
              navigationActions={settingsButton}
            >
              {chapter.untranslated && (
                <Alert severity="info" square sx={{ py: 0.25 }}>
                  {t("content.untranslated", {
                    lang: langLabel(chapter.untranslated.requested),
                    fallback: langLabel(chapter.untranslated.shown),
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
                : chapter.error
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
                      {chapter.error === "offline"
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
                    content={chapter.content}
                    fileType={chapter.fileType}
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
              {/* Join the reader's dock (it travels with the translated surface). */}
              <SyncIndicator bookSlug={activeSlug} />
              <NowPlayingRow
                hidden={onPlayingPage || readingThisInPlace}
                onGoTo={goToNowPlaying}
              />
            </NavShell>
          )}
        </Box>
      </Box>
      {
        /* Desktop keyboard-shortcut cheat-sheet (opened with `?`). The Dialog
          renders nothing while closed; on touch it never opens (the `?` handler
          is desktop-gated). */
      }
      <ShortcutsDialog open={helpOpen} onClose={closeHelp} />
      <PlaybackSheet
        onGoToNowPlaying={nowPlaying &&
            (currentPath !== nowPlaying.chapterPath ||
              rendition !== nowPlaying.rendition)
          ? goToNowPlaying
          : undefined}
      />
      {NATIVE_RELEASE_APP_ID && NATIVE_RELEASE_MANIFEST_URL && (
        <NativeReleaseUpdatePrompt
          appId={NATIVE_RELEASE_APP_ID}
          manifestUrl={remoteUrl(NATIVE_RELEASE_MANIFEST_URL)}
        />
      )}
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
