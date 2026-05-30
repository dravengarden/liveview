import {
  Box,
  Card,
  CardActionArea,
  Chip,
  IconButton,
  InputAdornment,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  AutoStories as ShelfIcon,
  MenuBook as BookIcon,
  Article as DocsIcon,
  Headphones as AudiobookIcon,
  Search as SearchIcon,
  Clear as ClearIcon,
} from "@mui/icons-material";
import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { Book, ReadingProgress } from "@/types";
import { useI18n } from "@/i18n";
import { PortalLauncherButton } from "../_shell";

interface LandingProps {
  books: Book[];
  /** Per-book "continue reading" state, keyed by slug; absent ⇒ never opened. */
  progress: Record<string, ReadingProgress>;
  onOpen: (slug: string) => void;
  /** Return to a clean bookshelf (clears any deep link) — the title is a home link. */
  onHome: () => void;
  /** The shared SettingsSheet (gear + responsive sheet), placed in the header. */
  settingsSlot: ReactNode;
}

/** The shelf splits into three mutually-exclusive kinds, each with its own card
 *  treatment and filter chip. A `book.toml` book that ships an audio rendition
 *  is an "audiobook" — it still carries text, but the listen affordance is its
 *  defining feature on the shelf, so it gets the headphones card and lives under
 *  the 有声书 filter (not double-counted under books). A `book.toml` book with no
 *  audio is a plain "book"; a raw `[[book]]`/`[[mount]]` tree is "docs". */
type Category = "book" | "audiobook" | "docs";
/** `all` is the no-filter pseudo-category the leftmost chip selects. */
type Filter = "all" | Category;

function bookCategory(b: Book): Category {
  if (!b.manifest) return "docs";
  if (b.renditions.some((r) => r.kind === "audio")) return "audiobook";
  return "book";
}

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
  return `linear-gradient(135deg, hsl(${h} 52% 52%), hsl(${(h + 38) % 360} 48% 42%))`;
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
      {showImage ? (
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
      ) : (
        // No image (or it failed): show the kind icon over the gradient.
        <KindIcon sx={{ fontSize: 52, color: "rgba(255,255,255,0.92)" }} />
      )}
      {children}
    </Box>
  );
}

/** A pill that rides on a card cover (audio badge, progress %). Dark scrim so
 *  white text/icon reads over any gradient or cover image. */
const coverChipSx = {
  bgcolor: "rgba(0,0,0,0.4)",
  color: "#fff",
  "& .MuiChip-icon": { color: "#fff" },
} as const;

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
 * The navbar stays put while the shelf scrolls so search/filters/settings are
 * always one tap away. Search matches by name (label/slug); the filter chips
 * narrow the shelf to one kind (书 / 有声书 / docs) and combine with search.
 */
export function Landing({
  books,
  progress,
  onOpen,
  onHome,
  settingsSlot,
}: LandingProps): React.JSX.Element {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  // Per-kind totals for the filter chips, over the WHOLE shelf (not the search
  // result), so the chips read as a stable map of what's available.
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: books.length, book: 0, audiobook: 0, docs: 0 };
    for (const b of books) c[bookCategory(b)] += 1;
    return c;
  }, [books]);

  // The shelf after both narrowing controls: kind filter AND name search.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return books.filter((b) => {
      if (filter !== "all" && bookCategory(b) !== filter) return false;
      if (q && !b.label.toLowerCase().includes(q) && !b.slug.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [books, filter, query]);

  // Leftmost "All" always shows; a kind chip only appears when the shelf has at
  // least one of that kind (no dead "有声书 0" chip).
  const allChips: { key: Filter; labelKey: string; icon?: ReactElement }[] = [
    { key: "all", labelKey: "landing.filterAll" },
    { key: "book", labelKey: "landing.filterBooks", icon: <BookIcon /> },
    { key: "audiobook", labelKey: "landing.filterAudiobooks", icon: <AudiobookIcon /> },
    { key: "docs", labelKey: "landing.filterDocs", icon: <DocsIcon /> },
  ];
  const filterChips = allChips.filter((f) => f.key === "all" || counts[f.key] > 0);

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
      {/* ── Sticky navbar ──────────────────────────────────────────────────
          Neutral chrome (background.default + divider, not a saturated bar —
          ui.md §4) that sticks to the top of the scroll container, so settings,
          the launcher, search and the filters stay reachable however far the
          shelf is scrolled. It owns the safe-area top inset so its background
          covers the notch. */}
      <Box
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          bgcolor: "background.default",
          borderBottom: 1,
          borderColor: "divider",
          pt: "calc(env(safe-area-inset-top, 0px) + 8px)",
          px: { xs: 2, md: 6 },
        }}
      >
        <Box sx={{ maxWidth: 1000, mx: "auto", display: "flex", flexDirection: "column", gap: 1, pb: 1 }}>
          {/* Row 1: title (home link) · settings · launcher (rightmost,
              self-hides when not hosted). */}
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, minHeight: 40 }}>
            <Box
              role="button"
              tabIndex={0}
              aria-label={t("landing.home")}
              title={t("landing.home")}
              onClick={onHome}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onHome();
                }
              }}
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 1.25,
                minWidth: 0,
                cursor: "pointer",
                borderRadius: 1,
                "&:hover": { opacity: 0.8 },
              }}
            >
              <ShelfIcon sx={{ fontSize: 30, color: "primary.main", flexShrink: 0 }} />
              <Typography variant="h5" fontWeight={700} noWrap>
                {t("landing.title")}
              </Typography>
            </Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
              {settingsSlot}
              <PortalLauncherButton />
            </Box>
          </Box>

          {/* Row 2: search + filter chips. Wraps on narrow widths — search takes
              the first row, chips drop below — so nothing is a horizontal-scroll
              strip (ui.md §7). Hidden entirely on an empty shelf. */}
          {books.length > 0 && (
            <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
              <TextField
                size="small"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("landing.search")}
                aria-label={t("landing.search")}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                  endAdornment: query ? (
                    <InputAdornment position="end">
                      <IconButton size="small" edge="end" onClick={() => setQuery("")} aria-label={t("landing.searchClear")}>
                        <ClearIcon fontSize="small" />
                      </IconButton>
                    </InputAdornment>
                  ) : null,
                }}
                sx={{ flexGrow: 1, flexBasis: 200, minWidth: 160, maxWidth: 360 }}
              />
              <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1 }}>
                {filterChips.map((f) => {
                  const selected = filter === f.key;
                  return (
                    <Chip
                      key={f.key}
                      icon={f.icon}
                      label={`${t(f.labelKey)} · ${counts[f.key]}`}
                      onClick={() => setFilter(f.key)}
                      // Selected = accent fill (the you-are-here treatment, ui.md
                      // §6), never a dimmed chip.
                      color={selected ? "primary" : "default"}
                      variant={selected ? "filled" : "outlined"}
                      aria-pressed={selected}
                      sx={{ fontVariantNumeric: "tabular-nums" }}
                    />
                  );
                })}
              </Stack>
            </Box>
          )}
        </Box>
      </Box>

      {/* ── Shelf ──────────────────────────────────────────────────────────── */}
      <Box sx={{ px: { xs: 2, md: 6 }, pt: 2, pb: { xs: 4, md: 6 } }}>
        <Box sx={{ maxWidth: 1000, mx: "auto" }}>
          {books.length === 0 ? (
            <Typography color="text.secondary">{t("landing.noMounts")}</Typography>
          ) : visible.length === 0 ? (
            <Typography color="text.secondary">{t("landing.noResults")}</Typography>
          ) : (
            // CSS multi-column = a true vertical waterfall with no JS, but only
            // from `sm` up: on a phone it's one column anyway, and iOS Safari's
            // multicol + break-inside is buggy (cards render blank), so drop to
            // plain block flow (columnWidth:auto) on xs. Cards stay
            // break-inside:avoid + margin-bottom, which work in both modes.
            <Box sx={{ columnWidth: { xs: "auto", sm: "260px" }, columnGap: "20px" }}>
              {visible.map((b) => {
                const category = bookCategory(b);
                const p = progress[b.slug];
                const pct = p ? Math.min(100, Math.max(0, Math.round(p.scroll * 100))) : 0;
                return (
                  <Card
                    key={b.slug}
                    variant="outlined"
                    sx={{
                      breakInside: "avoid",
                      mb: "20px",
                      borderRadius: 2,
                      overflow: "hidden",
                      // Skip layout/paint for off-screen cards. The shelf is a tall
                      // CSS-multicol list; on a phone (and right after returning
                      // from a book, when the whole shelf re-lays-out at once) the
                      // browser was laying out + painting every card every frame,
                      // which made the first second of scrolling drop inputs.
                      // content-visibility:auto lets the engine skip cards outside
                      // the viewport; contain-intrinsic-size reserves a plausible
                      // box so the scrollbar/column balance stays stable.
                      contentVisibility: "auto",
                      containIntrinsicSize: "0 320px",
                      // Hover lift is a pointer affordance; on touch it fires on
                      // every scroll-tap and forces a repaint mid-scroll, so gate
                      // the transition + lift behind a real hover-capable pointer.
                      "@media (hover: hover)": {
                        transition: "box-shadow 0.18s, transform 0.18s",
                        "&:hover": { boxShadow: 4, transform: "translateY(-2px)" },
                      },
                    }}
                  >
                    {/* disableRipple: the bookshelf is kept mounted while a
                        book is open (visibility:hidden, no remount). A press
                        ripple started here can't run its exit animation while
                        hidden, so it lingers on the card for seconds after
                        returning. Navigation is its own feedback — drop the
                        ripple. */}
                    <CardActionArea disableRipple onClick={() => onOpen(b.slug)}>
                      {/* Cover: the book's own image when it has one, else a
                          slug-keyed gradient + the kind icon. Audiobooks carry an
                          audio badge (top-left); books in progress carry a % badge
                          (top-right). */}
                      <BookCover book={b} category={category}>
                        {category === "audiobook" && (
                          <Chip
                            icon={<AudiobookIcon />}
                            label={t("landing.filterAudiobooks")}
                            size="small"
                            sx={{ position: "absolute", top: 8, left: 8, ...coverChipSx }}
                          />
                        )}
                        {p && (
                          <Chip
                            label={`${pct}%`}
                            size="small"
                            sx={{
                              position: "absolute",
                              top: 8,
                              right: 8,
                              fontVariantNumeric: "tabular-nums",
                              ...coverChipSx,
                            }}
                          />
                        )}
                      </BookCover>
                      <Box sx={{ p: 1.75 }}>
                        <Typography variant="subtitle1" fontWeight={700} sx={{ lineHeight: 1.3 }}>
                          {b.label}
                        </Typography>
                        {b.description ? (
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
                        ) : (
                          <Typography variant="body2" color="text.disabled" fontStyle="italic" sx={{ mt: 0.5 }}>
                            /{b.slug}
                          </Typography>
                        )}
                        {p && (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: "block", mt: 1 }}
                            title={p.chapterLabel}
                          >
                            {t("landing.continue", { chapter: p.chapterLabel })}
                          </Typography>
                        )}
                        {b.langs.length > 1 && (
                          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 1 }}>
                            {b.langs.map((l) => (
                              <Chip key={l.lang} label={l.label} size="small" variant="outlined" />
                            ))}
                          </Box>
                        )}
                      </Box>
                      {p && <LinearProgress variant="determinate" value={pct} aria-hidden sx={{ height: 3 }} />}
                    </CardActionArea>
                  </Card>
                );
              })}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
