import { rem } from "@/px";
import {
  Badge,
  Box,
  Button,
  Chip,
  Collapse,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { type Theme, useTheme } from "@mui/material/styles";
import {
  ArrowBack as BackIcon,
  ChevronRight as NextIcon,
  Clear as ClearIcon,
  ExpandMore as ExpandMoreIcon,
  FolderOutlined as FolderIcon,
  Headphones as AudiobookIcon,
  KeyboardHide as KeyboardHideIcon,
  MenuBook as BookIcon,
  Search as SearchIcon,
  Tune as TuneIcon,
} from "@mui/icons-material";
import { BottomSheet } from "@/_shell";
import {
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Book, BookProgress, ReadingProgress } from "@/types";
import { setShelfSort, type ShelfSort, useShelfSort } from "@/hooks";
import { useI18n } from "@/i18n";
import { localeDescriptor } from "@/locales/registry";
import { useSyncStatus } from "@/syncStore";
import {
  buildBookSearchIndex,
  buildLibraryTaxonomy,
  countTagFacetMatches,
  facetStartsFolded,
  matchesTagFacets,
  type ReadingFilter,
  readingState,
  scoreBookSearchIndex,
  tagLabel,
  tokenizeSearchQuery,
} from "@/libraryDiscovery";
import { resumableLibraryBooks, resumableLibraryProgress } from "@/libraryHome";
import { libraryDirectories } from "@/libraryDirectories";
import {
  directoryAncestors,
  directoryTree,
  useUserLibrary,
} from "@/userLibrary";
import { LibraryOrganizer } from "./LibraryOrganizer";
import { DirectoryLocation } from "./DirectoryLocation";
import { BrandMark } from "./BrandMark";
import { ScrollToTopButton } from "./ScrollToTopButton";

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
}

/** The shelf splits into three mutually-exclusive kinds, each with its own card
 *  treatment and filter chip. A `book.toml` book that ships an audio rendition
 *  is an "audiobook" — it still carries text, but the listen affordance is its
 *  defining feature on the shelf, so it gets the headphones card and lives under
 *  the 有声书 filter (not double-counted under books). A `book.toml` book with no
 *  audio is a plain "book"; a raw `[[book]]`/`[[mount]]` tree is "docs". */
type Category = "book" | "audiobook" | "docs";

/** A single shelf card — ONE per book. A book that ships both text and audio is
 *  a single "book" card with an audio badge (`hasAudio`); it opens in whichever
 *  rendition you last used (the in-book navbar switches between them). An
 *  audio-ONLY book is an "audiobook" card; a raw `[[book]]`/`[[mount]]` tree is
 *  a "docs" card. */
interface ShelfEntry {
  book: Book;
  category: Category;
  hasAudio: boolean;
  hasText: boolean;
}

function shelfEntries(books: Book[]): ShelfEntry[] {
  const out: ShelfEntry[] = [];
  for (const b of books) {
    const audio = b.renditions.some((r) => r.kind === "audio");
    const text = b.renditions.some((r) => r.kind === "text");
    const category: Category = !b.manifest
      ? "docs"
      : audio && !text
      ? "audiobook"
      : "book";
    out.push({ book: b, category, hasAudio: audio, hasText: text });
  }
  return out;
}

/** The shelf kind filter — a SINGLE choice. "book" covers everything readable or
 *  listenable: a text book, a text+audio book, AND an audio-only "audiobook" all
 *  share ONE card, so audio is never split into its own filter (that just doubled
 *  a card's identity); only a raw docs tree is separate. "all" = no narrowing. */
type FilterKind = "all" | "book" | "docs";
const FILTER_KIND_LABEL: Record<Exclude<FilterKind, "all">, string> = {
  book: "landing.filterBooks",
  docs: "landing.filterDocs",
};

/** Bookshelf sort options, in display order (same set the old Settings row had,
 *  now surfaced in the toolbar's Sort & Filter sheet). */
const SHELF_SORTS: ShelfSort[] = ["updated", "read", "added", "name"];

interface ShelfCardProps {
  book: Book;
  category: Category;
  hasText: boolean;
  hasAudio: boolean;
  progress: BookProgress | undefined;
  generating?: boolean;
  resumeOnly?: boolean;
  directoryLabel?: string | undefined;
  onOpen: (slug: string, renditionKind?: string) => void;
  t: ReturnType<typeof useI18n>["t"];
}

const ShelfCard = memo(function ShelfCard({
  book: b,
  category,
  hasText,
  hasAudio,
  progress: bp,
  generating,
  resumeOnly,
  directoryLabel,
  onOpen,
  t,
}: ShelfCardProps): React.JSX.Element {
  // Progress is split by rendition: a text+audio book shows
  // BOTH a reading and a listening meter; single-rendition
  // books show just the one. The "continue" line resumes the
  // most-recently-opened rendition.
  const textP = bp?.text;
  const audioP = bp?.audio;
  // Book-level progress (how far through the spine), not
  // the in-chapter scroll — so resuming at the top of a
  // late chapter doesn't read 0%. See ReadingProgress.fraction.
  const pctOf = (r: ReadingProgress): number =>
    Math.min(
      100,
      Math.max(0, Math.round(r.fraction * 100)),
    );
  const resumeMode = resumableLibraryProgress(b, bp);
  const resume = resumeOnly
    ? resumeMode?.track
    : textP && audioP
    ? (textP.updatedAt >= audioP.updatedAt ? textP : audioP)
    : (textP ?? audioP);
  return (
    <Box
      data-lv-book={b.slug}
      component="article"
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: "14px",
        bgcolor: "background.paper",
        display: "flex",
        alignItems: "stretch",
        overflow: "hidden",
        height: "100%",
        width: "100%",
      }}
    >
      <Box
        component="button"
        onClick={() =>
          onOpen(b.slug, resumeOnly ? resumeMode?.kind : undefined)}
        sx={{
          flex: 1,
          minWidth: 0,
          border: 0,
          bgcolor: "transparent",
          color: "text.primary",
          textAlign: "left",
          cursor: "pointer",
          p: resumeOnly ? 1.25 : 2,
          touchAction: "pan-y",
          "&:focus-visible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: -2,
          },
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <Typography
          fontWeight={700}
          sx={{
            fontSize: rem(resumeOnly ? 14 : 15),
            lineHeight: 1.4,
            display: "-webkit-box",
            WebkitLineClamp: resumeOnly ? 1 : 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {b.label}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          component="div"
          sx={{ mt: 0.5, display: resumeOnly ? "none" : "block" }}
        >
          {[directoryLabel ?? b.collection, b.author].filter(Boolean).join(
            " · ",
          ) ||
            t(
              category === "docs" ? "landing.docsBadge" : "landing.bookBadge",
            )}
        </Typography>
        {resume
          ? (
            <Typography
              variant="caption"
              color="primary.main"
              noWrap
              component="div"
              sx={{ mt: 0.5 }}
            >
              {t("landing.continue", { chapter: resume.chapterLabel })}
              {b.manifest ? ` · ${pctOf(resume)}%` : ""}
            </Typography>
          )
          : b.description && (
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              component="div"
              sx={{ mt: 0.5 }}
            >
              {b.description}
            </Typography>
          )}
        {generating && (
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
          >
            {t("landing.generatingAudio")}
          </Typography>
        )}
      </Box>
      <Stack
        direction={resumeOnly ? "row" : "column"}
        alignItems="center"
        justifyContent="center"
        sx={{ pr: 1 }}
      >
        {hasText && (
          <IconButton
            aria-label={t("landing.bookBadge")}
            onClick={() => onOpen(b.slug, "text")}
            sx={{ width: 44, height: 44 }}
          >
            <BookIcon fontSize="small" />
          </IconButton>
        )}
        {hasAudio && (
          <IconButton
            aria-label={t("landing.audiobookBadge")}
            onClick={() => onOpen(b.slug, "audio")}
            sx={{ width: 44, height: 44 }}
          >
            <AudiobookIcon fontSize="small" />
          </IconButton>
        )}
      </Stack>
    </Box>
  );
});

/** A directory browser with global search and a retained reading position. */
export function Landing({
  books,
  progress,
  onOpen,
  settingsSlot,
  navbarAtBottom,
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
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const searchEditing = isPhone && searchFocused;
  // Keep the native input uncontrolled. iOS WebKit owns marked text while a
  // Chinese/Japanese/Korean IME is composing; feeding every provisional value
  // back through React's `value` prop replaces that marked range and leaves the
  // keyboard showing candidates while the field itself appears frozen.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchComposingRef = useRef(false);
  const clearSearch = (): void => {
    searchComposingRef.current = false;
    if (searchInputRef.current) {
      searchInputRef.current.value = "";
      searchInputRef.current.focus();
    }
    setQuery("");
  };
  const dismissSearchKeyboard = (): void => {
    searchInputRef.current?.blur();
  };
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
  // Explicit fold choices per facet; absent facets use `facetStartsFolded`.
  const [facetOpen, setFacetOpen] = useState<Record<string, boolean>>({});
  // One card per book (audio rides along as a badge on text+audio books),
  // ordered by the Settings → Library → Sort preference. Default "updated":
  // most-recent content change first (the last sync that added/removed/edited
  // it, falling back to first appearance) — a content-recency shelf.
  const entries = useMemo(() => {
    const changedAt = (b: Book): number => b.updated_at || b.created_at || 0;
    const readAt = (slug: string): number => {
      const bp = progress[slug];
      return Math.max(bp?.text?.updatedAt ?? 0, bp?.audio?.updatedAt ?? 0);
    };
    const cmp: Record<ShelfSort, (a: ShelfEntry, z: ShelfEntry) => number> = {
      updated: (a, z) => changedAt(z.book) - changedAt(a.book),
      added: (a, z) => (z.book.created_at || 0) - (a.book.created_at || 0),
      name: (a, z) => a.book.label.localeCompare(z.book.label, locale),
      // Most-recently opened first; never-opened books fall to the bottom,
      // tie-broken by content recency.
      read: (a, z) => {
        const d = readAt(z.book.slug) - readAt(a.book.slug);
        return d !== 0 ? d : changedAt(z.book) - changedAt(a.book);
      },
    };
    return shelfEntries(books).sort(cmp[sort]);
  }, [books, sort, progress, locale]);
  const libraryTaxonomy = useMemo(
    () => buildLibraryTaxonomy(books),
    [books],
  );
  const tagById = useMemo(
    () => new Map(libraryTaxonomy.tags.map((tag) => [tag.id, tag])),
    [libraryTaxonomy],
  );
  const searchIndexes = useMemo(
    () => new Map(books.map((book) => [book.slug, buildBookSearchIndex(book)])),
    [books],
  );
  const queryTokens = useMemo(() => tokenizeSearchQuery(query), [query]);
  // Score each book exactly once per query. The result is shared by the visible
  // shelf and the facet preview counts below.
  const searchScores = useMemo(() => {
    const scores = new Map<string, number | null>();
    for (const entry of entries) {
      scores.set(
        entry.book.slug,
        scoreBookSearchIndex(searchIndexes.get(entry.book.slug)!, queryTokens),
      );
    }
    return scores;
  }, [entries, queryTokens, searchIndexes]);
  // A refreshed catalog can remove its last use of a tag. Drop that stale
  // selection instead of leaving the shelf trapped in an impossible filter.
  useEffect(() => {
    setSelectedTags((current) => {
      if ([...current].every((id) => tagById.has(id))) return current;
      return new Set([...current].filter((id) => tagById.has(id)));
    });
  }, [tagById]);

  // "book" = anything readable/listenable (text book, text+audio book, OR an
  // audio-only book — one shared card); "docs" = a raw docs tree. So the only real
  // split is book-like vs docs.
  const matchesKind = (e: ShelfEntry, k: Exclude<FilterKind, "all">): boolean =>
    k === "docs" ? e.category === "docs" : e.category !== "docs";

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // The shelf after both narrowing controls: kind filter AND name search.
  const visible = useMemo(() => {
    const q = query.trim();
    const ranked: Array<{ entry: ShelfEntry; score: number }> = [];
    for (const entry of entries) {
      const e = entry;
      if (
        !query.trim() && selectedDirectory !== null &&
        directoryOf(e.book) !== selectedDirectory
      ) continue;
      if (kind !== "all" && !matchesKind(e, kind)) continue;
      if (
        readingFilter !== "all" &&
        readingState(progress[e.book.slug]) !== readingFilter
      ) {
        continue;
      }
      if (!matchesTagFacets(e.book, selectedTags)) continue;
      const score = searchScores.get(e.book.slug) ?? null;
      if (score == null) continue;
      ranked.push({ entry: e, score });
    }
    if (q) ranked.sort((a, b) => b.score - a.score);
    return ranked.map(({ entry }) => entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entries,
    kind,
    query,
    readingFilter,
    selectedTags,
    progress,
    searchScores,
    selectedDirectory,
    library,
  ]);

  const discoveryActive = query.trim().length > 0 || selectedTags.size > 0 ||
    kind !== "all" || readingFilter !== "all";
  const activeFilterCount = selectedTags.size + (kind === "all" ? 0 : 1) +
    (readingFilter === "all" ? 0 : 1);
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
  const tagCountBooks = useMemo(() => {
    const result: Book[] = [];
    for (const entry of entries) {
      if (
        !query.trim() && selectedDirectory !== null &&
        directoryOf(entry.book) !== selectedDirectory
      ) continue;
      if (kind !== "all" && !matchesKind(entry, kind)) continue;
      if (
        readingFilter !== "all" &&
        readingState(progress[entry.book.slug]) !== readingFilter
      ) continue;
      if (searchScores.get(entry.book.slug) == null) continue;
      result.push(entry.book);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entries,
    kind,
    readingFilter,
    progress,
    searchScores,
    selectedDirectory,
    library,
    query,
  ]);
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
  const childDirectories = directories.filter((dir) =>
    dir.parent === selectedDirectory
  );
  const directoryById = useMemo(
    () => new Map(directories.map((dir) => [dir.id, dir])),
    [directories],
  );
  const directoryMatches = query.trim() && activeFilterCount === 0
    ? directories.filter((dir) =>
      dir.path.toLocaleLowerCase(locale).includes(
        query.trim().toLocaleLowerCase(locale),
      )
    )
    : [];
  const displayedDirectories = discoveryActive
    ? directoryMatches
    : childDirectories;
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
  const navigate = (directory: string | null): void => {
    dismissSearchKeyboard();
    if (searchInputRef.current) searchInputRef.current.value = "";
    setQuery("");
    clearDiscoveryFilters();
    setSelectedDirectory(directory);
  };
  const goBack = (): void => {
    if (discoveryActive) navigate(selectedDirectory);
    else navigate(currentDirectory?.parent ?? null);
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
    </Box>
  );

  // Share the measured toolbar height with shelf padding and the sync strip.
  const shelfRegionRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const toolbarEl = toolbarRef.current;
    const regionEl = shelfRegionRef.current;
    if (!toolbarEl || !regionEl) return;
    const publish = (): void => {
      const h = `${toolbarEl.offsetHeight}px`;
      regionEl.style.setProperty("--lv-toolbar-h", h);
      // ALSO publish on documentElement: the ambient sync strip is a root-level
      // fixed element (outside this region), and on the shelf it sits just ABOVE
      // this toolbar — sharing the one frosted bottom backplate, like the reader.
      // It can only offset by the toolbar height if the var is visible at the
      // root. (The region copy stays for the scroller + ScrollToTop, which live
      // inside the region.)
      document.documentElement.style.setProperty("--lv-toolbar-h", h);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(toolbarEl);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--lv-toolbar-h");
    };
  }, []);

  // Lift the bottom toolbar above the on-screen keyboard. The toolbar is an
  // ABSOLUTE overlay pinned to the shelf bottom, so focusing the search input
  // would otherwise leave the iOS keyboard covering it (input hidden while
  // typing). Publish the keyboard's bottom overlap as `--lv-kb-inset` from the
  // VisualViewport and offset the toolbar by it. Self-correcting vs the viewport
  // `interactive-widget=resizes-content`: where the layout viewport already
  // shrinks, innerHeight === visualViewport.height → 0, so no double-shift.
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
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    // Reset the instant the search field blurs (e.g. before navigating away), so
    // we never leave a stale lift behind for the return.
    document.addEventListener("focusout", apply);
    return () => {
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
      onOpen={onOpen}
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
        // Positioning context for the frosted toolbar overlay (absolute within
        // this root) and the carrier of the published --lv-toolbar-h.
        position: "relative",
      }}
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
      <Box
        ref={toolbarRef}
        sx={{
          position: "absolute",
          left: splitView ? 220 : 0,
          right: 0,
          // Bottom: lift above the keyboard (var set above; 0 when closed).
          ...(navbarAtBottom
            ? { bottom: "var(--lv-kb-inset, 0px)" }
            : { top: 0 }),
          zIndex: 6,
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
        {!atRoot && !searchEditing && (
          <DirectoryLocation
            ancestors={selectedDirectory !== null && !query.trim()
              ? library
                ? directoryAncestors(library, selectedDirectory)
                : currentDirectory
                ? [{ id: selectedDirectory, name: currentDirectory.name }]
                : []
              : []}
            navigate={navigate}
          />
        )}
        <Box
          data-lv-search-editing={searchEditing ? "true" : "false"}
          sx={{
            width: "100%",
            mx: "auto",
            display: "flex",
            alignItems: "center",
            gap: { xs: 0.75, sm: 1 },
            minHeight: 44,
          }}
        >
          {!searchEditing && (selectedDirectory !== null || discoveryActive) &&
            (
              <IconButton
                data-lv-directory-back
                aria-label={t("landing.backToDirectory")}
                onClick={goBack}
                sx={{ width: 44, height: 44 }}
              >
                <BackIcon />
              </IconButton>
            )}
          {books.length === 0 && <Box sx={{ flexGrow: 1 }} />}
          {books.length > 0 && (
            <>
              <TextField
                size="small"
                inputRef={searchInputRef}
                data-lv-search-field="true"
                defaultValue=""
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={(e) => {
                  const nativeEvent = e.nativeEvent as KeyboardEvent;
                  if (e.key === "Escape" && !nativeEvent.isComposing) {
                    e.preventDefault();
                    navigate(selectedDirectory);
                  }
                  if (
                    e.key === "Enter" && !searchComposingRef.current &&
                    !nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    dismissSearchKeyboard();
                  }
                }}
                onCompositionStart={() => {
                  searchComposingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  searchComposingRef.current = false;
                  setQuery(
                    searchInputRef.current?.value ??
                      (e.target as HTMLInputElement).value,
                  );
                }}
                onChange={(e) => {
                  const nativeEvent = e.nativeEvent as InputEvent;
                  if (
                    !searchComposingRef.current && !nativeEvent.isComposing
                  ) {
                    setQuery(e.currentTarget.value);
                  }
                }}
                placeholder={t("landing.searchLibrary")}
                aria-label={t("landing.searchLibrary")}
                inputProps={{
                  "data-lv-search-input": "true",
                  "aria-label": t("landing.searchLibrary"),
                  enterKeyHint: "search",
                }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="medium" />
                    </InputAdornment>
                  ),
                  endAdornment: query || searchEditing
                    ? (
                      // ui.md §7: no edge="end" (negative margin pins the target to the
                      // iOS back-swipe edge); floor to a ≥40px touch target on phones and
                      // keep the adornment off the safe-area edge.
                      <InputAdornment
                        position="end"
                        sx={{
                          gap: 0.25,
                          pr: "max(env(safe-area-inset-right), 8px)",
                        }}
                      >
                        <IconButton
                          size="small"
                          data-lv-search-clear="true"
                          disabled={!query}
                          onPointerDown={(e) => e.preventDefault()}
                          onClick={clearSearch}
                          aria-label={t("landing.searchClear")}
                          sx={{
                            width: { xs: 40, lg: 32 },
                            height: { xs: 40, lg: 32 },
                          }}
                        >
                          <ClearIcon fontSize="medium" />
                        </IconButton>
                        {searchEditing && (
                          <IconButton
                            size="small"
                            data-lv-search-dismiss="true"
                            onPointerDown={(e) => {
                              // Perform the blur before this focused-only
                              // control unmounts. onClick remains for keyboard
                              // activation and non-pointer assistive input.
                              e.preventDefault();
                              dismissSearchKeyboard();
                            }}
                            onClick={dismissSearchKeyboard}
                            aria-label={t("landing.searchHideKeyboard")}
                            sx={{ width: 40, height: 40 }}
                          >
                            <KeyboardHideIcon fontSize="medium" />
                          </IconButton>
                        )}
                      </InputAdornment>
                    )
                    : null,
                }}
                sx={{ flexGrow: 1, minWidth: 0 }}
              />
              {
                /* ONE control for both shelf order + kind narrowing — opens the
                  Sort & Filter sheet. The pill shows the active sort at a glance
                  (always set); a primary dot flags an active kind filter (the
                  occasional state). Replaces the old two-dropdown clutter. */
              }
            </>
          )}
          {
            /* Settings (gear / launcher), pinned at the row's end. The reading-
              history widget was removed — sort by "Read" surfaces the same thing,
              and each card now carries its own last-read stamp. */
          }
          {!searchEditing && (
            <Box
              data-lv-shelf-actions
              sx={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                gap: { xs: 0.75, sm: 1 },
              }}
            >
              {books.length > 0 && (
                <Badge
                  color="primary"
                  badgeContent={activeFilterCount}
                  invisible={activeFilterCount === 0}
                  sx={{ flexShrink: 0 }}
                >
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<TuneIcon fontSize="small" />}
                    onClick={() => setSfOpen(true)}
                    aria-label={t("landing.sortFilter")}
                    sx={{
                      flexShrink: 0,
                      minHeight: 44,
                      minWidth: { xs: 44, sm: "auto" },
                      width: { xs: 44, sm: "auto" },
                      px: { xs: 0, sm: 1.25 },
                      textTransform: "none",
                      color: "text.secondary",
                      borderColor: "divider",
                      whiteSpace: "nowrap",
                      "& .MuiButton-startIcon": {
                        m: { xs: 0, sm: "0 8px 0 -4px" },
                      },
                    }}
                  >
                    <Box
                      component="span"
                      sx={{ display: { xs: "none", sm: "inline" } }}
                    >
                      {activeFilterCount > 0
                        ? t("landing.filtersN", { n: activeFilterCount })
                        : t(`sort.${sort}`)}
                    </Box>
                  </Button>
                </Badge>
              )}
              <LibraryOrganizer
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
              {settingsSlot}
            </Box>
          )}
        </Box>
      </Box>

      {/* Sort & Filter sheet — both shelf-organizing controls in one surface. */}
      <BottomSheet
        open={sfOpen}
        onClose={() => setSfOpen(false)}
        title={t("landing.sortFilter")}
        wide
        // This catalog can contain thousands of facet chips. Keep its actions
        // in a real footer so they never obscure the choices being reviewed.
        floatingActions={false}
        actions={
          <>
            <Button
              onClick={clearDiscoveryFilters}
              disabled={activeFilterCount === 0}
            >
              {t("landing.clearFilters")}
            </Button>
            <Button
              variant="contained"
              onClick={() => {
                setSfOpen(false);
              }}
            >
              {t("landing.showResults", { n: visible.length })}
            </Button>
          </>
        }
      >
        <Stack spacing={3} sx={{ pb: 1 }}>
          {selectedTags.size > 0 && (
            <Stack spacing={1}>
              <Typography variant="overline" color="text.secondary">
                {t("landing.selectedFilters")}
              </Typography>
              <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.75}>
                {[...selectedTags].map((id) => {
                  const tag = tagById.get(id);
                  return (
                    <Chip
                      key={id}
                      label={tag?.label ?? tagLabel(id)}
                      color="primary"
                      onDelete={() => toggleTag(id)}
                    />
                  );
                })}
              </Stack>
            </Stack>
          )}
          {libraryTaxonomy.facets.map((facet) => {
            const facetTags = libraryTaxonomy.tags.filter((tag) =>
              tag.facet === facet.id
            );
            const selectedInFacet = facetTags.filter((tag) =>
              selectedTags.has(tag.id)
            ).length;
            const open = facetOpen[facet.id] ??
              !facetStartsFolded(facetTags.length);
            return (
              <Stack key={facet.id} spacing={1}>
                <Box
                  component="button"
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setFacetOpen((current) => ({
                      ...current,
                      [facet.id]: !open,
                    }))}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    width: "100%",
                    minHeight: 40,
                    p: 0,
                    border: 0,
                    bgcolor: "transparent",
                    color: "text.secondary",
                    font: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <Typography variant="overline" sx={{ flex: 1, minWidth: 0 }}>
                    {facet.id === "tags" ? t("landing.tags") : facet.label}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {selectedInFacet > 0
                      ? t("landing.facetSelected", {
                        n: selectedInFacet,
                        total: facetTags.length,
                      })
                      : facetTags.length}
                  </Typography>
                  <ExpandMoreIcon
                    fontSize="small"
                    sx={{
                      transition: "transform .2s",
                      transform: open ? "rotate(180deg)" : "none",
                    }}
                  />
                </Box>
                {
                  /* Folded facets don't mount their chips: a catalog-wide
                    facet can hold hundreds of them. */
                }
                <Collapse in={open} timeout={180} unmountOnExit>
                  <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.75}>
                    {facetTags.map((tag) => {
                      const selected = selectedTags.has(tag.id);
                      const count = tagCounts.get(tag.id) ?? 0;
                      return (
                        <Chip
                          key={tag.id}
                          label={`${tag.label} · ${count}`}
                          color={selected ? "primary" : "default"}
                          variant={selected ? "filled" : "outlined"}
                          disabled={!selected && count === 0}
                          onClick={() => toggleTag(tag.id)}
                          sx={{ minHeight: 40 }}
                        />
                      );
                    })}
                  </Stack>
                </Collapse>
              </Stack>
            );
          })}
          <Stack spacing={1}>
            <Typography variant="overline" color="text.secondary">
              {t("landing.readingState")}
            </Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={readingFilter}
              onChange={(_e, value: ReadingFilter | null) =>
                value && setReadingFilter(value)}
            >
              {(["all", "unread", "progress", "finished"] as const).map((
                value,
              ) => (
                <ToggleButton key={value} value={value}>
                  {t(`reading.${value}`)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="overline" color="text.secondary">
              {t("landing.sortBy")}
            </Typography>
            <RadioGroup
              value={sort}
              onChange={(e) => setShelfSort(e.target.value as ShelfSort)}
            >
              {SHELF_SORTS.map((s) => (
                <FormControlLabel
                  key={s}
                  value={s}
                  control={<Radio />}
                  label={t(`sort.${s}`)}
                />
              ))}
            </RadioGroup>
          </Stack>
          {showKindFilter && (
            <Stack spacing={1}>
              <Typography variant="overline" color="text.secondary">
                {t("landing.kind")}
              </Typography>
              <ToggleButtonGroup
                exclusive
                fullWidth
                size="small"
                value={kind}
                onChange={(_e, v: FilterKind | null) => v && setKind(v)}
                aria-label={t("landing.filter")}
              >
                <ToggleButton value="all">{t("landing.kindAll")}</ToggleButton>
                <ToggleButton value="book">
                  {t(FILTER_KIND_LABEL.book)}
                </ToggleButton>
                <ToggleButton value="docs">
                  {t(FILTER_KIND_LABEL.docs)}
                </ToggleButton>
              </ToggleButtonGroup>
            </Stack>
          )}
        </Stack>
      </BottomSheet>

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
          // The frosted toolbar overlays one edge of this scroller (top on the
          // desktop/top tier, bottom on the mobile-browser tier), so reserve
          // --lv-toolbar-h of foot/head space at THAT edge — the cards then fully
          // clear the bar yet still scroll under it. The var is 0 before measured
          // (a brief first paint), so the base breathing values hold meanwhile.
          // scroll-padding at the same edge keeps scroll-to-top / a scrolled-into-
          // view card from landing under the bar.
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            px: { xs: 2, md: 3 },
            ...(navbarAtBottom
              ? {
                // Bottom tier: bar at the foot; the shelf reaches the top so it
                // still clears the notch itself. The ambient sync strip now sits
                // at the BOTTOM too — above the toolbar, one frosted backplate —
                // so its height (--lv-syncbar-h, 0 unless generating) is reserved
                // at the FOOT (on top of the toolbar), not the head.
                pt: "calc(env(safe-area-inset-top, 0px) + 16px)",
                pb:
                  "calc(32px + var(--lv-toolbar-h, 0px) + var(--lv-syncbar-h, 0px))",
                scrollPaddingTop: "calc(env(safe-area-inset-top, 0px) + 16px)",
                scrollPaddingBottom:
                  "calc(var(--lv-toolbar-h, 0px) + var(--lv-syncbar-h, 0px))",
              }
              : {
                // Top tier: bar at the head; pad the top by its height plus the
                // base breathing room.
                pt: "calc(16px + var(--lv-toolbar-h, 0px))",
                pb: { xs: 4, md: 6 },
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
                    : t("landing.libraryCount", { n: visible.length })}
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
                        minHeight: 84,
                        px: 1.5,
                        py: 1.25,
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
                          fontSize: rem(28),
                        }}
                      />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Stack direction="row" alignItems="baseline" gap={1}>
                          <Typography
                            component="span"
                            fontWeight={700}
                            sx={{ flex: 1, overflowWrap: "anywhere" }}
                          >
                            {query.trim() ? directory.path : directory.name}
                          </Typography>
                          <Typography
                            component="span"
                            variant="caption"
                            color="text.secondary"
                          >
                            {directory.books.length}
                          </Typography>
                        </Stack>
                        <Typography
                          component="span"
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            mt: 0.5,
                          }}
                        >
                          {directory.books.slice(0, 3).map((book) => book.label)
                            .join(" · ")}
                        </Typography>
                      </Box>
                      <NextIcon
                        sx={{
                          color: "text.secondary",
                          fontSize: rem(20),
                          flexShrink: 0,
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
          bottomLift={navbarAtBottom ? "var(--lv-toolbar-h, 0px)" : "0px"}
        />
      </Box>
    </Box>
  );
}
