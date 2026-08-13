import { Drawer } from "@mui/material";
import type { ReactNode } from "react";

import { DetentSheet } from "./detent-sheet.tsx";

export function MobileNavigation({
  presentation,
  bottom,
  open,
  onClose,
  children,
}: {
  readonly presentation: "sheet" | "sidebar";
  readonly bottom: boolean;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  if (presentation === "sidebar") {
    return null;
  }
  if (bottom) {
    return (
      <DetentSheet open={open} onClose={onClose} ariaLabel="Navigation" peekDetent={false}>
        {children}
      </DetentSheet>
    );
  }
  return (
    <Drawer
      anchor="top"
      open={open}
      onClose={onClose}
      ModalProps={{ keepMounted: true }}
      slotProps={{
        paper: {
          sx: {
            maxHeight: "85dvh",
            pt: "env(safe-area-inset-top, 0px)",
            display: "flex",
            flexDirection: "column",
          },
        },
      }}
    >
      {children}
    </Drawer>
  );
}
