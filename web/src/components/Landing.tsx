import { rem } from "@/px";
import {
  Badge,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
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
import { alpha, type Theme, useTheme } from "@mui/material/styles";
import {
  Article as DocsIcon,
  Clear as ClearIcon,
  ExpandMore as ExpandMoreIcon,
  Headphones as AudiobookIcon,
  KeyboardHide as KeyboardHideIcon,
  MenuBook as BookIcon,
  Search as SearchIcon,
  Tune as TuneIcon,
  UnfoldLess as CollapseAllIcon,
  UnfoldMore as ExpandAllIcon,
} from "@mui/icons-material";
import { BottomSheet } from "@/_shell";
import {
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Book, BookProgress, ReadingProgress } from "@/types";
import {
  setGroupsCollapsed,
  setShelfGroup,
  setShelfSort,
  type ShelfGroup,
  type ShelfSort,
  toggleGroupCollapsed,
  useCollapsedGroups,
  useShelfGroup,
  useShelfSort,
} from "@/hooks";
import { useI18n } from "@/i18n";
import { localeDescriptor } from "@/locales/registry";
import { useSyncStatus } from "@/syncStore";
import {
  buildBookSearchIndex,
  buildLibraryTaxonomy,
  countTagFacetMatches,
  matchesTagFacets,
  type ReadingFilter,
  readingState,
  scoreBookSearchIndex,
  sortCollectionNames,
  tagLabel,
  tokenizeSearchQuery,
} from "@/libraryDiscovery";
import { ShelfCardArtwork } from "./CoverTile";
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

/** Bookshelf grouping options, in display order (moved out of Settings into the
 *  Sort & Filter sheet — grouping is a shelf-organizing control, same surface). */
const SHELF_GROUPS: ShelfGroup[] = ["none", "collection"];

/** A named shelf group: its display label + the entries that fall under it,
 *  already in the shelf's active sort order. `name` is the collection string
 *  (the stable key used for collapse state); for the catch-all bucket it's the
 *  localized "Other" label, which is fine — that bucket is unique on the shelf. */
interface ShelfGroupSection {
  name: string;
  entries: ShelfEntry[];
}

/** Partition `visible` (already sorted) into ordered series sections. Group
 *  membership is `book.collection`; a null/empty collection lands in the
 *  catch-all bucket labelled `otherLabel`, which always sorts last. Named
 *  collections use locale-aware alphabetical order; LiveView never assigns
 *  product-specific priority. Within each group the entries keep `visible`'s
 *  order (round-robin happens per-group at render). */
function groupByCollection(
  visible: ShelfEntry[],
  otherLabel: string,
  locale: string,
): ShelfGroupSection[] {
  // Preserve first-seen order within each bucket by appending as we scan.
  const buckets = new Map<string, ShelfEntry[]>();
  let hasOther = false;
  for (const e of visible) {
    const c = e.book.collection?.trim();
    if (c) {
      (buckets.get(c) ?? buckets.set(c, []).get(c)!).push(e);
    } else {
      (buckets.get(otherLabel) ?? buckets.set(otherLabel, []).get(otherLabel)!)
        .push(e);
      hasOther = true;
    }
  }
  const named = sortCollectionNames(
    [...buckets.keys()].filter((name) => name !== otherLabel),
    locale,
  );
  const order = [...named, ...(hasOther ? [otherLabel] : [])];
  return order
    .map((name) => ({ name, entries: buckets.get(name) ?? [] }))
    .filter((g) => g.entries.length > 0);
}

/** Deterministic hue (0–359) from a slug, so a book's generated cover colour is
 *  stable across reloads without storing anything. */
function slugHue(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** A faint slug-keyed wash over the card paper. It preserves the original
 *  shelf's colourful identity while authored artwork remains the focal point. */
function compactTint(slug: string): string {
  const h = slugHue(slug);
  return `linear-gradient(135deg, hsl(${h} 52% 52% / 0.22), hsl(${
    (h + 38) % 360
  } 48% 42% / 0.08))`;
}

/** The kind glyph for a card: the audiobook's defining cue (headphones) vs a book
 *  vs docs, so each kind reads at a glance. Used by the single-kind title badge. */
function kindIcon(category: Category): typeof BookIcon {
  if (category === "audiobook") return AudiobookIcon;
  if (category === "docs") return DocsIcon;
  return BookIcon;
}

/** Cover badge for a book that ships BOTH renditions: a compact segmented switch
 *  (📖 Book | 🎧 Audiobook) that shows both supported formats AND which one is
 *  current (the last-used, highlighted). Each segment opens the book directly in
 *  that rendition — so the card doubles as the format picker. Replaces the single
 *  static badge on dual-format cards.
 *
 *  Rendered inside the CardActionArea's <button>, so the segments are role=button
 *  DIVs (not nested <button>s, which is invalid HTML); the click + mousedown stop
 *  propagation so picking a format doesn't also trigger the card's default open. */
function CoverRenditionSwitch({
  slug,
  activeKind,
  onOpen,
  bookLabel,
  audioLabel,
  inline = false,
}: {
  slug: string;
  activeKind: "text" | "audio";
  onOpen: (slug: string, renditionKind?: string) => void;
  bookLabel: string;
  audioLabel: string;
  // `inline`: render in a card BODY (compact shelf, no cover band) instead of
  // overlaying the dark cover — static-positioned, with a light theme-aware
  // track instead of the dark scrim, so it reads on the paper surface.
  inline?: boolean;
}): React.JSX.Element {
  const segs = [
    { kind: "text" as const, Icon: BookIcon, label: bookLabel },
    { kind: "audio" as const, Icon: AudiobookIcon, label: audioLabel },
  ];
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "stretch",
        borderRadius: 5,
        overflow: "hidden",
        ...(inline
          ? {
            flexShrink: 0,
            bgcolor: (theme: Theme) =>
              alpha(
                theme.palette.background.paper,
                theme.palette.mode === "dark" ? 0.9 : 0.88,
              ),
            border: 1,
            borderColor: (theme: Theme) =>
              alpha(theme.palette.text.primary, 0.12),
          }
          : {
            position: "absolute",
            top: 8,
            right: 8,
            bgcolor: "rgba(0,0,0,0.45)",
          }),
      }}
    >
      {segs.map((s) => {
        const active = activeKind === s.kind;
        return (
          <Box
            key={s.kind}
            role="button"
            tabIndex={0}
            // Label only for a11y — the switch is icon-only (mirrors the in-book
            // read↔listen widget); the two glyphs are self-explanatory.
            aria-label={s.label}
            aria-pressed={active}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(slug, s.kind);
            }}
            sx={{
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              px: 1,
              py: 0.5,
              color: active
                ? (inline ? "primary.contrastText" : "#fff")
                : (inline ? "text.secondary" : "rgba(255,255,255,0.6)"),
              bgcolor: active ? "primary.main" : "transparent",
              transition: "background-color .15s, color .15s",
              "&:hover": { color: inline ? "text.primary" : "#fff" },
            }}
          >
            <s.Icon sx={{ fontSize: rem(17) }} />
          </Box>
        );
      })}
    </Box>
  );
}

/** Single-kind badge for a compact card's title row — a book/audiobook/docs that
 *  ships only ONE rendition, so there's no switch to make. A small primary pill
 *  with the kind glyph, matching the active segment of the dual-format inline
 *  switch (so a single-format card reads consistently next to a dual one). The
 *  non-compact cover shows the same badge overlaid; this is its inline twin. */
function CompactKindBadge(
  { category, label }: { category: Category; label: string },
): React.JSX.Element {
  const Icon = kindIcon(category);
  return (
    <Box
      aria-label={label}
      sx={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        px: 1,
        py: 0.5,
        borderRadius: 5,
        bgcolor: "primary.main",
        color: "primary.contrastText",
      }}
    >
      <Icon sx={{ fontSize: rem(17) }} />
    </Box>
  );
}

/** A compact per-rendition progress pill. Text and audio advance independently,
 *  so a dual-rendition book keeps one small meter for each track. */
function ProgressMeter(
  { icon, pct }: { icon: ReactNode; pct: number },
): React.JSX.Element {
  return (
    <Box
      sx={{
        position: "relative",
        flex: 1,
        minWidth: 0,
        height: 26,
        borderRadius: 999,
        overflow: "hidden",
        bgcolor: (theme) =>
          alpha(
            theme.palette.background.paper,
            theme.palette.mode === "dark" ? 0.9 : 0.88,
          ),
        border: 1,
        borderColor: (theme) => alpha(theme.palette.text.primary, 0.1),
        display: "flex",
        alignItems: "center",
        // No per-meter inset shadow. A large shelf contains hundreds of these
        // pills; WKWebView repaints every shadow while the image-backed cards
        // move, turning a decorative 1px highlight into a measurable scroll
        // cost. Border + fill already communicate the track geometry.
      }}
    >
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          right: "auto",
          width: `${pct}%`,
          bgcolor: (theme) => alpha(theme.palette.primary.main, 0.22),
        }}
      />
      <Box
        sx={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 1,
          width: "100%",
          color: "text.secondary",
        }}
      >
        {icon}
        <Typography
          variant="caption"
          sx={{
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            color: "text.primary",
          }}
        >
          {pct}%
        </Typography>
      </Box>
    </Box>
  );
}

// Pull-to-refresh was removed (offline-first): the shelf is network-first +
// live-updated over the WS (TreeUpdate) and re-pulls recent progress on open and
// on book-close, so a manual pull was redundant. See docs/offline-first.md.

/** One collapsible series section: a sticky paper header (series name +
 *  count + a rotating chevron) over a `Collapse` wrapping that group's grid.
 *  The header is a full-width button (mouse + keyboard) toggling the group's
 *  collapsed state; `sticky top:0` pins it to the scrolling shelf as you read
 *  down a long series. Each section keeps a little bottom margin so adjacent
 *  series read as distinct. Because it overlaps moving cards, the material is
 *  near-opaque and deliberately unblurred for WKWebView scroll performance. */
function GroupSection({
  name,
  count,
  collapsed,
  onToggle,
  instant,
  children,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  instant?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const hue = slugHue(name);
  return (
    <Box sx={{ mb: 1.5 }}>
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        sx={{
          // Sticky within the shelf scroller so the series name stays visible
          // while you read down a long group; above the cards but below the
          // toolbar overlay (zIndex 6).
          position: "sticky",
          top: 0,
          zIndex: 2,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          px: 1.75,
          py: 1.25,
          mb: 1,
          borderRadius: 2,
          // A real surface, not bare text: a near-opaque paper bar with a
          // hairline + soft shadow so it floats above the shelf (the page bg is
          // flat, so a `background.default` wash was invisible — it read as
          // unstyled text with big gaps). NO backdrop-filter here: this sticky
          // element overlaps moving artwork and would re-rasterize every frame.
          border: 1,
          borderColor: "divider",
          boxShadow: 1,
          bgcolor: (t) => alpha(t.palette.background.paper, 0.96),
        }}
      >
        {
          /* Per-series colour anchor — the slug-keyed cover gradient as a small
            dot, so each section reads at a glance and the headers aren't a
            monochrome list. */
        }
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            flexShrink: 0,
            background: `linear-gradient(135deg, hsl(${hue} 58% 56%), hsl(${
              (hue + 38) % 360
            } 54% 46%))`,
          }}
        />
        <Typography
          variant="subtitle1"
          sx={{ fontWeight: 700, minWidth: 0, flex: 1 }}
          noWrap
        >
          {name}
        </Typography>
        <Box
          component="span"
          sx={{
            flexShrink: 0,
            minWidth: 22,
            textAlign: "center",
            px: 0.75,
            py: 0.1,
            borderRadius: 5,
            bgcolor: "action.selected",
            color: "text.secondary",
            fontSize: rem(12),
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {count}
        </Box>
        <ExpandMoreIcon
          sx={{
            flexShrink: 0,
            color: "text.secondary",
            transition: "transform .2s",
            // Collapsed → chevron points down ("expand"); open → up ("collapse").
            transform: collapsed ? "none" : "rotate(180deg)",
          }}
        />
      </Box>
      <Collapse
        in={!collapsed}
        timeout={instant ? 0 : 180}
        unmountOnExit={false}
      >
        {children}
      </Collapse>
    </Box>
  );
}

interface ShelfCardProps {
  book: Book;
  category: Category;
  hasText: boolean;
  hasAudio: boolean;
  progress: BookProgress | undefined;
  /** This book's audiobook audio is still being generated in the background — a
   *  subtle "generating" micro-badge; text stays fully usable. */
  generating?: boolean | undefined;
  onOpen: (slug: string, renditionKind?: string) => void;
  t: ReturnType<typeof useI18n>["t"];
}

// One shelf card for a single entry, memoized at module level. The shelf
// re-renders on every return from a book (only the read book's progress
// changed), so an un-memoized card closure rebuilt all ~44 cards each time —
// the bulk of the return-from-book freeze. As a memoized component, only the
// card whose props actually changed re-renders.
const ShelfCard = memo(function ShelfCard({
  book: b,
  category,
  hasText,
  hasAudio,
  progress: bp,
  generating,
  onOpen,
  t,
}: ShelfCardProps): React.JSX.Element {
  const langs = b.langs;
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
  const resume = textP && audioP
    ? (textP.updatedAt >= audioP.updatedAt ? textP : audioP)
    : (textP ?? audioP);
  // The dual-format card shows a rendition switch; the
  // highlighted "current" segment is the last-used one
  // (most-recent progress), defaulting to reading for a
  // never-opened book (the default rendition of a "book").
  const activeKind: "text" | "audio" = textP && audioP
    ? (audioP.updatedAt > textP.updatedAt ? "audio" : "text")
    : audioP
    ? "audio"
    : "text";
  return (
    <Card
      variant="outlined"
      sx={{
        borderRadius: 2,
        overflow: "hidden",
        position: "relative",
        backgroundImage: compactTint(b.slug),
        "@media (hover: hover)": {
          transition: "box-shadow 0.18s, transform 0.18s",
          "&:hover": {
            boxShadow: 5,
            transform: "translateY(-2px)",
          },
        },
      }}
    >
      <ShelfCardArtwork slug={b.slug} hasBackdrop={b.backdrop} />
      <CardActionArea
        disableRipple
        onClick={() => onOpen(b.slug)}
        sx={{
          position: "relative",
          zIndex: 1,
          p: 1.75,
          alignItems: "flex-start",
          height: "100%",
          // This surface is a navigation target, but its dominant gesture is
          // vertical shelf scrolling. Let WebKit hand the pan straight to the
          // native scroller instead of starting/cancelling a ButtonBase ripple.
          touchAction: "pan-y",
        }}
      >
        <Box
          sx={{
            position: "relative",
            minHeight: 142,
            width: "100%",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {hasText && hasAudio
            ? (
              <Box sx={{ position: "absolute", top: 0, right: 0 }}>
                <CoverRenditionSwitch
                  slug={b.slug}
                  activeKind={activeKind}
                  onOpen={onOpen}
                  bookLabel={t("landing.bookBadge")}
                  audioLabel={t("landing.audiobookBadge")}
                  inline
                />
              </Box>
            )
            : (
              <Box sx={{ position: "absolute", top: 0, right: 0 }}>
                <CompactKindBadge
                  category={category}
                  label={t(
                    category === "docs"
                      ? "landing.docsBadge"
                      : category === "audiobook"
                      ? "landing.audiobookBadge"
                      : "landing.bookBadge",
                  )}
                />
              </Box>
            )}
          <Typography
            variant="subtitle1"
            fontWeight={700}
            sx={{
              lineHeight: 1.3,
              pr: 9,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {b.label}
          </Typography>
          {b.author && (
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              sx={{ display: "block", mt: 0.35 }}
            >
              {b.author}
            </Typography>
          )}
          {b.description && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{
                mt: 0.75,
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {b.description}
            </Typography>
          )}
          {(hasText || hasAudio) && (
            <Box sx={{ display: "flex", gap: 1, mt: 1.25 }}>
              {hasText && (
                <ProgressMeter
                  icon={<BookIcon sx={{ fontSize: rem(15) }} />}
                  pct={textP ? pctOf(textP) : 0}
                />
              )}
              {hasAudio && (
                <ProgressMeter
                  icon={<AudiobookIcon sx={{ fontSize: rem(15) }} />}
                  pct={audioP ? pctOf(audioP) : 0}
                />
              )}
            </Box>
          )}
          {resume && (
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              sx={{ display: "block", mt: 0.75 }}
            >
              {t("landing.continue", { chapter: resume.chapterLabel })}
            </Typography>
          )}
          <Box
            sx={{
              mt: "auto",
              pt: 1.25,
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 0.5,
              minWidth: 0,
            }}
          >
            {langs.map((l) => (
              <Chip
                key={l.lang}
                label={l.label}
                size="small"
                variant="outlined"
                sx={{
                  bgcolor: (theme) =>
                    alpha(
                      theme.palette.background.paper,
                      theme.palette.mode === "dark" ? 0.9 : 0.88,
                    ),
                  borderColor: (theme) =>
                    alpha(theme.palette.text.primary, 0.2),
                }}
              />
            ))}
          </Box>
          {generating && (
            <Box
              sx={{ display: "flex", alignItems: "center", gap: 0.6, mt: 0.75 }}
            >
              <CircularProgress size={rem(11)} thickness={5} />
              <Typography variant="caption" color="text.secondary">
                {t("landing.generatingAudio")}
              </Typography>
            </Box>
          )}
        </Box>
      </CardActionArea>
    </Card>
  );
});

/**
 * The "bookshelf" landing page: a sticky navbar (title · search · filters ·
 * settings · launcher) over a cover-first book grid.
 *
 * A 2:3 cover is the primary scan target; title and author stay as accessible
 * real text beneath it. Coverless books use the same geometry with a stable
 * gradient fallback, so a partially illustrated shelf never changes layout.
 * Picking a card
 * enters that book (resuming the last-read chapter); books with more than one
 * language edition show their editions as chips, and books with saved progress
 * show a % badge on the cover plus a progress bar along the card's bottom.
 *
 * The navbar stays put while the shelf scrolls so search/filter/settings are
 * always one tap away. Search matches by name (label/slug); a compact
 * multi-select dropdown narrows the shelf by kind (书 / 有声书 / docs) and
 * combines with search (empty selection = all kinds).
 */
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
  // Group-by-series: when "collection", the shelf splits into collapsible
  // per-series sections (each with a sticky frosted header); `collapsed` is the
  // set of currently-folded section names.
  const group = useShelfGroup();
  const collapsed = useCollapsedGroups();
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
  // Bulk folding must not animate dozens of card grids at once: doing so creates
  // a large layout/paint burst in WKWebView. Individual sections still use a
  // short transition; expand/collapse-all applies in one frame.
  const [bulkGroupChange, setBulkGroupChange] = useState(false);
  // Search/filter-driven expansion is intentionally ephemeral. It reveals every
  // matching series without destroying the reader's saved browsing layout; once
  // discovery clears, the prior persisted collapse state returns exactly.
  const [discoveryCollapsed, setDiscoveryCollapsed] = useState<Set<string>>(
    () => new Set(),
  );

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
  ]);

  const discoveryActive = query.trim().length > 0 || selectedTags.size > 0 ||
    kind !== "all" || readingFilter !== "all";
  const activeFilterCount = selectedTags.size + (kind === "all" ? 0 : 1) +
    (readingFilter === "all" ? 0 : 1);
  const discoverySignature = `${query}\0${kind}\0${readingFilter}\0${
    [...selectedTags].sort().join(",")
  }`;
  useEffect(() => setDiscoveryCollapsed(new Set()), [discoverySignature]);

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

  // The ordered series sections (only when grouping by collection): named
  // collections use locale order and the "Other" catch-all remains last.
  const groupSections = useMemo(
    () =>
      group === "collection"
        ? groupByCollection(
          visible,
          t("landing.otherGroup"),
          locale,
        )
        : [],
    [group, visible, t, locale],
  );
  const visibleGroupNames = useMemo(
    () => groupSections.map((section) => section.name),
    [groupSections],
  );
  const effectiveCollapsed = discoveryActive ? discoveryCollapsed : collapsed;
  const anyVisibleGroupCollapsed = visibleGroupNames.some((name) =>
    effectiveCollapsed.has(name)
  );
  const allVisibleGroupsCollapsed = visibleGroupNames.length > 0 &&
    visibleGroupNames.every((name) => effectiveCollapsed.has(name));
  const setVisibleGroupsCollapsed = (nextCollapsed: boolean): void => {
    setBulkGroupChange(true);
    if (discoveryActive) {
      setDiscoveryCollapsed(
        nextCollapsed ? new Set(visibleGroupNames) : new Set(),
      );
    } else {
      setGroupsCollapsed(visibleGroupNames, nextCollapsed);
    }
    requestAnimationFrame(() => setBulkGroupChange(false));
  };
  const toggleVisibleGroup = (name: string): void => {
    if (!discoveryActive) {
      toggleGroupCollapsed(name);
      return;
    }
    setDiscoveryCollapsed((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // The kind segments only make sense when the shelf has BOTH books and docs;
  // otherwise All/Books/Docs would narrow to the same set.
  const showKindFilter = counts.book > 0 && counts.docs > 0;

  // The shelf scroll container — ref'd for the back-to-top button + the
  // app-level status-bar tap (both scroll it to the top).
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Frosted-overlay toolbar: the bookshelf bar is now an iOS-style frosted
  // OVERLAY (like the in-book NavShell bar + the audio transport) that the shelf
  // scrolls UNDER, not a solid flex sibling. We measure its rendered height (it
  // varies with the safe-area inset + rotation + whether the kind filter shows)
  // and publish it as `--lv-toolbar-h` on the shelf region, so the scroller can
  // reserve that much space at the matching edge (top or bottom, per
  // navbarAtBottom). Same recipe + var-name idiom as NavShell's --shell-bar-h.
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
  const renderCard = (e: ShelfEntry): React.JSX.Element => (
    <ShelfCard
      key={e.book.slug}
      book={e.book}
      category={e.category}
      hasText={e.hasText}
      hasAudio={e.hasAudio}
      progress={progress[e.book.slug]}
      generating={generatingSlugs.has(e.book.slug)}
      onOpen={onOpen}
      t={t}
    />
  );

  // Compact artwork-backed cards stay one-up on phones, then progressively add
  // columns. Equal tracks keep reading order stable in every engine.
  const renderGrid = (entries2: ShelfEntry[]): React.JSX.Element => (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: {
          xs: "repeat(1, minmax(0, 1fr))",
          sm: "repeat(2, minmax(0, 1fr))",
          md: "repeat(3, minmax(0, 1fr))",
          lg: "repeat(4, minmax(0, 1fr))",
          xl: "repeat(5, minmax(0, 1fr))",
        },
        columnGap: { xs: 2, sm: 2.5, md: 3 },
        rowGap: { xs: 3, md: 4 },
        alignItems: "start",
      }}
    >
      {entries2.map((e) => renderCard(e))}
    </Box>
  );

  return (
    <Box
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
      {
        /* ── Navbar ──────────────────────────────────────────────────────────
          An iOS-style FROSTED-GLASS OVERLAY (matching the in-book NavShell bar +
          the audio transport) pinned to the shelf region's top (or bottom, on
          the mobile-browser tier), with the shelf scrolling UNDER it; the
          scroller reserves --lv-toolbar-h at the matching edge so the cards
          still clear it. Higher alpha (0.78) than the status strip because real
          card content scrolls under it — the search/filter/gear legibility comes
          first; blur+saturate match the other bars so they read as one glass
          layer. background.default (the page bg the cards sit on), not paper. A
          subtle edge (hairline / divider) still marks the boundary. zIndex above
          the scroller + the back-to-top button. */
      }
      <Box
        ref={toolbarRef}
        sx={{
          position: "absolute",
          left: 0,
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
          bgcolor: (t) =>
            alpha(
              t.palette.background.default,
              t.palette.mode === "dark" ? 0.94 : 0.96,
            ),
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
              pb: "max(calc(env(safe-area-inset-bottom, 0px) - 16px), 10px)",
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
            md: 6,
          },
          pr: {
            xs: searchEditing
              ? "max(env(safe-area-inset-right, 0px), 8px)"
              : 1.5,
            sm: 2.5,
            md: 6,
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
          }}
        >
          {
            /* One row: search (grows) · kind filter · settings. The old
              "Bookshelf" title row was dropped — it just ate vertical space;
              app identity lives in the status bar / launcher, and scroll-to-top
              is the floating button. An empty shelf shows a spacer so settings
              still pins to the right. */
          }
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
                placeholder={t("landing.search")}
                aria-label={t("landing.search")}
                inputProps={{
                  "data-lv-search-input": "true",
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
            <Button variant="contained" onClick={() => setSfOpen(false)}>
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
          {libraryTaxonomy.facets.map((facet) => (
            <Stack key={facet.id} spacing={1}>
              <Typography variant="overline" color="text.secondary">
                {facet.id === "tags" ? t("landing.tags") : facet.label}
              </Typography>
              <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.75}>
                {libraryTaxonomy.tags.filter((tag) =>
                  tag.facet === facet.id
                )
                  .map((tag) => {
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
            </Stack>
          ))}
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
          {
            /* Group — moved here from Settings: organizing the shelf belongs with
              sort + filter, not in app preferences. */
          }
          <Stack spacing={1}>
            <Typography variant="overline" color="text.secondary">
              {t("landing.group")}
            </Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={group}
              onChange={(_e, v: ShelfGroup | null) => v && setShelfGroup(v)}
              aria-label={t("settings.group")}
            >
              {SHELF_GROUPS.map((g) => (
                <ToggleButton key={g} value={g}>{t(`group.${g}`)}</ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Stack>
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
            px: { xs: 2, md: 6 },
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
          <Box sx={{ width: "100%", mx: "auto" }}>
            {activeFilterCount > 0 && (
              <Stack
                direction="row"
                useFlexGap
                gap={0.75}
                sx={{ mb: 1.25, overflowX: "auto", pb: 0.25 }}
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
                <Button
                  size="small"
                  onClick={clearDiscoveryFilters}
                  sx={{ flexShrink: 0 }}
                >
                  {t("landing.clearFilters")}
                </Button>
              </Stack>
            )}
            {books.length === 0
              ? (
                <Typography color="text.secondary">
                  {t("landing.noMounts")}
                </Typography>
              )
              : visible.length === 0
              ? (
                <Typography color="text.secondary">
                  {t("landing.noResults")}
                </Typography>
              )
              : group === "collection"
              ? (
                <>
                  {
                    /* These controls belong to the grouped result, not the
                    persistent shelf toolbar. On phones they share the width for
                    reliable touch targets; wider layouts keep them compact and
                    right-aligned above the sections they affect. */
                  }
                  <Stack
                    direction="row"
                    spacing={1}
                    justifyContent={{ xs: "stretch", sm: "flex-end" }}
                    sx={{ mb: 1.25 }}
                  >
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<ExpandAllIcon />}
                      disabled={!anyVisibleGroupCollapsed}
                      onClick={() => setVisibleGroupsCollapsed(false)}
                      sx={{ flex: { xs: 1, sm: "0 0 auto" }, minHeight: 40 }}
                    >
                      {t("landing.expandAllSeries")}
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<CollapseAllIcon />}
                      disabled={allVisibleGroupsCollapsed}
                      onClick={() => setVisibleGroupsCollapsed(true)}
                      sx={{ flex: { xs: 1, sm: "0 0 auto" }, minHeight: 40 }}
                    >
                      {t("landing.collapseAllSeries")}
                    </Button>
                  </Stack>
                  {
                    /* Grouped shelf: curated series order, each retaining the
                    same responsive card grid as the flat shelf. */
                  }
                  {groupSections.map((g) => (
                    <GroupSection
                      key={g.name}
                      name={g.name}
                      count={g.entries.length}
                      collapsed={effectiveCollapsed.has(g.name)}
                      onToggle={() => toggleVisibleGroup(g.name)}
                      instant={bulkGroupChange}
                    >
                      {renderGrid(g.entries)}
                    </GroupSection>
                  ))}
                </>
              )
              : (
                // Flat shelf: one responsive cover grid over all visible entries.
                renderGrid(visible)
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
