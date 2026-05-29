import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  AutoStories as ShelfIcon,
  MenuBook as BookIcon,
  Settings as SettingsIcon,
} from "@mui/icons-material";
import type { Book } from "@/types";
import { useI18n } from "@/i18n";
import { PortalLauncherButton } from "../_shell";

interface LandingProps {
  books: Book[];
  onOpen: (slug: string) => void;
  onOpenSettings: () => void;
}

/**
 * The "bookshelf" landing page: one card per book. Picking a card enters that
 * book; the sidebar then scopes to it and offers a way back. Cards with more
 * than one language edition show their available languages as chips.
 */
export function Landing({ books, onOpen, onOpenSettings }: LandingProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Box
      sx={{
        flex: 1,
        overflow: "auto",
        position: "relative",
        px: { xs: 2, md: 6 },
        py: { xs: 4, md: 6 },
      }}
    >
      {/* Portal launcher (top-left); self-hides when not hosted. */}
      <Box sx={{ position: "absolute", top: 12, left: 12 }}>
        <PortalLauncherButton />
      </Box>

      <Tooltip title={t("app.settings")}>
        <IconButton
          aria-label={t("app.settings")}
          onClick={onOpenSettings}
          sx={{ position: "absolute", top: 12, right: 12 }}
        >
          <SettingsIcon />
        </IconButton>
      </Tooltip>

      <Box sx={{ maxWidth: 1000, mx: "auto" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 0.5 }}>
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
              gap: 2,
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            }}
          >
            {books.map((b) => (
              <Card key={b.slug} variant="outlined" sx={{ height: "100%" }}>
                <CardActionArea
                  onClick={() => onOpen(b.slug)}
                  sx={{ height: "100%", "& .MuiCardActionArea-focusHighlight": {} }}
                >
                  <CardContent sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      <BookIcon fontSize="small" color="primary" />
                      <Typography variant="h6" noWrap title={b.label}>
                        {b.label}
                      </Typography>
                    </Box>
                    {b.description ? (
                      <Typography variant="body2" color="text.secondary">
                        {b.description}
                      </Typography>
                    ) : (
                      <Typography variant="body2" color="text.disabled" fontStyle="italic">
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
