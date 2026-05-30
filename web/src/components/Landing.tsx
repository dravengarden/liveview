import {
  Box,
  Card,
  CardActionArea,
  Chip,
  LinearProgress,
  Typography,
} from "@mui/material";
import {
  AutoStories as ShelfIcon,
  MenuBook as BookIcon,
  Article as DocsIcon,
} from "@mui/icons-material";
import { useState, type ReactNode } from "react";
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

/** A book card's cover: the real cover image when the book has one (lazy-loaded,
 *  falling back to the synthesised gradient if it fails to load), else the
 *  gradient straight away. The kind icon + progress badge ride on top in both
 *  cases. */
function BookCover({
  book,
  children,
}: {
  book: Book;
  children: ReactNode;
}): React.JSX.Element {
  // Once the <img> errors we permanently fall back to the gradient for this
  // card (avoids a broken-image flash on every re-render).
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = book.cover && !imgFailed;
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
      ) : // No image (or it failed): show the kind icon over the gradient.
      book.manifest ? (
        <BookIcon sx={{ fontSize: 52, color: "rgba(255,255,255,0.92)" }} />
      ) : (
        <DocsIcon sx={{ fontSize: 52, color: "rgba(255,255,255,0.92)" }} />
      )}
      {children}
    </Box>
  );
}

/**
 * The "bookshelf" landing page: a masonry of book cards.
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
 */
export function Landing({
  books,
  progress,
  onOpen,
  onHome,
  settingsSlot,
}: LandingProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Box
      sx={{
        flex: 1,
        // Pair with the flex-column parent so this column owns the scroll
        // (min-height:0 lets it shrink below content, engaging overflow:auto).
        minHeight: 0,
        overflow: "auto",
        px: { xs: 2, md: 6 },
        pb: { xs: 4, md: 6 },
        // Clear the iPhone status bar / notch; the toolbar sits below it.
        pt: {
          xs: "calc(env(safe-area-inset-top, 0px) + 12px)",
          md: "calc(env(safe-area-inset-top, 0px) + 24px)",
        },
      }}
    >
      <Box sx={{ maxWidth: 1000, mx: "auto" }}>
        {/* Header on one row: title (home link) left, controls right — so the
            title shares the top bar instead of being pushed onto its own line
            below an otherwise-empty toolbar. Settings then the portal launcher
            (rightmost; self-hides when not hosted). */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
            minHeight: 40,
            mb: 0.5,
          }}
        >
          {/* The title doubles as a home link: clicking it clears any deep link
              and returns to a clean bookshelf (useful when a page has gone). */}
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
              gap: 1.5,
              minWidth: 0,
              cursor: "pointer",
              borderRadius: 1,
              "&:hover": { opacity: 0.8 },
            }}
          >
            <ShelfIcon sx={{ fontSize: 36, color: "primary.main", flexShrink: 0 }} />
            <Typography variant="h4" fontWeight={700} noWrap>
              {t("landing.title")}
            </Typography>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
            {settingsSlot}
            <PortalLauncherButton />
          </Box>
        </Box>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
          {books.length > 0 ? t("landing.subtitle", { n: books.length }) : t("landing.empty")}
        </Typography>

        {books.length === 0 ? (
          <Typography color="text.secondary">{t("landing.noMounts")}</Typography>
        ) : (
          // CSS multi-column = a true vertical waterfall with no JS, but only
          // from `sm` up: on a phone it's one column anyway, and iOS Safari's
          // multicol + break-inside is buggy (cards render blank), so drop to
          // plain block flow (columnWidth:auto) on xs. Cards stay
          // break-inside:avoid + margin-bottom, which work in both modes.
          <Box sx={{ columnWidth: { xs: "auto", sm: "260px" }, columnGap: "20px" }}>
            {books.map((b) => {
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
                  <CardActionArea onClick={() => onOpen(b.slug)}>
                    {/* Cover: the book's own image when it has one, else a
                        slug-keyed gradient + the kind icon (book vs docs). The %
                        badge for books in progress rides on top in both cases. */}
                    <BookCover book={b}>
                      {p && (
                        <Chip
                          label={`${pct}%`}
                          size="small"
                          sx={{
                            position: "absolute",
                            top: 8,
                            right: 8,
                            bgcolor: "rgba(0,0,0,0.4)",
                            color: "#fff",
                            fontVariantNumeric: "tabular-nums",
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
  );
}
