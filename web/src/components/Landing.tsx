import { rem } from "@/px";
import {
  Badge,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { type Theme, useTheme } from "@mui/material/styles";
import {
  ArrowBack as BackIcon,
  ChevronRight as NextIcon,
  FolderOutlined as FolderIcon,
  Search as SearchIcon,
  Tune as TuneIcon,
  DriveFileMove as OrganizeIcon,
} from "@mui/icons-material";
import { flushSync } from "react-dom";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Book, BookProgress } from "@/types";
import { useShelfSort } from "@/hooks";
import { useI18n } from "@/i18n";
import { localeDescriptor } from "@/locales/registry";
import { useSyncStatus } from "@/syncStore";
import {
  buildLibraryTaxonomy,
  countTagFacetMatches,
  type ReadingFilter,
  tagLabel,
} from "@/libraryDiscovery";
import {
  type BookSearchMatch,
  buildBookSearchIndex,
  buildDirectorySearchIndex,
  compareSearchMatches,
  hasSearchTerms,
  matchBookSearch,
  parseSearchQuery,
  settleApproximateMatches,
} from "@/librarySearch";
import { resumableLibraryBooks } from "@/libraryHome";
import { libraryDirectories } from "@/libraryDirectories";
import {
  directoryAncestors,
  directoryTree,
  useUserLibrary,
} from "@/userLibrary";
import { LibraryOrganizer } from "./LibraryOrganizer";
import {
  activeFilterCount as countFilters,
  type Discovery,
  discoveryActive as isDiscovering,
  type FilterKind,
  matchesKind,
  narrowShelf,
  openedAt,
  sortShelf,
  toolbarBack,
} from "@/library/discovery";
import { LocationButton, LocationSheet } from "@/library/LocationSheet";
import { SearchField } from "@/library/SearchField";
import { FILTER_KIND_LABEL, SortFilterSheet } from "@/library/SortFilterSheet";
import { BrandMark } from "./BrandMark";
import { ScrollToTopButton } from "./ScrollToTopButton";
import { SyncIndicator } from "./SyncIndicator";
import { BottomDock } from "@/_shell/bottom-dock.tsx";
import { Highlighted } from "./SearchHighlight";
import { ShelfCard, shelfEntries, type ShelfEntry } from "./ShelfCard";

interface LandingProps {
  books: Book[];
  /** Per-book "continue reading" state, keyed by slug; absent ⇒ never opened.
   *  Split by rendition so a text+audio book shows both reading and listening
   *  progress on its card. */
  progress: Record<string, BookProgress>;
  /** Open a book. With no renditionKind it opens in the last-used / default
   *  rendition (a plain card tap); an explicit kind (the cover format switch on
   *  a dual-format book) opens straight into that rendition. */
  onOpen: (slug: string, renditionKind?: string) => void;
  /** The shared SettingsSheet (gear + responsive sheet), placed in the bar. */
  settingsSlot: ReactNode;
  /** On the mobile tier with the "bottom" navbar preference, the bookshelf bar
   *  drops below the shelf (mobile-browser style), matching the in-book bar. */
  navbarAtBottom: boolean;
  isVisible: boolean;
  /** A row for the shelf's bottom dock (what is playing). */
  accessory?: ReactNode;
  /** Offline: books with nothing downloaded, dimmed so readable ones stand
   *  out. Absent online. */
  unavailableOffline?: ReadonlySet<string> | undefined;
}


/** A directory browser with global search and a retained reading position. */
export function Landing({
  books,
  progress,
  onOpen,
  settingsSlot,
  navbarAtBottom,
  isVisible,
  unavailableOffline,
  accessory,
}: LandingProps): React.JSX.Element {
  const { t, lang } = useI18n();
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const locale = localeDescriptor(lang).htmlLang;
  const sort = useShelfSort();
  // Books whose audiobook audio is still generating — drives the card micro-badge.
  const syncStatus = useSyncStatus();
  const generatingSlugs = useMemo(
    () =>
      new Set(syncStatus.books.filter((b) => b.pending > 0).map((b) => b.slug)),
    [syncStatus],
  );
  const splitView = useMediaQuery("(min-width: 700px)");
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(
    null,
  );
  const {
    library,
    error: libraryError,
    busy: libraryBusy,
    change: changeLibrary,
    undo: undoLibrary,
  } = useUserLibrary();
  const [continueLimit, setContinueLimit] = useState(4);
  const directoryOf = (book: Book): string | null =>
    library
      ? library.placements[book.slug] ?? null
      : book.collection?.trim() || null;
  const [pageLimits, setPageLimits] = useState<Record<string, number>>({});
  const [directoryLimit, setDirectoryLimit] = useState(40);
  const savedScroll = useRef(new Map<string, number>());
  const [typedQuery, setQuery] = useState("");
  // Results follow the typed text at low priority, so a large catalog never
  // makes keystrokes or IME composition wait on matching and rendering.
  const query = useDeferredValue(typedQuery);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchEditing = isPhone && searchFocused;
  // Keep the native input uncontrolled. iOS WebKit owns marked text while a
  // Chinese/Japanese/Korean IME is composing; feeding every provisional value
  // back through React's `value` prop replaces that marked range and leaves the
  // keyboard showing candidates while the field itself appears frozen.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dismissSearchKeyboard = (): void => {
    searchInputRef.current?.blur();
  };
  // Inside a folder on a phone the search field collapses to an icon so the
  // location stays in the row; tapping it opens the field.
  const [searchOpen, setSearchOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  // Single-choice kind filter ("all" = no narrowing). Audio-only books fall under
  // "book" — they share the card, so they're never a separate filter.
  const [kind, setKind] = useState<FilterKind>("all");
  const [readingFilter, setReadingFilter] = useState<ReadingFilter>("all");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() =>
    new Set()
  );
  // The combined Sort & Filter sheet (one toolbar control for both the shelf order
  // and the kind narrowing — the two list-organizing concerns in one place).
  const [sfOpen, setSfOpen] = useState(false);
  // One card per book (audio rides along as a badge on text+audio books),
  // ordered by the Settings → Library → Sort preference. Default "updated":
  // most-recent content change first (the last sync that added/removed/edited
  // it, falling back to first appearance) — a content-recency shelf.
  const entries = useMemo(
    () => sortShelf(shelfEntries(books), sort, progress, locale),
    [books, sort, progress, locale],
  );
  const libraryTaxonomy = useMemo(
    () => buildLibraryTaxonomy(books),
    [books],
  );
  const tagById = useMemo(
    () => new Map(libraryTaxonomy.tags.map((tag) => [tag.id, tag])),
    [libraryTaxonomy],
  );
  const directories = useMemo(
    () =>
      library
        ? directoryTree(library, locale).map((dir) => ({
          ...dir,
          books: books.filter((book) =>
            library.placements[book.slug] === dir.id
          ),
        }))
        : libraryDirectories(books, locale).map((dir) => ({
          ...dir,
          id: dir.name,
          parent: null,
          depth: 0,
          path: dir.name,
        })),
    [books, locale, library],
  );
  const directoryById = useMemo(
    () => new Map(directories.map((dir) => [dir.id, dir])),
    [directories],
  );
  // Fold every searchable field once per catalog or folder change. A book is
  // also searchable by the path of the user folder it is filed in.
  const searchIndexes = useMemo(
    () =>
      new Map(books.map((book) => [
        book.slug,
        buildBookSearchIndex(
          book,
          library
            ? directoryById.get(library.placements[book.slug] ?? "")?.path
            : undefined,
        ),
      ])),
    [books, library, directoryById],
  );
  const searchQuery = useMemo(() => parseSearchQuery(query), [query]);
  // Match each book exactly once per query. The result is shared by the visible
  // shelf, its highlights, and the facet preview counts below.
  const searchMatches = useMemo(() => {
    const matches = new Map<string, BookSearchMatch | null>();
    for (const book of books) {
      matches.set(
        book.slug,
        matchBookSearch(searchIndexes.get(book.slug)!, searchQuery),
      );
    }
    settleApproximateMatches(matches);
    return matches;
  }, [books, searchQuery, searchIndexes]);
  // A refreshed catalog can remove its last use of a tag. Drop that stale
  // selection instead of leaving the shelf trapped in an impossible filter.
  useEffect(() => {
    setSelectedTags((current) => {
      if ([...current].every((id) => tagById.has(id))) return current;
      return new Set([...current].filter((id) => tagById.has(id)));
    });
  }, [tagById]);


  // Per-kind totals over the WHOLE shelf (not the search result) — used to decide
  // whether the kind segments are even worth showing (a shelf that's all books
  // needs no Books/Docs split).
  const counts = useMemo(() => {
    const c = { book: 0, docs: 0 };
    for (const e of entries) {
      if (matchesKind(e, "docs")) c.docs += 1;
      else c.book += 1;
    }
    return c;
  }, [entries]);

  const discovery = useMemo<Discovery>(
    () => ({ query, kind, reading: readingFilter, tags: selectedTags }),
    [query, kind, readingFilter, selectedTags],
  );
  const narrowContext = useMemo(
    () => ({ directory: selectedDirectory, directoryOf, progress, matches: searchMatches }),
    // directoryOf reads `library`, which `directories` already tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedDirectory, library, progress, searchMatches],
  );
  // The shelf after every narrowing control. Relevance leads while searching,
  // then what was opened most recently; remaining ties keep the shelf's own
  // (stable) sort order.
  const visible = useMemo(() => {
    const ranked = narrowShelf(entries, discovery, narrowContext);
    if (query.trim()) {
      ranked.sort((a, b) =>
        compareSearchMatches(a.match, b.match) ||
        openedAt(progress[b.entry.book.slug]) - openedAt(progress[a.entry.book.slug])
      );
    }
    return ranked.map(({ entry }) => entry);
  }, [entries, discovery, narrowContext, query, progress]);

  // Tell the reader when a typo-tolerant match is among the results.
  const hasCloseMatches = visible.some((entry) =>
    searchMatches.get(entry.book.slug)?.approximate
  );
  const discoveryActive = isDiscovering(discovery);
  const activeFilterCount = countFilters(discovery);
  const discoverySignature = `${query}\0${kind}\0${readingFilter}\0${
    [...selectedTags].sort().join(",")
  }`;

  const toggleTag = (id: string): void => {
    setSelectedTags((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearDiscoveryFilters = (): void => {
    setSelectedTags(new Set());
    setKind("all");
    setReadingFilter("all");
  };

  // Disjunctive facet counts preview adding each candidate. Existing choices
  // in the same facet remain because facet values are ORed; other facets stay
  // as AND constraints.
  const tagCountBooks = useMemo(
    () => narrowShelf(entries, discovery, narrowContext, false).map(({ entry }) => entry.book),
    [entries, discovery, narrowContext],
  );
  const tagCounts = useMemo(
    () =>
      countTagFacetMatches(
        tagCountBooks,
        libraryTaxonomy.tags,
        selectedTags,
      ),
    [tagCountBooks, libraryTaxonomy.tags, selectedTags],
  );

  // The kind segments only make sense when the shelf has BOTH books and docs;
  // otherwise All/Books/Docs would narrow to the same set.
  const showKindFilter = counts.book > 0 && counts.docs > 0;

  // The shelf scroll container — ref'd for the back-to-top button + the
  // app-level status-bar tap (both scroll it to the top).
  const scrollerRef = useRef<HTMLDivElement>(null);

  const childDirectories = directories.filter((dir) =>
    dir.parent === selectedDirectory
  );
  // Folders found by the same query grammar, best match first.
  const directoryMatches = useMemo(() => {
    if (!hasSearchTerms(searchQuery) || activeFilterCount > 0) return [];
    const found: Array<{
      dir: (typeof directories)[number];
      match: BookSearchMatch;
    }> = [];
    for (const dir of directories) {
      const match = matchBookSearch(
        buildDirectorySearchIndex(dir.path),
        searchQuery,
      );
      if (match) found.push({ dir, match });
    }
    return found.sort((a, b) => compareSearchMatches(a.match, b.match));
  }, [directories, searchQuery, activeFilterCount]);
  const displayedDirectories = discoveryActive
    ? directoryMatches.map(({ dir }) => dir)
    : childDirectories;
  const directoryHighlights = useMemo(
    () =>
      new Map(directoryMatches.map(({ dir, match }) => [
        dir.id,
        match.highlights.directory,
      ])),
    [directoryMatches],
  );
  const currentDirectory = directories.find((dir) =>
    dir.id === selectedDirectory
  );
  const atRoot = selectedDirectory === null && !discoveryActive;
  const continueBooks = useMemo(
    () =>
      resumableLibraryBooks(
        books,
        progress,
        continueLimit,
      ),
    [books, progress, continueLimit],
  );
  const continueCount = useMemo(
    () => resumableLibraryBooks(books, progress, books.length).length,
    [books, progress],
  );
  const rootEntries = useMemo(
    () => entries.filter((entry) => directoryOf(entry.book) === null),
    [entries, library],
  );
  const listEntries = atRoot ? rootEntries : visible;
  const positionKey = `${selectedDirectory ?? ""}\0${discoverySignature}`;
  const visibleLimit = pageLimits[positionKey] ?? 40;
  // Mount only a bounded batch per frame, including the cold first render.
  // Restore deep saved positions after all retained rows exist.
  const paintedRows = useRef({ key: "", limit: 8 });
  const [, advancePaint] = useState(0);
  if (paintedRows.current.key !== positionKey) {
    paintedRows.current = { key: positionKey, limit: 8 };
  }
  const desiredRows = Math.min(listEntries.length, visibleLimit);
  const rowBudget = Math.min(paintedRows.current.limit, desiredRows);
  useEffect(() => {
    if (rowBudget >= desiredRows) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (paintedRows.current.key !== positionKey) return;
        paintedRows.current.limit = Math.min(rowBudget + 8, desiredRows);
        advancePaint((version) => version + 1);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [positionKey, rowBudget, desiredRows]);
  const pendingScroll = useRef<{ key: string; top: number } | null>(null);
  const previousPosition = useRef(positionKey);
  useLayoutEffect(() => {
    if (previousPosition.current !== positionKey) {
      previousPosition.current = positionKey;
      pendingScroll.current = {
        key: positionKey,
        top: savedScroll.current.get(positionKey) ?? 0,
      };
      scrollerRef.current?.scrollTo({ top: pendingScroll.current.top });
    }
    if (
      pendingScroll.current?.key === positionKey && rowBudget >= desiredRows
    ) {
      scrollerRef.current?.scrollTo({ top: pendingScroll.current.top });
      pendingScroll.current = null;
    }
  }, [positionKey, rowBudget, desiredRows]);
  // Catalog refreshes can remove a folder. Return to the root instead of
  // leaving an empty, inaccessible location selected.
  useEffect(() => {
    if (
      (library !== null || books.length > 0) && selectedDirectory !== null &&
      !directories.some((dir) => dir.id === selectedDirectory)
    ) {
      setSelectedDirectory(null);
    }
  }, [books.length, directories, selectedDirectory, library]);
  const searchShown = !isPhone || selectedDirectory === null || searchOpen ||
    typedQuery.trim().length > 0;
  const openSearch = (): void => {
    // Focus inside the tap: iOS opens the keyboard only for a focus that
    // happens during the user gesture, so commit the field synchronously.
    flushSync(() => setSearchOpen(true));
    searchInputRef.current?.focus();
  };
  const navigate = (directory: string | null): void => {
    setSearchOpen(false);
    dismissSearchKeyboard();
    if (searchInputRef.current) searchInputRef.current.value = "";
    setQuery("");
    clearDiscoveryFilters();
    setSelectedDirectory(directory);
  };
  const goBack = (): void => {
    const back = toolbarBack(discovery, selectedDirectory, currentDirectory?.parent ?? null);
    if (back) navigate(back.to);
  };
  const directoryNavigation = (
    <Box
      component="nav"
      aria-label={t("landing.navigation")}
      sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}
    >
      <Button
        data-lv-root
        onClick={() => navigate(null)}
        startIcon={<FolderIcon />}
        aria-current={selectedDirectory === null ? "page" : undefined}
        sx={{
          justifyContent: "flex-start",
          minHeight: 44,
          mb: 1,
          color: "text.primary",
          bgcolor: selectedDirectory === null
            ? "action.selected"
            : "transparent",
        }}
      >
        {t("landing.directories")}
      </Button>
      {directories.slice(0, directoryLimit).map((directory) => (
        <Button
          key={directory.id}
          disableRipple
          data-lv-directory-nav={directory.name}
          onClick={() => navigate(directory.id)}
          aria-current={selectedDirectory === directory.id ? "page" : undefined}
          sx={{
            justifyContent: "flex-start",
            gap: 1,
            minHeight: 44,
            px: 1.5,
            pl: 1.5 + Math.min(directory.depth, 6) * 1.5,
            textTransform: "none",
            textAlign: "left",
            color: selectedDirectory === directory.id
              ? "primary.main"
              : "text.secondary",
            bgcolor: selectedDirectory === directory.id
              ? "action.selected"
              : "transparent",
          }}
        >
          <FolderIcon sx={{ fontSize: rem(19), flexShrink: 0 }} />
          <Typography
            variant="body2"
            sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}
          >
            {directory.name}
          </Typography>
          <Typography variant="caption">{directory.books.length}</Typography>
        </Button>
      ))}
      {directories.length > directoryLimit && (
        <Button onClick={() => setDirectoryLimit((n) => n + 40)}>
          {t("landing.loadMore", { n: directories.length - directoryLimit })}
        </Button>
      )}
      <Button
        data-lv-organize
        startIcon={<OrganizeIcon />}
        onClick={() => setOrganizeOpen(true)}
        sx={{ justifyContent: "flex-start", minHeight: 44, mt: 1, color: "text.secondary" }}
      >
        {t("landing.organize")}
      </Button>
    </Box>
  );

  // Top tier only: the toolbar overlays the shelf's head, so publish its
  // height for the scroller's top padding. The bottom tier's toolbar is the
  // dock's bar and is covered by `--lv-dock-h`.
  const shelfRegionRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const toolbarEl = toolbarRef.current;
    const regionEl = shelfRegionRef.current;
    if (!toolbarEl || !regionEl) return;
    const publish = (): void => {
      const h = `${toolbarEl.offsetHeight}px`;
      regionEl.style.setProperty("--lv-toolbar-h", h);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(toolbarEl);
    return () => {
      ro.disconnect();
      regionEl.style.removeProperty("--lv-toolbar-h");
    };
  }, []);

  // Lift the bottom toolbar above the on-screen keyboard. The toolbar is an
  // ABSOLUTE overlay pinned to the shelf bottom, so focusing the search input
  // would otherwise leave the iOS keyboard covering it (input hidden while
  // typing). Publish the keyboard's bottom overlap as `--lv-kb-inset` from the
  // VisualViewport and offset the toolbar by it. Self-correcting vs the viewport
  // `interactive-widget=resizes-content`: where the layout viewport already
  // shrinks, innerHeight === visualViewport.height → 0, so no double-shift.
  const keyboardSeenRef = useRef(false);
  useEffect(() => {
    const vv = globalThis.visualViewport;
    const regionEl = shelfRegionRef.current;
    if (!vv || !regionEl) return undefined;
    const apply = (): void => {
      // ONLY lift for a real on-screen keyboard — i.e. a focused text field.
      // Without this gate, a transient VisualViewport offset (the back-to-shelf
      // snapshot transition momentarily shifts the viewport) was read as a huge
      // "keyboard" inset and stuck with no event to reset it, floating the toolbar
      // mid-screen on return. No focus ⇒ no keyboard ⇒ inset 0 (toolbar at edge).
      const ae = document.activeElement;
      const editing = ae instanceof HTMLElement &&
        (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" ||
          ae.isContentEditable);
      const inset = editing
        ? Math.max(0, globalThis.innerHeight - vv.height - vv.offsetTop)
        : 0;
      regionEl.style.setProperty("--lv-kb-inset", `${inset}px`);
      // iOS can retract the keyboard without blurring the field (keyboard
      // dismissal while backgrounded, an external keyboard connecting, a
      // system sheet). The search would then stay in its focus-owned editing
      // mode — Sort/Filter hidden, a dead keyboard-dismiss button — with no
      // keyboard to type into. Leave that mode once a keyboard we saw open is
      // gone. Height alone measures the keyboard; offsetTop also moves when
      // WebKit pans the field into view. Where the layout viewport resizes
      // with the keyboard this never reads as open, so it never blurs.
      const keyboardOpen = editing && globalThis.innerHeight - vv.height > 120;
      if (keyboardOpen) {
        keyboardSeenRef.current = true;
      } else if (keyboardSeenRef.current) {
        keyboardSeenRef.current = false;
        if (ae === searchInputRef.current) searchInputRef.current?.blur();
      }
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    // Reset the instant the search field blurs (e.g. before navigating away), so
    // we never leave a stale lift behind for the return.
    document.addEventListener("focusout", apply);
    // Returning from the background may not resize the viewport again.
    document.addEventListener("visibilitychange", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.removeEventListener("focusout", apply);
    };
  }, []);

  // One shelf card for a single entry. Thin wrapper that builds props for the
  // module-level memoized <ShelfCard> — so the flat shelf and each grouped
  // section render the identical card, and when only one book's progress
  // changes (returning from a book) only that one card re-renders.
  const renderCard = (e: ShelfEntry, resumeOnly = false): React.JSX.Element => (
    <ShelfCard
      key={e.book.slug}
      book={e.book}
      category={e.category}
      hasText={e.hasText}
      hasAudio={e.hasAudio}
      progress={progress[e.book.slug]}
      generating={generatingSlugs.has(e.book.slug)}
      resumeOnly={resumeOnly}
      directoryLabel={library
        ? directoryById.get(library.placements[e.book.slug] ?? "")?.path ?? ""
        : undefined}
      match={resumeOnly || !query.trim()
        ? undefined
        : searchMatches.get(e.book.slug) ?? undefined}
      onOpen={onOpen}
      unavailableOffline={unavailableOffline?.has(e.book.slug) ?? false}
      t={t}
    />
  );

  // Text rows keep directory browsing and search inexpensive while scrolling.
  const renderGrid = (items: ShelfEntry[]): React.JSX.Element => (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: {
          xs: "minmax(0, 1fr)",
          lg: "repeat(2, minmax(0, 1fr))",
          xl: "repeat(3, minmax(0, 1fr))",
        },
        gap: 1,
        alignItems: "stretch",
      }}
    >
      {items.map((entry) => renderCard(entry))}
    </Box>
  );

  const toolbar = (
    <Box
      ref={toolbarRef}
      sx={{
        // Bottom tier: the shelf dock's bar (the dock places and lifts it).
        // Top tier: an overlay across the shelf's head.
        ...(navbarAtBottom
          ? { position: "relative" }
          : { position: "absolute", left: splitView ? 220 : 0, right: 0, top: 0, zIndex: 6 }),
        borderColor: "divider",
        // Near-opaque, unified with every other chrome bar: cards scrolling
        // under this toolbar must NOT bleed through and clash with the search
        // field + controls. NO backdrop-filter: a blur here re-rasterizes the
        // cards scrolling under it every frame for a result that's invisible at
        // this opacity = scroll jank for nothing. The opaque tint alone hides
        // them.
        bgcolor: "background.default",
        ...(navbarAtBottom
          ? {
            // A hard, edge-to-edge 1px rule looks like a stray line when the
            // shelf has scrolled and there's empty page-bg above the bar.
            // Use a hairline that fades to transparent at both ends so the
            // seam reads as intentional, not a harsh divider.
            "&::before": {
              content: '""',
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: "1px",
              background: (t: Theme) =>
                `linear-gradient(to right, transparent, ${t.palette.divider} 18%, ${t.palette.divider} 82%, transparent)`,
            },
            // The home-indicator inset is generous; trim it down (floor 10px)
            // to lift the bar off the very bottom without leaving a dead gap.
            pt: 0.75,
            pb: "max(env(safe-area-inset-bottom, 0px), 10px)",
          }
          : {
            borderBottom: 1,
            pt: "calc(env(safe-area-inset-top, 0px) + 8px)",
          }),
        // Focused phone search is the sole toolbar control, so let it use the
        // whole safe horizontal span. The compact row keeps a little more air
        // around its three separate controls.
        pl: {
          xs: searchEditing
            ? "max(env(safe-area-inset-left, 0px), 8px)"
            : 1.5,
          sm: 2.5,
          md: 3,
        },
        pr: {
          xs: searchEditing
            ? "max(env(safe-area-inset-right, 0px), 8px)"
            : 1.5,
          sm: 2.5,
          md: 3,
        },
      }}
    >
      <Box
        data-lv-search-editing={searchEditing ? "true" : "false"}
        sx={{
          width: "100%",
          mx: "auto",
          display: "flex",
          alignItems: "center",
          gap: { xs: 0.75, sm: 1 },
          minHeight: 44,
          // Always one row: search, location and actions share it, and phone
          // search editing takes the whole row instead of wrapping.
          flexWrap: "nowrap",
        }}
      >
        {!searchEditing && (selectedDirectory !== null || discoveryActive) && (
          <IconButton
            data-lv-directory-back
            aria-label={t("landing.backToDirectory")}
            onClick={goBack}
            sx={{ width: 44, height: 44, flexShrink: 0 }}
          >
            <BackIcon />
          </IconButton>
        )}
        {!searchEditing && (selectedDirectory === null || !(isPhone && searchShown)) && (
          <LocationButton
            name={selectedDirectory === null ? null : currentDirectory?.name ?? ""}
            onOpen={() => setLocationOpen(true)}
          />
        )}
        {books.length === 0 && <Box sx={{ flexGrow: 1 }} />}
        {books.length > 0 && searchShown && (
          <SearchField
            inputRef={searchInputRef}
            query={query}
            editing={searchEditing}
            onQuery={setQuery}
            onFocusChange={(focused) => {
              setSearchFocused(focused);
              if (!focused && !searchInputRef.current?.value.trim()) setSearchOpen(false);
            }}
            onEscape={() => navigate(selectedDirectory)}
            onDismiss={dismissSearchKeyboard}
          />
        )}
        {/* Search finds content; these explicit actions change the view or library. */}
        {!searchEditing && (
          <Box
            data-lv-shelf-actions
            sx={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: { xs: 0.25, sm: 1 },
            }}
          >
            {books.length > 0 && !searchShown && (
              <IconButton
                data-lv-search-open
                aria-label={t("landing.searchLibrary")}
                onClick={openSearch}
                sx={{ width: 44, height: 44 }}
              >
                <SearchIcon />
              </IconButton>
            )}
            {books.length > 0 && (
              <Badge
                color="primary"
                badgeContent={activeFilterCount}
                invisible={activeFilterCount === 0}
                overlap={isPhone ? "circular" : "rectangular"}
              >
                {isPhone
                  ? (
                    <IconButton
                      onClick={() => setSfOpen(true)}
                      aria-label={t("landing.sortFilter")}
                      sx={{
                        width: 44,
                        height: 44,
                        color: activeFilterCount > 0 ? "primary.main" : "text.secondary",
                      }}
                    >
                      <TuneIcon />
                    </IconButton>
                  )
                  : (
                    <Button
                      size="small"
                      startIcon={<TuneIcon fontSize="small" />}
                      onClick={() => setSfOpen(true)}
                      aria-label={t("landing.sortFilter")}
                      sx={{
                        minHeight: 44,
                        px: 1.25,
                        textTransform: "none",
                        color: activeFilterCount > 0 ? "primary.main" : "text.secondary",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("landing.sortFilterAction")}
                    </Button>
                  )}
              </Badge>
            )}
            {settingsSlot}
          </Box>
        )}
      </Box>
    </Box>
  );

  return (
    <Box
      data-lv-library="true"
      ref={shelfRegionRef}
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        // Positioning context for the toolbar / dock and the host of their
        // published heights.
        position: "relative",
      }}
    >
      <ShelfDock
        docked={navbarAtBottom}
        toolbar={toolbar}
        left={splitView ? 220 : 0}
      >
      {splitView && (
        <Box
          component="aside"
          sx={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: 220,
            p: 1.5,
            pt: "calc(env(safe-area-inset-top, 0px) + 20px)",
            borderRight: 1,
            borderColor: "divider",
            bgcolor: "background.paper",
            overflowY: "auto",
          }}
        >
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ mb: 3, px: 1 }}
          >
            <BrandMark width={28} height={28} />
            <Typography fontWeight={750}>LiveView</Typography>
          </Stack>
          {directoryNavigation}
        </Box>
      )}
      {!navbarAtBottom && toolbar}

      <LocationSheet
        open={locationOpen}
        onClose={() => setLocationOpen(false)}
        ancestors={selectedDirectory === null
          ? []
          : library
          ? directoryAncestors(library, selectedDirectory)
          : currentDirectory
          ? [{ id: selectedDirectory, name: currentDirectory.name }]
          : []}
        navigate={navigate}
        onOrganize={() => setOrganizeOpen(true)}
      />
      <LibraryOrganizer
        open={organizeOpen}
        onClose={() => setOrganizeOpen(false)}
        library={library}
        libraryError={libraryError}
        libraryBusy={libraryBusy}
        changeLibrary={changeLibrary}
        undoLibrary={undoLibrary}
        selectedDirectory={selectedDirectory}
        currentDirectory={currentDirectory}
        directories={directories}
        listEntries={listEntries}
      />
      <SortFilterSheet
        open={sfOpen}
        onClose={() => setSfOpen(false)}
        taxonomy={libraryTaxonomy}
        selectedTags={selectedTags}
        tagById={tagById}
        tagCounts={tagCounts}
        onToggleTag={toggleTag}
        reading={readingFilter}
        onReading={setReadingFilter}
        sort={sort}
        kind={kind}
        onKind={setKind}
        showKindFilter={showKindFilter}
        activeFilterCount={activeFilterCount}
        onClear={clearDiscoveryFilters}
        resultCount={visible.length}
      />

      {
        /* ── Shelf (the scroll area) ──────────────────────────────────────────
          Wrapped in a relative box so the back-to-top button can sit absolute
          above a bottom nav bar (which is a sibling of this area, not inside).
          The scroller is tagged + ref'd so the title tap scrolls it to top.
          When the navbar is at the bottom, this area reaches the top of the
          screen, so it must clear the notch itself. */
      }
      <Box
        sx={{
          ml: splitView ? "220px" : 0,
          order: navbarAtBottom ? 1 : 0,
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box
          ref={scrollerRef}
          data-lv-scroller="shelf"
          onTouchStart={() => {
            pendingScroll.current = null;
          }}
          onWheel={() => {
            pendingScroll.current = null;
          }}
          onScroll={(event) => {
            if (pendingScroll.current?.key === positionKey) return;
            savedScroll.current.set(positionKey, event.currentTarget.scrollTop);
            if (savedScroll.current.size > 50) {
              savedScroll.current.delete(
                savedScroll.current.keys().next().value!,
              );
            }
          }}
          // The toolbar overlays one edge of this scroller (the head on the top
          // tier, the foot as part of the dock on the bottom tier); reserve that
          // edge so cards clear it yet still scroll under it.
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            px: { xs: 2, md: 3 },
            ...(navbarAtBottom
              ? {
                // Bottom tier: the dock (strip + toolbar, lifted with the
                // keyboard) is at the foot; the shelf reaches the top, so it
                // clears the notch itself.
                pt: "calc(env(safe-area-inset-top, 0px) + 16px)",
                pb: "calc(32px + var(--lv-dock-h, 0px))",
                scrollPaddingTop: "calc(env(safe-area-inset-top, 0px) + 16px)",
                scrollPaddingBottom: "var(--lv-dock-h, 0px)",
              }
              : {
                // Top tier: bar at the head; pad the top by its height plus the
                // base breathing room.
                pt: "calc(16px + var(--lv-toolbar-h, 0px))",
                pb: "calc(48px + var(--lv-dock-h, 0px))",
                scrollPaddingTop: "var(--lv-toolbar-h, 0px)",
              }),
          }}
        >
          <Box sx={{ width: "100%", maxWidth: 1320, mx: "auto" }}>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              gap={2}
              sx={{ mb: 2.5 }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  component="h1"
                  sx={{
                    fontSize: { xs: rem(28), sm: rem(30) },
                    fontWeight: 750,
                    letterSpacing: "-0.025em",
                    overflowWrap: "anywhere",
                  }}
                >
                  {query.trim()
                    ? t("landing.searchResults")
                    : currentDirectory?.name ?? t("landing.directories")}
                </Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 0.5 }}
                  role="status"
                >
                  {atRoot
                    ? t("landing.directorySummary", {
                      folders: directories.length,
                      books: books.length,
                    })
                    : t("landing.libraryCount", { n: visible.length }) +
                      (hasCloseMatches
                        ? ` · ${t("landing.closeMatches")}`
                        : "")}
                </Typography>
              </Box>
              {!splitView && atRoot && <BrandMark width={32} height={32} />}
            </Stack>

            {activeFilterCount > 0 && (
              <Stack
                direction="row"
                useFlexGap
                gap={0.75}
                sx={{ mb: 2, flexWrap: "wrap" }}
              >
                {[...selectedTags].map((id) => (
                  <Chip
                    key={id}
                    size="small"
                    label={tagById.get(id)?.label ?? tagLabel(id)}
                    onDelete={() => toggleTag(id)}
                  />
                ))}
                {readingFilter !== "all" && (
                  <Chip
                    size="small"
                    label={t(`reading.${readingFilter}`)}
                    onDelete={() => setReadingFilter("all")}
                  />
                )}
                {kind !== "all" && (
                  <Chip
                    size="small"
                    label={t(FILTER_KIND_LABEL[kind])}
                    onDelete={() => setKind("all")}
                  />
                )}
                <Button size="small" onClick={clearDiscoveryFilters}>
                  {t("landing.clearFilters")}
                </Button>
              </Stack>
            )}

            {atRoot && continueBooks.length > 0 && (
              <Box
                component="section"
                aria-label={t("landing.resume")}
                sx={{ mb: 3 }}
              >
                <Typography
                  variant="body2"
                  fontWeight={650}
                  color="text.secondary"
                  sx={{ mb: 1 }}
                >
                  {t("landing.resume")}
                </Typography>
                {continueBooks.map((book) => (
                  <Box
                    key={book.slug}
                    data-lv-resume={book.slug}
                    sx={{ mb: 1 }}
                  >
                    {renderCard(
                      entries.find((entry) => entry.book.slug === book.slug)!,
                      true,
                    )}
                  </Box>
                ))}
                {continueCount > 4 && (
                  <Button
                    onClick={() =>
                      setContinueLimit((value) => value > 4 ? 4 : 40)}
                  >
                    {continueLimit > 4
                      ? t("landing.showLess")
                      : t("landing.showAllContinue", { n: continueCount })}
                  </Button>
                )}
              </Box>
            )}
            {atRoot && continueLimit > 4 && continueCount > continueLimit && (
              <Button
                sx={{ mb: 2 }}
                onClick={() => setContinueLimit((n) => n + 40)}
              >
                {t("landing.loadMore", { n: continueCount - continueLimit })}
              </Button>
            )}
            {displayedDirectories.length > 0 && (
              <Box
                component="section"
                aria-label={t("landing.directories")}
                sx={{ mb: 3 }}
              >
                {query.trim() && (
                  <Typography
                    component="h2"
                    variant="body2"
                    fontWeight={650}
                    color="text.secondary"
                    sx={{ mb: 1 }}
                  >
                    {t("landing.matchingDirectories", {
                      n: displayedDirectories.length,
                    })}
                  </Typography>
                )}
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: {
                      xs: "minmax(0, 1fr)",
                      lg: "repeat(2, minmax(0, 1fr))",
                    },
                    gap: 1,
                  }}
                >
                  {displayedDirectories.slice(0, directoryLimit).map((
                    directory,
                  ) => (
                    <Button
                      disableRipple
                      key={directory.id}
                      data-lv-directory={directory.name}
                      data-lv-directory-id={directory.id}
                      onClick={() => navigate(directory.id)}
                      sx={{
                        // One title line plus one preview line: 24 folders
                        // stay scannable instead of filling three screens.
                        minHeight: 64,
                        px: 1.5,
                        py: 1,
                        gap: 1.5,
                        border: 1,
                        borderColor: "divider",
                        borderRadius: "14px",
                        bgcolor: "background.paper",
                        color: "text.primary",
                        textTransform: "none",
                        textAlign: "left",
                        alignItems: "center",
                        justifyContent: "flex-start",
                        touchAction: "pan-y",
                      }}
                    >
                      <FolderIcon
                        sx={{
                          color: "primary.main",
                          flexShrink: 0,
                          fontSize: rem(26),
                        }}
                      />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography
                          component="span"
                          fontWeight={700}
                          sx={{ display: "block", overflowWrap: "anywhere" }}
                        >
                          {query.trim()
                            ? (
                              <Highlighted
                                text={directory.path}
                                ranges={directoryHighlights.get(directory.id)}
                              />
                            )
                            : directory.name}
                        </Typography>
                        <Typography
                          component="span"
                          variant="body2"
                          color="text.secondary"
                          noWrap
                          sx={{ display: "block", mt: 0.25 }}
                        >
                          {directory.books.slice(0, 3).map((book) => book.label)
                            .join(" · ")}
                        </Typography>
                      </Box>
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                        sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
                      >
                        {directory.books.length}
                      </Typography>
                      <NextIcon
                        sx={{
                          color: "text.secondary",
                          fontSize: rem(20),
                          flexShrink: 0,
                          ml: -0.75,
                        }}
                      />
                    </Button>
                  ))}
                </Box>
                {displayedDirectories.length > directoryLimit && (
                  <Button
                    onClick={() => setDirectoryLimit((n) => n + 40)}
                    sx={{ width: "100%", minHeight: 44, mt: 1 }}
                  >
                    {t("landing.loadMore", {
                      n: displayedDirectories.length - directoryLimit,
                    })}
                  </Button>
                )}
              </Box>
            )}
            {atRoot && rootEntries.length > 0 && directories.length > 0 && (
              <Typography
                component="h2"
                variant="body2"
                fontWeight={650}
                color="text.secondary"
                sx={{ mb: 1 }}
              >
                {t("landing.rootContent")}
              </Typography>
            )}
            {books.length === 0
              ? (
                <Typography color="text.secondary">
                  {t("landing.noMounts")}
                </Typography>
              )
              : !atRoot && visible.length === 0 &&
                  displayedDirectories.length === 0
              ? (
                <Stack alignItems="flex-start" spacing={1}>
                  <Typography color="text.secondary">
                    {t("landing.noResults")}
                  </Typography>
                  <Button onClick={() => navigate(selectedDirectory)}>
                    {t("landing.backToDirectory")}
                  </Button>
                </Stack>
              )
              : renderGrid(listEntries.slice(0, rowBudget))}
            {listEntries.length > visibleLimit && (
              <Button
                variant="outlined"
                onClick={() =>
                  setPageLimits((current) => ({
                    ...current,
                    [positionKey]: visibleLimit + 40,
                  }))}
                sx={{ mt: 3, minHeight: 44, width: "100%" }}
              >
                {t("landing.loadMore", {
                  n: listEntries.length - visibleLimit,
                })}
              </Button>
            )}
          </Box>
        </Box>
        {
          /* Lift the FAB above the frosted toolbar when it overlays the foot
            (mobile-browser tier); on the top tier the toolbar is at the head, so
            no lift. */
        }
        <ScrollToTopButton
          targetRef={scrollerRef}
          bottomLift="var(--lv-dock-h, 0px)"
        />
      </Box>
      {isVisible && <SyncIndicator bookSlug={null} />}
      {accessory}
      </ShelfDock>
    </Box>
  );
}

/** The shelf's dock. On the bottom tier the toolbar is its bar, lifted above
 *  the on-screen keyboard, and the sync strip joins it; on the top tier it
 *  holds only rows such as what is playing. */
function ShelfDock(
  { docked, toolbar, left, children }: {
    docked: boolean;
    toolbar: ReactNode;
    left: number;
    children: ReactNode;
  },
): React.JSX.Element {
  return (
    <BottomDock
      bar={docked ? toolbar : undefined}
      lift={docked ? "var(--lv-kb-inset, 0px)" : "0px"}
      sx={{ left }}
    >
      {children}
    </BottomDock>
  );
}
