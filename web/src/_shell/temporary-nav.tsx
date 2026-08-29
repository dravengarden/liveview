import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import CloseIcon from "@mui/icons-material/Close";
import { alpha, Box, Button, IconButton, Typography } from "@mui/material";
import type { ReactNode } from "react";

export function TemporaryNav(
  { title, backLabel, onBack, onClose, spatial, children }: {
    readonly title?: string | undefined;
    readonly backLabel?: string | undefined;
    readonly onBack?: (() => void) | undefined;
    readonly onClose: () => void;
    readonly spatial: boolean;
    readonly children: ReactNode;
  },
): ReactNode {
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
          minHeight: spatial ? 58 : 52,
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
