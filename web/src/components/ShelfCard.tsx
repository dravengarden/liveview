import { rem } from "@/px";
import { Box, IconButton, Stack, Typography } from "@mui/material";
import {
  Headphones as AudiobookIcon,
  MenuBook as BookIcon,
} from "@mui/icons-material";
import { Fragment, memo } from "react";
import type { Book, BookProgress, ReadingProgress } from "@/types";
import type { useI18n } from "@/i18n";
import { type BookSearchMatch, matchContext } from "@/librarySearch";
import { resumableLibraryProgress } from "@/libraryHome";
import { Highlighted } from "./SearchHighlight";

/** The shelf splits into three mutually-exclusive kinds, each with its own card
 *  treatment and filter chip. A `book.toml` book that ships an audio rendition
 *  is an "audiobook" — it still carries text, but the listen affordance is its
 *  defining feature on the shelf, so it gets the headphones card and lives under
 *  the 有声书 filter (not double-counted under books). A `book.toml` book with no
 *  audio is a plain "book"; a raw `[[book]]`/`[[mount]]` tree is "docs". */
export type Category = "book" | "audiobook" | "docs";

/** A single shelf card — ONE per book. A book that ships both text and audio is
 *  a single "book" card with an audio badge (`hasAudio`); it opens in whichever
 *  rendition you last used (the in-book navbar switches between them). An
 *  audio-ONLY book is an "audiobook" card; a raw `[[book]]`/`[[mount]]` tree is
 *  a "docs" card. */
export interface ShelfEntry {
  book: Book;
  category: Category;
  hasAudio: boolean;
  hasText: boolean;
}

export function shelfEntries(books: Book[]): ShelfEntry[] {
  const out: ShelfEntry[] = [];
  for (const b of books) {
    const audio = b.renditions.some((r) => r.kind === "audio");
    const text = b.renditions.some((r) => r.kind === "text");
    const category: Category = !b.manifest
      ? "docs"
      : audio && !text
      ? "audiobook"
      : "book";
    out.push({ book: b, category, hasAudio: audio, hasText: text });
  }
  return out;
}

interface ShelfCardProps {
  book: Book;
  category: Category;
  hasText: boolean;
  hasAudio: boolean;
  progress: BookProgress | undefined;
  generating?: boolean;
  resumeOnly?: boolean;
  directoryLabel?: string | undefined;
  /** Present while searching: what matched, for highlighting. */
  match?: BookSearchMatch | undefined;
  onOpen: (slug: string, renditionKind?: string) => void;
  t: ReturnType<typeof useI18n>["t"];
}

export const ShelfCard = memo(function ShelfCard({
  book: b,
  category,
  hasText,
  hasAudio,
  progress: bp,
  generating,
  resumeOnly,
  directoryLabel,
  match,
  onOpen,
  t,
}: ShelfCardProps): React.JSX.Element {
  // Progress is split by rendition: a text+audio book shows
  // BOTH a reading and a listening meter; single-rendition
  // books show just the one. The "continue" line resumes the
  // most-recently-opened rendition.
  const textP = bp?.text;
  const audioP = bp?.audio;
  // Book-level progress (how far through the spine), not
  // the in-chapter scroll — so resuming at the top of a
  // late chapter doesn't read 0%. See ReadingProgress.fraction.
  const pctOf = (r: ReadingProgress): number =>
    Math.min(
      100,
      Math.max(0, Math.round(r.fraction * 100)),
    );
  const context = match ? matchContext(b, match) : null;
  // With a user library the folder path replaces the manifest collection.
  const place = directoryLabel ?? b.collection;
  const byline = [
    place
      ? {
        text: place,
        ranges: directoryLabel !== undefined
          ? match?.highlights.directory
          : match?.highlights.collection,
      }
      : null,
    b.author ? { text: b.author, ranges: match?.highlights.author } : null,
  ].filter((part) => part !== null);
  const resumeMode = resumableLibraryProgress(b, bp);
  const resume = resumeOnly
    ? resumeMode?.track
    : textP && audioP
    ? (textP.updatedAt >= audioP.updatedAt ? textP : audioP)
    : (textP ?? audioP);
  return (
    <Box
      data-lv-book={b.slug}
      component="article"
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: "14px",
        bgcolor: "background.paper",
        display: "flex",
        alignItems: "stretch",
        overflow: "hidden",
        height: "100%",
        width: "100%",
      }}
    >
      <Box
        component="button"
        onClick={() =>
          onOpen(b.slug, resumeOnly ? resumeMode?.kind : undefined)}
        sx={{
          flex: 1,
          minWidth: 0,
          border: 0,
          bgcolor: "transparent",
          color: "text.primary",
          textAlign: "left",
          cursor: "pointer",
          p: resumeOnly ? 1.25 : 2,
          touchAction: "pan-y",
          "&:focus-visible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: -2,
          },
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <Typography
          fontWeight={700}
          sx={{
            fontSize: rem(resumeOnly ? 14 : 15),
            lineHeight: 1.4,
            display: "-webkit-box",
            WebkitLineClamp: resumeOnly ? 1 : 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          <Highlighted text={b.label} ranges={match?.highlights.label} />
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          component="div"
          sx={{ mt: 0.5, display: resumeOnly ? "none" : "block" }}
        >
          {byline.length
            ? byline.map((part, i) => (
              <Fragment key={i}>
                {i > 0 && " · "}
                <Highlighted text={part.text} ranges={part.ranges} />
              </Fragment>
            ))
            : t(
              category === "docs" ? "landing.docsBadge" : "landing.bookBadge",
            )}
        </Typography>
        {resume && (
          <Typography
            variant="caption"
            color="primary.main"
            noWrap
            component="div"
            sx={{ mt: 0.5 }}
          >
            {t("landing.continue", { chapter: resume.chapterLabel })}
            {b.manifest ? ` · ${pctOf(resume)}%` : ""}
          </Typography>
        )}
        {context
          ? (
            // Why this result matched, when the title does not show it.
            <Typography
              variant="caption"
              color={context.kind === "tags"
                ? "primary.main"
                : "text.secondary"}
              noWrap
              component="div"
              sx={{ mt: 0.5 }}
            >
              <Highlighted text={context.text} ranges={context.ranges} />
            </Typography>
          )
          : !resume && b.description && (
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              component="div"
              sx={{ mt: 0.5 }}
            >
              {b.description}
            </Typography>
          )}
        {generating && (
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
          >
            {t("landing.generatingAudio")}
          </Typography>
        )}
      </Box>
      <Stack
        direction={resumeOnly ? "row" : "column"}
        alignItems="center"
        justifyContent="center"
        sx={{ pr: 1 }}
      >
        {hasText && (
          <IconButton
            aria-label={t("landing.bookBadge")}
            onClick={() => onOpen(b.slug, "text")}
            sx={{ width: 44, height: 44 }}
          >
            <BookIcon fontSize="small" />
          </IconButton>
        )}
        {hasAudio && (
          <IconButton
            aria-label={t("landing.audiobookBadge")}
            onClick={() => onOpen(b.slug, "audio")}
            sx={{ width: 44, height: 44 }}
          >
            <AudiobookIcon fontSize="small" />
          </IconButton>
        )}
      </Stack>
    </Box>
  );
});
