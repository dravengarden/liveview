import {
  Box,
  Chip,
  IconButton,
  LinearProgress,
  List,
  ListItemButton,
  Paper,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  AutoStories as ShelfIcon,
  MenuBook as BookIcon,
  Settings as SettingsIcon,
} from "@mui/icons-material";
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
  onOpenSettings: () => void;
}

/**
 * The "bookshelf" landing page: a compact reading list, one row per book.
 *
 * Why a list, not a card grid: with no cover art, a grid of equal-height tiles
 * is mostly empty box around a little text — it reads as clunky and wastes the
 * screen (the "giant cards" anti-pattern in conventions/ui.md). A divided list
 * scales to any number of books, never leaves dead space, and scans like a real
 * library index. Picking a row enters that book (resuming the last-read
 * chapter); the sidebar then scopes to it and offers a way back. Rows with more
 * than one language edition show their editions as chips, and books with saved
 * progress show how far the reader got — both as a trailing % and a hairline
 * progress bar along the row's bottom edge.
 */
export function Landing({
  books,
  progress,
  onOpen,
  onHome,
  onOpenSettings,
}: LandingProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Box
      sx={{
        flex: 1,
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
            <Tooltip title={t("app.settings")}>
              <IconButton aria-label={t("app.settings")} onClick={onOpenSettings}>
                <SettingsIcon />
              </IconButton>
            </Tooltip>
            <PortalLauncherButton />
          </Box>
        </Box>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
          {books.length > 0 ? t("landing.subtitle", { n: books.length }) : t("landing.empty")}
        </Typography>

        {books.length === 0 ? (
          <Typography color="text.secondary">{t("landing.noMounts")}</Typography>
        ) : (
          <Paper variant="outlined" sx={{ borderRadius: 2, overflow: "hidden" }}>
            <List disablePadding>
              {books.map((b) => {
                const p = progress[b.slug];
                const pct = p ? Math.min(100, Math.max(0, Math.round(p.scroll * 100))) : 0;
                return (
                  <ListItemButton
                    key={b.slug}
                    onClick={() => onOpen(b.slug)}
                    sx={{
                      position: "relative",
                      alignItems: "flex-start",
                      gap: 1.5,
                      px: { xs: 1.75, sm: 2.5 },
                      py: 1.5,
                      // Row separators instead of one box per book — reads as a
                      // single shelf, not a grid of tiles.
                      "&:not(:last-of-type)": { borderBottom: 1, borderColor: "divider" },
                      // On phones the meta cluster (langs + %) wraps under the
                      // title rather than crushing it; nowrap from sm up.
                      flexWrap: { xs: "wrap", sm: "nowrap" },
                    }}
                  >
                    <BookIcon
                      fontSize="small"
                      color="primary"
                      sx={{ mt: 0.3, flexShrink: 0 }}
                    />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="subtitle1" fontWeight={600} noWrap title={b.label}>
                        {b.label}
                      </Typography>
                      {b.description ? (
                        <Typography variant="body2" color="text.secondary" noWrap title={b.description}>
                          {b.description}
                        </Typography>
                      ) : (
                        <Typography variant="body2" color="text.disabled" fontStyle="italic" noWrap>
                          /{b.slug}
                        </Typography>
                      )}
                      {p && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          noWrap
                          sx={{ display: "block", mt: 0.25 }}
                          title={p.chapterLabel}
                        >
                          {t("landing.continue", { chapter: p.chapterLabel })}
                        </Typography>
                      )}
                    </Box>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        flexWrap: "wrap",
                        justifyContent: "flex-end",
                        gap: 0.75,
                        flexShrink: 0,
                        // Push to the right edge on wide rows; on the wrapped
                        // mobile line, indent to line up under the title.
                        ml: { sm: "auto" },
                        pl: { xs: "32px", sm: 0 },
                      }}
                    >
                      {b.langs.length > 1 &&
                        b.langs.map((l) => (
                          <Chip key={l.lang} label={l.label} size="small" variant="outlined" />
                        ))}
                      {p && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {pct}%
                        </Typography>
                      )}
                    </Box>
                    {p && (
                      <LinearProgress
                        variant="determinate"
                        value={pct}
                        aria-hidden
                        sx={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          bottom: 0,
                          height: 2,
                          // Track transparent so only the read portion shows as
                          // a thin accent rule along the row's bottom edge.
                          bgcolor: "transparent",
                        }}
                      />
                    )}
                  </ListItemButton>
                );
              })}
            </List>
          </Paper>
        )}
      </Box>
    </Box>
  );
}
