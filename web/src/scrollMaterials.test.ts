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
    shell,
    /display: activeSlug === null \? "flex" : "none"/,
    "the mounted bookshelf must leave layout and paint while a reader is open",
  );
  assertAbsent(
    shell,
    /opacity: activeSlug === null \? 1 : 0/,
    "the hidden bookshelf must not retain thousands of painted nodes behind the reader",
  );
  assertPresent(
    mobileStyles,
    /table:not\(:has\(tr > :nth-child\(4\)\)\)/,
    "phone-sized prose tables must not become nested horizontal scrollers",
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
