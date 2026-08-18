import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import CloseIcon from "@mui/icons-material/Close";
import { Box, IconButton, Typography } from "@mui/material";
import type { ReactNode } from "react";

import { MobileSheetActionGroup } from "./bottom-sheet.tsx";

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
      {!spatial && (
        <Box
          sx={{
            minHeight: 52,
            px: 1,
            display: "grid",
            gridTemplateColumns: "minmax(88px, 1fr) auto minmax(88px, 1fr)",
            alignItems: "center",
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          {onBack && backLabel
            ? (
              <IconButton
                aria-label={backLabel}
                onClick={onBack}
                sx={{
                  justifySelf: "start",
                  width: 40,
                  height: 40,
                  color: "primary.main",
                  border: 1,
                  borderColor: "divider",
                  bgcolor: "action.hover",
                }}
              >
                <ChevronLeftIcon />
              </IconButton>
            )
            : <Box />}
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          <IconButton
            aria-label="Close navigation"
            onClick={onClose}
            sx={{ justifySelf: "end" }}
          >
            <CloseIcon />
          </IconButton>
        </Box>
      )}
      <Box
        sx={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          "--temporary-nav-overlay-clearance": spatial
            ? "calc(84px + env(safe-area-inset-bottom, 0px))"
            : "0px",
        }}
      >
        {children}
        {spatial && (
          <Box
            sx={{
              position: "absolute",
              zIndex: 3,
              left: 0,
              right: 0,
              bottom: "max(env(safe-area-inset-bottom, 0px), 12px)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              px: 2,
              pointerEvents: "none",
            }}
          >
            {onBack && backLabel && (
              <Box sx={{ width: 54, flex: "0 0 54px" }}>
                <MobileSheetActionGroup
                  actions={[{
                    key: "back",
                    label: backLabel,
                    onPress: onBack,
                    icon: <ChevronLeftIcon aria-hidden fontSize="small" />,
                  }]}
                />
              </Box>
            )}
            <Box sx={{ width: 54, flex: "0 0 54px" }}>
              <MobileSheetActionGroup
                actions={[{
                  key: "close",
                  label: "Close navigation",
                  onPress: onClose,
                  icon: <CloseIcon aria-hidden fontSize="small" />,
                }]}
              />
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}
