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
// A bottom bar is the last row of the content column's BottomDock, so it
// shares one opaque material with any strip or accessory the app portals into
// the dock, and content scrolls under it (padded by `--lv-dock-h`). A top bar
// is a solid flex sibling above the content.

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import MenuIcon from "@mui/icons-material/Menu";
import TocIcon from "@mui/icons-material/Toc";
import {
  alpha,
  Box,
  Button,
  IconButton,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { BottomDock } from "./bottom-dock.tsx";
import { EDGE_BACK_WIDTH } from "./edge-back-gesture.ts";
import { prepareSelectionHaptic, selectionHaptic } from "./haptics.ts";
import { MobileNavigation } from "./mobile-navigation.tsx";
import { useShellLabels } from "./shell-labels.tsx";
import {
  bindSpatialDrawer,
  type SpatialDrawerSettle,
} from "./spatial-drawer.ts";
import { TemporaryNav } from "./temporary-nav.tsx";

// Width below which nav collapses to a hamburger + top drawer. `lg` (1200px),
// not MUI's `sm`: tablets — iPad portrait (768–834) and landscape (1024–1180) —
// and an embedding iframe (which eats horizontal room) should all get the
// drawer rather than a cramped desktop sidebar.
type Breakpoint = "sm" | "md" | "lg" | "xl" | number;
const BOTTOM_PAD = "max(calc(env(safe-area-inset-bottom, 0px) - 22px), 6px)";
const SPATIAL_PHONE_WIDTH = "min(84%, 360px)";
const SPATIAL_TABLET_WIDTH = "min(64%, 560px)";

/** Handed to the `nav` render-prop so the body can drive the shell. */
export interface NavShellApi {
  /** Close temporary mobile navigation after the user picks a nav item. */
  readonly closeMobile: () => void;
  /** True while the viewport uses temporary mobile navigation. */
  readonly isMobile: boolean;
  readonly visible: boolean;
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
  /** Compact app-owned control shown in the trailing rail while a spatial
   *  mobile drawer is open. The shell owns its placement; the app owns its
   *  semantics (for LiveView this is the stable playback entry point). */
  readonly spatialAccessory?: ReactNode;
  /** Where the bar sits. Default "top". "bottom" makes it a mobile-browser-style
   *  bottom bar (the content fills above it, the nav drawer slides UP from it),
   *  and the bar owns the home-indicator inset instead of the notch. Apps gate
   *  this on their own mobile tier — desktop is best left "top". */
  readonly barPosition?: "top" | "bottom";
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
    spatialAccessory,
    barPosition = "top",
    children,
  } = props;
  const bottom = barPosition === "bottom";
  const theme = useTheme();
  const isMobile = useMediaQuery(
    typeof breakpoint === "number"
      ? `(max-width:${breakpoint - 0.05}px)`
      : theme.breakpoints.down(breakpoint),
  );
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const spatial = isMobile && mobilePresentation === "sidebar";
  const labels = useShellLabels();

  // The bottom bar's height, published on the shell root for the spatial
  // drawer's stationary companion, which sits just above the bar (the rest of
  // the dock travels with the translated reader).
  const barRef = useRef<HTMLElement | null>(null);
  const spatialRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const barEl = barRef.current;
    const rootEl = spatialRootRef.current;
    if (!bottom || !barEl || !rootEl) {
      return;
    }
    const publish = (): void => {
      rootEl.style.setProperty("--shell-bar-h", `${barEl.offsetHeight}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(barEl);
    return () => {
      ro.disconnect();
      rootEl.style.removeProperty("--shell-bar-h");
    };
  }, [bottom]);

  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(appKey));
  const mobileOpenRef = useRef(mobileOpen);
  mobileOpenRef.current = mobileOpen;
  const spatialSurfaceRef = useRef<HTMLDivElement | null>(null);
  const spatialDrawerRef = useRef<HTMLDivElement | null>(null);
  const spatialMaskRef = useRef<HTMLDivElement | null>(null);
  const spatialBackdropRef = useRef<HTMLDivElement | null>(null);
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
      root.setAttribute("data-lv-spatial-drawer-open", "");
    } else {
      root.removeAttribute("data-lv-spatial-drawer-open");
    }
    return () => {
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
    const backdrop = spatialBackdropRef.current;
    if (!root || !surface || !drawer || !mask || !backdrop) {
      return;
    }
    const binding = bindSpatialDrawer({
      gestureTarget: root,
      surface,
      drawer,
      drawerMask: mask,
      backdrop,
      phone: isPhone,
      // The app-level iOS-style edge swipe uses the first 28px to return to
      // the bookshelf. Let that gesture win there; the rest of the reading
      // surface still opens Contents, and an open drawer keeps the full width
      // available for swipe-to-close.
      reservedLeadingEdge: onBack ? EDGE_BACK_WIDTH : 0,
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

  // The body receives visibility so its background work can pause with the pane.
  // Sidebar memoizes the individual chapter rows across visibility changes.
  const navBody = useMemo(
    () => nav({ closeMobile, isMobile, visible: isMobile ? mobileOpen : !collapsed }),
    [nav, closeMobile, isMobile, mobileOpen, collapsed],
  );
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
  let toggleLabel = labels.openNavigation;
  if (sidebarShown) {
    toggleLabel = labels.collapseNavigation;
  } else if (isMobile && mobileOpen) {
    toggleLabel = labels.closeNavigation;
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

  const header = (
    <Box
      component="header"
      ref={barRef}
      data-lv-shell-bar="true"
      sx={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        // Keep the end buttons off the rounded display corners and a
        // landscape notch: the safe-area inset, floored to 12 px on phones and
        // 20 px on tablets, where the corner controls are hardest to hit.
        pl: {
          xs: "max(env(safe-area-inset-left, 0px), 12px)",
          sm: "max(env(safe-area-inset-left, 0px), 20px)",
        },
        pr: {
          xs: "max(env(safe-area-inset-right, 0px), 12px)",
          sm: "max(env(safe-area-inset-right, 0px), 20px)",
        },
        position: "relative",
        zIndex: (t) => t.zIndex.appBar,
        ...(bottom
          ? {
            // Pure padding model: no minimum height, so nothing is centred
            // into leftover space above the controls.
            pt: BOTTOM_PAD,
            pb: BOTTOM_PAD,
            bgcolor: "background.default",
            borderTop: 1,
            borderColor: "divider",
            // Under an accessory (the transport) the bar continues the same
            // row group: no seam and no top padding between the two.
            '[data-lv-dock-slot="accessory"]:not(:empty) ~ &': { pt: 0, borderTop: 0 },
          }
          : {
            // The top bar owns the notch and floats over content with an
            // elevation shadow.
            minHeight: 48,
            pt: "env(safe-area-inset-top, 0px)",
            bgcolor: "background.paper",
            boxShadow: 3,
          }),
      }}
    >
    <Tooltip title={toggleLabel}>
      {
        /* Primary mobile nav opener — 40px target on iPhone, compact 36 on
        desktop. On the tablet tier (sm=600+, i.e. iPad) raise it to 48 to
        MATCH the settings gear (see SettingsSheet): both end controls sit
        in the display's bottom rounded corners, where a 40px target is
        hard to hit. The gear got this bump; the symmetric left ≡ must too,
        or the bottom-left corner stays awkward to tap on iPad. */
      }
      <IconButton
        aria-label={toggleLabel}
        onClick={onToggle}
        size="small"
        sx={{
          width: { xs: 40, sm: 48, lg: 36 },
          height: { xs: 40, sm: 48, lg: 36 },
        }}
      >
        {toggleIcon}
      </IconButton>
    </Tooltip>
    {!isMobile && onBack && backLabel && (
      <Button
        onClick={onBack}
        endIcon={<Typography color="text.disabled">/</Typography>}
        sx={{
          minWidth: 0,
          px: 0.5,
          textTransform: "none",
          color: "text.secondary",
        }}
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
  );

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
          aria-label={navTitle ?? labels.navigation}
          aria-hidden={!mobileOpen}
          // A closed rail sits behind the reader but stays in the DOM: `inert`
          // keeps its links out of the Tab order and hit testing, not just out
          // of the accessibility tree.
          inert={!mobileOpen}
          data-spatial-drawer
          sx={{
            position: "absolute",
            zIndex: 0,
            inset: 0,
            width: { xs: SPATIAL_PHONE_WIDTH, sm: SPATIAL_TABLET_WIDTH },
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
        {!bottom && header}

        <Box
          sx={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
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
              // The dock's positioning context and `--lv-dock-h` host.
              position: "relative",
            }}
          >
            <BottomDock bar={bottom ? header : undefined}>{children}</BottomDock>
          </Box>
        </Box>
        {spatial && (
          <Box
            ref={spatialBackdropRef}
            role="button"
            data-lv-spatial-backdrop
            tabIndex={mobileOpen ? 0 : -1}
            aria-label={labels.closeNavigation}
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
              pointerEvents: "none",
              cursor: "default",
              '&[aria-hidden="false"]': { pointerEvents: "auto", cursor: "pointer" },
              // Cowboy keeps the trailing workspace legible as spatial context,
              // but subdued enough that the revealed rail is unquestionably the
              // active plane. Keep the tint stable and let the spatial compositor
              // drive its opacity with the drawer offset. Tying the colour to the
              // delayed React open-state commit left a second 180ms full-screen
              // fade after the close translation had already finished — visible
              // on WKWebView as a backdrop flash.
              bgcolor: (t) =>
                alpha(
                  t.palette.common.black,
                  t.palette.mode === "dark" ? 0.10 : 0.035,
                ),
              opacity: 0,
            }}
          />
        )}
      </Box>
      {spatial && spatialAccessory && (
        <Box
          aria-hidden={!mobileOpen}
          data-spatial-drawer-ignore
          data-lv-spatial-accessory
          sx={{
            position: "absolute",
            // This rail is a sibling of the translated reader, so it remains
            // inside the actually-visible trailing 16% instead of being clipped
            // with the reader's full-width transport. It sits above the reader's
            // tap-to-close backdrop only for this bounded control. Keep it hidden
            // during direct manipulation so the full transport moves continuously
            // with the reader; reveal it only after React commits `mobileOpen`.
            // App chrome must remain below root-level settings and other sheets.
            zIndex: (t) => t.zIndex.appBar,
            left: { xs: SPATIAL_PHONE_WIDTH, sm: SPATIAL_TABLET_WIDTH },
            right: 0,
            bottom: "calc(var(--shell-bar-h, 0px) + 12px)",
            // Keep this bounded control laid out before the first reveal. A
            // display:none -> flex flip otherwise performs its cold layout in
            // the same frame that starts translating the full reader.
            display: "flex",
            visibility: "hidden",
            '&[aria-hidden="false"]': { visibility: "visible", pointerEvents: "auto" },
            justifyContent: "center",
            alignItems: "center",
            pointerEvents: "none",
          }}
        >
          {spatialAccessory}
        </Box>
      )}
    </Box>
  );
}
