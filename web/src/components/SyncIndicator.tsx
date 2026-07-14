import { Box, LinearProgress, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { alpha } from "@mui/material/styles";
import { CloudDownload, ExpandMore, GraphicEq } from "@mui/icons-material";
import { DetentSheet, useAnyDetentSheetOpen } from "../_shell";
import { useNavbarAtBottom } from "@/hooks";
import { rem } from "@/px";
import {
  type BookAudioStatus,
  refreshSyncStatus,
  useSyncStatus,
} from "@/syncStore";
import { useI18n } from "@/i18n";

/**
 * The ambient sync indicator — a flat, full-bleed chrome LINE that appears ONLY
 * while audio is generating or the SW is prefetching and quietly vanishes when
 * idle. On mobile it's the topmost segment of the ONE frosted BOTTOM slab — above
 * the nav bar + transport in the reader, above the bookshelf toolbar on the shelf
 * — so the whole bottom chrome reads as one backplate. On desktop it rides at the
 * top, a hairline above the NavShell bar. It shares the visual language of the
 * reader's reading-progress bar: a thin strip with a progress filament along its
 * edge. Deliberately NOT a floating card —
 * no shadow, no rounded corners, no border ring — so it reads as part of the
 * chrome (a sibling of the nav bar) rather than something hovering over it.
 * Tapping it opens the Sync sheet (per-task progress breakdown). Offline is
 * automatic — reading and listened audio are cached as you go, no per-book
 * toggle — so the sheet is purely a status view. Calm-tech: the user knows, but
 * it weighs almost nothing.
 *
 * SCOPE (the important bit): a progress bar's fill must map to a goal the USER
 * owns. The global queue ("739 chapters across the whole library") is the
 * SYSTEM's goal, not the reader's — showing it as a near-full percentage right
 * above the playback scrubber was misleading (your just-opened book can be 0%
 * done while the global bar reads 99%) and competed visually with the scrubber.
 * So in the reader the strip is SCOPED to the book you're in: it tracks only
 * that book's narration toward 100% (a goal you actually own) and goes silent
 * the moment that book is done — even while other books keep generating in the
 * background. The global, all-books breakdown still lives in the expandable
 * sheet. On the shelf (no current book) there's no single goal to fill toward,
 * so the strip shows an AMBIENT, indeterminate "generating…" cue — no count,
 * no percentage.
 */
export function SyncIndicator(
  { bookSlug = null }: { bookSlug?: string | null },
): React.JSX.Element | null {
  const { t } = useI18n();
  const status = useSyncStatus();
  // On mobile the nav/toolbar sits at the bottom, so the strip joins it there as
  // the top of the one frosted bottom slab. On desktop the NavShell bar owns the
  // top, so the strip rides at top:0 as a hairline above it.
  const navbarAtBottom = useNavbarAtBottom();
  const [open, setOpen] = useState(false);
  // Hide the ambient bottom strip while ANY DetentSheet (Settings, TOC, the
  // PlaybackSheet…) is open — the strip is fixed at appBar z-index and would
  // otherwise float OVER the sheet's content.
  const anySheetOpen = useAnyDetentSheetOpen();

  // The strip surfaces only GENUINE background work — audio GENERATION. Routine
  // offline prefetch (warming text/audio as you browse) is instant-ish and stays
  // SILENT: it never pops the top strip. So "nothing needs sync" ⇒ no strip.
  const inReader = bookSlug != null;
  const g = status.global;
  // Per-book rows for the sheet (the global breakdown lives there, not on the
  // collapsed strip).
  const generatingBooks = status.books.filter(
    (b) => b.pending > 0 || b.failed > 0,
  );
  // The book you're currently in — the only one the collapsed strip tracks while
  // reading. `scoped` is set only while THAT book still has work; once it's done
  // the strip falls silent (your goal is met) regardless of other books.
  const currentBook = bookSlug
    ? status.books.find((b) => b.slug === bookSlug) ?? null
    : null;
  const scoped = inReader
    ? (currentBook && currentBook.pending > 0 ? currentBook : null)
    : null;
  // Visibility: in the reader gate on the CURRENT book's work; on the shelf, on
  // any global work (ambient cue). `pct` is determinate only when scoped to a
  // book — the shelf cue is indeterminate (no goal to fill toward).
  const generating = inReader ? scoped != null : g.pending > 0;
  const pct = scoped && scoped.total > 0
    ? Math.round((scoped.done / scoped.total) * 100)
    : null;
  // Reader: "this book's audio" (the count rides alongside). Shelf: ambient.
  const barLabel = inReader
    ? t("sync.generatingBook")
    : t("sync.generatingAmbient");

  // Initial fetch, then poll while work is in flight (progress ticks) or while
  // the sheet is open (so a prefetch row updates live).
  useEffect(() => {
    void refreshSyncStatus();
  }, []);
  useEffect(() => {
    if (!generating && !open) return undefined;
    const id = window.setInterval(() => void refreshSyncStatus(), 5000);
    return () => window.clearInterval(id);
  }, [generating, open]);

  // Reserve the strip's height so content clears it yet still scrolls UNDER it.
  // Mobile: the strip sits at the BOTTOM in BOTH the reader (foot padding:
  // MarkdownViewer / AudiobookPlayer pb add --lv-syncbar-h) and the shelf (foot
  // padding: Landing's pb). Mobile only: there the strip overlays content; on
  // desktop it rides over the NavShell bar, which owns its own space, so leave
  // that tier alone. 28px = the 26px row + 2px filament.
  useEffect(() => {
    const el = document.documentElement;
    if (generating && !open && navbarAtBottom) {
      // rem so the reserved space scales WITH the strip when the global font
      // size changes (the strip's own text/height are rem too — see below).
      el.style.setProperty("--lv-syncbar-h", rem(28));
    } else {
      el.style.removeProperty("--lv-syncbar-h");
    }
    return () => {
      el.style.removeProperty("--lv-syncbar-h");
    };
  }, [generating, open, navbarAtBottom]);

  if (!generating && !open) return null;

  return (
    <>
      {generating && !open && !anySheetOpen && (
        <Box
          role="button"
          tabIndex={0}
          aria-label={t("sync.title")}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setOpen(true);
          }}
          sx={{
            // A flat, full-bleed chrome LINE — no rounding / shadow / ring: it's
            // chrome, not a floating card; content scrolls under it.
            //   • Reader (mobile): pinned to the BOTTOM, ABOVE the nav bar and
            //     the transport (when read-aloud/audio is up) — the topmost
            //     segment of the ONE frosted bottom slab (nav + transport share
            //     a backplate; this continues it). Offsets by their mirrored
            //     heights (--shell-bar-h + --lv-transport-h on documentElement).
            //   • Shelf / desktop: no bottom nav bar to sit above, so it stays a
            //     top strip (under the status bar on mobile; a hairline above the
            //     NavShell top bar on desktop).
            position: "fixed",
            left: 0,
            right: 0,
            ...(navbarAtBottom
              ? {
                // Mobile: the topmost segment of the ONE frosted bottom slab.
                //   • Reader → above the nav bar + transport (their mirrored
                //     heights on documentElement).
                //   • Shelf → above the bookshelf toolbar (--lv-toolbar-h, also
                //     mirrored to documentElement by Landing).
                // Either way it continues the bottom backplate (border on top).
                bottom: inReader
                  ? "calc(var(--shell-bar-h, 0px) + var(--lv-transport-h, 0px))"
                  : "var(--lv-toolbar-h, 0px)",
                borderTop: 1,
              }
              : {
                // Desktop: the NavShell bar owns the top, so ride at top:0 as a
                // hairline above it.
                top: 0,
                borderBottom: 1,
              }),
            zIndex: (th) => th.zIndex.appBar,
            cursor: "pointer",
            overflow: "hidden", // clip the progress filament to the edges
            color: "text.secondary",
            // Strong frost so content scrolling UNDER the strip is cleanly
            // obscured, not bled-through to collide with the label. On mobile the
            // strip overlays the reading content (its space is reserved above),
            // so it must read as solid chrome — near-opaque + a heavy blur. On
            // desktop it rides over the NavShell bar, but a static material keeps
            // the same component safe when responsive layout changes move it over
            // the scroller.
            bgcolor: (th) =>
              alpha(th.palette.background.default, navbarAtBottom ? 0.96 : 0.92),
            // No backdrop-filter: this fixed status surface can overlap a reader
            // or shelf after a breakpoint change, and WKWebView otherwise
            // re-rasterizes the moving page beneath it on every frame.
            borderColor: "divider",
            "@media (hover: hover)": {
              transition: "background-color .15s",
              "&:hover": {
                bgcolor: (th) => alpha(th.palette.background.default, 0.92),
              },
            },
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 1.5,
              // rem (not fixed px) so the whole strip — text AND height — scales
              // with the app-wide font-size setting, like the rest of the UI.
              // minHeight (not height) so a larger font can't clip the row.
              minHeight: rem(26),
            }}
          >
            {/* Leading glyph only — NOT a progress indicator. The single
                progress cue is the filament along the edge (+ the count); a
                spinner here duplicated it. */}
            <GraphicEq sx={{ fontSize: rem(14), flexShrink: 0, opacity: 0.7 }} />
            <Typography
              noWrap
              sx={{
                flex: 1,
                fontSize: rem(12),
                fontWeight: 500,
                color: "text.secondary",
              }}
            >
              {barLabel}
            </Typography>
            {/* Count = THIS book's chapters (reader scope) — never the global
                739. The shelf's ambient cue carries no count. */}
            {scoped && (
              <Typography
                sx={{
                  fontSize: rem(11),
                  color: "text.disabled",
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                {scoped.done}/{scoped.total}
              </Typography>
            )}
            <ExpandMore sx={{ fontSize: rem(16), flexShrink: 0, opacity: 0.5 }} />
          </Box>
          {/* Progress filament along the strip's bottom edge — same cue as the
              reader's reading-progress bar, so the two read as kin. Reader:
              DETERMINATE, filling toward this book's 100% (a goal you own).
              Shelf: INDETERMINATE shimmer — work is happening but there's no
              single goal to fill toward, so no false percentage. */}
          {scoped
            ? (
              <Box
                sx={{
                  height: 2,
                  width: `${pct}%`,
                  bgcolor: "primary.main",
                  opacity: 0.8,
                  transition: "width .3s ease",
                }}
              />
            )
            : (
              <LinearProgress
                sx={{
                  height: 2,
                  backgroundColor: "transparent",
                  "& .MuiLinearProgress-bar": {
                    backgroundColor: "primary.main",
                    opacity: 0.8,
                  },
                }}
              />
            )}
        </Box>
      )}

      <DetentSheet
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel={t("sync.title")}
        frosted
        header={
          // px matches the body's px:2 so the title aligns with the rows below.
          <Typography variant="subtitle1" sx={{ fontWeight: 700, px: 2, pb: 0.5 }}>
            {t("sync.title")}
          </Typography>
        }
      >
        <Box sx={{ px: 2, pb: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
          {/* One row per currently-syncing resource, each with its own progress.
              Generation rows are determinate (done/total); the offline prefetch is
              indeterminate (no per-file total). */}
          {generatingBooks.map((b) => <GeneratingRow key={b.slug} book={b} t={t} />)}

          {status.prefetching > 0 && (
            <Box sx={{ py: 0.5 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
                <CloudDownload sx={{ fontSize: 16, color: "text.secondary" }} />
                <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: 600 }}>
                  {t("sync.prefetching")}
                </Typography>
              </Box>
              <LinearProgress sx={{ height: 4, borderRadius: 2 }} />
            </Box>
          )}

          {!generating && status.prefetching === 0 && (
            <Typography variant="body2" color="text.secondary">
              {t("sync.upToDate")}
            </Typography>
          )}

          {/* Offline is automatic — no per-book switches. Reading is cached on
              open; audio is cached as you listen (content-addressed, survives
              deploys). Just a reassuring one-liner. */}
          <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5 }}>
            {t("sync.offlineAuto")}
          </Typography>
        </Box>
      </DetentSheet>
    </>
  );
}

function GeneratingRow(
  { book, t }: {
    book: BookAudioStatus;
    t: (k: string, vars?: Record<string, string | number>) => string;
  },
): React.JSX.Element {
  const pct = book.total > 0 ? Math.round((book.done / book.total) * 100) : 0;
  return (
    <Box sx={{ py: 0.75 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <GraphicEq sx={{ fontSize: 16, color: "text.secondary" }} />
        <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: 600 }}>
          {book.slug}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontVariantNumeric: "tabular-nums" }}
        >
          {book.done}/{book.total}
        </Typography>
        {book.failed > 0 && (
          <Typography variant="caption" color="error.main">
            {t("sync.failedCount", { n: book.failed })}
          </Typography>
        )}
      </Box>
      <LinearProgress
        variant="determinate"
        value={pct}
        sx={{ height: 4, borderRadius: 2 }}
      />
    </Box>
  );
}
