import { rem } from "@/px";
import { lazy, Suspense } from "react";
import { Box, CircularProgress, Typography } from "@mui/material";
import { Description as FileIcon } from "@mui/icons-material";
import type { FileType, Theme } from "@/types";
import { useI18n } from "@/i18n";
import { MarkdownViewer } from "./MarkdownViewer";
import { ImageViewer } from "./viewers/ImageViewer";
import { JsonViewer } from "./viewers/JsonViewer";

// Markdown (the common path), the tiny image viewer, and the now-lightweight
// JSON viewer stay eager. The rest are rare file types backed by heavy libs
// (PDF.js, Excalidraw, a CSV grid, …); code-split them out of the main bundle
// so opening a book doesn't ship code for file types it may never show. Named
// exports → map to a default for React.lazy.
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
