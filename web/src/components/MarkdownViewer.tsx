import { useEffect, useRef, useCallback, useState } from "react";
import { Box } from "@mui/material";
import type { Theme } from "@/types";
import { ImageLightbox } from "./ImageLightbox";

declare global {
  interface Window {
    hljs?: {
      highlightElement: (el: Element) => void;
    };
    mermaid?: {
      initialize: (config: { theme: string; startOnLoad: boolean }) => void;
      run: (config: { nodes: NodeListOf<Element> }) => Promise<void>;
    };
    katex?: {
      renderToString: (
        tex: string,
        options: { displayMode: boolean; throwOnError: boolean }
      ) => string;
    };
  }
}

interface MarkdownViewerProps {
  html: string | null;
  currentPath: string | null;
  theme: Theme;
  onNavigate: (path: string) => void;
  /** Max width of the inner reading column in px. 0 ⇒ no limit (full width). */
  contentMaxWidth: number;
  /** Line height applied to .markdown-body via the --lv-line-height CSS var. */
  lineHeight: number;
  /** Saved scroll ratio (0..1) for a doc path, to restore on open. */
  savedScroll?: ((path: string) => number | undefined) | undefined;
  /** Report the current scroll ratio (0..1) for a doc path (debounced upstream). */
  onSaveScroll?: ((path: string, ratio: number) => void) | undefined;
}

function isDarkTheme(theme: Theme): boolean {
  return !theme.includes("light");
}

export function MarkdownViewer({
  html,
  currentPath,
  theme,
  onNavigate,
  contentMaxWidth,
  lineHeight,
  savedScroll,
  onSaveScroll,
}: MarkdownViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevThemeRef = useRef<Theme>(theme);
  // Suppresses the scroll handler while we programmatically restore position,
  // so restoring doesn't immediately overwrite the saved value with itself.
  const restoringRef = useRef(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const processContent = useCallback((forceRerender = false) => {
    const container = containerRef.current;
    if (!container) return;

    container.querySelectorAll<HTMLElement>("pre code").forEach((block) => {
      if (window.hljs && !block.dataset["highlighted"]) {
        window.hljs.highlightElement(block);
        block.dataset["highlighted"] = "true";
      }

      const pre = block.parentElement;
      if (pre && !pre.querySelector(".copy-btn")) {
        const copyBtn = document.createElement("button");
        copyBtn.className = "copy-btn";
        copyBtn.textContent = "Copy";
        copyBtn.onclick = async () => {
          await navigator.clipboard.writeText(block.textContent ?? "");
          copyBtn.textContent = "Copied!";
          setTimeout(() => {
            copyBtn.textContent = "Copy";
          }, 2000);
        };
        pre.style.position = "relative";
        pre.appendChild(copyBtn);
      }
    });

    const mermaidTheme = isDarkTheme(theme) ? "dark" : "default";

    // Handle unprocessed mermaid blocks
    const mermaidBlocks = container.querySelectorAll<HTMLElement>(
      'pre[lang="mermaid"], code.language-mermaid'
    );
    if (mermaidBlocks.length > 0 && window.mermaid) {
      window.mermaid.initialize({
        theme: mermaidTheme,
        startOnLoad: false,
      });

      mermaidBlocks.forEach((block) => {
        const code = block.tagName === "CODE" ? block.textContent : block.querySelector("code")?.textContent;
        if (code && !block.dataset["mermaid"]) {
          const div = document.createElement("div");
          div.className = "mermaid";
          div.textContent = code;
          block.parentElement?.replaceChild(div, block);
        }
      });

      const mermaidDivs = container.querySelectorAll<Element>(".mermaid:not([data-processed])");
      if (mermaidDivs.length > 0) {
        void window.mermaid.run({ nodes: mermaidDivs });
      }
    }

    // Re-render existing mermaid diagrams when theme changes
    if (forceRerender && window.mermaid) {
      window.mermaid.initialize({
        theme: mermaidTheme,
        startOnLoad: false,
      });

      const processedMermaids = container.querySelectorAll<HTMLElement>(".mermaid[data-processed]");
      processedMermaids.forEach((el) => {
        const originalCode = el.getAttribute("data-original");
        if (originalCode) {
          el.removeAttribute("data-processed");
          el.innerHTML = originalCode;
        }
      });

      const mermaidDivs = container.querySelectorAll<Element>(".mermaid:not([data-processed])");
      if (mermaidDivs.length > 0) {
        // Store original code before re-rendering
        mermaidDivs.forEach((el) => {
          if (!el.getAttribute("data-original")) {
            el.setAttribute("data-original", el.textContent ?? "");
          }
        });
        void window.mermaid.run({ nodes: mermaidDivs });
      }
    }

    // Process KaTeX math blocks (comrak outputs <span data-math-style="...">...</span>)
    if (window.katex) {
      container.querySelectorAll<HTMLElement>('[data-math-style]:not([data-katex-rendered])').forEach((el) => {
        const tex = el.textContent ?? "";
        const displayMode = el.dataset["mathStyle"] === "display";
        try {
          el.innerHTML = window.katex!.renderToString(tex, {
            displayMode,
            throwOnError: false,
          });
          el.dataset["katexRendered"] = "true";
        } catch {
          // Keep original content on error
        }
      });

      // Also handle code blocks with language "math"
      container.querySelectorAll<HTMLElement>('code.language-math:not([data-katex-rendered])').forEach((el) => {
        const tex = el.textContent ?? "";
        const pre = el.parentElement;
        if (pre?.tagName === "PRE") {
          try {
            const div = document.createElement("div");
            div.className = "katex-display-block";
            div.innerHTML = window.katex!.renderToString(tex, {
              displayMode: true,
              throwOnError: false,
            });
            pre.replaceWith(div);
          } catch {
            // Keep original content on error
          }
        }
      });
    }
  }, [theme]);

  useEffect(() => {
    const themeChanged = prevThemeRef.current !== theme;
    prevThemeRef.current = theme;
    processContent(themeChanged);
  }, [html, theme, processContent]);

  // Persist scroll position (as a 0..1 ratio, robust to reflow) while reading.
  // Upstream debounces the network write; here we just report on each scroll.
  const handleScroll = useCallback(() => {
    if (restoringRef.current || !currentPath || !onSaveScroll) return;
    const el = containerRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return; // not scrollable yet — don't clobber with 0
    onSaveScroll(currentPath, el.scrollTop / max);
  }, [currentPath, onSaveScroll]);

  // Restore the saved position when a document opens. Content height settles
  // asynchronously (syntax highlight, KaTeX, mermaid, images), so re-apply a
  // few times; `restoringRef` keeps these programmatic scrolls from saving.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !currentPath) return undefined;
    const ratio = savedScroll?.(currentPath) ?? 0;
    restoringRef.current = true;
    const apply = (): void => {
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = max > 0 ? ratio * max : 0;
    };
    apply();
    const t1 = setTimeout(apply, 250);
    const t2 = setTimeout(apply, 600);
    const done = setTimeout(() => {
      restoringRef.current = false;
    }, 700);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(done);
    };
  }, [html, currentPath, savedScroll]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");

      if (anchor) {
        const href = anchor.getAttribute("href");
        if (!href) return;

        if (href.startsWith("http://") || href.startsWith("https://")) {
          return;
        }

        e.preventDefault();

        if (href.startsWith("#")) {
          const id = href.slice(1);
          const el = document.getElementById(id);
          el?.scrollIntoView({ behavior: "smooth" });
          return;
        }

        if (href.endsWith(".md") || href.endsWith(".markdown")) {
          const basePath = currentPath?.split("/").slice(0, -1).join("/") ?? "";
          let resolvedPath: string;
          if (href.startsWith("/")) {
            resolvedPath = href.slice(1);
          } else if (basePath) {
            // Resolve relative path
            const parts = `${basePath}/${href}`.split("/");
            const normalized: string[] = [];
            for (const part of parts) {
              if (part === "..") {
                normalized.pop();
              } else if (part !== "." && part !== "") {
                normalized.push(part);
              }
            }
            resolvedPath = normalized.join("/");
          } else {
            resolvedPath = href;
          }
          onNavigate(resolvedPath);
        }
        return;
      }

      // Click on a (non-linked) doc image → open the zoom lightbox. Reuse the
      // browser-resolved URL the <img> already loaded, so this works no matter
      // how the src was formed. Skip broken/zero-size images.
      const img = target.closest("img");
      if (img instanceof HTMLImageElement && img.naturalWidth > 0) {
        setLightbox({ src: img.currentSrc || img.src, alt: img.alt });
      }
    },
    [currentPath, onNavigate]
  );

  // Reading-layout vars from settings → applied as CSS custom properties on
  // the inner column. `.markdown-body` reads --lv-line-height; max-width is
  // applied directly so layout responds without an extra CSS round-trip.
  const innerSx = {
    maxWidth: contentMaxWidth > 0 ? `${contentMaxWidth}px` : "none",
    mx: "auto",
    // CSS custom prop consumed by markdown.css.
    "--lv-line-height": String(lineHeight),
  } as const;

  if (!html) {
    // Empty file - just show empty content area
    return (
      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          p: 4,
        }}
      >
        <Box className="markdown-body" sx={innerSx} />
      </Box>
    );
  }

  return (
    <>
    <Box
      ref={containerRef}
      onClick={handleClick}
      onScroll={handleScroll}
      sx={{
        flex: 1,
        overflow: "auto",
        p: { xs: 2, md: 4 },
        "& img": {
          cursor: "zoom-in",
        },
        "& .copy-btn": {
          position: "absolute",
          top: 8,
          right: 8,
          px: 1.5,
          py: 0.5,
          fontSize: 12,
          bgcolor: "action.hover",
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
          cursor: "pointer",
          opacity: 0,
          transition: "opacity 0.2s",
          "&:hover": {
            bgcolor: "action.selected",
          },
        },
        "& pre:hover .copy-btn": {
          opacity: 1,
        },
      }}
    >
      <Box
        className="markdown-body"
        sx={innerSx}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </Box>
      <ImageLightbox
        src={lightbox?.src ?? null}
        alt={lightbox?.alt ?? ""}
        onClose={() => setLightbox(null)}
      />
    </>
  );
}
