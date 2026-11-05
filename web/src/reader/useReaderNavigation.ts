import { useCallback, useEffect, useRef, useState } from "react";
import { loadContentsTree } from "@/audio/contents";
import { nativeNavPop, nativeNavPush, nativeNavReady } from "@/native-nav";
import { logEvent } from "@/apm";
import { useI18n } from "@/i18n";
import { useEdgeBackGesture } from "@/_shell/edge-back-gesture";
import { findFirstFile, hasFilePath } from "@/readerTree";
import type { BookPrefs } from "@/hooks/useBookPrefs";
import type { UseProgress } from "@/hooks/useProgress";
import type { Book, ProgressEntry, TreeNode } from "@/types";
import {
  bookSlugOf,
  getHashState,
  hashTokens,
  readResume,
  type ResumeLocation,
  writeHash,
  writeResume,
} from "./location.ts";
import {
  entryLang,
  hashEntryLang,
  hashEntryRendition,
  resolveRendition,
  resumeTextPath,
} from "./entry.ts";
import { historyMode, type NavSource } from "./history.ts";
import { returnToShelf } from "./shelfTransition.ts";
import { type ChapterContent, useChapterContent } from "./useChapterContent.ts";

export interface ReaderNavigationInput {
  books: Book[];
  bookPrefs: BookPrefs;
  saveBookPref: (slug: string, patch: { rendition?: string; lang?: string }) => void;
  recentProgress: ProgressEntry[];
  loadBook: UseProgress["loadBook"];
  loadBookRows: UseProgress["loadBookRows"];
  putSpine: (slug: string, kind: string, nodes: TreeNode[]) => void;
  /** Reads cannot reach the server (drives the offline auto-retry). */
  offline: boolean;
  /** Show a transient message. */
  notify: (message: string) => void;
}

export interface ReaderNavigation {
  /** The chapter shown, or null on the shelf. */
  currentPath: string | null;
  currentPathRef: { readonly current: string | null };
  /** The selected edition. */
  lang: string;
  /** The rendition shown (text or audio). */
  rendition: string;
  chapter: ChapterContent;
  loadFile: (path: string, lang: string, rendition: string) => Promise<void>;
  openFile: (path: string, lang: string, rendition: string, source: NavSource) => Promise<void>;
  enterBook: (slug: string, renditionKind?: string, source?: NavSource) => void;
  openAudiobook: (slug: string, chapterPath: string | undefined, source: NavSource) => void;
  backToLanding: () => void;
  handleSelect: (path: string) => void;
  handleNavigateLink: (path: string) => void;
  switchLang: (lang: string) => void;
  switchRendition: (kind: string) => void;
  /** Move the audiobook page to the chapter playback advanced to. */
  followAudioChapter: (path: string) => void;
}

/**
 * The reader's location and every way it changes: opening books and
 * chapters, edition and rendition switches, the URL hash, back/forward, the
 * cold-relaunch resume and the return to the shelf. One navigation epoch
 * orders all of them; see reader/history.ts for the history policy.
 */
export function useReaderNavigation({
  books,
  bookPrefs,
  saveBookPref,
  recentProgress,
  loadBook,
  loadBookRows,
  putSpine,
  offline,
  notify,
}: ReaderNavigationInput): ReaderNavigation {
  const { t, lang: uiLang } = useI18n();
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  // The reading location saved on this device, read ONCE at first render — before
  // the save-effect can clear it on the mount-time `currentPath === null` — so the
  // cold-relaunch resume (tryResumeLastLocation) sees it. Pure init, no re-read.
  const [initialResume] = useState<ResumeLocation | null>(() => readResume());
  // `lang` is the *selected* edition; the chapter may be shown in another one
  // when the page is untranslated (see useChapterContent).
  const [lang, setLang] = useState<string>("");
  // The browse plane's reading mode. Audio is no longer a browse view (it's the
  // floating popup), so in practice this stays "text" — it still drives which
  // rendition's spine + language list the reading chrome shows, and is threaded
  // to /api/file. The audio rendition is reached via the popup, never here.
  const [rendition, setRendition] = useState<string>("text");
  const initializedRef = useRef(false);
  // Mirror of `currentPath` for callbacks that must not re-subscribe.
  const currentPathRef = useRef<string | null>(null);
  // The navigation epoch: every open, restore and return to the shelf claims
  // it, and each async continuation checks it, so only the newest navigation
  // may change the reader.
  const fileLoadSeq = useRef(0);
  // Latest `openFile`, held in a ref so the chapter loader can re-enter it for
  // the missing-path redirect without a dependency cycle.
  const openFileRef = useRef<
    ((p: string, l: string, r: string, source: NavSource) => void) | null
  >(null);
  const redirectChapter = useCallback(
    (req: { path: string; lang: string; rendition: string }) => {
      void openFileRef.current?.(req.path, req.lang, req.rendition, "redirect");
    },
    [],
  );
  const chapter = useChapterContent(fileLoadSeq, redirectChapter);
  const {
    load: loadChapterBody,
    reset: resetChapter,
    clearUntranslated,
  } = chapter;

  const activeSlug = currentPath ? bookSlugOf(currentPath) : null;

  // Show a chapter in `reqLang`. A page missing in that edition falls back to
  // the book's default edition with an "untranslated" notice; `reqLang` stays
  // the selected edition regardless.
  const loadFile = useCallback(
    async (path: string, reqLang: string, reqRendition: string) => {
      setCurrentPath(path);
      currentPathRef.current = path;
      await loadChapterBody({ path, lang: reqLang, rendition: reqRendition });
    },
    [loadChapterBody],
  );

  // A chapter that was not downloaded opens by itself once the server answers
  // again (landing, or paying for in-flight Wi-Fi), without a Retry tap.
  useEffect(() => {
    if (chapter.error !== "offline" || offline || !currentPath) return;
    void loadFile(currentPath, lang, rendition);
  }, [chapter.error, offline, currentPath, lang, rendition, loadFile]);

  // Open a file in a given edition + rendition: sync state, URL hash, and (for
  // the text rendition) content. The audio rendition renders in the player off
  // `currentPath`, so it needs no /api/file fetch — just the path + hash.
  const openFile = useCallback(
    async (
      path: string,
      langArg: string,
      renditionArg: string,
      source: NavSource,
    ) => {
      const replace = historyMode(source, currentPathRef.current === null) === "replace";
      const slug = bookSlugOf(path);
      const book = books.find((b) => b.slug === slug);
      logEvent("open_chapter", {
        book: slug,
        chapter: path,
        lang: langArg,
        rendition: renditionArg,
      });
      // The hash is the source of truth across a reload; see hashTokens for
      // why the language is always pinned and only a default rendition is
      // omitted.
      const { lang: langForHash, rendition: renditionForHash } = hashTokens(
        langArg,
        renditionArg,
        book,
      );

      setLang(langArg);
      setRendition(renditionArg);
      writeHash(path, langForHash, renditionForHash, replace);
      if (renditionArg === "audio") {
        fileLoadSeq.current += 1;
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
  // Keep the ref pointing at the latest openFile so loadFile's 404 self-heal can
  // re-enter it (see openFileRef declaration).
  openFileRef.current = openFile;

  // Contents and in-text links reach chapters with different history
  // behaviour; see reader/history.ts.
  const handleSelect = useCallback(
    (path: string) => void openFile(path, lang, rendition, "contents"),
    [openFile, lang, rendition],
  );
  const handleNavigateLink = useCallback(
    (path: string) => void openFile(path, lang, rendition, "link"),
    [openFile, lang, rendition],
  );

  // Switch the active book to another language edition, keeping the page +
  // rendition.
  const switchLang = useCallback(
    (newLang: string) => {
      if (currentPath) {
        if (activeSlug) saveBookPref(activeSlug, { lang: newLang });
        void openFile(currentPath, newLang, rendition, "lang");
      }
    },
    [currentPath, openFile, rendition, activeSlug, saveBookPref],
  );

  // (entryChapter removed — book entry is now resolved offline-first directly in
  // enterBook from already-loaded recent progress, never via a network read.)

  // Open a book's AUDIO rendition INLINE (a normal NavShell page with the audio
  // spine in the sidebar and the read-along in the content area — not a popup).
  // Fetches the audio spine, makes it the active tree, and opens the target
  // chapter; the view→engine effect then seeds playback. Target: an explicit
  // chapter (deep link / resume from the bubble), else this rendition's resume
  // chapter, else the first. Audio chapter ids differ from text, so we never map
  // a text position across — it lands on the audio rendition's own chapter.
  const openAudiobook = useCallback(
    (slug: string, chapterPath: string | undefined, source: NavSource) => {
      const book = books.find((b) => b.slug === slug);
      const r = book?.renditions.find((x) => x.kind === "audio");
      if (!book || !r) {
        notify(t("audiobook.empty"));
        return;
      }
      void (async () => {
        try {
          const spine = await loadContentsTree(slug, "audio");
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
          const audioLang = entryLang(r, bookPrefs[slug]?.lang, uiLang);
          if (!target) {
            // Spine loaded but no playable chapter resolved — still ENTER the book
            // (text README) rather than dead-ending the tap with only a toast.
            void openFile(`${slug}/README.md`, audioLang, "text", source);
            return;
          }
          putSpine(slug, "audio", spine);
          void openFile(target, audioLang, "audio", source);
        } catch (e) {
          // Offline + the audio spine isn't cached (the "card does nothing offline"
          // bug): the audio path used to dead-end with only a toast, UNLIKE the text
          // path which always navigates. Enter the book in TEXT at its README so the
          // tap is never dead — the user gets into the book and can read offline;
          // reconnecting (prefetchTrees warms both spines) restores audio.
          console.error("Failed to open audiobook:", e);
          void openFile(
            `${slug}/README.md`,
            entryLang(r, bookPrefs[slug]?.lang, uiLang),
            "text",
            source,
          );
        }
      })();
    },
    [books, bookPrefs, loadBookRows, uiLang, openFile, putSpine, t],
  );

  // Enter a book from the landing page in a specific rendition (the bookshelf
  // shows a separate card per rendition, so it passes the kind to open). Falls
  // back to the book's default rendition. Resumes the last-read chapter if there
  // is one (and it still exists), else its README, else its first doc.
  const enterBook = useCallback(
    (slug: string, renditionKind?: string, source: NavSource = "shelf") => {
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
      const r = resolveRendition(book, renditionKind, pref?.rendition);
      if (!r) return;
      const initialLang = entryLang(r, pref?.lang, uiLang);
      // Audio opens its inline read-along page (sidebar = audio spine).
      if (r.kind === "audio") {
        openAudiobook(slug, undefined, source);
        return;
      }
      // OFFLINE-FIRST: NAVIGATE IMMEDIATELY — NEVER await the network before showing
      // the reader. The old flow awaited the spine + a network-first progress read
      // (entryChapter → /api/progress) BEFORE navigating, so a card tap froze with no
      // navigation whenever a read hung (offline / unreachable). A tap into a book
      // must only set the route + render cache-first; nothing on this path may block
      // on the network. Best-guess the entry chapter SYNCHRONOUSLY from already-loaded
      // recent progress (the resume), else the book's README. openFile sets
      // currentPath first, then loadFile renders it cache-first (or a calm offline
      // placeholder) — zero network on the critical path.
      const resume = resumeTextPath(recentProgress, slug);
      void openFile(
        resume ?? `${slug}/README.md`,
        initialLang,
        r.kind,
        source,
      );
      // Load this rendition's contents in the background, cache-first; it
      // never gates navigation.
      void loadContentsTree(slug, r.kind)
        .then((spine) => putSpine(slug, r.kind, spine))
        .catch(() => {
          // Offline and uncached: the reader still works from the entry above.
        });
    },
    [books, bookPrefs, openFile, uiLang, openAudiobook, recentProgress, putSpine],
  );

  // Return to the landing bookshelf.
  // On the native shell the held shelf snapshot covers the shelf's
  // re-composite; see reader/shelfTransition.ts for the ordering.
  const backToLanding = useCallback(() => {
    returnToShelf(
      { push: nativeNavPush, pop: nativeNavPop, ready: nativeNavReady, frame: requestAnimationFrame },
      () => {
        writeHash(null, null, null, false);
        fileLoadSeq.current += 1;
        setCurrentPath(null);
        currentPathRef.current = null;
        resetChapter();
      },
    );
  }, [resetChapter]);

  // Edge swipe back to the shelf while reading (standalone PWA and native
  // shell have no browser back gesture).
  useEdgeBackGesture(currentPath !== null, backToLanding);

  // Resolve which (rendition, lang) a hash deep-link should open: explicit
  // `&rendition=`/`&lang=` win; else the book's default rendition and that
  // rendition's preferred initial edition.
  const bookOf = useCallback(
    (path: string): Book | undefined =>
      books.find((b) => b.slug === bookSlugOf(path)),
    [books],
  );
  const renditionForHashEntry = useCallback(
    (path: string, hashRendition: string | null): string =>
      hashEntryRendition(bookOf(path), hashRendition),
    [bookOf],
  );
  const langForHashEntry = useCallback(
    (path: string, kind: string, hashLang: string | null): string =>
      hashEntryLang(bookOf(path), kind, hashLang, uiLang),
    [bookOf, uiLang],
  );

  // Restore the view (path, lang, rendition) encoded in the hash. Fetches the
  // matching rendition's spine, sets state, and loads the chapter (audio
  // chapters route to the player off `currentPath`). Shared by initial load and
  // browser back/forward.
  const restoreFromHash = useCallback(
    async (replaceHash: boolean): Promise<void> => {
      const { path, lang: hashLang, rendition: hashRendition } = getHashState();
      // Claim the navigation token. Any later navigation (another back/forward,
      // opening a chapter, returning to the shelf) bumps it; this restore then
      // stops after its awaits instead of applying a stale tree or chapter over
      // the newer view.
      const seq = ++fileLoadSeq.current;
      if (!path) {
        // empty hash → the landing bookshelf
        setCurrentPath(null);
        currentPathRef.current = null;
        resetChapter();
        return;
      }
      const kind = renditionForHashEntry(path, hashRendition);
      const restoredLang = langForHashEntry(path, kind, hashLang);
      setLang(restoredLang);
      setRendition(kind);
      if (replaceHash) {
        // Normalise the hash without a history entry (see hashTokens).
        const tokens = hashTokens(restoredLang, kind, bookOf(path));
        writeHash(path, tokens.lang, tokens.rendition, true);
      }
      try {
        // Cache-first (offline-safe), same as enterBook — never a raw network
        // fetch that fails offline / skips the cache.
        putSpine(bookSlugOf(path), kind, await loadContentsTree(bookSlugOf(path), kind));
      } catch (e) {
        console.error("Failed to fetch rendition tree:", e);
      }
      if (seq !== fileLoadSeq.current) return;
      // Load the book's progress first so the doc restores its scroll.
      const slug = bookSlugOf(path);
      if (slug) await loadBook(slug);
      if (seq !== fileLoadSeq.current) return;
      if (kind === "audio") {
        // Audio renders off the engine (seeded by the view→engine effect).
        setCurrentPath(path);
        currentPathRef.current = path;
      } else {
        void loadFile(path, restoredLang, kind);
      }
    },
    [bookOf, loadFile, langForHashEntry, renditionForHashEntry, loadBook, putSpine],
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
    const slug = bookSlugOf(saved.path);
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

  // Restore any deep link from the hash once the catalog is known. Waits for
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
      await tryResumeLastLocation();
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

  // Switch the active book between its text and audio renditions, in place.
  // Persisted per book so re-opening it from the shelf lands in the same mode.
  const switchRendition = useCallback(
    (kind: string) => {
      if (!activeSlug || kind === rendition) return;
      saveBookPref(activeSlug, { rendition: kind });
      if (kind === "audio") openAudiobook(activeSlug, undefined, "rendition");
      else enterBook(activeSlug, kind, "rendition");
    },
    [activeSlug, rendition, openAudiobook, enterBook, saveBookPref],
  );


  const followAudioChapter = useCallback((path: string) => {
    setCurrentPath(path);
    currentPathRef.current = path;
    clearUntranslated();
    const tokens = hashTokens(lang, rendition, bookOf(path));
    writeHash(path, tokens.lang, tokens.rendition, true);
  }, [lang, rendition, bookOf, clearUntranslated]);

  return {
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
  };
}
