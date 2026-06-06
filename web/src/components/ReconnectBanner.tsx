import { Box, Button, CircularProgress } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import { applyUpdate, useConnectionBanner } from "@/connectionStore";

// Full-width banner tracking the live-reload WebSocket + build version, driven
// by connectionStore. Three states: red "down" on a sustained reconnect failure,
// green "reconnected" on recovery (auto-dismissed), blue "update" when a redeploy
// is detected — the update banner is clickable and force-reloads into the new
// build. Mounted at the very top of the layout so it spans the width and pushes
// content down when shown.
export function ReconnectBanner(): React.JSX.Element | null {
  const banner = useConnectionBanner();
  if (!banner) return null;

  const isUpdate = banner.kind === "update";
  const palette = banner.kind === "down"
    ? "error"
    : banner.kind === "reconnected"
    ? "success"
    : "info";
  const label = banner.kind === "down"
    ? "Connection lost — reconnecting…"
    : banner.kind === "reconnected"
    ? "Reconnected"
    : "A new version is available";

  return (
    <Box
      role={isUpdate ? "button" : "status"}
      aria-live="polite"
      onClick={isUpdate ? () => void applyUpdate() : undefined}
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
        cursor: isUpdate ? "pointer" : "default",
        zIndex: (t) => t.zIndex.appBar + 1,
      }}
    >
      {banner.kind === "down" && <CircularProgress size={14} color="inherit" thickness={5} />}
      {banner.kind === "reconnected" && <CheckIcon sx={{ fontSize: 18 }} />}
      <span>{label}</span>
      {isUpdate && (
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          onClick={(e) => {
            // Stop the bubble so we don't double-fire with the bar's onClick.
            e.stopPropagation();
            void applyUpdate();
          }}
          sx={{ ml: 1, py: 0, minWidth: 0 }}
        >
          Reload
        </Button>
      )}
    </Box>
  );
}
