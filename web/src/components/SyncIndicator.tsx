import { useEffect, useState } from "react";
import {
  Box,
  CircularProgress,
  LinearProgress,
  Switch,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { ExpandLess, GraphicEq } from "@mui/icons-material";
import { DetentSheet } from "../_shell";
import {
  type BookAudioStatus,
  isSyncActive,
  refreshSyncStatus,
  useSyncStatus,
} from "@/syncStore";
import { setSavedOffline, useSavedOffline } from "@/offlineStore";
import { prefetchBookAudio } from "@/prefetch";
import type { Book } from "@/types";
import { useI18n } from "@/i18n";

/**
 * The ambient sync indicator — a low-weight frosted pill that appears ONLY while
 * audio is generating or the SW is prefetching, and quietly disappears when idle.
 * Tapping it opens the Sync sheet (full per-resource breakdown + offline
 * controls). Bottom-centre, lifted above the nav bar, so it never collides with
 * the top status-bar tap-to-top zone. Calm-tech: the user knows, but it weighs
 * almost nothing.
 */
export function SyncIndicator(): React.JSX.Element | null {
  const { t } = useI18n();
  const status = useSyncStatus();
  const saved = useSavedOffline();
  const [open, setOpen] = useState(false);
  const [audioBooks, setAudioBooks] = useState<Book[]>([]);
  const active = isSyncActive(status);

  // Load the books-with-audio list when the sheet opens (for the offline toggles).
  useEffect(() => {
    if (!open || audioBooks.length > 0) return;
    void (async () => {
      try {
        const res = await fetch("/api/books");
        if (!res.ok) return;
        const all = (await res.json()) as Book[];
        setAudioBooks(
          all.filter((b) => b.renditions.some((r) => r.kind === "audio")),
        );
      } catch {
        // offline — leave empty
      }
    })();
  }, [open, audioBooks.length]);

  // Initial fetch, then poll while anything is in flight (progress ticks down).
  useEffect(() => {
    void refreshSyncStatus();
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => void refreshSyncStatus(), 5000);
    return () => window.clearInterval(id);
  }, [active]);

  // Aggregate MULTIPLE concurrent tasks into one summary: the bar is a summary,
  // the sheet is the per-task breakdown. `pct` is the overall audio progress.
  const g = status.global;
  const activeBooks = status.books.filter((b) => b.pending > 0).length;
  const pct = g.total > 0 ? Math.round((g.done / g.total) * 100) : null;
  // The bar's short label (it also carries the count + a progress filament).
  const barLabel = g.pending > 0
    ? (activeBooks > 1 ? t("sync.generatingN", { n: activeBooks }) : t("sync.generating"))
    : status.prefetching > 0
    ? t("sync.prefetching")
    : t("sync.upToDate");
  // The sheet's peek line — a fuller sentence.
  const headline = status.prefetching > 0 && g.pending > 0
    ? t("sync.busy")
    : g.pending > 0
    ? t("sync.generatingAudio", { done: g.done, total: g.total })
    : status.prefetching > 0
    ? t("sync.prefetching")
    : t("sync.upToDate");

  if (!active && !open) return null;

  return (
    <>
      {active && !open && (
        <Box
          role="button"
          tabIndex={0}
          aria-label={t("sync.title")}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setOpen(true);
          }}
          sx={{
            // A floating activity BAR above the bottom nav bar / shelf toolbar
            // (max() of whichever owns that edge), centred with side gutters so it
            // reads as a bar, not a chip. Content scrolls under it (high
            // transparency + blur), so it never disturbs reading.
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            width: "min(94vw, 560px)",
            bottom:
              "calc(8px + env(safe-area-inset-bottom, 0px) + max(var(--shell-bar-h, 0px), var(--lv-toolbar-h, 0px)))",
            zIndex: (th) => th.zIndex.appBar + 1,
            cursor: "pointer",
            borderRadius: 2.5,
            overflow: "hidden", // clip the progress filament to the rounded corners
            color: "text.secondary",
            // Very translucent floating glass — high transparency, blurred.
            bgcolor: (th) =>
              alpha(
                th.palette.background.paper,
                th.palette.mode === "dark" ? 0.5 : 0.6,
              ),
            backdropFilter: "blur(18px) saturate(180%)",
            WebkitBackdropFilter: "blur(18px) saturate(180%)",
            border: 1,
            borderColor: "divider",
            boxShadow: 4,
            "@media (hover: hover)": {
              transition: "background-color .15s",
              "&:hover": {
                bgcolor: (th) =>
                  alpha(
                    th.palette.background.paper,
                    th.palette.mode === "dark" ? 0.62 : 0.72,
                  ),
              },
            },
          }}
        >
          <Box
            sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 0.75 }}
          >
            <CircularProgress
              size={15}
              thickness={5}
              {...(pct != null
                ? { variant: "determinate", value: pct }
                : {})}
            />
            <Typography
              variant="caption"
              noWrap
              sx={{ flex: 1, fontWeight: 600, color: "text.primary" }}
            >
              {barLabel}
            </Typography>
            {pct != null && (
              <Typography
                variant="caption"
                sx={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}
              >
                {g.done}/{g.total}
              </Typography>
            )}
            <ExpandLess sx={{ fontSize: 18, flexShrink: 0, opacity: 0.7 }} />
          </Box>
          {/* Aggregate progress filament along the bar's bottom edge. */}
          {pct != null && (
            <Box
              sx={{
                height: 2,
                width: `${pct}%`,
                bgcolor: "primary.main",
                opacity: 0.85,
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
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {t("sync.title")}
          </Typography>
        }
      >
        <Box sx={{ px: 2, pb: 2, display: "flex", flexDirection: "column", gap: 2 }}>
          {/* Peek line — the dominant activity. */}
          <Typography variant="body2" color="text.secondary">
            {headline}
          </Typography>

          {/* Generating group — books with audio in flight. */}
          {status.books.some((b) => b.pending > 0 || b.failed > 0) && (
            <Box>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: "block", mb: 0.5 }}
              >
                {t("sync.generating")}
              </Typography>
              {status.books
                .filter((b) => b.pending > 0 || b.failed > 0)
                .map((b) => <GeneratingRow key={b.slug} book={b} t={t} />)}
            </Box>
          )}

          {/* Offline group — per-book "save audio offline" toggles. Text is
              always cached on open; this opts a book's (heavy) audio into the SW
              cache so it plays offline. */}
          <Box>
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ display: "block", mb: 0.5 }}
            >
              {t("sync.offline")}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 1 }}
            >
              {t("sync.offlineHint")}
            </Typography>
            {audioBooks.length === 0
              ? (
                <Typography variant="body2" color="text.secondary">
                  {t("sync.offlineNone")}
                </Typography>
              )
              : (
                audioBooks.map((b) => (
                  <Box
                    key={b.slug}
                    sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.25 }}
                  >
                    <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                      {b.label}
                    </Typography>
                    <Switch
                      size="small"
                      checked={saved.has(b.slug)}
                      onChange={(_e, on) => {
                        setSavedOffline(b.slug, on);
                        if (on) void prefetchBookAudio(b.slug);
                      }}
                      inputProps={{ "aria-label": b.label }}
                    />
                  </Box>
                ))
              )}
          </Box>
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
