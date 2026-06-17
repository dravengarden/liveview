import { Box, Button, Typography } from "@mui/material";
import { ChevronLeft, ChevronRight } from "@mui/icons-material";
import { useI18n } from "@/i18n";

/** One end of the pager: where it goes + how it reads. */
export interface ChapterLink {
  path: string;
  label: string;
}

/**
 * Docs-style previous/next chapter footer, pinned at the bottom of the reading
 * content (text reader AND audiobook read-along). Two equal-width outlined cards
 * — prev on the left (chevron + title), next on the right — each showing the
 * destination chapter's title so you know where you're going. A missing end keeps
 * its slot empty so the other stays pinned to its edge. Renders nothing when the
 * book has no neighbours (single-chapter).
 */
export function ChapterPager(
  { prev, next, onNavigate }: {
    prev?: ChapterLink | undefined;
    next?: ChapterLink | undefined;
    onNavigate: (path: string) => void;
  },
): React.JSX.Element | null {
  const { t } = useI18n();
  if (!prev && !next) return null;

  const slot = (
    link: ChapterLink | undefined,
    dir: "prev" | "next",
  ): React.JSX.Element => {
    if (!link) return <Box sx={{ flex: 1 }} />;
    const isPrev = dir === "prev";
    return (
      <Button
        // Filled (no outline). A 1px high-contrast border on content sitting at
        // the very bottom shimmers during the iOS rubber-band — the spring
        // oscillates the content sub-pixel and the thin line re-rasterizes each
        // frame ("鬼畜"). A soft filled background has only a low-contrast edge, so
        // it stays steady through the bounce.
        variant="text"
        onClick={() => onNavigate(link.path)}
        sx={{
          flex: 1,
          minWidth: 0,
          textTransform: "none",
          textAlign: isPrev ? "left" : "right",
          color: "text.primary",
          bgcolor: "action.hover",
          borderRadius: 2,
          px: 1.5,
          py: 1,
          gap: 1,
          justifyContent: isPrev ? "flex-start" : "flex-end",
          "&:hover": { bgcolor: "action.selected" },
        }}
      >
        {isPrev && (
          <ChevronLeft sx={{ flexShrink: 0, color: "text.secondary" }} />
        )}
        <Box sx={{ minWidth: 0 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", lineHeight: 1.2 }}
          >
            {isPrev ? t("reader.prevPage") : t("reader.nextPage")}
          </Typography>
          <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
            {link.label}
          </Typography>
        </Box>
        {!isPrev && (
          <ChevronRight sx={{ flexShrink: 0, color: "text.secondary" }} />
        )}
      </Button>
    );
  };

  return (
    <Box sx={{ display: "flex", gap: 1.5, mt: 5, mb: 1 }}>
      {slot(prev, "prev")}
      {slot(next, "next")}
    </Box>
  );
}
