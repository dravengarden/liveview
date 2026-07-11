import { rem } from "@/px";
import { lazy, Suspense } from "react";
import { Box, CircularProgress, Skeleton, Typography } from "@mui/material";
import { Description as FileIcon } from "@mui/icons-material";
import { type FileType, READING_COLUMN_MAX, type Theme } from "@/types";
import { useI18n } from "@/i18n";
import { MarkdownViewer } from "./MarkdownViewer";
import { ImageViewer } from "./viewers/ImageViewer";
import { JsonViewer } from "./viewers/JsonViewer";
import { InteractiveViewViewer } from "./viewers/InteractiveViewViewer";

// Markdown (the common path), the tiny image/JSON viewers, and interactive-view
// stay eager. Markdown embeds InteractiveViewInline from that same module, so a
// second dynamic import could not split it and only produced a Vite warning. The
// remaining rare file types are backed by heavy libs (PDF.js, Excalidraw, a CSV
// grid, …), so code-split those out of the main bundle. Named exports map to a
// default for React.lazy.
const PdfViewer = lazy(() =>
  import("./viewers/PdfViewer").then((m) => ({ default: m.PdfViewer }))
);
const HtmlViewer = lazy(() =>
  import("./viewers/HtmlViewer").then((m) => ({ default: m.HtmlViewer }))
);
const CsvViewer = lazy(() =>
  import("./viewers/CsvViewer").then((m) => ({ default: m.CsvViewer }))
);
const ExcalidrawViewer = lazy(() =>
  import("./viewers/ExcalidrawViewer").then((m) => ({
    default: m.ExcalidrawViewer,
  }))
);
const LatexViewer = lazy(() =>
  import("./viewers/LatexViewer").then((m) => ({ default: m.LatexViewer }))
);
const TypstViewer = lazy(() =>
  import("./viewers/TypstViewer").then((m) => ({ default: m.TypstViewer }))
);
interface ContentViewerProps {
  content: string | null;
  fileType: FileType;
  currentPath: string | null;
  theme: Theme;
  onNavigate: (path: string) => void;
  /** Markdown reader: max content width in px (0 = full width). */
  contentMaxWidth: number;
  /** Markdown reader: line-height multiplier. */
  lineHeight: number;
  /** Reading-progress: saved scroll ratio for a doc path. */
  savedScroll?: ((path: string) => number | undefined) | undefined;
  /** Reading-progress: report current scroll ratio for a doc path. */
  onSaveScroll?: ((path: string, ratio: number) => void) | undefined;
  /** True when the nav bar sits at the bottom — forwarded to the read-aloud
   *  <PlaybackBar> overlay so it drops its own home-indicator inset. */
  navbarAtBottom?: boolean | undefined;
  /** Footer pinned under the markdown content — the prev/next <ChapterPager>. */
  footer?: React.ReactNode;
}

/** Spinner shown while a code-split viewer chunk downloads. */
function ViewerLoading(): React.JSX.Element {
  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "text.secondary",
      }}
    >
      <CircularProgress size={28} />
    </Box>
  );
}

/** File types whose viewer needs the fetched body. Image/PDF load by path, so
 *  they render immediately and never wait on `content`. */
function needsContent(fileType: FileType): boolean {
  return fileType !== "image" && fileType !== "pdf";
}

/** Reading-shaped loading placeholder: a title bar + paragraph lines laid out in
 *  the same centred column the reader uses, so opening a book shows the page
 *  *taking shape* instead of a blank white flash while `/api/file` is in flight.
 *  Shown only on a COLD open (no prior content); chapter→chapter nav keeps the
 *  previous text up and cross-fades, so the skeleton never flashes mid-book. */
function ReaderSkeleton({
  contentMaxWidth,
}: {
  contentMaxWidth: number;
}): React.JSX.Element {
  // A few paragraphs of varying length — the last line of each is short, like
  // real prose. Pure visual filler; widths chosen to read as text, not a table.
  const paras = [
    [92, 88, 95, 60],
    [90, 96, 84, 91, 48],
    [94, 87, 92, 70],
    [89, 93, 86, 95, 55],
  ];
  return (
    <Box
      aria-busy
      aria-label="Loading"
      sx={{ flex: 1, overflow: "hidden", px: `${contentMaxWidth}px`, py: 4 }}
    >
      <Box sx={{ maxWidth: `${READING_COLUMN_MAX}px`, mx: "auto" }}>
        {/* Chapter title */}
        <Skeleton
          variant="text"
          animation="wave"
          sx={{ fontSize: rem(34), width: "70%", mb: 3 }}
        />
        {paras.map((lines, p) => (
          <Box key={p} sx={{ mb: 3 }}>
            {lines.map((w, i) => (
              <Skeleton
                key={i}
                variant="text"
                animation="wave"
                sx={{ fontSize: rem(18), width: `${w}%` }}
              />
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function ContentViewer({
  content,
  fileType,
  currentPath,
  theme,
  onNavigate,
  contentMaxWidth,
  lineHeight,
  savedScroll,
  onSaveScroll,
  navbarAtBottom,
  footer,
}: ContentViewerProps): React.JSX.Element {
  const { t } = useI18n();
  if (!currentPath) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
        }}
      >
        <FileIcon sx={{ fontSize: rem(64), mb: 2, opacity: 0.5 }} />
        <Typography variant="body1">{t("content.selectFile")}</Typography>
      </Box>
    );
  }

  // A chapter is selected but its body hasn't arrived yet (`null` = still
  // fetching; `""` is a genuinely empty file and renders as empty, not a
  // skeleton). Show the reading-shaped placeholder instead of a blank screen.
  if (content === null && needsContent(fileType)) {
    return <ReaderSkeleton contentMaxWidth={contentMaxWidth} />;
  }

  let node: React.JSX.Element;
  switch (fileType) {
    case "markdown":
      node = (
        <MarkdownViewer
          html={content}
          currentPath={currentPath}
          onNavigate={onNavigate}
          contentMaxWidth={contentMaxWidth}
          lineHeight={lineHeight}
          savedScroll={savedScroll}
          onSaveScroll={onSaveScroll}
          navbarAtBottom={navbarAtBottom}
          footer={footer}
        />
      );
      break;

    case "image":
      node = <ImageViewer path={currentPath} />;
      break;

    case "pdf":
      node = <PdfViewer path={currentPath} />;
      break;

    case "html":
      node = <HtmlViewer content={content} path={currentPath} />;
      break;

    case "csv":
      node = <CsvViewer content={content} theme={theme} />;
      break;

    case "json":
      node = <JsonViewer content={content} />;
      break;

    case "excalidraw":
      node = <ExcalidrawViewer content={content} theme={theme} />;
      break;

    case "latex":
      node = <LatexViewer content={content} theme={theme} />;
      break;

    case "typst":
      node = <TypstViewer content={content} path={currentPath} />;
      break;

    case "interactive-view":
      node = <InteractiveViewViewer content={content} theme={theme} />;
      break;

    default:
      return (
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            color: "text.secondary",
          }}
        >
          <FileIcon sx={{ fontSize: rem(64), mb: 2, opacity: 0.5 }} />
          <Typography variant="body1">
            {t("content.unsupported", { type: fileType })}
          </Typography>
        </Box>
      );
  }

  // Eager viewers resolve immediately (no fallback shown); lazy ones display the
  // spinner while their chunk loads.
  return <Suspense fallback={<ViewerLoading />}>{node}</Suspense>;
}
