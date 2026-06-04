import { Box } from "@mui/material";

interface JsonViewerProps {
  content: string | null;
}

// Read-only JSON view: pretty-print and show in a <pre>. This used to embed
// Monaco (~5 MB, CDN-loaded) for a rarely-opened file type — dropped entirely
// in favour of a formatted block. Invalid JSON is shown verbatim.
export function JsonViewer({ content }: JsonViewerProps): React.JSX.Element {
  let formatted = content ?? "";
  if (content) {
    try {
      formatted = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Not valid JSON — show the raw text rather than fail.
    }
  }

  return (
    <Box
      sx={{
        flex: 1,
        overflow: "auto",
        p: 2,
        fontFamily: "monospace",
        fontSize: 14,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        bgcolor: "background.paper",
      }}
    >
      <pre style={{ margin: 0 }}>{formatted}</pre>
    </Box>
  );
}
