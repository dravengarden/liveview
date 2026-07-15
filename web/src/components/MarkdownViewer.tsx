import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box } from "@mui/material";
import { READING_COLUMN_MAX } from "@/types";
import { ImageLightbox } from "../_shell";
import { ScrollToTopButton } from "./ScrollToTopButton";
import { PlaybackBar } from "./PlaybackBar";
import { InteractiveViewInline } from "./viewers/InteractiveViewViewer";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useInPlaceHighlight } from "@/hooks/useInPlaceHighlight";
import { ensureScript, ensureStyle, publicAsset } from "@/ensureAsset";

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
  /** True when the nav bar sits at the bottom — passed to the read-aloud
   *  <PlaybackBar> so it drops its own home-indicator inset (the bar below owns it). */
  navbarAtBottom?: boolean | undefined;
  /** Footer rendered under the content, inside the reading column — the prev/next
   *  <ChapterPager>. Scrolls with the text and clears the bottom bars via the
   *  scroller's own foot padding. */
  footer?: React.ReactNode;
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

/** Copy the read-along block anchors (`data-blk` numbered by the highlight, and
 *  `data-sourcepos` stamped by the server) from one element to its replacement,
 *  so a re-rendered diagram block stays findable by the in-place highlight. */
function carryReadAnchors(from: HTMLElement, to: HTMLElement): void {
  for (const attr of ["data-blk", "data-sourcepos"]) {
    const v = from.getAttribute(attr);
    if (v !== null) to.setAttribute(attr, v);
  }
}

/** Prose base font px — the app-wide font-size setting's default (scale 1). The
 *  diagram font scale is measured relative to this. */
const BASE_FONT_PX = 16;

/** The reader's live root font size in px (== the prose base; the app-wide
 *  font-size setting is applied as the root <html> font-size). */
function rootFontPx(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(v) && v > 0 ? v : BASE_FONT_PX;
}

/** How much bigger the reading font is than the default — the factor the diagram
 *  (and so its text) scales by, so a chart tracks the font-size setting like the
 *  prose does. Applied as a CSS var on the rendered SVG width, NOT baked into
 *  mermaid: mermaid normalizes any baked size back out (it sizes the diagram so
 *  its smallest label is a fixed ~9px on screen — see the sizing pass below — and
 *  a bigger baked font just grows the geometry that pass then shrinks back), so
 *  baking is a no-op. Scaling the FINAL width is what actually enlarges it. */
function chartScale(): number {
  return rootFontPx() / BASE_FONT_PX;
}

function mermaidConfig(isDark: boolean): Record<string, unknown> {
  return {
    theme: isDark ? "dark" : "default",
    startOnLoad: false,
    fontFamily: MERMAID_FONT_FAMILY,
    // A CONSTANT base size: the font-size setting is applied by scaling the
    // rendered SVG width (--lv-chart-scale), not by re-baking mermaid (which
    // normalizes a baked size back out — see chartScale). Constant base ⇒ the
    // scale stays linear and font changes need no mermaid re-layout.
    fontSize: BASE_FONT_PX,
    // htmlLabels (foreignObject + browser CSS) is what makes labels AUTO-WRAP —
    // incl. CJK, which has no spaces and so can't wrap via the SVG-tspan path.
    // It's the v11 flowchart default, but set explicitly + globally (the
    // flowchart-level flag is deprecated since 11.12.3) so authors can write
    // plain labels and rely on wrappingWidth instead of hand-inserting <br/>.
    htmlLabels: true,
    markdownAutoWrap: true,
    flowchart: {
      useMaxWidth: true,
      // The wrap width (px) for auto-wrapped labels. 220 fills the ~358px mobile
      // column without pushing multi-node (LR) rows past it. Verified headless:
      // a plain CJK label wraps to fill this, fewer/​fuller lines than hand-broken.
      wrappingWidth: 220,
      nodeSpacing: 55,
      rankSpacing: 60,
      padding: 12,
      // Subgraph titles default to 0 margin, so the title sits ON TOP of the first
      // node (the "一·科学发现的方法" title clipped into "01"). A bottom margin
      // clears the title from the first node; top pads it inside the cluster. Fixes
      // every book's subgraphs at the renderer — authors write nothing extra.
      subGraphTitleMargin: { top: 6, bottom: 16 },
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

/** Decode the HTML entities comrak escapes inside a code block, recovering the
 *  raw JSON of an ` ```interactive-view ` fence. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Rewrite server-rendered markdown html so each ` ```interactive-view ` fence
 *  (comrak emits `<pre lang="interactive-view"><code>…escaped JSON…</code></pre>`)
 *  becomes an empty placeholder `<div data-iv-slot="i">`, and return the fence
 *  JSON payloads. The caller renders `processedHtml` as ONE node (keeping the
 *  single-node structure prose read-along relies on) and React-**portals** each
 *  interactive view into its placeholder. A portal keeps the view inside React's
 *  tree (so it inherits the theme and its updates commit reliably) while its DOM
 *  lives at a stable anchor the imperative markdown passes never touch. */
function splitForPortals(
  html: string | null,
): { processedHtml: string; fences: string[] } {
  if (!html) return { processedHtml: "", fences: [] };
  const re = /<pre[^>]*\blang="interactive-view"[^>]*>([\s\S]*?)<\/pre>/g;
  const fences: string[] = [];
  const processedHtml = html.replace(re, (_full, inner: string) => {
    const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(inner);
    fences.push(decodeEntities(code ? (code[1] ?? "") : inner));
    return `<div data-iv-slot="${
      fences.length - 1
    }" class="lv-interactive-view"></div>`;
  });
  return { processedHtml, fences };
}

export function MarkdownViewer({
  html,
  currentPath,
  onNavigate,
  contentMaxWidth,
  lineHeight,
  savedScroll,
  onSaveScroll,
  navbarAtBottom,
  footer,
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
  // Progress persistence is deliberately NOT part of the display-frame path.
  // mirroredStore.set() still performs reconciliation/timer work even though
  // its network write is debounced upstream. Running that for every iOS scroll
  // frame makes the native scroller contend with JS. Keep only the latest ratio
  // and commit it after the gesture settles (or on the native scrollend event).
  const scrollSaveTimerRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<number | null>(null);
  // Ordered list of zoomable images in the doc + which one the lightbox shows.
  const [images, setImages] = useState<
    { src: string; alt: string; themed?: boolean }[]
  >([]);
  const [lbIndex, setLbIndex] = useState<number | null>(null);
  // Bumped when mermaid finishes rendering. Mermaid runs asynchronously, so the
  // diagrams aren't in the DOM yet when the gallery effect first wires click
  // handlers — re-running the effect on this tick picks them up once they are.
  const [diagramTick, setDiagramTick] = useState(0);

  // ` ```interactive-view ` fences are split out of the server-rendered html and
  // rendered as real React children (see the render body) — so React owns their
  // lifecycle and they inherit the app's MUI theme context. This is what makes
  // the type "just markdown": any book/doc chapter embeds a reactive report
  // inline, with a real chapter title from the `.md`'s H1.
  // Interactive-view fences → placeholder divs + their JSON payloads (memoized on
  // `html` so payloads keep a stable identity). Each is portalled into its
  // placeholder after the html commits; `slots` holds the resolved anchor nodes.
  const { processedHtml, fences } = useMemo(() => splitForPortals(html), [
    html,
  ]);
  const [slots, setSlots] = useState<(HTMLElement | null)[]>([]);

  // Keep the screen awake while a chapter is open — a reader may not touch the
  // screen for minutes. Released automatically when no doc is shown.
  useWakeLock(!!html);

  // Read-along: when the audio engine is narrating THIS text chapter, highlight
  // the spoken sentence in place + sticky-follow it. No-op during normal (silent)
  // reading. The play/pause control lives in the NavShell bar (App.tsx
  // bookActions); `follow` drives the transport's sticky-follow toggle.
  const follow = useInPlaceHighlight(containerRef, currentPath);

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
        void ensureScript(publicAsset("/highlight.min.js"))
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
        // Carry the read-along anchors forward. The block is a top-level child of
        // .markdown-body, so the read-aloud highlight numbers it (data-blk) and
        // the server may stamp it (data-sourcepos); replacing the element drops
        // those, and the highlight then can't find the chart to focus it. Copy
        // them onto every replacement so the final .mermaid div stays anchorable.
        carryReadAnchors(block, holder);
        block.parentElement?.replaceChild(holder, block);
        pending.push({ holder, code });
      });
      if (pending.length > 0) {
        void ensureScript(publicAsset("/mermaid.min.js"))
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
              carryReadAnchors(holder, div); // keep the chart anchorable (see above)
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

    // Interactive View fences are NOT hydrated here — they are split out of the
    // html and rendered as real React children (see `segments` below), so React
    // owns their lifecycle + theme context (imperatively mounting a root inside
    // this dangerouslySetInnerHTML container is fragile — it gets wiped on
    // re-render). This pass only touches the imperative libs (highlight/mermaid/
    // katex).

    // KaTeX math (comrak emits <span data-math-style>…</span> + code.language-math).
    // Self-hosted + loaded ON DEMAND — only when the chapter has math. No CDN
    // (jsdelivr is slow/blocked behind the GFW + dead offline); assets live in
    // /katex/ (woff2 fonts resolve relative to the stylesheet).
    const mathEls = container.querySelectorAll<HTMLElement>(
      "[data-math-style]:not([data-katex-rendered]), code.language-math:not([data-katex-rendered])",
    );
    if (mathEls.length > 0) {
      void Promise.all([
        ensureScript(publicAsset("/katex/katex.min.js")),
        ensureStyle(publicAsset("/katex/katex.min.css")),
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
                carryReadAnchors(pre, div); // keep the math block anchorable
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

  // Resolve the interactive-view placeholder anchors after the html commits, so
  // the portals below can target them. Re-runs when the html (hence the
  // placeholders) changes.
  useEffect(() => {
    const c = containerRef.current;
    setSlots(
      fences.map((_, i) =>
        c?.querySelector<HTMLElement>(`[data-iv-slot="${i}"]`) ?? null
      ),
    );
  }, [processedHtml, fences]);

  // Two reactions to root-level changes, both watching documentElement:
  //
  //  • THEME light/dark MODE flip → re-render each diagram in mermaid's native
  //    theme for the new mode (not a CSS-invert approximation). A light↔light
  //    switch (classic↔sepia) leaves `data-color-scheme` unchanged → no
  //    re-render. Redraws from the stashed `data-mermaid-src`. Book SVGs can't
  //    re-render, so they keep the invert filter (markdown.css).
  //  • FONT-SIZE change → just update the `--lv-chart-scale` var; the sizing
  //    pass below renders each SVG width as `rendered * var(--lv-chart-scale)`,
  //    so the diagram (text included) grows with the reading font WITHOUT a
  //    mermaid re-layout. Cheap — no re-measure, no re-render.
  //
  // The root's `style` also carries unrelated CSS vars (--shell-bar-h, … ) that
  // churn often, so guard on the resolved scheme/px actually changing.
  useEffect(() => {
    const root = document.documentElement;
    let lastScheme = root.dataset["colorScheme"];
    let lastFontPx = rootFontPx();
    root.style.setProperty("--lv-chart-scale", String(chartScale()));
    const obs = new MutationObserver(() => {
      const scheme = root.dataset["colorScheme"];
      const fontPx = rootFontPx();
      if (scheme === lastScheme && fontPx === lastFontPx) return;
      // Font change: rescale via the CSS var (re-setting it re-enters this
      // observer, but then nothing has changed → the guard above bails).
      if (fontPx !== lastFontPx) {
        lastFontPx = fontPx;
        root.style.setProperty("--lv-chart-scale", String(chartScale()));
      }
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
      attributeFilter: ["data-color-scheme", "style"],
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
        // Drop the in-page inline sizing (a `calc(... * var(--lv-chart-scale))`
        // width): the snapshot is an isolated <img> document with no :root to
        // resolve that var, so let the pinned viewBox px attributes govern.
        clone.style.width = "";
        clone.style.height = "";
      }
      // Fixed-colour figures (book SVGs) get a white backing — the lightbox
      // inverts it to a dark plate in dark mode. A mermaid SVG is theme-native
      // (re-rendered per mode), so leave it transparent and let the lightbox's
      // mode-matched plate show through instead of being inverted back to light.
      clone.style.backgroundColor = isMermaid ? "transparent" : "#ffffff";
      let xml = new XMLSerializer().serializeToString(clone);
      // Mermaid bakes each node box's width from its label measured IN-PAGE with
      // `font-family: var(--lv-reading-font), …` (the head of MERMAID_FONT_FAMILY).
      // A serialized standalone SVG shown via <img> is an ISOLATED document with
      // no :root to read that custom property from, so var() falls through to the
      // next named family — a different font whose (esp. mixed CJK+Latin) metrics
      // run wider than the baked box, so labels CLIP in the lightbox (the page
      // render is fine). Substitute the var's resolved value into the snapshot so
      // it uses the exact font stack the boxes were sized with. (Pure string
      // swap, not var-in-<img> resolution, which isn't reliable across engines.)
      const readingFont = getComputedStyle(document.documentElement)
        .getPropertyValue("--lv-reading-font")
        .trim();
      if (readingFont) {
        xml = xml.replaceAll("var(--lv-reading-font)", readingFont);
      }
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
        // `rendered` is the base (font-default) width that keeps the smallest
        // label ≈9px. Scale it by the live font factor so a larger reading font
        // enlarges the whole diagram — overflowing into the .lv-diagram-scroll
        // wrapper's horizontal scroll — instead of being normalized back. The
        // var updates on a font change with no re-render (see the observer).
        svg.style.width = `calc(${rendered}px * var(--lv-chart-scale, 1))`;
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
      // CLAMP to [0,1]: on iOS the rubber-band overscroll drives scrollTop
      // NEGATIVE at the top and PAST max at the bottom, so the raw ratio goes
      // <0 / >1. Fed into the progress bar's scaleX that flipped/mirrored the bar
      // at the top (鬼畜) and overshot it at the bottom (抖动), oscillating every
      // frame through the bounce. Clamping pins the bar at its ends instead.
      const ratio = Math.min(1, Math.max(0, el.scrollTop / max));
      // Drive the progress bar via a CSS var (no React re-render per scroll).
      wrapperRef.current?.style.setProperty(
        "--lv-read-progress",
        ratio.toFixed(4),
      );
      pendingScrollRef.current = ratio;
      if (scrollSaveTimerRef.current !== null) {
        clearTimeout(scrollSaveTimerRef.current);
      }
      scrollSaveTimerRef.current = window.setTimeout(() => {
        scrollSaveTimerRef.current = null;
        const pending = pendingScrollRef.current;
        pendingScrollRef.current = null;
        if (pending !== null) onSaveScroll?.(currentPath, pending);
      }, 180);
    });
  }, [currentPath, onSaveScroll]);

  // React's onScroll wiring keeps bookkeeping on the hot path. Attach the
  // reader listener directly and explicitly passive so WKWebView can leave the
  // pan gesture with its native scroller. `scrollend` flushes the trailing
  // progress value immediately on engines that support it; the timer remains a
  // compatible fallback.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const flush = (): void => {
      if (scrollSaveTimerRef.current !== null) {
        clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      const pending = pendingScrollRef.current;
      pendingScrollRef.current = null;
      if (pending !== null && currentPath) onSaveScroll?.(currentPath, pending);
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    el.addEventListener("scrollend", flush, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      el.removeEventListener("scrollend", flush);
      flush();
    };
  }, [currentPath, handleScroll, onSaveScroll]);

  // Cancel any queued scroll read on unmount so it can't fire after teardown.
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
      if (scrollSaveTimerRef.current !== null) {
        clearTimeout(scrollSaveTimerRef.current);
      }
    };
  }, []);

  // Restore the saved position when a document opens. Content height settles
  // asynchronously (syntax highlight, KaTeX, mermaid, images), so re-apply a
  // few times; `restoringRef` keeps these programmatic scrolls from saving.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !currentPath) return undefined;
    // Read-along owns the scroll while it's narrating THIS chapter and following:
    // don't fight it by restoring a saved mid-chapter ratio. When playback carries
    // the view into a NEW chapter, the follow centres its first spoken line, which
    // clamps to the top — so the page lands at the top instead of a stale saved
    // position. A manual scroll flips following off, after which a normal open
    // restores again. Read from the render closure (NOT effect deps) so toggling
    // follow never re-triggers a restore that would yank a reader back.
    if (follow.active && follow.following) return undefined;
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
          sx={{
            flex: 1,
            // Without min-height:0 a flex child won't shrink below its content, so
            // overflow:auto never engages and the page can't scroll (notably on
            // iOS, where there's no trackpad to mask it).
            minHeight: 0,
            overflow: "auto",
            // Vertical padding fixed; horizontal padding IS the reading margin.
            pt: { xs: 2, md: 4 },
            // Foot padding ADDS the two frosted overlays the text scrolls under:
            // the read-aloud <PlaybackBar> (--lv-transport-h; 0 unless read-aloud
            // is on this chapter) and the NavShell bar below it (--shell-bar-h;
            // mobile tier only, 0 on desktop / before measured) — on top of the
            // base breathing room, so the last paragraph clears both yet the text
            // still scrolls UNDER them. Restore-by-ratio is unaffected (it reads
            // scrollHeight after this padding is in).
            pb: {
              xs:
                "calc(16px + var(--lv-syncbar-h, 0px) + var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))",
              md:
                "calc(32px + var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))",
            },
            // Keep the spoken-line auto-centre (read-aloud follow) from parking the
            // narrated sentence UNDER the bar near the chapter's end.
            scrollPaddingBottom:
              "calc(var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))",
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
          {
            /* One node (fence placeholders included) — keeps the structure the
              read-along highlight + sourcepos anchors depend on. */
          }
          <Box
            className="markdown-body"
            sx={innerSx}
            dangerouslySetInnerHTML={{ __html: processedHtml }}
          />
          {
            /* Portal each interactive view into its placeholder: it stays in
              React's tree (theme + reliable commits) while its DOM anchor sits
              in the injected html, untouched by the imperative markdown passes. */
          }
          {fences.map((json, i) => {
            const node = slots[i];
            return node
              ? createPortal(
                <InteractiveViewInline content={json} />,
                node,
                String(i),
              )
              : null;
          })}
          {
            /* Prev/next chapter pager — same centred reading column as the text
              above, so it lines up; scrolls with the content. */
          }
          {footer && (
            <Box sx={{ maxWidth: `${READING_COLUMN_MAX}px`, mx: "auto" }}>
              {footer}
            </Box>
          )}
        </Box>
        {
          /* Back-to-top — absolute within this relative wrapper. Lift it above
          BOTH frosted overlays this area scrolls under: the read-aloud transport
          (--lv-transport-h; 0 unless read-aloud is on this chapter) and the nav
          bar below it (--shell-bar-h; 0 on the solid/desktop path). Same lift the
          audiobook reader (AudiobookPlayer) uses, so the FAB sits identically in
          both playback modes. */
        }
        <ScrollToTopButton
          targetRef={containerRef}
          bottomLift="calc(var(--lv-transport-h, 0px) + var(--shell-bar-h, 0px))"
        />
        {
          /* (The floating "Back to narration" pill was removed — the transport's
            own follow/re-centre control (the ◎ button) already does exactly this,
            so the pill was a redundant second affordance. `follow.jumpToCurrent`
            stays wired through the transport's toggle.) */
        }
        {
          /* Read-aloud transport — the SAME shared <PlaybackBar> the audiobook
            read-along page uses, pinned as a frosted overlay over the bottom of
            this reader while read-aloud narrates THIS chapter (in-place rich-text
            highlight via useInPlaceHighlight). Book + audiobook playback now share
            one bar. The follow toggle drives the in-place sticky-follow. */
        }
        {follow.active && (
          <PlaybackBar
            navbarAtBottom={navbarAtBottom}
            follow={{
              following: follow.following,
              onToggle: follow.toggleFollow,
            }}
          />
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
