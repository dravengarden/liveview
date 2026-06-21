import { Box, LinearProgress, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { alpha } from "@mui/material/styles";
import { CloudDownload, ExpandMore, GraphicEq } from "@mui/icons-material";
import { DetentSheet } from "../_shell";
import { useNavbarAtBottom } from "@/hooks";
import {
  type BookAudioStatus,
  refreshSyncStatus,
  useSyncStatus,
} from "@/syncStore";
import { useI18n } from "@/i18n";

/**
 * The ambient sync indicator — a flat, full-bleed chrome LINE pinned to the very
 * top of the viewport (just under the status bar), appearing ONLY while audio is
 * generating or the SW is prefetching and quietly vanishing when idle. It shares
 * the visual language of the reader's top reading-progress bar: a thin strip with
 * a progress filament along its bottom edge. Deliberately NOT a floating card —
 * no shadow, no rounded corners, no border ring — so it reads as part of the
 * chrome (a sibling of the nav bar) rather than something hovering over it.
 * Tapping it opens the Sync sheet (per-task progress breakdown). Offline is
 * automatic — reading and listened audio are cached as you go, no per-book
 * toggle — so the sheet is purely a status view. Calm-tech: the user knows, but
 * it weighs almost nothing.
 */
export function SyncIndicator(
  { inReader = false }: { inReader?: boolean },
): React.JSX.Element | null {
  const { t } = useI18n();
  const status = useSyncStatus();
  // On mobile the nav bar drops to the bottom, leaving the top free for this
  // strip (under the safe-area status bar). On desktop the NavShell bar owns the
  // top, so the strip rides at top:0 as a hairline above it.
  const navbarAtBottom = useNavbarAtBottom();
  const [open, setOpen] = useState(false);

  // The strip surfaces only GENUINE background work — audio GENERATION. Routine
  // offline prefetch (warming text/audio as you browse) is instant-ish and stays
  // SILENT: it never pops the top strip. So "nothing needs sync" ⇒ no strip.
  const g = status.global;
  const generatingBooks = status.books.filter(
    (b) => b.pending > 0 || b.failed > 0,
  );
  const activeCount = status.books.filter((b) => b.pending > 0).length;
  const generating = g.pending > 0;
  const pct = g.total > 0 ? Math.round((g.done / g.total) * 100) : null;
  // The strip's short label (it also carries the count + a progress filament).
  const barLabel = activeCount > 1
    ? t("sync.generatingN", { n: activeCount })
    : t("sync.generating");

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
  // The strip sits at the BOTTOM in the reader (foot padding: MarkdownViewer /
  // AudiobookPlayer pb add --lv-syncbar-h) and at the TOP on the shelf (head
  // padding: Landing's pt). Mobile only: there the strip overlays content; on
  // desktop it rides over the NavShell bar, which owns its own space, so leave
  // that tier alone. 28px = the 26px row + 2px filament.
  useEffect(() => {
    const el = document.documentElement;
    if (generating && !open && navbarAtBottom) {
      el.style.setProperty("--lv-syncbar-h", "28px");
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
      {generating && !open && (
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
            ...(navbarAtBottom && inReader
              ? {
                bottom:
                  "calc(var(--shell-bar-h, 0px) + var(--lv-transport-h, 0px))",
                borderTop: 1,
              }
              : {
                top: navbarAtBottom ? "env(safe-area-inset-top, 0px)" : 0,
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
            // desktop it rides over the NavShell bar, so keep the lighter touch.
            bgcolor: (th) =>
              alpha(th.palette.background.default, navbarAtBottom ? 0.96 : 0.82),
            // Mobile: near-opaque (0.96) over the scrolling reader → NO blur
            // (it would re-rasterize the moving content every frame for an
            // invisible result = scroll jank). Desktop: translucent (0.82) over
            // the NavShell bar, not the scroller, so keep its glass blur.
            ...(navbarAtBottom ? {} : {
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
            }),
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
              height: 26,
            }}
          >
            {/* Leading glyph only — NOT a progress indicator. The single
                progress cue is the filament along the edge (+ the count); a
                spinner here duplicated it. */}
            <GraphicEq sx={{ fontSize: 14, flexShrink: 0, opacity: 0.7 }} />
            <Typography
              noWrap
              sx={{
                flex: 1,
                fontSize: 12,
                fontWeight: 500,
                color: "text.secondary",
              }}
            >
              {barLabel}
            </Typography>
            {pct != null && (
              <Typography
                sx={{
                  fontSize: 11,
                  color: "text.disabled",
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                {g.done}/{g.total}
              </Typography>
            )}
            <ExpandMore sx={{ fontSize: 16, flexShrink: 0, opacity: 0.5 }} />
          </Box>
          {/* Aggregate progress filament along the strip's bottom edge — the same
              cue the reader uses for reading progress, so the two read as kin. */}
          {pct != null && (
            <Box
              sx={{
                height: 2,
                width: `${pct}%`,
                bgcolor: "primary.main",
                opacity: 0.8,
                transition: "width .3s ease",
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
