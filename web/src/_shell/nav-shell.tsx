// NavShell — the unified app-navigation primitive.
//
// One nav behavior for every app, and NO floating affordances (they read as
// gimmicky and, over a reading column, hurt usability). The shape:
//
//   • A thin bar (a solid flex sibling by default) holds the menu toggle,
//     the title, and app actions. It sits at the top by default; `barPosition`
//     can drop it to the bottom for a mobile-browser-style bar.
//   • Desktop (≥ breakpoint): a persistent left sidebar with the app's nav
//     body. The toggle collapses it to just the content; collapsed, the toggle
//     becomes a hamburger that brings it back.
//   • Mobile (< breakpoint): the toggle opens the same nav body in a sheet that
//     follows the bar edge, or an opt-in full-height left sidebar.
//
// The shell owns the frame + responsive state (+ collapse persistence); each
// app supplies its nav body via `nav` and its content via `children`, so apps
// stay distinct while the chrome is identical.
//
// `barFrosted` (opt-in, default OFF) turns the bar into an iOS-style frosted-
// glass OVERLAY that content scrolls UNDER, instead of the solid flex sibling.
// Only apps that want translucency pass it; every other app keeps the solid bar
// with the same behavior. When on,
// the bar is `position:absolute` pinned to its edge over a `position:relative`
// content region, and its measured height is published as the CSS custom
// property `--shell-bar-h` on that region so the app's scrollers can pad by it
// (so content clears the floating bar yet still scrolls under it).

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import MenuIcon from "@mui/icons-material/Menu";
import TocIcon from "@mui/icons-material/Toc";
import { alpha, Box, Button, IconButton, Tooltip, Typography, useMediaQuery, useTheme } from "@mui/material";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { prepareSelectionHaptic, selectionHaptic } from "./haptics.ts";
import { MobileNavigation } from "./mobile-navigation.tsx";
import { bindSpatialDrawer, type SpatialDrawerSettle } from "./spatial-drawer.ts";
import { TemporaryNav } from "./temporary-nav.tsx";

// Width below which nav collapses to a hamburger + top drawer. `lg` (1200px),
// not MUI's `sm`: tablets — iPad portrait (768–834) and landscape (1024–1180) —
// and an embedding iframe (which eats horizontal room) should all get the
// drawer rather than a cramped desktop sidebar.
type Breakpoint = "sm" | "md" | "lg" | "xl" | number;
const BOTTOM_PAD = "max(calc(env(safe-area-inset-bottom, 0px) - 22px), 6px)";

function barTopPadding(bottom: boolean, transparent: boolean): string | number {
  if (!bottom) {
    return "env(safe-area-inset-top, 0px)";
  }
  return transparent ? 0 : BOTTOM_PAD;
}

/** Handed to the `nav` render-prop so the body can drive the shell. */
export interface NavShellApi {
  /** Close temporary mobile navigation after the user picks a nav item. */
  readonly closeMobile: () => void;
  /** True while the viewport uses temporary mobile navigation. */
  readonly isMobile: boolean;
}

export interface NavShellProps {
  /** localStorage namespace for the persisted desktop-collapsed flag. */
  readonly appKey: string;
  /** Shown in the top bar (e.g. the app or current doc name). */
  readonly title?: ReactNode;
  /** Desktop expanded sidebar width in px. Default 280. */
  readonly navWidth?: number;
  /** Viewport width below which nav becomes temporary. Default "lg". */
  readonly breakpoint?: Breakpoint;
  /** Mobile navigation presentation. `sheet` follows the bar edge; `sidebar`
   *  uses a full-height left navigation pane sized like Cowboy's touch rail. */
  readonly mobilePresentation?: "sheet" | "sidebar";
  /** The navigation body. Render-prop receives {@link NavShellApi}. */
  readonly nav: (api: NavShellApi) => ReactNode;
  readonly navTitle?: string;
  readonly backLabel?: string;
  readonly onBack?: () => void;
  /** App-specific top-bar actions (e.g. settings), placed at the bar's end. */
  readonly actions?: ReactNode;
  /** Actions that live inside temporary navigation on touch layouts and return
   *  to the app bar beside `actions` on desktop (for example Settings). */
  readonly navigationActions?: ReactNode;
  /** Where the bar sits. Default "top". "bottom" makes it a mobile-browser-style
   *  bottom bar (the content fills above it, the nav drawer slides UP from it),
   *  and the bar owns the home-indicator inset instead of the notch. Apps gate
   *  this on their own mobile tier — desktop is best left "top". */
  readonly barPosition?: "top" | "bottom";
  /** Opt-in (default OFF). When true the bar is an iOS-style frosted-glass
   *  OVERLAY that content scrolls UNDER, not a solid flex sibling: it's pinned
   *  absolute to its edge over the content region, and its rendered height is
   *  published as `--shell-bar-h` on that region so the app's scrollers can
   *  reserve space (`padding-{top,bottom}: var(--shell-bar-h)`). OFF keeps the
   *  unchanged solid-sibling bar. */
  readonly barFrosted?: boolean;
  /** Opt-in (default OFF). Only meaningful together with `barFrosted`. Keeps the
   *  frosted OVERLAY POSITIONING (absolute, pinned, height still published as
   *  `--shell-bar-h`) but renders NO background and NO backdrop-filter — the bar
   *  is fully transparent. Use this when the HOST draws ONE frosted slab behind
   *  BOTH this bar and an adjacent surface pinned right above it (e.g. a media
   *  transport), so the two read as a SINGLE pane of glass instead of two
   *  separately-frosted layers that sample different content and never match. */
  readonly barTransparent?: boolean;
  /** The main content area. */
  readonly children: ReactNode;
}

function loadCollapsed(appKey: string): boolean {
  return globalThis.localStorage.getItem(`${appKey}-nav-collapsed`) === "true";
}

function saveCollapsed(appKey: string, collapsed: boolean): void {
  globalThis.localStorage.setItem(`${appKey}-nav-collapsed`, String(collapsed));
}

// The shell deliberately keeps the responsive frame in one function so the
// desktop, sheet, and spatial-sidebar branches share one state machine.
// eslint-disable-next-line max-lines-per-function
export function NavShell(props: NavShellProps): ReactNode {
  const {
    appKey,
    title,
    navWidth = 280,
    breakpoint = "lg",
    mobilePresentation = "sheet",
    nav,
    navTitle,
    backLabel,
    onBack,
    actions,
    navigationActions,
    barPosition = "top",
    barFrosted = false,
    barTransparent = false,
    children,
  } = props;
  const bottom = barPosition === "bottom";
  const theme = useTheme();
  const isMobile = useMediaQuery(
    typeof breakpoint === "number" ? `(max-width:${breakpoint - 0.05}px)` : theme.breakpoints.down(breakpoint),
  );
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const spatial = isMobile && mobilePresentation === "sidebar";

  // Frosted overlay: measure the bar's RENDERED height (it varies with the
  // safe-area inset, dynamic title content, and rotation) and publish it as
  // `--shell-bar-h` on the content region, so the app's scrollers can pad by an
  // always-exact value rather than a guessed constant. A ResizeObserver keeps it
  // live; off (the solid path) neither ref is wired, so this costs nothing.
  const barRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!barFrosted) {
      return;
    }
    const barEl = barRef.current;
    const contentEl = contentRef.current;
    if (!barEl || !contentEl) {
      return;
    }
    const publish = (): void => {
      const h = `${barEl.offsetHeight}px`;
      contentEl.style.setProperty("--shell-bar-h", h);
      // Also mirror onto the document root: a fixed overlay rendered OUTSIDE the
      // content region (e.g. an app's ambient bottom strip that must sit ABOVE
      // this bar) can't inherit the region-scoped var, so it reads the mirror.
      // Cleared on unmount so a later view (no bar) doesn't see a stale height.
      document.documentElement.style.setProperty("--shell-bar-h", h);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(barEl);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--shell-bar-h");
    };
  }, [barFrosted]);

  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(appKey));
  const mobileOpenRef = useRef(mobileOpen);
  mobileOpenRef.current = mobileOpen;
  const spatialRootRef = useRef<HTMLDivElement | null>(null);
  const spatialSurfaceRef = useRef<HTMLDivElement | null>(null);
  const spatialDrawerRef = useRef<HTMLDivElement | null>(null);
  const spatialMaskRef = useRef<HTMLDivElement | null>(null);
  const spatialSettleRef = useRef<SpatialDrawerSettle | null>(null);

  // The native iOS status-bar safe area exposes the document root rather than
  // the drawer element. While the spatial rail is open, hand that canvas the
  // same resolved surface token as the rail; otherwise warm themes show a
  // bgDefault band above a bgPaper drawer. Also publish an explicit open-state
  // attribute so the app-level fixed status material can be REMOVED while the
  // drawer itself owns this edge. Physical WKWebView can retain the old raster
  // for a fixed layer whose background only changes through a custom property;
  // removing that compositor layer is the reliable repaint boundary.
  useEffect(() => {
    const root = document.documentElement;
    if (spatial && mobileOpen) {
      root.style.setProperty("--lv-safe-area-bg", "var(--lv-nav-bg)");
      root.setAttribute("data-lv-spatial-drawer-open", "");
    } else {
      root.style.removeProperty("--lv-safe-area-bg");
      root.removeAttribute("data-lv-spatial-drawer-open");
    }
    return () => {
      root.style.removeProperty("--lv-safe-area-bg");
      root.removeAttribute("data-lv-spatial-drawer-open");
    };
  }, [mobileOpen, spatial]);

  const closeMobile = useCallback(() => {
    if (spatialSettleRef.current) {
      spatialSettleRef.current(false);
      return;
    }
    setMobileOpen(false);
  }, []);

  useEffect(() => {
    if (!spatial) {
      return;
    }
    const root = spatialRootRef.current;
    const surface = spatialSurfaceRef.current;
    const drawer = spatialDrawerRef.current;
    const mask = spatialMaskRef.current;
    if (!root || !surface || !drawer || !mask) {
      return;
    }
    const binding = bindSpatialDrawer({
      gestureTarget: root,
      surface,
      drawer,
      drawerMask: mask,
      phone: isPhone,
      // The app-level iOS-style edge swipe uses the first 28px to return to
      // the bookshelf. Let that gesture win there; the rest of the reading
      // surface still opens Contents, and an open drawer keeps the full width
      // available for swipe-to-close.
      reservedLeadingEdge: onBack ? 28 : 0,
      getOpen: () => mobileOpenRef.current,
      setOpen: setMobileOpen,
      onPrepareThreshold: prepareSelectionHaptic,
      onThreshold: selectionHaptic,
    });
    spatialSettleRef.current = binding.settle;
    return () => {
      spatialSettleRef.current = null;
      binding.dispose();
    };
  }, [isPhone, onBack, spatial]);

  useEffect(() => {
    if (!spatial || !mobileOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMobile();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [closeMobile, mobileOpen, spatial]);

  // Leaving mobile (rotate / resize to desktop) drops the temporary drawer so
  // it can't linger as a stuck overlay or auto-reopen on return. React's
  // adjust-state-during-render-on-change pattern — NOT an effect: a synchronous
  // setState inside an effect triggers a cascading render (the React Compiler
  // flags it), and this is the documented alternative.
  const [wasMobile, setWasMobile] = useState(isMobile);
  if (wasMobile !== isMobile) {
    setWasMobile(isMobile);
    if (!isMobile && mobileOpen) {
      setMobileOpen(false);
    }
  }

  // The toggle: on mobile it opens the top drawer; on desktop it collapses /
  // expands the persistent sidebar (persisting the choice).
  const sidebarShown = !isMobile && !collapsed;
  const onToggle = useCallback(() => {
    if (isMobile) {
      if (spatialSettleRef.current) {
        spatialSettleRef.current(!mobileOpenRef.current);
        return;
      }
      setMobileOpen((v) => !v);
      return;
    }
    setCollapsed((v) => {
      const next = !v;
      saveCollapsed(appKey, next);
      return next;
    });
  }, [appKey, isMobile]);

  const navBody = nav({ closeMobile, isMobile });
  const temporaryNavBody = (
    <TemporaryNav
      title={navTitle}
      backLabel={backLabel}
      onBack={onBack}
      onClose={closeMobile}
      spatial={spatial}
      actions={navigationActions}
    >
      {navBody}
    </TemporaryNav>
  );
  let toggleIcon: ReactNode = <MenuIcon />;
  if (sidebarShown) {
    toggleIcon = <ChevronLeftIcon />;
  } else if (isMobile) {
    toggleIcon = <TocIcon />;
  }

  // A string title gets the default single-line styling; a node title is
  // rendered raw in the slot, so an app can stack two lines (e.g. a chapter over
  // its book) or supply its own chrome.
  let titleSlot: ReactNode = <Box sx={{ flex: 1 }} />;
  if (typeof title === "string") {
    titleSlot = (
      <Typography
        variant="subtitle2"
        noWrap
        sx={{ fontWeight: 600, minWidth: 0, flex: 1 }}
      >
        {title}
      </Typography>
    );
  } else if (title != null) {
    titleSlot = (
      <Box
        sx={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        {title}
      </Box>
    );
  }

  return (
    <Box
      ref={spatialRootRef}
      sx={{
        position: "relative",
        height: "100dvh",
        overflow: "hidden",
        bgcolor: "background.default",
      }}
    >
      {spatial && (
        <Box
          ref={spatialDrawerRef}
          role="navigation"
          aria-label={navTitle ?? "Navigation"}
          aria-hidden={!mobileOpen}
          data-spatial-drawer
          sx={{
            position: "absolute",
            zIndex: 0,
            inset: 0,
            width: { xs: "min(84%, 360px)", sm: "min(52%, 440px)" },
            maxWidth: "calc(100% - 48px)",
            height: "100%",
            pt: "env(safe-area-inset-top, 0px)",
            pb: "env(safe-area-inset-bottom, 0px)",
            pl: "env(safe-area-inset-left, 0px)",
            overflow: "hidden",
            // Match the navigation body through the bottom safe-area padding.
            // Using background.default here exposed a black strip below the
            // paper-colored rail on iPhones with a home indicator.
            bgcolor: "background.paper",
            backfaceVisibility: "hidden",
          }}
        >
          {temporaryNavBody}
        </Box>
      )}
      {spatial && (
        <Box
          ref={spatialMaskRef}
          aria-hidden
          sx={{
            position: "absolute",
            zIndex: 0,
            inset: 0,
            bgcolor: "background.default",
            pointerEvents: "none",
            backfaceVisibility: "hidden",
          }}
        />
      )}
      <Box
        ref={spatialSurfaceRef}
        data-spatial-drawer-surface={spatial ? "true" : undefined}
        sx={{
          position: "relative",
          zIndex: spatial ? 1 : undefined,
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          bgcolor: "background.default",
          transformOrigin: "left center",
          backfaceVisibility: spatial ? "hidden" : undefined,
          contain: spatial ? "paint" : undefined,
        }}
      >
        <Box
          component="header"
          ref={barFrosted ? barRef : undefined}
          sx={{
            flexShrink: 0,
            // Bottom mode flips the bar below the content via flex order (one
            // bar, not a second element), so reading order in the DOM is stable.
            // (Frosted overrides position to absolute below; `order` is harmless
            // on an absolute box and keeps the non-frosted path untouched.)
            order: bottom ? 2 : 0,
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            // Keep the end buttons (menu / actions) off the screen edge so they
            // clear the display's rounded corners and a landscape notch — pull in
            // the safe-area inset, floored to a comfortable 12px in portrait.
            // On the tablet tier (sm=600+, i.e. iPad) raise the floor to 20px so
            // the end controls (the settings gear especially) sit further from the
            // rounded corner and are easier to hit; iPhone (<sm) and desktop keep
            // 12px. Safe-area flooring semantics unchanged (ui.md §7).
            pl: {
              xs: "max(env(safe-area-inset-left, 0px), 12px)",
              sm: "max(env(safe-area-inset-left, 0px), 20px)",
            },
            pr: {
              xs: "max(env(safe-area-inset-right, 0px), 12px)",
              sm: "max(env(safe-area-inset-right, 0px), 20px)",
            },
            // Vertical sizing is a PURE PADDING model for the bottom bar: height =
            // pt + content + pb, no minHeight floor. The controls are their own tap
            // targets (IconButtons ≥40px, ui.md §7), so a bar minHeight only ever
            // ADDED problems — with alignItems:center it centred the content in the
            // leftover 48px and left a gap ABOVE it (toward a transport sharing the
            // slab) even with pt:0. Dropping it makes the layout predictable and
            // kills that gap at the root; alignItems:center stays, but now only for
            // cross-item alignment (a 2-line title vs the icons) — no leftover space
            // to distribute, so no gap. The TOP bar (desktop) keeps the 48px floor.
            ...(bottom ? {} : { minHeight: 48 }),
            // Separator: a top bar floats over the content (Material elevation,
            // shadow falling down). A BOTTOM bar gets a flat 1px divider instead —
            // an upward drop-shadow there reads heavy and muddy over the reading
            // surface; a hairline rule is the cleaner, calmer cut. position+zIndex
            // so a top bar's shadow paints over the content (flex siblings would
            // otherwise share a layer).
            zIndex: (t) => t.zIndex.appBar,
            // Top bar owns the notch (pt only). Bottom bar is padded symmetrically
            // (see bottomPad) so its content is vertically centred and clears the
            // home indicator — EXCEPT when a transport rides directly above it in
            // ONE shared slab (`barTransparent`): then drop the top pad so the nav
            // row hugs the transport instead of leaving a seam-like gap between the
            // two control rows (the transport carries its own bottom breathing room).
            pt: barTopPadding(bottom, barTransparent),
            pb: bottom ? BOTTOM_PAD : 0,
            ...(barFrosted
              ? {
                // Frosted overlay: pin the bar absolute to its edge OVER the
                // (position:relative) content region, so the scroller fills
                // full-height under it. Milky tint + blur 30 / saturate 200 read as
                // thick frosted glass (not a clear pane) over a busy text column —
                // and let a same-recipe frosted surface stacked right above it (an
                // app's transport) blend into ONE continuous slab. A BOTTOM bar
                // therefore carries NO border: a hairline would re-introduce the
                // seam the single glass look removes. background.default (the page
                // bg the text sits on), not paper.
                position: "absolute",
                left: 0,
                right: 0,
                ...(bottom ? { bottom: 0 } : { top: 0 }),
                // `barTransparent`: the HOST owns a single frosted slab behind both
                // this bar and the surface above it, so the bar itself must add NO
                // tint/backdrop of its own (two backdrop-filters never match — they
                // sample different content). Keep the positioning, drop the glass.
                ...(barTransparent ? {} : {
                  // Near-opaque so the reading text does NOT bleed through and
                  // clash with the bar's controls (the old 0.72/0.76 showed through
                  // on warm / low-contrast pages).
                  //
                  // NO backdrop-filter: a blur here is a SCROLL-PERF trap. As the
                  // reader scrolls UNDER this fixed bar, a backdrop-filter must
                  // re-blur the moving content every frame — and at this opacity
                  // the blurred result is invisible anyway (the ~0.95 tint covers
                  // it), so it was pure wasted per-frame GPU work that dropped
                  // frames while scrolling. The opaque tint alone hides the page;
                  // the blur bought nothing. (Genuinely translucent chrome — the
                  // status-bar strip, small glass pucks — still needs its blur.)
                  bgcolor: (t) =>
                    alpha(
                      t.palette.background.default,
                      t.palette.mode === "dark" ? 0.94 : 0.96,
                    ),
                }),
                // Top bar keeps its downward elevation shadow to mark the edge; a
                // bottom bar stays flat + borderless (the glass tint is the edge).
                boxShadow: bottom ? "none" : 3,
              }
              : {
                position: "relative",
                bgcolor: "background.paper",
                boxShadow: bottom ? "none" : 3,
                ...(bottom ? { borderTop: 1, borderColor: "divider" } : {}),
              }),
          }}
        >
          <Tooltip title={sidebarShown ? "Collapse" : "Menu"}>
            {
              /* Primary mobile nav opener — 40px target on iPhone, compact 36 on
              desktop. On the tablet tier (sm=600+, i.e. iPad) raise it to 48 to
              MATCH the settings gear (see SettingsSheet): both end controls sit
              in the display's bottom rounded corners, where a 40px target is
              hard to hit. The gear got this bump; the symmetric left ≡ must too,
              or the bottom-left corner stays awkward to tap on iPad. */
            }
            <IconButton
              aria-label="toggle navigation"
              onClick={onToggle}
              size="small"
              sx={{ width: { xs: 40, sm: 48, lg: 36 }, height: { xs: 40, sm: 48, lg: 36 } }}
            >
              {toggleIcon}
            </IconButton>
          </Tooltip>
          {!isMobile && onBack && backLabel && (
            <Button
              onClick={onBack}
              endIcon={<Typography color="text.disabled">/</Typography>}
              sx={{ minWidth: 0, px: 0.5, textTransform: "none", color: "text.secondary" }}
            >
              {backLabel}
            </Button>
          )}
          {titleSlot}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              flexShrink: 0,
            }}
          >
            {actions}
            {!isMobile && navigationActions}
          </Box>
        </Box>

        <Box
          ref={barFrosted ? contentRef : undefined}
          sx={{
            order: bottom ? 1 : 0,
            display: "flex",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            // Frosted: this region is the bar's positioning context (the bar is
            // absolute within it) AND carries the published --shell-bar-h that the
            // app's scrollers pad by. The solid path leaves it static (unchanged).
            ...(barFrosted ? { position: "relative" } : {}),
          }}
        >
          {sidebarShown && (
            <Box
              sx={{
                flexShrink: 0,
                width: navWidth,
                height: "100%",
                borderRight: 1,
                borderColor: "divider",
                bgcolor: "background.paper",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {navBody}
            </Box>
          )}

          {
            /* Mobile nav body. A bottom bar presents it as the momentum
            DetentSheet (drag handle, rounded top, swipe-to-dismiss) — the same
            sheet every other bottom-anchored surface uses, so it feels native
            and consistent. A top bar keeps the plain top Drawer that slides
            down from under it. */
          }
          <MobileNavigation
            presentation={mobilePresentation}
            bottom={bottom}
            open={isMobile && mobileOpen}
            onClose={closeMobile}
          >
            {temporaryNavBody}
          </MobileNavigation>

          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {children}
          </Box>
        </Box>
        {spatial && (
          <Box
            role="button"
            tabIndex={mobileOpen ? 0 : -1}
            aria-label="Close navigation"
            aria-hidden={!mobileOpen}
            onClick={closeMobile}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                closeMobile();
              }
            }}
            sx={{
              position: "absolute",
              inset: 0,
              zIndex: (t) => t.zIndex.modal - 1,
              pointerEvents: mobileOpen ? "auto" : "none",
              cursor: mobileOpen ? "pointer" : "default",
              // Cowboy keeps the trailing workspace legible as spatial context,
              // but subdued enough that the revealed rail is unquestionably the
              // active plane. A flat tint is compositor-cheap and avoids blur.
              bgcolor: (t) =>
                mobileOpen
                  ? alpha(
                    t.palette.common.black,
                    t.palette.mode === "dark" ? 0.18 : 0.08,
                  )
                  : "transparent",
              transition: "background-color 180ms ease",
            }}
          />
        )}
      </Box>
    </Box>
  );
}
