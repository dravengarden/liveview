import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  IconButton,
  LinearProgress,
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
 * The "bookshelf" landing page: one card per book. Picking a card enters that
 * book (resuming the last-read chapter); the sidebar then scopes to it and
 * offers a way back. Cards with more than one language edition show their
 * available languages as chips, and books with saved progress show how far
 * the reader got.
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
        {/* Top toolbar: portal launcher (left, self-hides when not hosted) and
            settings (right). A flex bar — not absolute corners — so neither
            control overlaps the title on narrow screens. */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            minHeight: 40,
            mb: 1,
          }}
        >
          <Box sx={{ display: "flex" }}>
            <PortalLauncherButton />
          </Box>
          <Tooltip title={t("app.settings")}>
            <IconButton aria-label={t("app.settings")} onClick={onOpenSettings}>
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Box>
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
            mb: 0.5,
            cursor: "pointer",
            borderRadius: 1,
            "&:hover": { opacity: 0.8 },
          }}
        >
          <ShelfIcon sx={{ fontSize: 36, color: "primary.main" }} />
          <Typography variant="h4" fontWeight={700}>
            {t("landing.title")}
          </Typography>
        </Box>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
          {books.length > 0 ? t("landing.subtitle", { n: books.length }) : t("landing.empty")}
        </Typography>

        {books.length === 0 ? (
          <Typography color="text.secondary">{t("landing.noMounts")}</Typography>
        ) : (
          <Box
            sx={{
              display: "grid",
              gap: { xs: 1.5, md: 2 },
              // Denser on small screens so books aren't one huge card per row:
              // 2 columns on phones, 3 on tablets, fluid on desktop.
              gridTemplateColumns: {
                xs: "repeat(2, 1fr)",
                sm: "repeat(3, 1fr)",
                md: "repeat(auto-fill, minmax(240px, 1fr))",
              },
            }}
          >
            {books.map((b) => (
              <Card key={b.slug} variant="outlined" sx={{ height: "100%" }}>
                <CardActionArea
                  onClick={() => onOpen(b.slug)}
                  sx={{ height: "100%", "& .MuiCardActionArea-focusHighlight": {} }}
                >
                  <CardContent
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 0.75,
                      p: 1.5,
                      "&:last-child": { pb: 1.5 },
                    }}
                  >
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
                      <BookIcon fontSize="small" color="primary" sx={{ flexShrink: 0 }} />
                      <Typography
                        variant="subtitle1"
                        fontWeight={600}
                        noWrap
                        title={b.label}
                        sx={{ minWidth: 0, fontSize: { xs: "0.95rem", md: "1.05rem" } }}
                      >
                        {b.label}
                      </Typography>
                    </Box>
                    {b.description ? (
                      <Typography variant="body2" color="text.secondary" noWrap title={b.description}>
                        {b.description}
                      </Typography>
                    ) : (
                      <Typography variant="body2" color="text.disabled" fontStyle="italic" noWrap>
                        /{b.slug}
                      </Typography>
                    )}
                    {b.langs.length > 1 && (
                      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
                        {b.langs.map((l) => (
                          <Chip key={l.lang} label={l.label} size="small" variant="outlined" />
                        ))}
                      </Box>
                    )}
                    {progress[b.slug] && (
                      <Box sx={{ mt: 1 }}>
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "baseline",
                            justifyContent: "space-between",
                            gap: 1,
                            mb: 0.5,
                          }}
                        >
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            noWrap
                            title={progress[b.slug]?.chapterLabel}
                          >
                            {t("landing.continue", { chapter: progress[b.slug]?.chapterLabel ?? "" })}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                            {Math.round((progress[b.slug]?.scroll ?? 0) * 100)}%
                          </Typography>
                        </Box>
                        <LinearProgress
                          variant="determinate"
                          value={Math.min(100, Math.max(0, (progress[b.slug]?.scroll ?? 0) * 100))}
                          sx={{ height: 4, borderRadius: 2 }}
                        />
                      </Box>
                    )}
                  </CardContent>
                </CardActionArea>
              </Card>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
