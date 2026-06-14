import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Fab } from "@mui/material";
import {
  GraphicEq as ReadingIcon,
  Headphones as ReadAloudIcon,
  Pause as PauseIcon,
} from "@mui/icons-material";
import { READING_COLUMN_MAX } from "@/types";
import { ImageLightbox } from "../_shell";
import { ScrollToTopButton } from "./ScrollToTopButton";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useInPlaceHighlight } from "@/hooks/useInPlaceHighlight";
import { useAudioPlayer } from "@/audio/player";
import { ensureScript, ensureStyle } from "@/ensureAsset";

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
        options: { displayMode: boolean; throwOnError: boolean },
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
  /** Start reading this document aloud (text-rendition TTS + in-place highlight). */
  onReadAloud?: (() => void) | undefined;
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

// Mermaid renders with its NATIVE theme for the active page mode — "default"
// (light) on Light/Sepia, "dark" on Dark/Night — so a diagram is designed for
// the page it sits on, not a `filter: invert()` approximation of it. The page's
// color scheme is read from documentElement's `data-color-scheme` (set by
// useTheme); a live theme toggle re-renders every diagram from its stashed
// source (see the re-render effect + `data-mermaid-src`). Book SVGs (raster /
// fixed-colour standalone `.lv-svg-figure`) CAN'T re-render, so they keep the
// invert-filter dark adaptation in markdown.css — only mermaid goes native.
function isDarkScheme(): boolean {
  return document.documentElement.dataset["colorScheme"] === "dark";
}

function mermaidConfig(isDark: boolean): Record<string, unknown> {
  return {
    theme: isDark ? "dark" : "default",
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

// Resolve a document-relative reference (a link href or an image src) against
// the directory of `currentPath`, using shelf path semantics: a leading "/" is
// shelf-root-absolute, "." / ".." segments collapse, the result has no leading
// slash. Shared by the in-doc link handler and the image-src rewrite so the two
// can't drift.
function resolveDocPath(currentPath: string | null, ref: string): string {
  if (ref.startsWith("/")) return ref.slice(1);
  const basePath = currentPath?.split("/").slice(0, -1).join("/") ?? "";
  if (!basePath) return ref;
  const normalized: string[] = [];
  for (const part of `${basePath}/${ref}`.split("/")) {
    if (part === "..") normalized.pop();
    else if (part !== "." && part !== "") normalized.push(part);
  }
  return normalized.join("/");
}

// Open a figure (diagram / image) on a real TAP, not a naive `click`. A figure
// lives inside scrollable content — the page scrolls vertically and wide
// diagrams scroll horizontally — and a browser `click` fires even when the
// finger was actually scrolling, so the lightbox popped open by accident. This
// is the mobile-standard touch-slop model (Flutter's kTouchSlop = 18px,
// empirically tuned up from 8; iOS does the same): it counts as a tap only while
// net finger travel stays within the slop AND the press is brief. Any larger
// move — or a browser-issued `pointercancel` when scrolling takes the pointer
// over — cancels the tap. Returns a cleanup.
const FIGURE_TAP_SLOP_PX = 18;
const FIGURE_TAP_MAX_MS = 700;
function onTapToOpen(el: HTMLElement, open: () => void): () => void {
  let sx = 0;
  let sy = 0;
  let t0 = 0;
  let candidate = false;
  const moved = (e: PointerEvent): number =>
    Math.hypot(e.clientX - sx, e.clientY - sy);
  const down = (e: PointerEvent): void => {
    sx = e.clientX;
    sy = e.clientY;
    t0 = e.timeStamp;
    candidate = true;
  };
  const move = (e: PointerEvent): void => {
    if (candidate && moved(e) > FIGURE_TAP_SLOP_PX) candidate = false;
  };
  const up = (e: PointerEvent): void => {
    if (
      candidate && e.timeStamp - t0 <= FIGURE_TAP_MAX_MS &&
      moved(e) <= FIGURE_TAP_SLOP_PX
    ) {
      open();
    }
    candidate = false;
  };
  const cancel = (): void => {
    candidate = false;
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
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
  onReadAloud,
}: MarkdownViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  // Wrapper that hosts the reading-progress bar; carries the --lv-read-progress
  // CSS var (0..1) the bar scales to, set imperatively on scroll (no re-render).
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Suppresses the scroll handler while we programmatically restore position,
  // so restoring doesn't immediately overwrite the saved value with itself.
  const restoringRef = useRef(false);
  // rAF handle coalescing scroll bursts into one layout read per frame.
  const scrollRafRef = useRef<number | null>(null);
  // Ordered list of zoomable images in the doc + which one the lightbox shows.
  const [images, setImages] = useState<
    { src: string; alt: string; themed?: boolean }[]
  >([]);
  const [lbIndex, setLbIndex] = useState<number | null>(null);
  // Bumped when mermaid finishes rendering. Mermaid runs asynchronously, so the
  // diagrams aren't in the DOM yet when the gallery effect first wires click
  // handlers — re-running the effect on this tick picks them up once they are.
  const [diagramTick, setDiagramTick] = useState(0);

  // Keep the screen awake while a chapter is open — a reader may not touch the
  // screen for minutes. Released automatically when no doc is shown.
  useWakeLock(!!html);

  // Read-along: when the audio engine is narrating THIS text chapter, highlight
  // the spoken sentence in place. No-op during normal (silent) reading.
  useInPlaceHighlight(containerRef, currentPath);

  // Read-aloud floating control. `readingThis` = the engine is currently on this
  // very document (text rendition), so the button toggles play/pause; otherwise
  // it starts read-aloud via the parent-supplied callback.
  const { nowPlaying, playing, togglePlay } = useAudioPlayer();
  const readingThis = nowPlaying?.rendition === "text" &&
    nowPlaying.chapterPath === currentPath;

  const processContent = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Code blocks: add the copy button immediately (needs no library), then
    // syntax-highlight ON DEMAND — load highlight.js only when the page has
    // code, not on every visit. Plain (unhighlighted) code is the graceful
    // fallback if it fails to load.
    const codeBlocks = container.querySelectorAll<HTMLElement>("pre code");
    if (codeBlocks.length > 0) {
      codeBlocks.forEach((block) => {
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
      if ([...codeBlocks].some((b) => !b.dataset["highlighted"])) {
        void ensureScript("/highlight.min.js")
          .then(() => {
            containerRef.current?.querySelectorAll<HTMLElement>("pre code")
              .forEach((block) => {
                if (window.hljs && !block.dataset["highlighted"]) {
                  window.hljs.highlightElement(block);
                  block.dataset["highlighted"] = "true";
                }
              });
          })
          .catch(() => {
            // highlight.js unavailable — leave code as plain text.
          });
      }
    }

    // Mermaid: the library is ~3 MB, so load it ON DEMAND — only when the
    // chapter actually has a diagram. Each block becomes a spinner placeholder
    // while the script downloads, then renders in the page's native mode (see
    // mermaidConfig); a theme toggle re-renders them via the effect below.
    const mermaidBlocks = container.querySelectorAll<HTMLElement>(
      'pre[lang="mermaid"], code.language-mermaid',
    );
    if (mermaidBlocks.length > 0) {
      const pending: { holder: HTMLElement; code: string }[] = [];
      mermaidBlocks.forEach((block) => {
        if (block.dataset["mermaid"]) return;
        const code = block.tagName === "CODE"
          ? block.textContent
          : block.querySelector("code")?.textContent;
        if (!code) return;
        block.dataset["mermaid"] = "true";
        const holder = document.createElement("div");
        holder.className = "lv-diagram-loading";
        block.parentElement?.replaceChild(holder, block);
        pending.push({ holder, code });
      });
      if (pending.length > 0) {
        void ensureScript("/mermaid.min.js")
          .then(() => {
            if (!window.mermaid) return;
            window.mermaid.initialize(mermaidConfig(isDarkScheme()));
            pending.forEach(({ holder, code }) => {
              const div = document.createElement("div");
              div.className = "mermaid";
              div.textContent = code;
              // Stash the source so a later theme toggle can re-render this
              // diagram in the other mode (mermaid replaces textContent with the
              // SVG, losing the source otherwise).
              div.dataset["mermaidSrc"] = code;
              holder.replaceWith(div);
            });
            // Re-wire the lightbox gallery once the SVGs exist (run() is async).
            const divs = containerRef.current?.querySelectorAll<Element>(
              ".mermaid:not([data-processed])",
            );
            if (divs && divs.length > 0) {
              void window.mermaid.run({ nodes: divs }).then(() => {
                setDiagramTick((tk) => tk + 1);
              });
            }
          })
          .catch(() => {
            pending.forEach(({ holder }) => {
              holder.className = "lv-diagram-error";
            });
          });
      }
    }

    // KaTeX math (comrak emits <span data-math-style>…</span> + code.language-math).
    // Self-hosted + loaded ON DEMAND — only when the chapter has math. No CDN
    // (jsdelivr is slow/blocked behind the GFW + dead offline); assets live in
    // /katex/ (woff2 fonts resolve relative to the stylesheet).
    const mathEls = container.querySelectorAll<HTMLElement>(
      "[data-math-style]:not([data-katex-rendered]), code.language-math:not([data-katex-rendered])",
    );
    if (mathEls.length > 0) {
      void Promise.all([
        ensureScript("/katex/katex.min.js"),
        ensureStyle("/katex/katex.min.css"),
      ])
        .then(() => {
          const c = containerRef.current;
          if (!c || !window.katex) return;
          c.querySelectorAll<HTMLElement>(
            "[data-math-style]:not([data-katex-rendered])",
          ).forEach((el) => {
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
          // Also handle fenced code blocks with language "math".
          c.querySelectorAll<HTMLElement>(
            "code.language-math:not([data-katex-rendered])",
          ).forEach((el) => {
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
        })
        .catch(() => {
          // KaTeX unavailable — leave the raw TeX source visible.
        });
    }
  }, []);

  useEffect(() => {
    processContent();
  }, [html, processContent]);

  // Re-render mermaid diagrams when the app theme's light/dark MODE flips, so
  // each redraws in mermaid's native theme for the new mode (not a CSS-invert
  // approximation). Watches documentElement's `data-color-scheme` (set by
  // useTheme); a light↔light switch (classic↔sepia) leaves it unchanged → no
  // re-render. Each diagram redraws from its stashed `data-mermaid-src`. Book
  // SVGs can't re-render, so they keep the invert filter (markdown.css).
  useEffect(() => {
    const root = document.documentElement;
    let lastScheme = root.dataset["colorScheme"];
    const obs = new MutationObserver(() => {
      const scheme = root.dataset["colorScheme"];
      if (scheme === lastScheme) return;
      lastScheme = scheme;
      const container = containerRef.current;
      if (!container || !window.mermaid) return;
      const divs = container.querySelectorAll<HTMLElement>(
        ".mermaid[data-mermaid-src]",
      );
      if (divs.length === 0) return;
      divs.forEach((div) => {
        div.textContent = div.dataset["mermaidSrc"] ?? "";
        div.removeAttribute("data-processed");
      });
      window.mermaid.initialize(mermaidConfig(isDarkScheme()));
      void window.mermaid.run({ nodes: divs }).then(() => {
        setDiagramTick((tk) => tk + 1);
      });
    });
    obs.observe(root, {
      attributes: true,
      attributeFilter: ["data-color-scheme"],
    });
    return () => obs.disconnect();
  }, []);

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
      (img) =>
        !img.closest("a") && !img.classList.contains("emoji") &&
        !img.closest("g-emoji"),
    );
    const gallery: { src: string; alt: string; themed?: boolean }[] = [];
    const cleanups: (() => void)[] = [];
    imgs.forEach((img) => {
      // Book images are authored relative to the chapter (e.g. "assets/x.jpg").
      // Against the SPA origin those resolve to /assets/*, which is the embedded
      // bundle route — a 404, so the figure (and its lightbox entry) is blank.
      // Rewrite doc-relative srcs to the /api/raw file route; its overlay→base
      // fallback finds the asset under the served lang. Absolute URLs, data:/
      // blob: URIs and existing /api/ paths pass through. A trailing
      // #only-light/#only-dark fragment is kept so the dual-image CSS switch
      // (markdown.css) still matches on it.
      const rawSrc = img.getAttribute("src") ?? "";
      if (rawSrc && !/^(?:https?:|data:|blob:|\/\/|\/api\/)/.test(rawSrc)) {
        const hash = rawSrc.indexOf("#");
        const pathPart = hash >= 0 ? rawSrc.slice(0, hash) : rawSrc;
        const frag = hash >= 0 ? rawSrc.slice(hash) : "";
        img.src = `/api/raw?path=${
          encodeURIComponent(resolveDocPath(currentPath, pathPart))
        }${frag}`;
      }
      const idx = gallery.length;
      gallery.push({ src: img.currentSrc || img.src, alt: img.alt });
      let wrap = img.parentElement;
      if (
        !(wrap instanceof HTMLElement) ||
        !wrap.classList.contains("lv-zoom-wrap")
      ) {
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
      // Tap, not click — so scrolling the page over an image doesn't open the
      // lightbox by accident (same touch-slop recognizer as diagrams).
      cleanups.push(onTapToOpen(target, () => setLbIndex(idx)));
    });

    // Diagrams (mermaid + standalone SVG) join the same lightbox gallery. They
    // aren't <img>, so the click opens a lightbox entry backed by the SVG
    // serialized to a data: URL — the lightbox's <img> + zoom/pan code then
    // works unchanged. The SVG is snapshotted with an explicit white background
    // so the enlarged view matches the in-page plate (the backdrop is dark).
    // `.lv-svg-figure` is tagged here on genuine standalone SVGs only (skip
    // KaTeX math and octicons), so the CSS plate also lands only on those.
    const svgToDataUrl = (svg: SVGSVGElement, isMermaid: boolean): string => {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      if (!clone.getAttribute("xmlns")) {
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      }
      // Mermaid/book SVGs are sized with width="100%" + a CSS max-width. An
      // <img> is a replaced element with no containing block to resolve "100%"
      // against, so it falls back to the SVG default 300×150 — the diagram
      // shrinks to an unreadable thumbnail in the lightbox. Pin explicit pixel
      // dimensions from the viewBox (the diagram's own coordinate space), or
      // the rendered box if there's no viewBox, so the data: URL carries a real
      // intrinsic size; drop the inline max-width that would otherwise cap it.
      const vb = svg.viewBox.baseVal;
      let w = vb.width;
      let h = vb.height;
      if (!w || !h) {
        const rect = svg.getBoundingClientRect();
        w = rect.width;
        h = rect.height;
      }
      if (w && h) {
        clone.setAttribute("width", String(Math.round(w)));
        clone.setAttribute("height", String(Math.round(h)));
        clone.style.maxWidth = "none";
      }
      // Fixed-colour figures (book SVGs) get a white backing — the lightbox
      // inverts it to a dark plate in dark mode. A mermaid SVG is theme-native
      // (re-rendered per mode), so leave it transparent and let the lightbox's
      // mode-matched plate show through instead of being inverted back to light.
      clone.style.backgroundColor = isMermaid ? "transparent" : "#ffffff";
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
      const svg = el.tagName.toLowerCase() === "svg"
        ? (el as unknown as SVGSVGElement)
        : el.querySelector("svg");
      if (!svg) return;

      // Responsive inline sizing — let a diagram FIT the column whenever its
      // text stays at least readable (≈9px on screen), and only fall back to
      // horizontal scroll when fitting would shrink text below that floor. So
      // most diagrams just fit (no scrollbar); only genuinely-huge ones (a wide
      // sequence diagram, a sprawling SVG) scroll — and tap-to-zoom (below)
      // covers any fine detail. A lower floor than the QA target (11) is
      // deliberate: scrolling-too-eagerly is worse UX than slightly-small-but-
      // tappable inline text.
      const MIN_INLINE_FONT_PX = 9;
      const vbw = svg.viewBox.baseVal.width ||
        svg.getBoundingClientRect().width;
      if (vbw) {
        let minFont = Infinity;
        svg
          .querySelectorAll<HTMLElement>("text, .nodeLabel, .edgeLabel")
          .forEach((t) => {
            if (!(t.textContent ?? "").trim()) return;
            const fs = Number.parseFloat(getComputedStyle(t).fontSize);
            if (fs && fs < minFont) minFont = fs;
          });
        if (!Number.isFinite(minFont)) minFont = 14;
        // Subtract the diagram plate's padding (0.5rem each side) + a little
        // slack, so a diagram sized to "fit the column" actually fits INSIDE the
        // scroll wrapper rather than overflowing by the padding and scrolling for
        // no reason.
        const col = Math.max(120, (body.clientWidth || vbw) - 24);
        const rendered = Math.round(
          Math.min(vbw, Math.max(col, (vbw * MIN_INLINE_FONT_PX) / minFont)),
        );
        let wrap = el.parentElement;
        if (!wrap?.classList.contains("lv-diagram-scroll")) {
          const w = document.createElement("div");
          w.className = "lv-diagram-scroll";
          el.parentElement?.insertBefore(w, el);
          w.appendChild(el);
          wrap = w;
        }
        svg.style.width = `${rendered}px`;
        svg.style.maxWidth = "none";
        svg.style.height = "auto";
      }

      const idx = gallery.length;
      // Mermaid is theme-native (re-rendered per mode); a standalone book SVG
      // (.lv-svg-figure) has fixed baked-in colours. The lightbox must invert the
      // latter in dark mode but NOT the former, so tag the entry `themed`.
      const isMermaid = el.classList.contains("mermaid") ||
        svg.closest(".mermaid") !== null;
      gallery.push({
        src: svgToDataUrl(svg, isMermaid),
        alt: "",
        themed: isMermaid,
      });
      el.style.cursor = "zoom-in";
      // Open on a real TAP, not a naive `click` (which fires even after the
      // finger scrolled the page or panned a wide diagram → the lightbox popped
      // open by accident). See `onTapToOpen` — Flutter/iOS touch-slop model.
      cleanups.push(onTapToOpen(el, () => setLbIndex(idx)));
    });

    setImages(gallery);
    return () => {
      for (const c of cleanups) c();
    };
  }, [html, currentPath, diagramTick]);

  // Re-fit diagrams on viewport change (window resize / iPad rotate): bump the
  // diagram tick so the effect above recomputes each diagram's responsive width
  // for the new column. Coalesced to one rAF per burst.
  useEffect(() => {
    let raf = 0;
    const onResize = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setDiagramTick((t) => t + 1));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, []);

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
    if (restoringRef.current || !currentPath) return;
    if (scrollRafRef.current !== null) return; // a read is already queued
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = containerRef.current;
      if (!el || restoringRef.current || !currentPath) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return; // not scrollable yet — don't clobber with 0
      const ratio = el.scrollTop / max;
      // Drive the progress bar via a CSS var (no React re-render per scroll).
      wrapperRef.current?.style.setProperty(
        "--lv-read-progress",
        ratio.toFixed(4),
      );
      onSaveScroll?.(currentPath, ratio);
    });
  }, [currentPath, onSaveScroll]);

  // Cancel any queued scroll read on unmount so it can't fire after teardown.
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
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
          onNavigate(resolveDocPath(currentPath, href));
        }
        return;
      }
      // Image taps are handled by per-image listeners wired in the effect
      // above (so they fire reliably on iOS); nothing to do here.
    },
    [currentPath, onNavigate],
  );

  // Reading-layout vars from settings → applied as CSS custom properties on
  // the inner column. `.markdown-body` reads --lv-line-height; max-width is
  // applied directly so layout responds without an extra CSS round-trip.
  const innerSx = {
    // Fixed comfortable column cap (centred); the user-controlled value is the
    // side MARGIN, applied as the scroll container's horizontal padding below.
    maxWidth: `${READING_COLUMN_MAX}px`,
    mx: "auto",
    // CSS custom prop consumed by markdown.css. (Font size scales globally via
    // the root font-size, so there's no per-reader scale var here.)
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
        ref={wrapperRef}
        // `view-transition-name` scopes the chapter cross-fade (App.loadFile) to
        // the reader area, so the sidebar/chrome don't animate. Only one element
        // may carry a given name, and one MarkdownViewer is mounted at a time.
        style={{ viewTransitionName: "lv-content" }}
        sx={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {
          /* Reading-progress bar: scales with scroll via --lv-read-progress (set
          imperatively in handleScroll). Pinned to the top edge of the reader. */
        }
        <Box
          aria-hidden
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "3px",
            zIndex: 4,
            transformOrigin: "left center",
            transform: "scaleX(var(--lv-read-progress, 0))",
            bgcolor: "primary.main",
            opacity: 0.85,
            pointerEvents: "none",
          }}
        />
        <Box
          ref={containerRef}
          data-lv-scroller="reader"
          onClick={handleClick}
          onScroll={handleScroll}
          sx={{
            flex: 1,
            // Without min-height:0 a flex child won't shrink below its content, so
            // overflow:auto never engages and the page can't scroll (notably on
            // iOS, where there's no trackpad to mask it).
            minHeight: 0,
            overflow: "auto",
            // Vertical padding fixed; horizontal padding IS the reading margin.
            pt: { xs: 2, md: 4 },
            // Foot padding ADDS the frosted bottom bar's height on the mobile tier
            // (--shell-bar-h, published by NavShell on the content region; 0 on
            // desktop / before measured) on top of the base breathing room, so the
            // last paragraph scrolls fully clear of the frosted overlay bar yet the
            // text still scrolls UNDER it. Restore-by-ratio is unaffected (it reads
            // scrollHeight after this padding is in).
            pb: {
              xs: "calc(16px + var(--shell-bar-h, 0px))",
              md: "calc(32px + var(--shell-bar-h, 0px))",
            },
            px: `${contentMaxWidth}px`,
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
        {
          /* Back-to-top — absolute within this relative wrapper. The bottom nav bar
          is now a frosted OVERLAY over this area (not a flex sibling below it),
          so lift the FAB by the bar's height (--shell-bar-h; 0 on the solid /
          desktop path) to keep it clear of the bar + the reading-progress bar. */
        }
        <ScrollToTopButton
          targetRef={containerRef}
          bottomLift="var(--shell-bar-h, 0px)"
        />
        {onReadAloud && (
          <Fab
            color="primary"
            size="medium"
            aria-label={readingThis
              ? (playing ? "Pause reading aloud" : "Resume reading aloud")
              : "Read this page aloud"}
            onClick={() => (readingThis ? togglePlay() : onReadAloud())}
            sx={{
              position: "absolute",
              left: 16,
              // Sit above the frosted bottom bar on mobile (0 on desktop).
              bottom: "calc(16px + var(--shell-bar-h, 0px))",
              zIndex: 5,
            }}
          >
            {readingThis
              ? (playing ? <PauseIcon /> : <ReadingIcon />)
              : <ReadAloudIcon />}
          </Fab>
        )}
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
