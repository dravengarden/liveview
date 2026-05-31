import { useEffect, useState } from "react";
import {
  Box,
  Modal,
  Slide,
  IconButton,
  Tooltip,
  Typography,
  List,
  ListItemButton,
  ListItemText,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import {
  KeyboardArrowDown,
  FormatListBulleted,
  Headphones as AudiobookIcon,
} from "@mui/icons-material";
import { useAudioPlayer } from "@/audio/player";
import { useI18n } from "@/i18n";
import { BottomSheet } from "../_shell";
import { AudiobookPlayer } from "./AudiobookPlayer";

interface NowPlayingPopupProps {
  contentMaxWidth: number;
  lineHeight: number;
}

/** Stable hue from a slug → a calm gradient stand-in cover (mirrors the shelf
 *  + mini-player), so a coverless book still reads as itself everywhere. */
function coverGradient(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `linear-gradient(135deg, hsl(${hue} 52% 52%), hsl(${(hue + 38) % 360} 48% 42%))`;
}

/** A square book-cover tile: the real cover image when present, else the
 *  slug-keyed gradient + headphones glyph. */
function CoverTile({
  slug,
  hasCover,
  size,
}: {
  slug: string;
  hasCover: boolean;
  size: number | string;
}): React.JSX.Element {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: 1.5,
        overflow: "hidden",
        position: "relative",
        flexShrink: 0,
        background: coverGradient(slug),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {hasCover ? (
        <Box
          component="img"
          src={`/api/cover?book=${encodeURIComponent(slug)}`}
          alt=""
          sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <AudiobookIcon sx={{ fontSize: 48, color: "rgba(255,255,255,0.92)" }} />
      )}
    </Box>
  );
}

/** The chapter table-of-contents: the engine's queue, current chapter
 *  highlighted; picking a row jumps playback there. Shared by the desktop rail
 *  and the mobile drawer. */
function ChapterList({ onPick }: { onPick?: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const { queue, queueIndex, goToChapter } = useAudioPlayer();
  return (
    <List dense disablePadding aria-label={t("audiobook.chapters")}>
      {queue.map((tk, i) => (
        <ListItemButton
          key={tk.path}
          selected={i === queueIndex}
          onClick={() => {
            goToChapter(i);
            onPick?.();
          }}
          sx={{ py: 0.75, "&.Mui-selected": { bgcolor: "action.selected" } }}
        >
          <ListItemText
            primary={tk.label}
            slotProps={{
              primary: {
                noWrap: true,
                variant: "body2",
                fontWeight: i === queueIndex ? 700 : 400,
              },
            }}
          />
        </ListItemButton>
      ))}
    </List>
  );
}

/**
 * The full-screen "now playing" read-along popup — the focus state of the
 * listen plane. It floats above every browse view (mounted at the app root, not
 * inside any book's chrome), so playback and reading other books are fully
 * decoupled: collapse it to the bottom bar, browse freely, tap the bar to bring
 * it back. The audio engine lives at the root, so this view is a pure window
 * onto it — opening, closing, or switching books never interrupts the audio.
 *
 * Mobile: a bottom-up full-screen sheet (small screens must cover). Desktop: a
 * centered card over a dimmed scrim (no need to bury the whole desktop for a
 * narrow read-along column). Esc / scrim / the ⌄ button collapse it.
 */
export function NowPlayingPopup({ contentMaxWidth, lineHeight }: NowPlayingPopupProps): React.JSX.Element | null {
  const { t } = useI18n();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("lg"));
  const { nowPlaying, expanded, setExpanded } = useAudioPlayer();
  const [tocOpen, setTocOpen] = useState(false);

  const open = expanded && nowPlaying != null;

  // Esc collapses (Modal's own onClose also covers this, but keep it explicit so
  // the behavior is obvious and survives any Modal prop changes).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setExpanded]);

  if (!nowPlaying) return null;

  const collapse = (): void => setExpanded(false);

  // The collapse handle + chapter title, shared header row.
  const header = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        px: 1,
        py: 0.5,
        minHeight: 48,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: "divider",
        // Clear the iPhone status bar on the mobile full sheet.
        pt: isMobile ? "calc(env(safe-area-inset-top, 0px) + 4px)" : 0.5,
      }}
    >
      <Tooltip title={t("audiobook.collapse")}>
        <IconButton onClick={collapse} aria-label={t("audiobook.collapse")} sx={{ width: 44, height: 44 }}>
          <KeyboardArrowDown sx={{ fontSize: 28 }} />
        </IconButton>
      </Tooltip>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="subtitle2" fontWeight={700} noWrap>
          {nowPlaying.chapterLabel}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
          {nowPlaying.bookLabel}
        </Typography>
      </Box>
      {/* The chapter list is a permanent rail on desktop, so its toggle only
          shows on mobile (opens the drawer). */}
      {isMobile && (
        <Tooltip title={t("audiobook.chapters")}>
          <IconButton onClick={() => setTocOpen(true)} aria-label={t("audiobook.chapters")} sx={{ width: 44, height: 44 }}>
            <FormatListBulleted sx={{ fontSize: 26 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );

  const body = (
    <>
      {header}
      <AudiobookPlayer contentMaxWidth={contentMaxWidth} lineHeight={lineHeight} />
    </>
  );

  // Mobile: an edge-to-edge sheet. Desktop: a centered card with a left rail.
  // `pointerEvents: auto` so the surface itself is interactive while the empty
  // space around the desktop card stays click-through to the backdrop (close).
  const surface = isMobile ? (
    <Box
      sx={{
        pointerEvents: "auto",
        width: "100%",
        height: "100%",
        bgcolor: "background.default",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {body}
      {/* Chapter list as the app's canonical bottom sheet (slide-up momentum
          sheet on mobile — the standard audiobook-TOC affordance), NOT a bespoke
          side Drawer (ui.md: every app's modal sheet uses BottomSheet). It's
          self-contained (its own scrim, non-Modal) so it sits cleanly above the
          popup without the nested-Modal z-index dance. */}
      <BottomSheet open={tocOpen} onClose={() => setTocOpen(false)} title={nowPlaying.bookLabel}>
        <ChapterList onPick={() => setTocOpen(false)} />
      </BottomSheet>
    </Box>
  ) : (
    <Box
      sx={{
        pointerEvents: "auto",
        width: "min(900px, 92vw)",
        height: "min(880px, 90vh)",
        bgcolor: "background.default",
        borderRadius: 3,
        boxShadow: 24,
        overflow: "hidden",
        display: "flex",
      }}
    >
      {/* Left rail: cover + book + scrollable chapter list. */}
      <Box
        sx={{
          width: 280,
          flexShrink: 0,
          borderRight: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box sx={{ p: 2 }}>
          <CoverTile slug={nowPlaying.bookSlug} hasCover={nowPlaying.cover} size="100%" />
          <Typography variant="subtitle1" fontWeight={700} sx={{ mt: 1.5 }} noWrap>
            {nowPlaying.bookLabel}
          </Typography>
        </Box>
        <Box sx={{ flex: 1, overflowY: "auto", borderTop: 1, borderColor: "divider" }}>
          <ChapterList />
        </Box>
      </Box>
      {/* Right: header + the read-along reader. */}
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>{body}</Box>
    </Box>
  );

  return (
    <Modal
      open={open}
      onClose={collapse}
      // Mobile fills the screen, so its own surface is the backdrop — keep the
      // scrim transparent there; on desktop the scrim dims the browse plane.
      slotProps={{ backdrop: { sx: isMobile ? { bgcolor: "transparent" } : undefined } }}
    >
      {/* Full-viewport positioning layer (the Modal's single child). Flex-centers
          the desktop card; on mobile the sheet stretches to fill. Centering lives
          HERE, not on the surface's own transform — Slide animates the surface's
          transform, which would otherwise fight a translate-based centering.
          `pointerEvents: none` lets desktop clicks outside the card reach the
          backdrop (→ collapse); the surface re-enables them for itself. */}
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: isMobile ? "stretch" : "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <Slide direction="up" in={open} appear mountOnEnter unmountOnExit>
          {surface}
        </Slide>
      </Box>
    </Modal>
  );
}
