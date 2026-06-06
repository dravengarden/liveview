import { Box, CircularProgress } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import { useEffect, useState } from "react";
import { applyUpdate, useConnectionBanner } from "@/connectionStore";

// Seconds the update overlay counts down before reloading on its own.
const UPDATE_COUNTDOWN_SECS = 3;

// Floating overlay shown when a redeploy is detected. Unlike the status bar it
// never participates in layout — `position: fixed` keeps it on top of everything
// without pushing the page down, so it never disturbs whatever the user is
// reading/listening to. It counts 3→0 and then hard-reloads into the new build
// by itself; there's no button to click.
function UpdateOverlay(): React.JSX.Element {
  const [secs, setSecs] = useState(UPDATE_COUNTDOWN_SECS);
  useEffect(() => {
    if (secs < 0) {
      void applyUpdate();
      return;
    }
    const t = setTimeout(() => setSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secs]);
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        position: "fixed",
        left: 0,
        right: 0,
        // Clear the notch; floored so it still hangs off the top edge off-device.
        top: "calc(env(safe-area-inset-top, 0px) + 12px)",
        display: "flex",
        justifyContent: "center",
        // The overlay is purely informational — never eat taps meant for the UI
        // underneath it.
        pointerEvents: "none",
        zIndex: (t) => t.zIndex.tooltip + 1,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 0.875,
          borderRadius: 999,
          bgcolor: "info.main",
          color: "info.contrastText",
          fontSize: "0.8125rem",
          fontWeight: 500,
          boxShadow: 6,
        }}
      >
        <span>New version · reloading in {Math.max(0, secs)}s</span>
      </Box>
    </Box>
  );
}

// Full-width status bar tracking the live-reload WebSocket: red "down" on a
// sustained reconnect failure, green "reconnected" on recovery (auto-dismissed).
// Mounted at the very top of the layout so it spans the width and pushes content
// down when shown. The blue "update" state instead renders as a non-intrusive
// floating overlay (see UpdateOverlay) that reloads on its own.
export function ReconnectBanner(): React.JSX.Element | null {
  const banner = useConnectionBanner();
  if (!banner) return null;
  if (banner.kind === "update") return <UpdateOverlay />;

  const palette = banner.kind === "down" ? "error" : "success";
  const label = banner.kind === "down"
    ? "Connection lost — reconnecting…"
    : "Reconnected";

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        px: 2,
        py: 0.75,
        // Owns the notch when shown (it's the topmost element).
        pt: "calc(env(safe-area-inset-top, 0px) + 6px)",
        bgcolor: `${palette}.main`,
        color: `${palette}.contrastText`,
        fontSize: "0.8125rem",
        fontWeight: 500,
        zIndex: (t) => t.zIndex.appBar + 1,
      }}
    >
      {banner.kind === "down" && <CircularProgress size={14} color="inherit" thickness={5} />}
      {banner.kind === "reconnected" && <CheckIcon sx={{ fontSize: 18 }} />}
      <span>{label}</span>
    </Box>
  );
}
