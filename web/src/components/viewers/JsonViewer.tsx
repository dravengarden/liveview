import { useEffect, useRef } from "react";
import { Box } from "@mui/material";
import type { Theme } from "@/types";

declare global {
  interface Window {
    monaco?: {
      editor: {
        create: (
          container: HTMLElement,
          options: {
            value: string;
            language: string;
            theme: string;
            readOnly: boolean;
            automaticLayout: boolean;
            minimap: { enabled: boolean };
            scrollBeyondLastLine: boolean;
            fontSize: number;
            wordWrap: string;
            folding: boolean;
          }
        ) => MonacoEditor;
        setTheme: (theme: string) => void;
      };
    };
  }
}

interface MonacoEditor {
  dispose: () => void;
  setValue: (value: string) => void;
}

interface JsonViewerProps {
  content: string | null;
  theme: Theme;
}

function isDarkTheme(theme: Theme): boolean {
  return !theme.includes("light");
}

export function JsonViewer({ content, theme }: JsonViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor | null>(null);

  // Create editor when content changes
  useEffect(() => {
    if (!containerRef.current || !content) return;

    const loadMonaco = () => {
      if (!window.monaco) return;

      if (editorRef.current) {
        editorRef.current.setValue(content);
        return;
      }

      editorRef.current = window.monaco.editor.create(containerRef.current!, {
        value: content,
        language: "json",
        theme: isDarkTheme(theme) ? "vs-dark" : "vs",
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 14,
        wordWrap: "on",
        folding: true,
      });
    };

    loadMonaco();

    return () => {
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
  }, [content]);

  // Update theme when it changes
  useEffect(() => {
    if (window.monaco) {
      window.monaco.editor.setTheme(isDarkTheme(theme) ? "vs-dark" : "vs");
    }
  }, [theme]);

  // Fallback if Monaco is not loaded
  if (!window.monaco && content) {
    let formattedJson = content;
    try {
      formattedJson = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Keep original content if parsing fails
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
        <pre style={{ margin: 0 }}>{formattedJson}</pre>
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      sx={{
        flex: 1,
        overflow: "hidden",
      }}
    />
  );
}
