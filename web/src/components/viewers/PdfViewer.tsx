import { Box } from "@mui/material";
import { remoteUrl } from "@/apiBase";

interface PdfViewerProps {
  path: string;
}

export function PdfViewer({ path }: PdfViewerProps): React.JSX.Element {
  // Absolute in the bundled native shell (see ImageViewer).
  const pdfUrl = remoteUrl(`/api/raw?path=${encodeURIComponent(path)}`);

  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        overflow: "hidden",
      }}
    >
      <Box
        component="iframe"
        src={pdfUrl}
        title={path}
        sx={{
          width: "100%",
          height: "100%",
          border: "none",
        }}
      />
    </Box>
  );
}
