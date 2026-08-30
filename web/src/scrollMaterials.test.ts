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
  const floatingBubble = await source("components/FloatingBubble.tsx");
  const navShell = await source("_shell/nav-shell.tsx");
  const spatialDrawer = await source("_shell/spatial-drawer.ts");
  const temporaryNav = await source("_shell/temporary-nav.tsx");
  const sidebar = await source("components/Sidebar.tsx");
  const playbackBar = await source("components/PlaybackBar.tsx");
  const spatialPlayback = await source("components/SpatialPlaybackPreview.tsx");
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
  const nativeTweaks = await readFile(
    new URL(
      "../../app/src-tauri/gen/apple/Sources/liveview-app/LiveviewNativeTweaks.mm",
      ROOT,
    ),
    "utf8",
  );
  const syncPlugin = await readFile(
    new URL("../../app/src-tauri/src/host.rs", ROOT),
    "utf8",
  );
  const shell = await source("App.tsx");
  const markdownViewer = await source("components/MarkdownViewer.tsx");
  const viteConfig = await source("../vite.config.ts");
  const mobileStyles = await source("styles/index.css");
  const markdownStyles = await source("styles/markdown.css");
  const themeHook = await source("hooks/useTheme.ts");

  assertPresent(
    themeHook,
    /setProperty\("--lv-page-bg", c\.bgDefault\)/,
    "the active theme must publish its page surface for authored reader CSS",
  );
  assertPresent(
    themeHook,
    /backgroundColor\s*=\s*`var\(--lv-safe-area-bg, \$\{c\.bgDefault\}\)`/,
    "the document safe area must accept a temporary shell-owned surface",
  );
  assertPresent(
    themeHook,
    /setProperty\("--lv-nav-bg", c\.bgPaper\)[\s\S]{0,300}setProperty\(\s*"--lv-nav-fg", c\.textPrimary\)/,
    "the active theme must publish the contents-rail surface and foreground",
  );
  assertPresent(
    sidebar,
    /var\(--lv-nav-bg,\s*\$\{theme\.palette\.background\.paper\}\)/,
    "the contents rail must consume the active theme instead of a fixed surface",
  );
  assertPresent(
    sidebar,
    /alpha\(\s*theme\.palette\.primary\.main[\s\S]{0,150}theme\.palette\.mode === "dark"/,
    "the selected contents row must use a theme-aware accent contrast",
  );
  assertPresent(
    markdownStyles,
    /background-color:\s*var\(--lv-page-bg,\s*#ffffff\)/,
    "the Markdown column must share the themed page instead of becoming a white card",
  );
  assertPresent(
    viteConfig,
    /outputDir = resolve\(config\.root, config\.build\.outDir\)/,
    "post-build plugins must honor the effective Vite output directory used by Nix",
  );
  assertAbsent(
    viteConfig,
    /closeBundle\(\)/,
    "output-mutating Vite plugins must not run before files are guaranteed to be written",
  );
  assertPresent(
    viteConfig,
    /name: "lv-stamp-sw"[\s\S]{0,500}writeBundle\(\)/,
    "service-worker stamping must run only after Vite writes the output bundle",
  );

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
    artwork,
    /theme\.palette\.mode === "dark" \? 0\.86 : 0\.9[\s\S]{0,420}0\.76 : 0\.8/,
    "shelf artwork must keep a static high-opacity text-protection wash",
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
    /<TextField[\s\S]{0,200}\bvalue=\{query\}/,
    "the iOS shelf search must not control the native input and replace IME marked text",
  );
  assertPresent(
    landing,
    /minWidth: \{ xs: 44, sm: "auto" \}[\s\S]{0,700}display: \{ xs: "none", sm: "inline" \}/,
    "the phone toolbar must preserve search width with an icon-only filter action",
  );
  assertPresent(
    landing,
    /onCompositionStart[\s\S]{0,500}onCompositionEnd[\s\S]{0,500}nativeEvent\.isComposing/,
    "the shelf search must defer discovery updates until IME composition commits",
  );
  assertPresent(
    landing,
    /const searchEditing = isPhone && searchFocused[\s\S]{0,900}const dismissSearchKeyboard/,
    "phone search must have an explicit focus-owned editing mode",
  );
  assertPresent(
    landing,
    /data-lv-search-field[\s\S]{0,240}onFocus=\{\(\) => setSearchFocused\(true\)\}[\s\S]{0,120}onBlur=\{\(\) => setSearchFocused\(false\)\}/,
    "phone search must expand on focus and restore the shelf actions on blur",
  );
  assertPresent(
    landing,
    /data-lv-search-clear[\s\S]{0,300}landing\.searchClear/,
    "expanded phone search must expose a clear action",
  );
  assertPresent(
    landing,
    /data-lv-search-dismiss[\s\S]{0,900}landing\.searchHideKeyboard/,
    "expanded phone search must expose a keyboard-dismiss action",
  );
  assertPresent(
    landing,
    /!searchEditing && \([\s\S]{0,180}data-lv-shelf-actions/,
    "filter and settings actions must yield the phone toolbar while search is editing",
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
    floatingBubble,
    /if \(!nowPlaying \|\| \(!playing && !buffering\) \|\| onPlayingPage \|\| suppressed\) \{[\s\S]{0,40}return null;/,
    "the floating playback bubble must hide only while playback is paused and not buffering",
  );
  assertPresent(
    navShell,
    /const SPATIAL_PHONE_WIDTH = "min\(84%, 360px\)";[\s\S]{0,100}const SPATIAL_TABLET_WIDTH = "min\(52%, 440px\)";[\s\S]{0,14000}data-spatial-drawer[\s\S]{0,500}width: \{ xs: SPATIAL_PHONE_WIDTH, sm: SPATIAL_TABLET_WIDTH \}/,
    "mobile Contents must use Cowboy's full-height spatial side navigation proportions",
  );
  assertPresent(
    navShell,
    /spatial && mobileOpen[\s\S]{0,120}setProperty\("--lv-safe-area-bg", "var\(--lv-nav-bg\)"\)[\s\S]{0,120}setAttribute\("data-lv-spatial-drawer-open", ""\)[\s\S]{0,240}removeAttribute\("data-lv-spatial-drawer-open"\)/,
    "an open spatial drawer must publish both its safe-area surface and a physical repaint boundary",
  );
  assertPresent(
    shell,
    /data-lv-status-bar-material[\s\S]{0,1400}html\[data-lv-spatial-drawer-open\] &[\s\S]{0,80}display:\s*"none"/,
    "the fixed iOS status-bar material must leave the compositor while the spatial drawer owns that edge",
  );
  assertAbsent(
    navShell.match(/data-spatial-drawer[\s\S]{0,700}/)?.[0] ?? "",
    /borderRight/,
    "the Cowboy-style spatial rail edge",
  );
  assertPresent(
    temporaryNav,
    /if \(spatial\)[\s\S]{0,900}data-temporary-nav-actions/,
    "mobile spatial navigation must use Cowboy-style bottom action islands instead of a header",
  );
  assertPresent(
    temporaryNav,
    /"--temporary-nav-overlay-clearance":[\s\S]{0,80}86px \+ env\(safe-area-inset-bottom/,
    "the spatial navigation scroller must clear its floating bottom actions",
  );
  assertPresent(
    temporaryNav,
    /DrawerActionIsland width=\{54\}[\s\S]{0,220}aria-label=\{backLabel \?\? "Back"\}/,
    "the spatial navigation back affordance must live in the bottom leading island",
  );
  assertPresent(
    temporaryNav,
    /DrawerActionIsland width=\{actions \? 108 : 54\}[\s\S]{0,600}aria-label="Close navigation"[\s\S]{0,800}\{actions\}/,
    "the trailing Cowboy-style island must group close with app navigation actions",
  );
  assertAbsent(
    temporaryNav,
    /backdropFilter|WebkitBackdropFilter|\bfilter:/,
    "the fixed drawer actions must keep Cowboy geometry without live-filtering scrolling content",
  );
  assertPresent(
    navShell,
    /actions=\{navigationActions\}/,
    "settings-like navigation actions must move into the mobile rail and remain in desktop chrome",
  );
  assertPresent(
    navShell,
    /!isMobile && navigationActions/,
    "navigation actions must remain beside reader actions on desktop",
  );
  assertPresent(
    navShell,
    /mobileOpen[\s\S]{0,180}palette\.common\.black[\s\S]{0,180}transition: "background-color 180ms ease"/,
    "the trailing reader preview must use a cheap Cowboy-style dim tint instead of blur",
  );
  assertPresent(
    sidebar,
    /data-liveview-nav-row[\s\S]{0,180}mx: 0\.75[\s\S]{0,80}my: 0\.25[\s\S]{0,100}borderRadius:/,
    "navigation rows must use Cowboy-style inset selected surfaces",
  );
  assertPresent(
    sidebar,
    /const isSelected = currentPath === node\.path;/,
    "only the viewed chapter may own the navigation selected state",
  );
  assertPresent(
    sidebar,
    /\{isPlaying && \([\s\S]{0,180}<PlayingIcon/,
    "the playing chapter must keep a distinct marker without becoming selected",
  );
  assertPresent(
    sidebar,
    /\[data-spatial-drawer\] &[\s\S]{0,40}display: "none"/,
    "mobile spatial navigation must not render the desktop deploy-time footer seam",
  );
  assertPresent(
    spatialDrawer,
    /requestAnimationFrame\(\(frameAt\)[\s\S]{0,180}predictSpatialDrawerOffset/,
    "the spatial drawer must coalesce direct manipulation into animation frames with bounded prediction",
  );
  assertPresent(
    navShell,
    /onPrepareThreshold:\s*prepareSelectionHaptic[\s\S]{0,100}onThreshold:\s*selectionHaptic/,
    "the spatial drawer must prewarm and fire the native selection generator around its threshold",
  );
  assertPresent(
    navShell,
    /reservedLeadingEdge:\s*onBack \? 28 : 0/,
    "the reader must reserve the iOS back-swipe edge instead of letting Contents steal it",
  );
  assertPresent(
    spatialDrawer,
    /!startOpen && touch\.clientX <= reservedLeadingEdge/,
    "a closed spatial drawer must yield its reserved leading edge to host navigation",
  );
  assertPresent(
    nativeTweaks,
    /UISelectionFeedbackGenerator[\s\S]{0,900}prepare-selection[\s\S]{0,300}selectionChanged/,
    "the native shell must retain and prewarm a selection generator for the spatial drawer",
  );
  assertPresent(
    spatialDrawer,
    /predictSpatialDrawerOffset[\s\S]{0,220}pendingThresholdHaptic[\s\S]{0,100}onThreshold\?\.\(\)/,
    "the spatial drawer must align Cowboy-style selection haptics with the painted threshold frame",
  );
  assertPresent(
    spatialDrawer,
    /if \(pendingThresholdHaptic\) \{[\s\S]{0,120}requestAnimationFrame\(\(\) => onThreshold\?\.\(\)\)/,
    "the spatial drawer release path must preserve a threshold haptic pending behind the final frame",
  );
  assertPresent(
    spatialDrawer,
    /removeProperty\("will-change"\)/,
    "the spatial drawer must release temporary compositor hints after movement settles",
  );
  assertPresent(
    spatialDrawer,
    /surface\.style\.transform = `translate3d\(\$\{String\(offset\)\}px,0,0\)`/,
    "the reader surface must stay on Cowboy's translation-only compositor path",
  );
  assertAbsent(
    spatialDrawer,
    /surface\.style\.(?:borderRadius|boxShadow|opacity)/,
    "the heavy reader surface must not be clipped, shadowed, or faded during drawer motion",
  );
  assertPresent(
    spatialDrawer,
    /drawerMask\.style\.boxShadow[\s\S]{0,120}-18px 0 42px/,
    "the empty drawer mask must own the spatial edge shadow",
  );
  assertPresent(
    spatialDrawer,
    /event\.stopPropagation\(\);[\s\S]{0,180}Math\.abs\(dx\) < 12/,
    "clear vertical intent must release the drawer before its horizontal lock distance",
  );
  assertPresent(
    spatialDrawer,
    /requestIdleCallback\(finish, \{ timeout: 180 \}\)/,
    "drawer compositor hints must release after the settle frame without blocking touch paint",
  );
  assertPresent(
    sidebar,
    /\[data-spatial-drawer-moving\] &[\s\S]{0,80}transform:\s*"none"/,
    "the sidebar must collapse its nested tiled layer during direct drawer manipulation",
  );
  assertPresent(
    shell,
    /mobilePresentation="sidebar"/,
    "the LiveView reader must explicitly opt into side navigation",
  );
  assertPresent(
    playbackBar,
    /data-lv-playback-bar="true"/,
    "the playback transport must expose an app-owned marker for mobile drawer chrome",
  );
  assertPresent(
    navShell,
    /data-lv-spatial-backdrop[\s\S]{0,2200}data-spatial-drawer-ignore[\s\S]{0,100}data-lv-spatial-accessory/,
    "the spatial drawer must keep an explicit backdrop and stationary companion rail",
  );
  assertPresent(
    navShell,
    /left: \{ xs: SPATIAL_PHONE_WIDTH, sm: SPATIAL_TABLET_WIDTH \}[\s\S]{0,180}bottom: "calc\(var\(--shell-bar-h, 0px\) \+ 12px\)"/,
    "the spatial companion must occupy the visible rail above the bottom navigation",
  );
  assertPresent(
    shell,
    /spatialAccessory=\{currentPath[\s\S]{0,260}<SpatialPlaybackPreview[\s\S]{0,100}onStartCurrent=\{handleReadAloud\}/,
    "the reader must provide playback in the drawer even before a session is loaded",
  );
  assertPresent(
    spatialPlayback,
    /const loaded = nowPlaying !== null[\s\S]{0,2400}onClick=\{loaded \? togglePlay : onStartCurrent\}/,
    "the spatial playback control must start an idle reader and pause or resume a loaded session",
  );
  assertPresent(
    spatialPlayback,
    /const wideRail = useMediaQuery\(theme\.breakpoints\.up\("sm"\)\)[\s\S]{0,500}if \(wideRail && loaded\) return <><\/>/,
    "the compact playback control must yield to the complete transport on tablet widths",
  );
  assertAbsent(
    spatialPlayback,
    /backdropFilter|WebkitBackdropFilter|\bfilter:/,
    "the spatial playback companion",
  );
  assertPresent(
    playbackBar,
    /aria-hidden[\s\S]{0,80}data-lv-playback-bar="true"[\s\S]{0,300}height: "calc\(var\(--lv-transport-h, 0px\) \+ var\(--shell-bar-h, 0px\)\)"/,
    "playback must retain a shared material behind the transport and bottom navigation",
  );
  assertPresent(
    playbackBar,
    /aria-pressed=\{follow\.following\}[\s\S]{0,300}color: follow\.following \? "primary\.main" : "text\.secondary"[\s\S]{0,160}bgcolor: "transparent"[\s\S]{0,100}boxShadow: "none"/,
    "the active read-along follow control must highlight only its icon",
  );
  assertAbsent(
    mobileStyles,
    /\[data-spatial-drawer\]\[aria-hidden="false"\][\s\S]{0,100}~\s*\[data-spatial-drawer-surface\][\s\S]{0,100}\[data-lv-playback-bar="true"\][\s\S]{0,160}visibility:\s*hidden;[\s\S]{0,80}pointer-events:\s*none;/,
    "the spatial drawer preview must preserve playback chrome",
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
    /if \(st\.pinched\) \{[\s\S]{0,500}constrainPan\(\);[\s\S]{0,80}applyTransform\(true, true\);/,
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
    /if \(st\.pinched\) \{[\s\S]{0,700}bakePanLayer\(\);[\s\S]{0,80}constrainPan\(\);[\s\S]{0,80}applyTransform\(true, true\);/,
    "a completed pinch must bake its final scale before release animation",
  );
  assertPresent(
    lightboxGestures,
    /const visualScale = scale \/ bakedScale\.current;[\s\S]{0,160}scale\(\$\{visualScale\}\)/,
    "lightbox transforms must account for scale already baked into CSS dimensions",
  );
  assertPresent(
    lightboxGestures,
    /const bakePanLayer = useCallback[\s\S]{0,500}img\.style\.width = `\$\{box\.imageWidth \* tf\.current\.scale\}px`;[\s\S]{0,220}bakedScale\.current = tf\.current\.scale;[\s\S]{0,80}paintTransform\(false, true\);/,
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
    /enqueueMissingAudio/,
    "TS owns the audio worklist; native only enqueues cacheFromUrl",
  );
  assertPresent(
    nativeAudio,
    /hashSetQueue\.async/,
    "native hash-set rebuild and legacy export must stay off the main thread",
  );
  assertAbsent(
    nativeAudio,
    /kind == "pin"|case "pin"|case "reconcile"|case "audioStats"|case "setCap"/,
    "native must not keep LiveView-store pin/reconcile/stats commands",
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
