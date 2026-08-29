import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import CloseIcon from "@mui/icons-material/Close";
import { alpha, Box, Button, ButtonBase, IconButton, Typography } from "@mui/material";
import type { ReactNode } from "react";

function DrawerActionIsland(
  { width, children }: { readonly width: number; readonly children: ReactNode },
): ReactNode {
  return (
    <Box
      sx={{
        width,
        minHeight: 54,
        px: 0.5,
        py: 0.375,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: 1,
        borderColor: (theme) =>
          alpha(
            theme.palette.common.white,
            theme.palette.mode === "dark" ? 0.16 : 0.7,
          ),
        borderRadius: 999,
        bgcolor: (theme) =>
          alpha(
            theme.palette.background.paper,
            theme.palette.mode === "dark" ? 0.96 : 0.94,
          ),
        boxShadow: (theme) =>
          [
            `0 14px 38px ${
              alpha(
                theme.palette.common.black,
                theme.palette.mode === "dark" ? 0.34 : 0.14,
              )
            }`,
            `inset 0 1px 0 ${
              alpha(
                theme.palette.common.white,
                theme.palette.mode === "dark" ? 0.16 : 0.78,
              )
            }`,
          ].join(", "),
      }}
    >
      {children}
    </Box>
  );
}

export function TemporaryNav(
  { title, backLabel, onBack, onClose, spatial, actions, children }: {
    readonly title?: string | undefined;
    readonly backLabel?: string | undefined;
    readonly onBack?: (() => void) | undefined;
    readonly onClose: () => void;
    readonly spatial: boolean;
    readonly actions?: ReactNode;
    readonly children: ReactNode;
  },
): ReactNode {
  if (spatial) {
    return (
      <Box
        sx={{
          position: "relative",
          height: "100%",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box
          sx={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            "--temporary-nav-overlay-clearance":
              "calc(86px + env(safe-area-inset-bottom, 0px))",
          }}
        >
          {children}
        </Box>
        <Box
          data-temporary-nav-actions
          sx={{
            position: "absolute",
            zIndex: 3,
            left: "max(env(safe-area-inset-left, 0px), 12px)",
            right: "max(env(safe-area-inset-right, 0px), 12px)",
            bottom: "max(env(safe-area-inset-bottom, 0px), 12px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            pointerEvents: "none",
          }}
        >
          {onBack
            ? (
              <Box sx={{ pointerEvents: "auto" }}>
                <DrawerActionIsland width={54}>
                  <ButtonBase
                    aria-label={backLabel ?? "Back"}
                    onClick={onBack}
                    sx={{
                      width: 46,
                      height: 46,
                      borderRadius: 999,
                      display: "grid",
                      placeItems: "center",
                      color: "text.primary",
                      "&:active": { transform: "scale(0.94)" },
                    }}
                  >
                    <ChevronLeftIcon aria-hidden fontSize="small" />
                  </ButtonBase>
                </DrawerActionIsland>
              </Box>
            )
            : <Box />}
          <Box sx={{ pointerEvents: "auto" }}>
            <DrawerActionIsland width={actions ? 108 : 54}>
              <Box
                sx={{
                  height: 46,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  "& .MuiIconButton-root": {
                    width: 46,
                    height: 46,
                    color: "text.primary",
                  },
                }}
              >
                <ButtonBase
                  aria-label="Close navigation"
                  onClick={onClose}
                  sx={{
                    width: 46,
                    height: 46,
                    borderRadius: 999,
                    display: "grid",
                    placeItems: "center",
                    color: "text.primary",
                    "&:active": {
                      transform: "scale(0.94)",
                      bgcolor: (theme) =>
                        alpha(
                          theme.palette.primary.main,
                          theme.palette.mode === "dark" ? 0.14 : 0.09,
                        ),
                    },
                  }}
                >
                  <CloseIcon aria-hidden fontSize="small" />
                </ButtonBase>
                {actions}
              </Box>
            </DrawerActionIsland>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        data-temporary-nav-header
        sx={{
          minHeight: 52,
          px: 1.25,
          display: "grid",
          gridTemplateColumns: "minmax(92px, 1fr) auto minmax(92px, 1fr)",
          alignItems: "center",
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        {onBack && backLabel
          ? (
            <Button
              aria-label={backLabel}
              onClick={onBack}
              startIcon={<ChevronLeftIcon />}
              sx={{
                justifySelf: "start",
                minWidth: 0,
                px: 0.5,
                color: "primary.main",
                fontSize: "0.78rem",
                "& .MuiButton-startIcon": { mr: 0.125 },
              }}
            >
              {backLabel}
            </Button>
          )
          : <Box />}
        <Typography
          variant="subtitle2"
          noWrap
          sx={{ fontWeight: 720, letterSpacing: "-0.015em" }}
        >
          {title}
        </Typography>
        <IconButton
          aria-label="Close navigation"
          onClick={onClose}
          sx={{
            justifySelf: "end",
            width: 40,
            height: 40,
            color: "text.secondary",
            bgcolor: (theme) =>
              alpha(
                theme.palette.primary.main,
                theme.palette.mode === "dark" ? 0.16 : 0.08,
              ),
            "@media (hover: hover)": {
              "&:hover": {
                bgcolor: (theme) =>
                  alpha(
                    theme.palette.primary.main,
                    theme.palette.mode === "dark" ? 0.22 : 0.13,
                  ),
              },
            },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      <Box
        sx={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          "--temporary-nav-overlay-clearance": "0px",
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
