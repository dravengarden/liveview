import { Box, Typography } from "@mui/material";
import { Description as FileIcon } from "@mui/icons-material";
import type { Theme, FileType } from "@/types";
import { useI18n } from "@/i18n";
import { MarkdownViewer } from "./MarkdownViewer";
import { ImageViewer } from "./viewers/ImageViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { HtmlViewer } from "./viewers/HtmlViewer";
import { CsvViewer } from "./viewers/CsvViewer";
import { JsonViewer } from "./viewers/JsonViewer";
import { ExcalidrawViewer } from "./viewers/ExcalidrawViewer";
import { LatexViewer } from "./viewers/LatexViewer";
import { TypstViewer } from "./viewers/TypstViewer";

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
        <FileIcon sx={{ fontSize: 64, mb: 2, opacity: 0.5 }} />
        <Typography variant="body1">{t("content.selectFile")}</Typography>
      </Box>
    );
  }

  switch (fileType) {
    case "markdown":
      return (
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

    case "image":
      return <ImageViewer path={currentPath} />;

    case "pdf":
      return <PdfViewer path={currentPath} />;

    case "html":
      return <HtmlViewer content={content} path={currentPath} />;

    case "csv":
      return <CsvViewer content={content} theme={theme} />;

    case "json":
      return <JsonViewer content={content} />;

    case "excalidraw":
      return <ExcalidrawViewer content={content} theme={theme} />;

    case "latex":
      return <LatexViewer content={content} theme={theme} />;

    case "typst":
      return <TypstViewer content={content} path={currentPath} />;

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
          <FileIcon sx={{ fontSize: 64, mb: 2, opacity: 0.5 }} />
          <Typography variant="body1">{t("content.unsupported", { type: fileType })}</Typography>
        </Box>
      );
  }
}
