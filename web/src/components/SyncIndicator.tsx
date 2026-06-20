import {
  Box,
  CircularProgress,
  LinearProgress,
  Typography,
} from "@mui/material";
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
export function SyncIndicator(): React.JSX.Element | null {
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
            // A flat, full-bleed chrome LINE at the very top — under the status
            // bar on mobile (nav bar is at the bottom), at top:0 on desktop (it
            // rides as a hairline; the NavShell top bar sits just below). No
            // rounding / shadow / ring: it's chrome, not a floating card. Content
            // scrolls under its faint frosted fill.
            position: "fixed",
            top: navbarAtBottom ? "env(safe-area-inset-top, 0px)" : 0,
            left: 0,
            right: 0,
            zIndex: (th) => th.zIndex.appBar,
            cursor: "pointer",
            overflow: "hidden", // clip the progress filament to the edges
            color: "text.secondary",
            bgcolor: (th) => alpha(th.palette.background.default, 0.82),
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            borderBottom: 1,
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
            <CircularProgress
              size={12}
              thickness={5}
              {...(pct != null
                ? { variant: "determinate", value: pct }
                : {})}
            />
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
