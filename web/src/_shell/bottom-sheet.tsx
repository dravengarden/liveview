// BottomSheet — the unified modal-sheet primitive.
//
// One affordance, two surfaces by viewport:
//   • mobile (< sm): the shared DetentSheet — a momentum two-detent sheet that
//     slides up from the bottom (drag the bar to expand, flick down to dismiss).
//   • desktop (≥ sm): a centered MUI Dialog — a sheet + drag handle read wrong
//     on a wide, pointer-driven screen.
//
// The mobile feel lives entirely in DetentSheet (dep-free, non-Modal so it never
// perturbs a hosted iframe). BottomSheet just maps its title/children/actions
// onto DetentSheet's header/body/footer, so every app's modal sheet shares the
// exact same behaviour. Every app's modal sheet should use THIS, not a bespoke
// Drawer.

import CloseIcon from "@mui/icons-material/Close";
import {
  alpha,
  Box,
  ButtonBase,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { ReactNode } from "react";

import { DetentSheet } from "./detent-sheet.tsx";

export interface BottomSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Heading shown at the top of the sheet/dialog. */
  readonly title?: ReactNode;
  /** Body content (scrolls when it overflows the sheet). */
  readonly children: ReactNode;
  /** Optional action row pinned to the bottom (e.g. Save / Cancel). */
  readonly actions?: ReactNode;
  /**
   * Desktop/tablet dialog width. Default is a compact ~444px dialog (right for
   * a handful of rows). Pass `wide` for content-rich surfaces (a palette grid +
   * font list + reading controls) so the dialog scales with the viewport
   * instead of staying cramped: ~560px on tablets, ~720px on wide desktops,
   * still shrinking to fit a narrow tablet. No effect on the mobile sheet.
   */
  readonly wide?: boolean;
  /**
   * Force the bottom-sheet surface regardless of viewport width. Default is
   * width-driven (sheet `< sm`, centered dialog otherwise). Set this when the
   * host puts its chrome at the bottom on a wider tier too (e.g. a mobile-
   * browser-style bottom navbar on a tablet), so its modals keep rising from
   * the bottom instead of switching to a centered dialog.
   */
  readonly forceSheet?: boolean;
  /** Frosted-glass surface on the mobile sheet — forwarded to DetentSheet's
   *  `frosted` variant (translucent 磨砂玻璃 material + lighter scrim). No effect on
   *  the desktop dialog. Default false = solid. */
  readonly frosted?: boolean;
  /** Near-full-screen cover on the mobile sheet — forwarded to DetentSheet's
   *  `cover` variant (微信读书 / iOS pageSheet feel, frosted). No effect on the
   *  desktop dialog. Default false. */
  readonly cover?: boolean;
  /**
   * Mobile dismiss placement. The shared liquid-glass footer island is the
   * default; `header` is an explicit conventional close button, while `none`
   * lets a confirmation or custom action footer own dismissal. Desktop dialogs
   * are intentionally unchanged.
   */
  readonly mobileDismiss?: "header" | "footer" | "none";
  /** Render the mobile footer as a detached glass overlay over the scroll body.
   *  The body still reserves scroll clearance behind it. */
  readonly floatingActions?: boolean;
}

export function FloatingActionIsland(
  {
    children,
    columns = "1fr",
    maxWidth,
    minHeight = 54,
    rim = "defined",
    tone = "adaptive",
  }: {
    readonly children: ReactNode;
    readonly columns?: string;
    readonly maxWidth?: number | string;
    readonly minHeight?: number | string;
    readonly rim?: "defined" | "soft";
    /**
     * `adaptive` follows the app theme. `dark` is for controls that always sit
     * on a dark modal scrim, even when the underlying app uses a light theme.
     */
    readonly tone?: "adaptive" | "dark";
  },
): ReactNode {
  const softRim = rim === "soft";
  const darkTone = tone === "dark";
  const topHighlightOpacity = (dark: boolean): number => {
    if (softRim) {
      return dark ? 0.14 : 0.48;
    }
    return dark ? 0.22 : 0.82;
  };
  return (
    <Box
      sx={{
        position: "relative",
        isolation: "isolate",
        overflow: "hidden",
        width: "100%",
        maxWidth,
        minHeight,
        px: 0.5,
        py: 0.375,
        display: "grid",
        gridTemplateColumns: columns,
        alignItems: "center",
        gap: 0.5,
        border: softRim ? 0 : 1,
        borderColor: darkTone
          ? "rgba(255, 255, 255, 0.14)"
          : (t) => alpha(t.palette.common.white, t.palette.mode === "dark" ? 0.18 : 0.62),
        borderRadius: 999,
        bgcolor: darkTone
          ? "rgba(24, 24, 28, 0.9)"
          : (t) => alpha(t.palette.background.paper, t.palette.mode === "dark" ? 0.48 : 0.42),
        backgroundImage: darkTone
          ? (t) =>
            `linear-gradient(180deg, rgba(255, 255, 255, 0.065), rgba(255, 255, 255, 0.012) 48%, ${
              alpha(t.palette.primary.main, 0.055)
            })`
          : (t) =>
            [
              `radial-gradient(120% 90% at 18% -18%, ${
                alpha(t.palette.common.white, t.palette.mode === "dark" ? 0.24 : 0.82)
              } 0%, transparent 52%)`,
              `linear-gradient(180deg, ${
                alpha(t.palette.common.white, t.palette.mode === "dark" ? 0.08 : 0.3)
              } 0%, transparent 46%, ${
                alpha(t.palette.primary.main, t.palette.mode === "dark" ? 0.08 : 0.055)
              } 100%)`,
            ].join(", "),
        boxShadow: darkTone
          ? (t) =>
            `0 14px 36px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255, 255, 255, 0.12), inset 0 -1px 0 ${
              alpha(t.palette.primary.main, 0.14)
            }`
          : (t) => {
            const topHighlight = topHighlightOpacity(t.palette.mode === "dark");
            return [
              `0 14px 38px ${alpha(t.palette.common.black, t.palette.mode === "dark" ? 0.42 : 0.16)}`,
              `inset 0 1px 0 ${alpha(t.palette.common.white, topHighlight)}`,
              `inset 0 -1px 0 ${alpha(t.palette.primary.main, t.palette.mode === "dark" ? 0.18 : 0.12)}`,
            ].join(", ");
          },
        backdropFilter: darkTone ? "none" : "blur(34px) saturate(190%) contrast(108%)",
        WebkitBackdropFilter: darkTone ? "none" : "blur(34px) saturate(190%) contrast(108%)",
        color: darkTone ? "rgba(255, 255, 255, 0.88)" : undefined,
        userSelect: "none",
        WebkitUserSelect: "none",
        "&::before": {
          content: '""',
          position: "absolute",
          zIndex: 0,
          pointerEvents: "none",
          inset: softRim ? 0 : 1,
          borderRadius: "inherit",
          background: darkTone
            ? "linear-gradient(112deg, rgba(255, 255, 255, 0.08), transparent 31%, transparent 70%, rgba(255, 255, 255, 0.035))"
            : (t) =>
              `linear-gradient(112deg, ${
                alpha(t.palette.common.white, t.palette.mode === "dark" ? 0.13 : 0.5)
              } 0%, transparent 31%, transparent 68%, ${
                alpha(t.palette.common.white, t.palette.mode === "dark" ? 0.07 : 0.2)
              } 100%)`,
        },
        "&::after": {
          content: '""',
          position: "absolute",
          zIndex: 0,
          pointerEvents: "none",
          left: "12%",
          right: "12%",
          top: 1,
          height: "42%",
          borderRadius: "999px 999px 50% 50%",
          background: darkTone
            ? "linear-gradient(180deg, rgba(255, 255, 255, 0.09), transparent)"
            : (t) =>
              `linear-gradient(180deg, ${
                alpha(t.palette.common.white, t.palette.mode === "dark" ? 0.16 : 0.58)
              }, transparent)`,
          filter: darkTone ? "blur(6px)" : "blur(7px)",
          opacity: darkTone ? 0.45 : 0.72,
        },
        "& > *": { position: "relative", zIndex: 1 },
      }}
    >
      {children}
    </Box>
  );
}

export interface MobileSheetAction {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onPress: () => void;
  readonly visible?: boolean;
  readonly disabled?: boolean;
}

/**
 * A compact liquid-glass action island whose material continuously grows from
 * one circular action into a multi-action capsule. Slots stay mounted while
 * hidden so both the shell and its contents can animate back to one action
 * without a second glass layer flashing in or out.
 */
export function MobileSheetActionGroup(
  { actions }: { readonly actions: readonly MobileSheetAction[] },
): ReactNode {
  const visibleCount = Math.max(
    1,
    actions.reduce((count, action) => count + (action.visible === false ? 0 : 1), 0),
  );
  const width = 54 + (visibleCount - 1) * 50;
  return (
    <Box
      sx={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <Box
        sx={{
          width,
          maxWidth: "100%",
          transition: "width 420ms cubic-bezier(0.22, 1, 0.36, 1)",
          willChange: "width",
          pointerEvents: "auto",
        }}
      >
        <FloatingActionIsland maxWidth="100%">
          <Box
            sx={{
              minWidth: 0,
              height: 46,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {actions.map((action, index) => {
              const visible = action.visible !== false;
              const handlePress = action.onPress;
              return (
                <Box
                  key={action.key}
                  aria-hidden={!visible}
                  sx={{
                    position: "relative",
                    flex: "0 0 auto",
                    width: visible ? 46 : 0,
                    ml: visible && index > 0 ? 0.5 : 0,
                    opacity: visible ? 1 : 0,
                    transform: visible ? "scale(1)" : "scale(0.72)",
                    overflow: "hidden",
                    pointerEvents: visible ? "auto" : "none",
                    transition: [
                      "width 420ms cubic-bezier(0.22, 1, 0.36, 1)",
                      "margin-left 420ms cubic-bezier(0.22, 1, 0.36, 1)",
                      "opacity 180ms ease",
                      "transform 360ms cubic-bezier(0.22, 1, 0.36, 1)",
                    ].join(", "),
                  }}
                >
                  <ButtonBase
                    aria-label={action.label}
                    disabled={action.disabled}
                    tabIndex={visible ? 0 : -1}
                    onClick={handlePress}
                    onPointerDown={(event) => event.stopPropagation()}
                    sx={{
                      color: "text.primary",
                      width: 46,
                      height: 46,
                      borderRadius: 999,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 650,
                      transition: [
                        "transform 160ms cubic-bezier(0.22, 1, 0.36, 1)",
                        "background-color 160ms ease",
                      ].join(", "),
                      "&:active": {
                        transform: "scale(0.94)",
                        bgcolor: (t) => alpha(t.palette.primary.main, t.palette.mode === "dark" ? 0.14 : 0.09),
                      },
                      "&:focus-visible": {
                        outline: "2px solid",
                        outlineColor: "primary.main",
                        outlineOffset: -2,
                      },
                      "&.Mui-disabled": { color: "text.disabled" },
                    }}
                  >
                    {action.icon}
                  </ButtonBase>
                </Box>
              );
            })}
          </Box>
        </FloatingActionIsland>
      </Box>
    </Box>
  );
}

export function MobileSheetDismiss(
  { onClose, label = "Close" }: { readonly onClose: () => void; readonly label?: string },
): ReactNode {
  return (
    <MobileSheetActionGroup
      actions={[{
        key: "close",
        label,
        onPress: onClose,
        icon: (
          <CloseIcon
            aria-hidden
            fontSize="small"
            // The crossed diagonals are mathematically centred but read a touch
            // low/right inside a luminous circle. Keep the island on the exact
            // layout centre and correct only the glyph's optical centre.
            sx={{ transform: "translate(-0.75px, -0.5px)" }}
          />
        ),
      }]}
    />
  );
}

export function BottomSheet(
  {
    open,
    onClose,
    title,
    children,
    actions,
    wide = false,
    forceSheet = false,
    frosted = false,
    cover = false,
    mobileDismiss = "footer",
    floatingActions = true,
  }: BottomSheetProps,
): ReactNode {
  const theme = useTheme();
  // useMediaQuery must run unconditionally (rules of hooks); OR with forceSheet
  // after.
  const widthIsMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const isMobile = forceSheet || widthIsMobile;

  // Desktop: a centered dialog. A bottom sheet (and its drag handle) only makes
  // sense on a touch/phone viewport. `fullWidth` + a Paper maxWidth cap lets the
  // dialog fill the viewport up to the cap, so narrow tablets shrink it while
  // wide screens get the full width — `wide` raises the cap per breakpoint.
  if (!isMobile) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth={false}
        fullWidth
        PaperProps={{ sx: { maxWidth: wide ? { sm: 560, lg: 720 } : 444 } }}
      >
        {title == null ? null : <DialogTitle sx={{ fontWeight: 700 }}>{title}</DialogTitle>}
        <DialogContent>{children}</DialogContent>
        {actions == null
          ? null
          : <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, px: 3, pb: 2 }}>{actions}</Box>}
      </Dialog>
    );
  }

  // Mobile: the shared momentum sheet. The title row rides the drag bar; its
  // close button stops pointerdown so a tap closes instead of starting a drag.
  return (
    <DetentSheet
      open={open}
      onClose={onClose}
      frosted={frosted}
      cover={cover}
      footerOverlay={floatingActions}
      ariaLabel={typeof title === "string" ? title : undefined}
      // Dim the standalone status bar in lockstep with the scrim, and — since
      // surfaceColor is also what DetentSheet RESTORES the bar to on close —
      // make that resting colour the page's, not the sheet's. The status-bar
      // strip sits in the scrim gap ABOVE the sheet, over the dimmed page
      // (`background.default`, the app's body + AppBar surface), not over the
      // sheet's `paper`. Using `default` both dims the strip against the right
      // base AND leaves the bar matching the navbar after close — paper left it
      // a shade off the navbar every time the theme changed (theme is only
      // switchable from inside a sheet). Reactive, so a theme switch while the
      // sheet is open restores the new theme's colour. Inert when hosted.
      surfaceColor={theme.palette.background.default}
      header={title == null ? <Box sx={{ pb: 0.5 }} /> : (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            pl: 2,
            // The close button is the sheet's primary dismiss; on a phone it sits
            // at the right edge. Drop edge="end" (its negative margin pinned the
            // small glyph to the iOS rounded corner / back-swipe edge) and floor a
            // right inset instead.
            pr: "max(env(safe-area-inset-right), 16px)",
            pb: 1,
          }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 700, flexGrow: 1 }}>
            {title}
          </Typography>
          {mobileDismiss === "header" && (
            <IconButton
              aria-label="close"
              size="small"
              onClick={onClose}
              onPointerDown={(e) => e.stopPropagation()}
              // ≥40px target on touch (the close affordance every sheet shares);
              // compact on desktop.
              sx={{ width: { xs: 40, lg: 34 }, height: { xs: 40, lg: 34 } }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
      )}
      footer={actions == null && mobileDismiss !== "footer"
        ? undefined
        : (
          <Box sx={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
            {actions == null ? null : (
              <Box sx={{ width: "100%", display: "flex", justifyContent: "flex-end", gap: 1 }}>
                {actions}
              </Box>
            )}
            {mobileDismiss === "footer" ? <MobileSheetDismiss onClose={onClose} /> : null}
          </Box>
        )}
    >
      {
        /* The sheet body is edge-to-edge; a modal sheet's text/controls want a
          side gutter, so add it here (every BottomSheet consumer inherits it). */
      }
      <Box sx={{ px: 2 }}>{children}</Box>
    </DetentSheet>
  );
}
