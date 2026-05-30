import { useEffect, useRef, useCallback, useState } from "react";
import { Box } from "@mui/material";
import { ImageLightbox } from "./ImageLightbox";

declare global {
  interface Window {
    hljs?: {
      highlightElement: (el: Element) => void;
    };
    mermaid?: {
      initialize: (config: Record<string, unknown>) => void;
      run: (config: { nodes: NodeListOf<Element> }) => Promise<void>;
      /** Present only after the vendored ELK layout loader registers itself. */
      registerLayoutLoaders?: (loaders: unknown) => void;
    };
    /** Default export of @mermaid-js/layout-elk, exposed by the vendored UMD. */
    "mermaid-layout-elk"?: unknown;
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

// Font stack for mermaid SVG labels. Why: mermaid's built-in default is
// "trebuchet ms", which has NO CJK glyphs — Chinese/Japanese labels render as
// tofu. We start from the reader's selected reading font (--lv-reading-font,
// which already chains a Noto SC face when a preset is loaded) and append
// platform CJK fallbacks so labels stay legible even before any @fontsource
// face is lazily fetched. var() resolves inside inline SVG in all evergreen
// browsers, so the font also tracks live font-preset changes.
const MERMAID_FONT_FAMILY =
  'var(--lv-reading-font), "Noto Sans SC", "PingFang SC", ' +
  '"Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

// Mermaid is pinned to its light "default" theme in EVERY app theme, and the
// rendered diagram sits on a fixed light plate (.mermaid in markdown.css). Why
// not switch mermaid light/dark with the page: that needs a full re-render of
// every diagram on each theme change, and still leaves dark-mermaid mismatched
// against the (necessarily light) plate book SVGs need. One fixed theme + one
// fixed plate means a diagram reads identically in Light / Sepia / Dark / Night
// with zero per-theme variants to maintain — the same floor the figure plate
// gives raster images.
function mermaidConfig(): Record<string, unknown> {
  return {
    theme: "default",
    startOnLoad: false,
    fontFamily: MERMAID_FONT_FAMILY,
    markdownAutoWrap: true,
    flowchart: {
      useMaxWidth: true,
      wrappingWidth: 220,
      nodeSpacing: 55,
      rankSpacing: 60,
      padding: 12,
      curve: "basis",
    },
    sequence: { useMaxWidth: true, wrap: true },
  };
}

export function MarkdownViewer({
  html,
  currentPath,
  onNavigate,
  contentMaxWidth,
  lineHeight,
  savedScroll,
  onSaveScroll,
}: MarkdownViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  // Suppresses the scroll handler while we programmatically restore position,
  // so restoring doesn't immediately overwrite the saved value with itself.
  const restoringRef = useRef(false);
  // rAF handle coalescing scroll bursts into one layout read per frame.
  const scrollRafRef = useRef<number | null>(null);
  // Ordered list of zoomable images in the doc + which one the lightbox shows.
  const [images, setImages] = useState<{ src: string; alt: string }[]>([]);
  const [lbIndex, setLbIndex] = useState<number | null>(null);

  const processContent = useCallback(() => {
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

    // Mermaid: pinned to one light theme regardless of the app theme (see
    // mermaidConfig), so there is no theme re-render path to maintain — render
    // each block once. The light plate behind it (.mermaid in markdown.css)
    // makes the diagram read identically in every app theme.
    const mermaidBlocks = container.querySelectorAll<HTMLElement>(
      'pre[lang="mermaid"], code.language-mermaid'
    );
    if (mermaidBlocks.length > 0 && window.mermaid) {
      window.mermaid.initialize(mermaidConfig());

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
  }, []);

  useEffect(() => {
    processContent();
  }, [html, processContent]);

  // Make every (non-linked) doc image a zoomable, tappable target and collect
  // them into an ordered gallery for the lightbox. The open listener is bound
  // to a wrapper element directly, NOT delegated from the container: iOS Safari
  // only dispatches `click` on elements that are themselves interactive (a
  // `cursor: zoom-in` rule is not enough), so container-level delegation
  // silently no-ops on iPhone/iPad — which is the whole "doesn't work on
  // mobile" bug. The wrapper also anchors the magnifier affordance badge.
  useEffect(() => {
    const container = containerRef.current;
    const body = container?.querySelector<HTMLElement>(".markdown-body");
    if (!body) {
      setImages([]);
      return undefined;
    }
    const imgs = [...body.querySelectorAll<HTMLImageElement>("img")].filter(
      (img) => !img.closest("a") && !img.classList.contains("emoji") && !img.closest("g-emoji"),
    );
    const gallery: { src: string; alt: string }[] = [];
    const cleanups: (() => void)[] = [];
    imgs.forEach((img) => {
      const idx = gallery.length;
      gallery.push({ src: img.currentSrc || img.src, alt: img.alt });
      let wrap = img.parentElement;
      if (!(wrap instanceof HTMLElement) || !wrap.classList.contains("lv-zoom-wrap")) {
        const span = document.createElement("span");
        span.className = "lv-zoom-wrap";
        img.replaceWith(span);
        span.appendChild(img);
        const badge = document.createElement("span");
        badge.className = "lv-zoom-badge";
        badge.setAttribute("aria-hidden", "true");
        span.appendChild(badge);
        wrap = span;
      }
      const target = wrap;
      const onOpen = (): void => setLbIndex(idx);
      target.addEventListener("click", onOpen);
      cleanups.push(() => target.removeEventListener("click", onOpen));
    });

    // Diagrams (mermaid + standalone SVG) join the same lightbox gallery. They
    // aren't <img>, so the click opens a lightbox entry backed by the SVG
    // serialized to a data: URL — the lightbox's <img> + zoom/pan code then
    // works unchanged. The SVG is snapshotted with an explicit white background
    // so the enlarged view matches the in-page plate (the backdrop is dark).
    // `.lv-svg-figure` is tagged here on genuine standalone SVGs only (skip
    // KaTeX math and octicons), so the CSS plate also lands only on those.
    const svgToDataUrl = (svg: SVGSVGElement): string => {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.style.backgroundColor = "#ffffff";
      const xml = new XMLSerializer().serializeToString(clone);
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    };
    const diagrams: HTMLElement[] = [
      ...body.querySelectorAll<HTMLElement>(".mermaid"),
      ...[...body.querySelectorAll<SVGSVGElement>("svg")]
        .filter(
          (svg) =>
            !svg.closest(".mermaid") &&
            !svg.classList.contains("octicon") &&
            !svg.closest(".katex") &&
            !svg.closest("a"),
        )
        .map((svg) => {
          svg.classList.add("lv-svg-figure");
          return svg as unknown as HTMLElement;
        }),
    ];
    diagrams.forEach((el) => {
      const svg = el.tagName.toLowerCase() === "svg" ? (el as unknown as SVGSVGElement) : el.querySelector("svg");
      if (!svg) return;
      const idx = gallery.length;
      gallery.push({ src: svgToDataUrl(svg), alt: "" });
      el.style.cursor = "zoom-in";
      const onOpen = (): void => setLbIndex(idx);
      el.addEventListener("click", onOpen);
      cleanups.push(() => el.removeEventListener("click", onOpen));
    });

    setImages(gallery);
    return () => {
      for (const c of cleanups) c();
    };
  }, [html]);

  // Persist scroll position (as a 0..1 ratio, robust to reflow) while reading.
  // Upstream debounces the network write; here we just report on each scroll.
  //
  // The read is deferred to a single requestAnimationFrame, NOT done inline.
  // Why: reading scrollHeight/clientHeight inside the scroll event forces a
  // synchronous reflow. A scroll burst (momentum scrolling, or the column
  // collapsing on teardown) would otherwise re-measure the tall .markdown-body
  // on every event. Coalescing to one read per frame — and bailing if the node
  // has since detached — keeps the scroll handler off the layout-thrash path.
  const handleScroll = useCallback(() => {
    if (restoringRef.current || !currentPath || !onSaveScroll) return;
    if (scrollRafRef.current !== null) return; // a read is already queued
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = containerRef.current;
      if (!el || restoringRef.current || !currentPath || !onSaveScroll) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return; // not scrollable yet — don't clobber with 0
      onSaveScroll(currentPath, el.scrollTop / max);
    });
  }, [currentPath, onSaveScroll]);

  // Cancel any queued scroll read on unmount so it can't fire after teardown.
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

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
      // Image taps are handled by per-image listeners wired in the effect
      // above (so they fire reliably on iOS); nothing to do here.
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
        // Without min-height:0 a flex child won't shrink below its content, so
        // overflow:auto never engages and the page can't scroll (notably on
        // iOS, where there's no trackpad to mask it).
        minHeight: 0,
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
        images={images}
        index={lbIndex}
        onIndex={setLbIndex}
        onClose={() => setLbIndex(null)}
      />
    </>
  );
}
