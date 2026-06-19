import { useEffect, useState } from "react";
import { Box, CircularProgress, LinearProgress, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { CloudDownload, GraphicEq } from "@mui/icons-material";
import { DetentSheet } from "../_shell";
import {
  type BookAudioStatus,
  isSyncActive,
  refreshSyncStatus,
  useSyncStatus,
} from "@/syncStore";
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
  const [open, setOpen] = useState(false);
  const active = isSyncActive(status);

  // Initial fetch, then poll while anything is in flight (progress ticks down).
  useEffect(() => {
    void refreshSyncStatus();
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => void refreshSyncStatus(), 5000);
    return () => window.clearInterval(id);
  }, [active]);

  // The dominant line for the pill + the sheet peek.
  const g = status.global;
  const headline = status.prefetching > 0
    ? t("sync.prefetching")
    : g.pending > 0
    ? t("sync.generatingAudio", { done: g.done, total: g.total })
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
          sx={{
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            bottom:
              "calc(12px + env(safe-area-inset-bottom, 0px) + var(--shell-bar-h, 0px))",
            zIndex: (th) => th.zIndex.appBar + 1,
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            pl: 1,
            pr: 1.5,
            py: 0.5,
            borderRadius: 999,
            cursor: "pointer",
            maxWidth: "min(86vw, 360px)",
            color: "text.secondary",
            bgcolor: (th) =>
              alpha(
                th.palette.background.paper,
                th.palette.mode === "dark" ? 0.72 : 0.82,
              ),
            backdropFilter: "blur(16px) saturate(180%)",
            WebkitBackdropFilter: "blur(16px) saturate(180%)",
            border: 1,
            borderColor: "divider",
            boxShadow: 3,
          }}
        >
          <CircularProgress size={14} thickness={5} />
          <Typography variant="caption" noWrap sx={{ fontWeight: 600 }}>
            {headline}
          </Typography>
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

          {/* Offline group — controls land in Phase 4; show the ambient state. */}
          <Box>
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ display: "block", mb: 0.5 }}
            >
              {t("sync.offline")}
            </Typography>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                color: "text.secondary",
              }}
            >
              <CloudDownload sx={{ fontSize: 18 }} />
              <Typography variant="body2">{t("sync.offlineSoon")}</Typography>
            </Box>
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
