import { Box } from "@mui/material";
import { remoteUrl } from "@/apiBase";

interface HtmlViewerProps {
  content: string | null;
  path: string;
}

export function HtmlViewer({ path }: HtmlViewerProps): React.JSX.Element {
  // Use raw API endpoint so relative paths in HTML work correctly
  // (absolute in the bundled native shell — see ImageViewer).
  const htmlUrl = remoteUrl(`/api/raw?path=${encodeURIComponent(path)}`);

  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        overflow: "hidden",
      }}
    >
      <iframe
        src={htmlUrl}
        title={path}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          backgroundColor: "white",
        }}
      />
    </Box>
  );
}
