import { rem } from "@/px";
import {
  Box,
  Card,
  CardActionArea,
  Checkbox,
  Chip,
  FormControl,
  IconButton,
  InputAdornment,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Select,
  type SelectChangeEvent,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import {
  Article as DocsIcon,
  Clear as ClearIcon,
  FilterList as FilterIcon,
  Headphones as AudiobookIcon,
  MenuBook as BookIcon,
  Search as SearchIcon,
} from "@mui/icons-material";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Book, BookProgress, ReadingProgress } from "@/types";
import { type ShelfSort, useShelfSort } from "@/hooks";
import { useI18n } from "@/i18n";
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

/** Filter dropdown rows, in display order, with their i18n label keys. An empty
 *  selection means "all kinds" (no narrowing), so there's no explicit "all" row. */
const KIND_ORDER: Category[] = ["book", "audiobook", "docs"];
const KIND_LABEL: Record<Category, string> = {
  book: "landing.filterBooks",
  audiobook: "landing.filterAudiobooks",
  docs: "landing.filterDocs",
};

/** Deterministic hue (0–359) from a slug, so a book's generated cover colour is
 *  stable across reloads without storing anything. */
function slugHue(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** A book has no cover art, so synthesise one: a calm two-stop gradient keyed
 *  off the slug. Mid lightness so the white kind-icon over it reads on any
 *  theme. */
function coverGradient(slug: string): string {
  const h = slugHue(slug);
  return `linear-gradient(135deg, hsl(${h} 52% 52%), hsl(${
    (h + 38) % 360
  } 48% 42%))`;
}

/** The kind glyph shown over a coverless card — also the audiobook's defining
 *  visual cue (headphones), so an audiobook reads as distinct from a book at a
 *  glance. */
function kindIcon(category: Category): typeof BookIcon {
  if (category === "audiobook") return AudiobookIcon;
  if (category === "docs") return DocsIcon;
  return BookIcon;
}

/** A book card's cover: the real cover image when the book has one (lazy-loaded,
 *  falling back to the synthesised gradient if it fails to load), else the
 *  gradient straight away. The kind icon + any badges ride on top in both
 *  cases. */
function BookCover({
  book,
  category,
  children,
}: {
  book: Book;
  category: Category;
  children: ReactNode;
}): React.JSX.Element {
  // Once the <img> errors we permanently fall back to the gradient for this
  // card (avoids a broken-image flash on every re-render).
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = book.cover && !imgFailed;
  const KindIcon = kindIcon(category);
  return (
    <Box
      sx={{
        position: "relative",
        height: 104,
        // The gradient is always the backdrop: it shows through while the image
        // loads and after a load error, so there's never a bare box.
        background: coverGradient(book.slug),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {showImage
        ? (
          <Box
            component="img"
            src={`/api/cover?book=${encodeURIComponent(book.slug)}`}
            alt=""
            loading="lazy"
            onError={() => {
              setImgFailed(true);
            }}
            sx={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        )
        : (
          // No image (or it failed): show the kind icon over the gradient.
          <KindIcon
            sx={{ fontSize: rem(52), color: "rgba(255,255,255,0.92)" }}
          />
        )}
      {children}
    </Box>
  );
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
}: {
  slug: string;
  activeKind: "text" | "audio";
  onOpen: (slug: string, renditionKind?: string) => void;
  bookLabel: string;
  audioLabel: string;
}): React.JSX.Element {
  const segs = [
    { kind: "text" as const, Icon: BookIcon, label: bookLabel },
    { kind: "audio" as const, Icon: AudiobookIcon, label: audioLabel },
  ];
  return (
    <Box
      sx={{
        position: "absolute",
        top: 8,
        left: 8,
        display: "flex",
        alignItems: "stretch",
        borderRadius: 5,
        overflow: "hidden",
        bgcolor: "rgba(0,0,0,0.45)",
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
              color: active ? "#fff" : "rgba(255,255,255,0.6)",
              bgcolor: active ? "primary.main" : "transparent",
              transition: "background-color .15s, color .15s",
              "&:hover": { color: "#fff" },
            }}
          >
            <s.Icon sx={{ fontSize: rem(17) }} />
          </Box>
        );
      })}
    </Box>
  );
}

/** Format a unix-ms deploy stamp as a locale date, or null when unset (0). */
function fmtDate(ms: number, lang: string): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The largest [unit, seconds-per-unit] step a delta fits into, coarsest last. */
const REL_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** Format a unix-ms timestamp as a locale relative time ("3 hours ago" /
 *  "3小时前"), or null when unset (0). `now` is passed in so every card on one
 *  render shares a single clock read. */
function fmtRelative(ms: number, now: number, lang: string): string | null {
  if (!ms) return null;
  const rtf = new Intl.RelativeTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
    numeric: "auto",
  });
  const sec = (ms - now) / 1000; // negative ⇒ in the past
  const abs = Math.abs(sec);
  for (const [unit, per] of REL_STEPS) {
    if (abs >= per) return rtf.format(Math.round(sec / per), unit);
  }
  return rtf.format(Math.round(sec), "second");
}

/** A compact progress "meter pill": a rounded track with an accent fill to
 *  `pct`, the mode icon + the % riding on top. Two sit side by side on a
 *  text+audio card (reading / listening); one fills the row on a single-
 *  rendition card. This per-item meter (the Audiobookshelf / Plex idiom)
 *  replaces the old stacked cover chips + naked bottom bars, and stays legible
 *  in every theme — the fill is a soft accent wash, so the label reads over
 *  both its filled and unfilled halves. */
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
        bgcolor: "action.hover",
        display: "flex",
        alignItems: "center",
      }}
    >
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          right: "auto",
          width: `${pct}%`,
          bgcolor: (t) => alpha(t.palette.primary.main, 0.3),
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
          "& svg": { flexShrink: 0 },
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

/**
 * The "bookshelf" landing page: a sticky navbar (title · search · filters ·
 * settings · launcher) over a masonry of book cards.
 *
 * Why masonry cards (not the old equal-height grid, nor a flat list): books
 * have no cover art, so an equal-height tile grid is mostly empty box around a
 * little text — the "giant cards" problem. Masonry fixes exactly that: each
 * card sizes to its own content (title + however much description + langs +
 * progress), so there's no dead space, while a synthesised gradient cover keyed
 * off the slug gives the shelf real visual rhythm and makes it scan like a
 * library. CSS columns give the vertical waterfall with no JS. Picking a card
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
  const sort = useShelfSort();
  const [query, setQuery] = useState("");
  // Multi-select kind filter; an empty selection means "all kinds".
  const [kinds, setKinds] = useState<Category[]>([]);

  // One clock read per render, shared by every card's relative "updated" stamp.
  // The shelf re-renders on each return from a book, so the relative times
  // refresh then without a per-second ticker.
  const now = Date.now();

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
      name: (a, z) =>
        a.book.label.localeCompare(z.book.label, lang === "zh" ? "zh" : "en"),
      // Most-recently opened first; never-opened books fall to the bottom,
      // tie-broken by content recency.
      read: (a, z) => {
        const d = readAt(z.book.slug) - readAt(a.book.slug);
        return d !== 0 ? d : changedAt(z.book) - changedAt(a.book);
      },
    };
    return shelfEntries(books).sort(cmp[sort]);
  }, [books, sort, progress, lang]);

  // A card matches the "audiobook" kind if it has audio AT ALL (text+audio books
  // included), so the filter surfaces everything listenable — not just
  // audio-only books. Other kinds match the card's primary category.
  const matchesKind = (e: ShelfEntry, kind: Category): boolean =>
    kind === "audiobook" ? e.hasAudio : e.category === kind;

  // Per-kind totals for the dropdown, over the WHOLE shelf (not the search
  // result), so each row reads as a stable map of what's available.
  const counts = useMemo(() => {
    const c: Record<Category, number> = { book: 0, audiobook: 0, docs: 0 };
    for (const e of entries) {
      for (const k of KIND_ORDER) if (matchesKind(e, k)) c[k] += 1;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // The shelf after both narrowing controls: kind filter AND name search.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (kinds.length > 0 && !kinds.some((k) => matchesKind(e, k))) {
        return false;
      }
      if (
        q && !e.book.label.toLowerCase().includes(q) &&
        !e.book.slug.toLowerCase().includes(q)
      ) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, kinds, query]);

  // Masonry as N independent top-anchored flex columns, NOT CSS multicol.
  // Why: WebKit (Safari/iPad/iPhone) mis-positions the first card of a
  // multicol's 2nd+ column — it gets pushed down so column tops don't align
  // (the `overflow:hidden` cards form BFCs, which WebKit fragments badly at
  // column boundaries). Chromium aligns them; Safari doesn't, and no CSS
  // property reliably pins it (the earlier content-visibility scoping only
  // dodged one variant). A flex row of column stacks gives every column its
  // own `top:0`, so first-card tops are always flush, in every engine — while
  // per-card height variance keeps the waterfall look. Column count is fixed
  // per breakpoint (no JS measuring); cards fan out round-robin (card i →
  // column i % cols), so reading order runs left→right then down.
  const theme = useTheme();
  const upSm = useMediaQuery(theme.breakpoints.up("sm"));
  const upMd = useMediaQuery(theme.breakpoints.up("md"));
  const cols = upMd ? 3 : upSm ? 2 : 1;
  const columns = useMemo(() => {
    const out: ShelfEntry[][] = Array.from({ length: cols }, () => []);
    visible.forEach((e, i) => {
      (out[i % cols] ??= []).push(e);
    });
    return out;
  }, [visible, cols]);

  // Only offer a kind in the dropdown when the shelf actually has one.
  const availableKinds = KIND_ORDER.filter((k) => counts[k] > 0);

  const onKindsChange = (e: SelectChangeEvent<Category[]>): void => {
    const v = e.target.value;
    setKinds(typeof v === "string" ? (v.split(",") as Category[]) : v);
  };

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
      regionEl.style.setProperty(
        "--lv-toolbar-h",
        `${toolbarEl.offsetHeight}px`,
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(toolbarEl);
    return () => {
      ro.disconnect();
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
      const inset = Math.max(
        0,
        globalThis.innerHeight - vv.height - vv.offsetTop,
      );
      regionEl.style.setProperty("--lv-kb-inset", `${inset}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, []);

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
          bgcolor: (t) => alpha(t.palette.background.default, 0.78),
          backdropFilter: "blur(24px) saturate(180%)",
          WebkitBackdropFilter: "blur(24px) saturate(180%)",
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
          // Extra side margin on mobile so the end controls (search box /
          // settings) clear the iPhone's rounded screen corners.
          px: { xs: 2.5, md: 6 },
        }}
      >
        <Box
          sx={{
            maxWidth: 1000,
            mx: "auto",
            display: "flex",
            alignItems: "center",
            gap: 1,
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
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("landing.search")}
                aria-label={t("landing.search")}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="medium" />
                    </InputAdornment>
                  ),
                  endAdornment: query
                    ? (
                      // ui.md §7: no edge="end" (negative margin pins the target to the
                      // iOS back-swipe edge); floor to a ≥40px touch target on phones and
                      // keep the adornment off the safe-area edge.
                      <InputAdornment
                        position="end"
                        sx={{ pr: "max(env(safe-area-inset-right), 8px)" }}
                      >
                        <IconButton
                          size="small"
                          onClick={() => setQuery("")}
                          aria-label={t("landing.searchClear")}
                          sx={{
                            width: { xs: 40, lg: 32 },
                            height: { xs: 40, lg: 32 },
                          }}
                        >
                          <ClearIcon fontSize="medium" />
                        </IconButton>
                      </InputAdornment>
                    )
                    : null,
                }}
                sx={{ flexGrow: 1, minWidth: 0 }}
              />
              {availableKinds.length > 0 && (
                <FormControl
                  size="small"
                  sx={{ flexShrink: 0, width: { xs: 136, sm: 172 } }}
                >
                  <Select
                    multiple
                    displayEmpty
                    value={kinds}
                    onChange={onKindsChange}
                    aria-label={t("landing.filter")}
                    title={t("landing.filter")}
                    input={
                      <OutlinedInput
                        startAdornment={
                          <InputAdornment position="start">
                            <FilterIcon fontSize="medium" />
                          </InputAdornment>
                        }
                      />
                    }
                    // Empty selection reads as a muted "All kinds" placeholder;
                    // otherwise the picked kinds, comma-joined (ellipsized by the
                    // Select when they overflow the compact control).
                    renderValue={(selected) =>
                      selected.length === 0
                        ? (
                          <Box
                            component="span"
                            sx={{ color: "text.secondary" }}
                          >
                            {t("landing.filterAll")}
                          </Box>
                        )
                        : (
                          selected.map((k) => t(KIND_LABEL[k])).join(", ")
                        )}
                  >
                    {availableKinds.map((k) => (
                      <MenuItem key={k} value={k} dense>
                        <Checkbox
                          checked={kinds.includes(k)}
                          size="small"
                          sx={{ py: 0, pl: 0, pr: 1 }}
                        />
                        <ListItemText primary={t(KIND_LABEL[k])} />
                        <Box
                          component="span"
                          sx={{
                            ml: 3,
                            color: "text.secondary",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {counts[k]}
                        </Box>
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
            </>
          )}
          {/* Settings (gear / launcher), pinned at the row's end. */}
          <Box
            sx={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 0.5,
            }}
          >
            {settingsSlot}
          </Box>
        </Box>
      </Box>

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
                // still clears the notch itself.
                pt: "calc(env(safe-area-inset-top, 0px) + 16px)",
                pb: "calc(32px + var(--lv-toolbar-h, 0px))",
                scrollPaddingTop: "calc(env(safe-area-inset-top, 0px) + 16px)",
                scrollPaddingBottom: "var(--lv-toolbar-h, 0px)",
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
          <Box sx={{ maxWidth: 1000, mx: "auto" }}>
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
              : (
                // Flex column stacks (see `columns` above) — a true waterfall with
                // no JS, where every column shares `top:0` so first-card tops are
                // flush in every engine (the CSS-multicol version drifted in
                // WebKit). `alignItems:flex-start` keeps columns top-anchored
                // regardless of their differing total heights.
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "20px",
                  }}
                >
                  {columns.map((col, ci) => (
                    <Box
                      key={ci}
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      {col.map((e) => {
                        const b = e.book;
                        const category = e.category;
                        const langs = b.langs;
                        // Progress is split by rendition: a text+audio book shows
                        // BOTH a reading and a listening meter; single-rendition
                        // books show just the one. The "continue" line resumes the
                        // most-recently-opened rendition.
                        const bp = progress[b.slug];
                        const textP = bp?.text;
                        const audioP = bp?.audio;
                        const pctOf = (r: ReadingProgress): number =>
                          Math.min(
                            100,
                            Math.max(0, Math.round(r.scroll * 100)),
                          );
                        const resume = textP && audioP
                          ? (textP.updatedAt >= audioP.updatedAt
                            ? textP
                            : audioP)
                          : (textP ?? audioP);
                        // The dual-format card shows a rendition switch; the
                        // highlighted "current" segment is the last-used one
                        // (most-recent progress), defaulting to reading for a
                        // never-opened book (the default rendition of a "book").
                        const activeKind: "text" | "audio" = textP && audioP
                          ? (audioP.updatedAt > textP.updatedAt
                            ? "audio"
                            : "text")
                          : audioP
                          ? "audio"
                          : "text";
                        // Stamps line: the book's content recency (the shelf's
                        // default sort key) — when it was last added/edited, shown
                        // relative. "Updated" when it changed after first
                        // appearing, else "Added". The absolute creation date
                        // trails as a second fact only when the book has since
                        // been updated (otherwise it duplicates the line above).
                        const changedAfterAdd = Boolean(
                          b.updated_at && b.updated_at !== b.created_at,
                        );
                        const changedRel = fmtRelative(
                          b.updated_at || b.created_at,
                          now,
                          lang,
                        );
                        const createdStr = fmtDate(b.created_at, lang);
                        const stamps = [
                          changedRel &&
                          t(
                            changedAfterAdd
                              ? "landing.updatedRel"
                              : "landing.addedRel",
                            { time: changedRel },
                          ),
                          changedAfterAdd && createdStr &&
                          t("landing.added", { date: createdStr }),
                        ].filter((s): s is string => Boolean(s));
                        return (
                          <Card
                            key={b.slug}
                            variant="outlined"
                            sx={{
                              mb: "20px",
                              borderRadius: 2,
                              overflow: "hidden",
                              // Skip layout/paint for off-screen cards. The shelf is a
                              // tall list; on a phone (and right after returning from a
                              // book, when the whole shelf re-lays-out at once) the
                              // browser was laying out + painting every card every frame,
                              // which made the first second of scrolling drop inputs.
                              // content-visibility:auto lets the engine skip cards outside
                              // the viewport; contain-intrinsic-size reserves a plausible
                              // box so the scrollbar stays stable. Scoped to xs — that's
                              // where the long single column makes the perf win matter;
                              // sm+ has fewer cards per column and we keep them painted.
                              contentVisibility: { xs: "auto", sm: "visible" },
                              containIntrinsicSize: {
                                xs: "0 320px",
                                sm: "auto",
                              },
                              // Hover lift is a pointer affordance; on touch it fires on
                              // every scroll-tap and forces a repaint mid-scroll, so gate
                              // the transition + lift behind a real hover-capable pointer.
                              "@media (hover: hover)": {
                                transition: "box-shadow 0.18s, transform 0.18s",
                                "&:hover": {
                                  boxShadow: 4,
                                  transform: "translateY(-2px)",
                                },
                              },
                            }}
                          >
                            {
                              /* Standard MUI ripple. (It was dropped once because the
                        shelf was hidden with visibility:hidden while a book was
                        open, which stranded the ripple's exit animation; the
                        shelf now stays painted via opacity:0, so the ripple
                        completes normally.) */
                            }
                            <CardActionArea onClick={() => onOpen(b.slug)}>
                              {
                                /* Cover: the book's own image when it has one, else a
                          slug-keyed gradient + the kind icon. Top-left badge: a
                          book offering BOTH renditions gets a segmented switch
                          (📖 | 🎧) showing both formats + the current one, each
                          opening that rendition; otherwise a single kind badge
                          (Audiobook-only / Book / Docs). Progress is a labeled
                          meter row in the body. */
                              }
                              <BookCover book={b} category={category}>
                                {e.hasText && e.hasAudio
                                  ? (
                                    <CoverRenditionSwitch
                                      slug={b.slug}
                                      activeKind={activeKind}
                                      onOpen={onOpen}
                                      bookLabel={t("landing.bookBadge")}
                                      audioLabel={t("landing.audiobookBadge")}
                                    />
                                  )
                                  : (
                                    // Single-format kind badge — ICON ONLY (no
                                    // text): the glyph already names the kind and
                                    // the big cover icon repeats it, so the label
                                    // was redundant. PRIMARY colour (not neutral):
                                    // a lone badge means that format is the active
                                    // one, so it reads like the highlighted segment
                                    // of the dual-format switch.
                                    <Box
                                      aria-label={t(
                                        category === "docs"
                                          ? "landing.docsBadge"
                                          : e.hasAudio
                                          ? "landing.audiobookBadge"
                                          : "landing.bookBadge",
                                      )}
                                      sx={{
                                        position: "absolute",
                                        top: 8,
                                        left: 8,
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
                                      {category === "docs"
                                        ? (
                                          <DocsIcon
                                            sx={{ fontSize: rem(17) }}
                                          />
                                        )
                                        : e.hasAudio
                                        ? (
                                          <AudiobookIcon
                                            sx={{ fontSize: rem(17) }}
                                          />
                                        )
                                        : (
                                          <BookIcon
                                            sx={{ fontSize: rem(17) }}
                                          />
                                        )}
                                    </Box>
                                  )}
                              </BookCover>
                              <Box sx={{ p: 1.75 }}>
                                <Typography
                                  variant="subtitle1"
                                  fontWeight={700}
                                  sx={{ lineHeight: 1.3 }}
                                >
                                  {b.label}
                                </Typography>
                                {b.description
                                  ? (
                                    <Typography
                                      variant="body2"
                                      color="text.secondary"
                                      sx={{
                                        mt: 0.5,
                                        // Clamp long blurbs but let short ones stay short —
                                        // the height variance is what makes the masonry work.
                                        display: "-webkit-box",
                                        WebkitLineClamp: 5,
                                        WebkitBoxOrient: "vertical",
                                        overflow: "hidden",
                                      }}
                                    >
                                      {b.description}
                                    </Typography>
                                  )
                                  : (
                                    <Typography
                                      variant="body2"
                                      color="text.disabled"
                                      fontStyle="italic"
                                      sx={{ mt: 0.5 }}
                                    >
                                      /{b.slug}
                                    </Typography>
                                  )}
                                {
                                  /* Progress as a labeled meter per rendition —
                                  reading and/or listening, side by side. The
                                  mode icon names each; the fill + % show how
                                  far. A clean per-item meter (Audiobookshelf /
                                  Plex idiom) instead of stacked naked bars. */
                                }
                                {
                                  /* Once a book has ANY progress, show a meter
                                    for EACH rendition it offers — reading and/or
                                    listening — so an opened audiobook still shows
                                    its 📖 book progress (0% until read), not just
                                    the 🎧. A never-opened book stays meter-free. */
                                }
                                {(textP || audioP) && (
                                  <Box
                                    sx={{ display: "flex", gap: 1, mt: 1.25 }}
                                  >
                                    {e.hasText && (
                                      <ProgressMeter
                                        icon={
                                          <BookIcon
                                            sx={{ fontSize: rem(15) }}
                                          />
                                        }
                                        pct={textP ? pctOf(textP) : 0}
                                      />
                                    )}
                                    {e.hasAudio && (
                                      <ProgressMeter
                                        icon={
                                          <AudiobookIcon
                                            sx={{ fontSize: rem(15) }}
                                          />
                                        }
                                        pct={audioP ? pctOf(audioP) : 0}
                                      />
                                    )}
                                  </Box>
                                )}
                                {
                                  /* Resume the most-recently-opened rendition. */
                                }
                                {resume && (
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    sx={{
                                      display: "block",
                                      mt: 1,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                    title={resume.chapterLabel}
                                  >
                                    {t("landing.continue", {
                                      chapter: resume.chapterLabel,
                                    })}
                                  </Typography>
                                )}
                                {langs.length > 1 && (
                                  <Box
                                    sx={{
                                      display: "flex",
                                      flexWrap: "wrap",
                                      gap: 0.5,
                                      mt: 1,
                                    }}
                                  >
                                    {langs.map((l) => (
                                      <Chip
                                        key={l.lang}
                                        label={l.label}
                                        size="small"
                                        variant="outlined"
                                      />
                                    ))}
                                  </Box>
                                )}
                                {stamps.length > 0 && (
                                  <Typography
                                    variant="caption"
                                    color="text.disabled"
                                    sx={{ display: "block", mt: 1 }}
                                  >
                                    {stamps.join(" · ")}
                                  </Typography>
                                )}
                              </Box>
                            </CardActionArea>
                          </Card>
                        );
                      })}
                    </Box>
                  ))}
                </Box>
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
