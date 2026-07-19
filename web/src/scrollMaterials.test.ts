import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ROOT = new URL("./", import.meta.url);

async function source(path: string): Promise<string> {
  return await readFile(new URL(path, ROOT), "utf8");
}

function assertAbsent(
  contents: string,
  pattern: RegExp,
  surface: string,
): void {
  if (pattern.test(contents)) {
    throw new Error(
      `${surface} is a scrolling hot path and must not use ${pattern.source}`,
    );
  }
}

function assertPresent(
  contents: string,
  pattern: RegExp,
  message: string,
): void {
  if (!pattern.test(contents)) throw new Error(message);
}

test("scrolling shelf surfaces avoid live backdrop filters", async () => {
  const landing = await source("components/Landing.tsx");
  const artwork = await source("components/CoverTile.tsx");
  const segmented = await source("components/SegmentedPill.tsx");
  const syncIndicator = await source("components/SyncIndicator.tsx");
  const scrollToTop = await source("components/ScrollToTopButton.tsx");
  const sidebar = await source("components/Sidebar.tsx");
  const navShell = await source("_shell/nav-shell.tsx");
  const detentSheet = await source("_shell/detent-sheet.tsx");
  const lightboxGestures = await source("_shell/image-lightbox-gestures.ts");
  const nativeSync = await source("native-sync.ts");
  const apm = await source("apm.ts");
  const preloadDriver = await source("hooks/useAudioPreloadDriver.ts");
  const nativeAudio = await readFile(
    new URL(
      "../../app/src-tauri/gen/apple/Sources/liveview-app/NativeAudioController.swift",
      ROOT,
    ),
    "utf8",
  );
  const syncPlugin = await readFile(
    new URL("../../plugins/lvsync/src/lib.rs", ROOT),
    "utf8",
  );
  const shell = await source("App.tsx");
  const markdownViewer = await source("components/MarkdownViewer.tsx");
  const mobileStyles = await source("styles/index.css");
  const markdownStyles = await source("styles/markdown.css");

  for (const theme of ["dark", "night", "plum"]) {
    assertPresent(
      mobileStyles,
      new RegExp(
        `\\[data-theme="${theme}"\\] \\.hljs-addition \\{[^}]*background-color:[^}]*\\}`,
      ),
      `${theme} syntax additions must override the vendored light-theme background`,
    );
    assertPresent(
      mobileStyles,
      new RegExp(
        `\\[data-theme="${theme}"\\] \\.hljs-deletion \\{[^}]*background-color:[^}]*\\}`,
      ),
      `${theme} syntax deletions must override the vendored light-theme background`,
    );
    for (const token of ["regexp", "operator", "punctuation", "subst"]) {
      assertPresent(
        mobileStyles,
        new RegExp(
          `\\[data-theme="${theme}"\\] \\.hljs-${token}(?:,| \\{)`,
        ),
        `${theme} syntax ${token} tokens must not inherit the vendored light-theme color`,
      );
    }
  }

  const backdropFilter = /\b(?:backdropFilter|WebkitBackdropFilter)\s*:/;
  assertAbsent(landing, backdropFilter, "Landing shelf");
  assertAbsent(shell, backdropFilter, "fixed application shell");
  assertAbsent(segmented, backdropFilter, "segmented controls over content");
  assertAbsent(syncIndicator, backdropFilter, "fixed sync indicator");
  assertAbsent(scrollToTop, backdropFilter, "scroll-to-top control");
  assertAbsent(artwork, /\bfilter\s*:/, "shelf backdrop artwork");
  assertAbsent(artwork, /\bmixBlendMode\s*:/, "shelf backdrop artwork");
  assertAbsent(
    artwork,
    /^\s+opacity\s*:/m,
    "shelf backdrop artwork alpha compositing",
  );
  assertPresent(
    artwork,
    /loading="lazy"/,
    "shelf artwork must defer offscreen image fetch and decode to the browser",
  );
  assertPresent(
    artwork,
    /src=\{cardBackdropSrc\(slug\)\}/,
    "shelf cards must use the compact DAG artwork rendition",
  );
  assertPresent(
    nativeSync,
    /\/api\/card-backdrop\?book=/,
    "the compact rendition must have a stable origin URL for native sync",
  );
  assertAbsent(
    nativeSync,
    /image\.src\s*=\s*backdropSrc\(slug\)/,
    "shelf artwork recovery must never decode the full-size hero backdrop",
  );
  assertAbsent(
    landing,
    /inset 0 1px 0/,
    "repeated shelf progress meters must not paint per-card inset shadows",
  );
  assertAbsent(
    landing,
    /\bcontain\s*:/,
    "per-card paint containment (WKWebView promotes the artwork cards into an expensive scrolling layer set)",
  );
  assertPresent(
    landing,
    /disableRipple/,
    "shelf cards must not start React ripple work during a vertical pan",
  );
  assertPresent(
    landing,
    /touchAction:\s*"pan-y"/,
    "shelf cards must hand vertical pans directly to the native scroller",
  );
  assertPresent(
    scrollToTop,
    /if \(next === shownRef\.current\) return/,
    "scroll listeners must not enqueue unchanged React state every frame",
  );
  assertPresent(
    sidebar,
    /"\[data-detent-moving\] &": \{ transform: "none" \}/,
    "the Contents scroller must collapse its promoted layer while its DetentSheet moves",
  );
  assertPresent(
    navShell,
    /peekDetent=\{false\}/,
    "the Contents sheet must not strand the reader and navigation at a half-height detent",
  );
  assertPresent(
    detentSheet,
    /pendingYRef\.current = y;/,
    "the DetentSheet drag loop must retain the latest coalesced pointer position",
  );
  assertPresent(
    detentSheet,
    /const finishDrag = useCallback[\s\S]{0,250}flushPendingDragFrame\(\);/,
    "the DetentSheet release path must flush its final coalesced pointer position",
  );
  assertPresent(
    detentSheet,
    /onPointerCancel=\{onPointerCancel\}[\s\S]{0,80}onLostPointerCapture=\{onPointerCancel\}/,
    "the DetentSheet must settle rather than strand a system-cancelled iOS drag",
  );
  assertPresent(
    detentSheet,
    /yRef\.current \+ \(projectVelocity \? vy \* PROJECTION_MS : 0\)/,
    "an interrupted DetentSheet drag must snap from its actual position without stale velocity projection",
  );
  assertPresent(
    lightboxGestures,
    /g\.current\.lastX = remaining\.x;[\s\S]{0,80}g\.current\.lastY = remaining\.y;/,
    "ending a lightbox pinch must rebase panning to the surviving finger",
  );
  assertPresent(
    lightboxGestures,
    /if \(st\.pinched\) \{[\s\S]{0,180}constrainPan\(\);[\s\S]{0,80}applyTransform\(true\);/,
    "a completed lightbox pinch must settle within the viewport instead of becoming a tap",
  );
  assertPresent(
    lightboxGestures,
    /tf\.current\.x \+= midX - st\.pinchMidX;[\s\S]{0,120}tf\.current\.y \+= midY - st\.pinchMidY;/,
    "lightbox pinch translation must follow the moving two-finger midpoint",
  );
  assertPresent(
    lightboxGestures,
    /const centerX = box\.centerX \+ tf\.current\.x;/,
    "lightbox zoom anchoring must use cached geometry plus the live transform",
  );
  assertPresent(
    lightboxGestures,
    /const applyTransform = useCallback[\s\S]{0,220}paintTransform\(animate, panLayer\);/,
    "lightbox gesture painting must not add a frame of input latency",
  );
  assertAbsent(
    lightboxGestures,
    /paintFrame|requestAnimationFrame/,
    "lightbox panning must not queue a second frame after WebKit pointer delivery",
  );
  assertPresent(
    lightboxGestures,
    /st\.panX \+= dx;[\s\S]{0,180}constrainPan\(true\);[\s\S]{0,80}applyTransform\(false, true\);/,
    "zoomed lightbox panning must use elastic edge resistance while the finger is down",
  );
  assertPresent(
    lightboxGestures,
    /const isDoubleTap =[\s\S]{0,300}if \(isDoubleTap\) \{[\s\S]{0,240}(?:reset\(true\)|zoomAt\()/,
    "lightbox image taps must require a deliberate double tap before changing zoom",
  );
  assertPresent(
    lightboxGestures,
    /img\.style\.willChange = scale <= 1 \|\| panLayer \? "transform" : "auto";/,
    "lightbox scaling must re-rasterize while settled panning uses a stable compositor layer",
  );
  assertPresent(
    lightboxGestures,
    /applyTransform\(false, true\);/,
    "zoomed lightbox panning must reuse its sharp settled compositor layer",
  );
  assertPresent(
    lightboxGestures,
    /applyTransform\(true\);[\s\S]{0,80}schedulePanLayer\(240\);/,
    "a completed pinch must settle before baking its final scale",
  );
  assertPresent(
    lightboxGestures,
    /const visualScale = scale \/ bakedScale\.current;[\s\S]{0,160}scale\(\$\{visualScale\}\)/,
    "lightbox transforms must account for scale already baked into CSS dimensions",
  );
  assertPresent(
    lightboxGestures,
    /img\.style\.width = `\$\{box\.imageWidth \* tf\.current\.scale\}px`;[\s\S]{0,220}bakedScale\.current = tf\.current\.scale;[\s\S]{0,80}paintTransform\(false, true\);/,
    "settled lightbox zoom must bake scale into layout before 1:1 panning",
  );
  assertAbsent(
    await source("_shell/image-lightbox.tsx"),
    /willChange:\s*"transform"/,
    "the lightbox image must not be permanently promoted before its zoom scale is known",
  );
  assertPresent(
    lightboxGestures,
    /const onPointerCancel = useCallback[\s\S]{0,600}pointers\.current\.delete\(e\.pointerId\);[\s\S]{0,600}(?:reset\(true\)|constrainPan\(\));/,
    "cancelled lightbox gestures must only clean up and settle",
  );
  assertPresent(
    await source("_shell/image-lightbox.tsx"),
    /onPointerCancel=\{onPointerCancel\}[\s\S]{0,80}onLostPointerCapture=\{onPointerCancel\}/,
    "the lightbox must settle system-cancelled and capture-lost gestures",
  );
  assertPresent(
    lightboxGestures,
    /const settleGeometry = useCallback[\s\S]{0,300}measureGeometry\(\);[\s\S]{0,180}constrainPan\(\);[\s\S]{0,80}applyTransform\(true\);/,
    "lightbox image load and viewport resize must remeasure and settle zoom bounds",
  );
  assertPresent(
    lightboxGestures,
    /addEventListener\("resize", settleGeometry\)[\s\S]{0,120}removeEventListener\("resize", settleGeometry\)/,
    "lightbox viewport changes must invoke geometry settling and clean up the listener",
  );
  assertPresent(
    `${lightboxGestures}\n${await source("_shell/image-lightbox.tsx")}`,
    /onImageLoad: settleGeometry[\s\S]{0,12000}onLoad=\{onImageLoad\}/,
    "lightbox image decode must refresh cached geometry before gestures",
  );
  assertPresent(
    shell,
    /display: activeSlug === null \? "flex" : "none"/,
    "the mounted bookshelf must leave layout and paint while a reader is open",
  );
  assertAbsent(
    shell,
    /opacity: activeSlug === null \? 1 : 0/,
    "the hidden bookshelf must not retain thousands of painted nodes behind the reader",
  );
  assertAbsent(
    `${mobileStyles}\n${markdownStyles}`,
    /\.markdown-body[^{}]*(?:table|th|td)[^{}]*\{[^}]*(?:overflow-wrap:\s*anywhere|word-break:\s*break-all|hyphens:\s*auto)/s,
    "markdown tables and cells (terms must not be split inside words)",
  );
  assertPresent(
    markdownStyles,
    /\.markdown-body table\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;[^}]*-webkit-overflow-scrolling:\s*touch;/s,
    "wide markdown tables must scroll horizontally with iOS momentum without capturing vertical overflow",
  );
  assertAbsent(
    markdownViewer,
    /onScroll=\{handleScroll\}/,
    "the reader must not use React scroll bookkeeping",
  );
  assertAbsent(
    markdownViewer,
    /--lv-read-progress/,
    "scrolling must not invalidate an inherited progress variable",
  );
  assertAbsent(
    markdownViewer,
    /scrollTimelineName: "--lv-reader-scroll"/,
    "the reader must not run a scroll-linked animation while moving",
  );
  assertPresent(
    markdownViewer,
    /Reflect\.has\(el, "onscrollend"\)/,
    "current WebKit must persist progress only after scrolling ends",
  );
  assertPresent(
    await source("hooks/useInPlaceHighlight.ts"),
    /useAudioTime\(active\)/,
    "an unrelated audio clock must not re-render the reader while scrolling",
  );
  assertAbsent(
    apm,
    /nativeAudioStats/,
    "APM must share pushed native network state instead of polling audio stats",
  );
  assertAbsent(
    preloadDriver,
    /nativeAudioStats/,
    "background preload must not enumerate the native audio cache on a timer",
  );
  assertAbsent(
    preloadDriver,
    /setInterval/,
    "audio synchronization must be lifecycle and Merkle-root driven",
  );
  assertAbsent(
    await source("native-audio.ts"),
    /kind: "preload"/,
    "the bridge must not expose the old unbounded resource-array command",
  );
  assertPresent(
    preloadDriver,
    /nativeAudioReconcile\(root, REMOTE\)/,
    "the web must submit only a constant-size native reconciliation signal",
  );
  assertPresent(
    nativeAudio,
    /planQueue\.async/,
    "native manifest decoding and disk diffing must stay off the main thread",
  );
  assertPresent(
    nativeAudio,
    /min\(start \+ 64, items\.count\)/,
    "native queue admission must be split into bounded runloop slices",
  );
  assertPresent(
    nativeAudio,
    /private static let dlMaxInflight = dlSessionCount/,
    "bulk audio must keep a bounded number of real URLSession tasks",
  );
  assertPresent(
    nativeAudio,
    /let item = dlQueue\[dlQueueHead\]/,
    "bulk audio dequeue must use an O(1) cursor",
  );
  assertAbsent(
    nativeAudio,
    /dlQueue\.removeFirst\(\)/,
    "an O(n) audio queue shift per download",
  );
  assertPresent(
    nativeAudio,
    /delegateQueue\.qualityOfService = \.utility/,
    "bulk audio delegate work must not compete at interactive QoS",
  );
  assertAbsent(
    nativeAudio,
    /let cached: \[String\] = store\?\.allKeys\(\)/,
    "a full audio-key enumeration in the bridge stats response",
  );
  assertAbsent(
    nativeAudio,
    /"cached": cached/,
    "thousands of audio keys serialized through WKWebView stats",
  );
  assertPresent(
    syncPlugin,
    /"\/" \| "\/index\.html" \| "\/app" \| "\/app\/" => Some\("index\.html"\)/,
    "native release startup aliases must always resolve to the embedded SPA",
  );
  assertPresent(
    nativeSync,
    /event\.type === "network"/,
    "native connectivity must arrive through NWPathMonitor push events",
  );
});
