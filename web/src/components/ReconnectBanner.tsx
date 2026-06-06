import { Box, CircularProgress } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import { useEffect, useState } from "react";
import { applyUpdate, useConnectionBanner } from "@/connectionStore";

// Seconds the update bar counts down before reloading on its own.
const UPDATE_COUNTDOWN_SECS = 3;

// Full-width overlay bar tracking the live-reload WebSocket + build version.
// All three states are the SAME bar — `position: fixed` keeps it on top of
// everything and out of the layout flow, so it never pushes content down or
// disturbs whatever the user is reading/listening to (`pointer-events: none`
// also lets taps fall through to the chrome it floats over):
//   - red "down"          — a sustained reconnect failure (spinner);
//   - green "reconnected"  — recovery, auto-dismissed (check);
//   - blue "update"        — a redeploy was detected; counts 3→0 and then
//                            hard-reloads into the new build on its own.
export function ReconnectBanner(): React.JSX.Element | null {
  const banner = useConnectionBanner();
  const isUpdate = banner?.kind === "update";
  const [secs, setSecs] = useState(UPDATE_COUNTDOWN_SECS);

  // Drive the update countdown (and only it). Resets whenever we're not on the
  // update state so a later redeploy starts a fresh 3→0.
  useEffect(() => {
    if (!isUpdate) {
      setSecs(UPDATE_COUNTDOWN_SECS);
      return;
    }
    if (secs < 0) {
      void applyUpdate();
      return;
    }
    const t = setTimeout(() => setSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [isUpdate, secs]);

  if (!banner) return null;

  const palette = banner.kind === "down"
    ? "error"
    : banner.kind === "reconnected"
    ? "success"
    : "info";
  const label = banner.kind === "down"
    ? "Connection lost — reconnecting…"
    : banner.kind === "reconnected"
    ? "Reconnected"
    : `New version · reloading in ${Math.max(0, secs)}s`;

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
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
        // Purely informational — never eat taps meant for the UI underneath.
        pointerEvents: "none",
        zIndex: (t) => t.zIndex.tooltip + 1,
      }}
    >
      {banner.kind === "down" && <CircularProgress size={14} color="inherit" thickness={5} />}
      {banner.kind === "reconnected" && <CheckIcon sx={{ fontSize: 18 }} />}
      <span>{label}</span>
    </Box>
  );
}
