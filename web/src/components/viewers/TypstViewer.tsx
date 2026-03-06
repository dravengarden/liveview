import { useEffect, useRef } from "react";
import { Box, Typography, Chip, Stack } from "@mui/material";
import { Code as CodeIcon } from "@mui/icons-material";

declare global {
  interface Window {
    hljs?: {
      highlightElement: (el: Element) => void;
    };
  }
}

interface TypstViewerProps {
  content: string | null;
  path: string;
}

export function TypstViewer({ content, path }: TypstViewerProps): React.JSX.Element {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (codeRef.current && window.hljs) {
      // Reset highlighting
      codeRef.current.removeAttribute("data-highlighted");
      window.hljs.highlightElement(codeRef.current);
    }
  }, [content]);

  if (!content) {
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
        Loading...
      </Box>
    );
  }

  return (
    <Box
      sx={{
        flex: 1,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          p: 2,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <CodeIcon fontSize="small" color="action" />
        <Typography variant="body2" color="text.secondary">
          {path}
        </Typography>
        <Chip
          label="Typst"
          size="small"
          variant="outlined"
          sx={{ ml: "auto" }}
        />
      </Stack>
      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          p: 0,
          "& pre": {
            m: 0,
            p: 2,
            height: "100%",
            overflow: "auto",
            borderRadius: 0,
          },
          "& code": {
            fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
            fontSize: 14,
            lineHeight: 1.6,
          },
        }}
      >
        <pre>
          <code ref={codeRef} className="language-typst">
            {content}
          </code>
        </pre>
      </Box>
    </Box>
  );
}
