import { useMemo, useState, useEffect } from "react";
import { Box, Typography, CircularProgress } from "@mui/material";
import type { Theme } from "@/types";
import { ensureScript, ensureStyle } from "@/ensureAsset";

// katex type is declared in MarkdownViewer.tsx

interface LatexViewerProps {
  content: string | null;
  theme: Theme;
}

function isDarkTheme(theme: Theme): boolean {
  return !theme.includes("light");
}

export function LatexViewer({ content, theme }: LatexViewerProps): React.JSX.Element {
  // KaTeX is self-hosted + loaded on demand (no CDN). Render once it's ready.
  const [katexReady, setKatexReady] = useState<boolean>(
    typeof window !== "undefined" && !!window.katex
  );
  useEffect(() => {
    if (window.katex) {
      setKatexReady(true);
      return;
    }
    let cancelled = false;
    void Promise.all([ensureScript("/katex/katex.min.js"), ensureStyle("/katex/katex.min.css")])
      .then(() => {
        if (!cancelled) setKatexReady(true);
      })
      .catch(() => {
        if (!cancelled) setKatexReady(true); // surface the raw-LaTeX fallback
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const renderedHtml = useMemo(() => {
    if (!content || !katexReady || !window.katex) return null;

    // Simple LaTeX document parsing - extract content between \begin{document} and \end{document}
    let mathContent = content;
    const docMatch = content.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
    if (docMatch?.[1]) {
      mathContent = docMatch[1];
    }

    // Split by display math delimiters and inline math
    const parts: { type: "text" | "display" | "inline"; content: string }[] = [];

    // Process display math: \[ \], $$ $$, \begin{equation} \end{equation}, etc.
    const displayMathRegex = /\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\begin\{(equation|align|gather|multline)\*?\}([\s\S]*?)\\end\{\3\*?\}/g;
    const inlineMathRegex = /\\\(([\s\S]*?)\\\)|\$([^$\n]+?)\$/g;

    let lastIndex = 0;
    const allMatches: { index: number; length: number; content: string; type: "display" | "inline" }[] = [];

    // Find all display math
    let match;
    while ((match = displayMathRegex.exec(mathContent)) !== null) {
      const tex = match[1] ?? match[2] ?? match[4] ?? "";
      if (tex) {
        allMatches.push({
          index: match.index,
          length: match[0].length,
          content: tex,
          type: "display",
        });
      }
    }

    // Find all inline math
    while ((match = inlineMathRegex.exec(mathContent)) !== null) {
      const tex = match[1] ?? match[2] ?? "";
      if (!tex) continue;
      // Check if this overlaps with display math
      const overlaps = allMatches.some(
        (m) => match!.index >= m.index && match!.index < m.index + m.length
      );
      if (!overlaps) {
        allMatches.push({
          index: match.index,
          length: match[0].length,
          content: tex,
          type: "inline",
        });
      }
    }

    // Sort by index
    allMatches.sort((a, b) => a.index - b.index);

    // Build parts array
    for (const m of allMatches) {
      if (m.index > lastIndex) {
        parts.push({
          type: "text",
          content: mathContent.slice(lastIndex, m.index),
        });
      }
      parts.push({
        type: m.type,
        content: m.content,
      });
      lastIndex = m.index + m.length;
    }

    if (lastIndex < mathContent.length) {
      parts.push({
        type: "text",
        content: mathContent.slice(lastIndex),
      });
    }

    // Render each part
    const html = parts
      .map((part) => {
        if (part.type === "text") {
          // Convert simple LaTeX text commands
          return part.content
            .replace(/\\section\{([^}]+)\}/g, "<h2>$1</h2>")
            .replace(/\\subsection\{([^}]+)\}/g, "<h3>$1</h3>")
            .replace(/\\textbf\{([^}]+)\}/g, "<strong>$1</strong>")
            .replace(/\\textit\{([^}]+)\}/g, "<em>$1</em>")
            .replace(/\\\\|\n\n/g, "<br/>")
            .replace(/\\par/g, "<p></p>");
        }
        try {
          return window.katex!.renderToString(part.content.trim(), {
            displayMode: part.type === "display",
            throwOnError: false,
          });
        } catch {
          return `<span class="katex-error">${part.content}</span>`;
        }
      })
      .join("");

    return html;
  }, [content, katexReady]);

  const dark = isDarkTheme(theme);

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

  if (!katexReady) {
    return (
      <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "text.secondary" }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (!window.katex) {
    return (
      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          p: 4,
          fontFamily: "monospace",
          fontSize: 14,
          whiteSpace: "pre-wrap",
          bgcolor: "background.paper",
        }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          KaTeX not loaded. Showing raw LaTeX:
        </Typography>
        <pre style={{ margin: 0 }}>{content}</pre>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        flex: 1,
        overflow: "auto",
        p: 4,
        bgcolor: dark ? "background.paper" : "#ffffff",
        color: dark ? "text.primary" : "#000000",
        "& .katex": {
          fontSize: "1.2em",
        },
        "& .katex-display": {
          margin: "1em 0",
          textAlign: "center",
        },
        "& .katex-error": {
          color: "error.main",
          fontFamily: "monospace",
        },
        "& h2": {
          fontSize: "1.5em",
          fontWeight: "bold",
          mt: 3,
          mb: 2,
        },
        "& h3": {
          fontSize: "1.25em",
          fontWeight: "bold",
          mt: 2,
          mb: 1,
        },
      }}
      dangerouslySetInnerHTML={{ __html: renderedHtml ?? "" }}
    />
  );
}
