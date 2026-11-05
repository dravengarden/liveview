// ConnectionBanner — the floating connection / version bar rendered from a
// `ConnectionStore` (see connection-store.ts for the policy).

import { Box, Button, CircularProgress } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import CloudOffIcon from "@mui/icons-material/CloudOffOutlined";
import { type ReactNode, useEffect, useState } from "react";
import type { BannerKind, ConnectionStore } from "./connection-store.ts";
import { type ShellLabels, useShellLabels } from "./shell-labels.tsx";
// Seconds the update bar counts down before reloading on its own.
const DEFAULT_UPDATE_COUNTDOWN_SECS = 3;

// MUI palette per banner kind: an outage is a calm WARNING (yellow), not an
// alarm — the app stays fully usable offline and retries are unbounded, so red
// would overstate it. Green recovery flash; blue (info) update.
function bannerPalette(kind: BannerKind): "warning" | "success" | "info" {
  if (kind === "down") {
    return "warning";
  }
  if (kind === "reconnected") {
    return "success";
  }
  return "info";
}

// Host-translated labels (English by default). The update line shows its live
// 3→0 countdown.
function bannerLabel(kind: BannerKind, secs: number, labels: ShellLabels): string {
  if (kind === "down") {
    return labels.connectionLost;
  }
  if (kind === "reconnected") {
    return labels.reconnected;
  }
  return labels.updateReloading(Math.max(0, secs));
}

export interface ConnectionBannerProps {
  readonly store: ConnectionStore;
  /** Seconds the update bar counts down before reloading. Default 3. */
  readonly countdownSecs?: number;
  /** A reader can defer updates until an explicit tap. */
  readonly updateLabel?: string;
  readonly updateFailedLabel?: string;
  /** With `updateLabel`, present the deferred update as a bottom pill offset
   *  by this CSS length (the app's bottom chrome) instead of the top bar, so
   *  the prompt stays reachable and never covers the top of the content. */
  readonly updateBottomOffset?: string;
}

// Full-width overlay bar tracking the app's socket + build version. All three
// states are the SAME bar — `position: fixed` keeps it on top of everything and
// out of the layout flow, so it never pushes content down or disturbs whatever
// the user is doing (`pointer-events: none` also lets taps fall through to the
// chrome it floats over):
//   - red "down"          — a sustained reconnect failure (spinner);
//   - green "reconnected"  — recovery, auto-dismissed (check);
//   - blue "update"        — a redeploy was detected; counts 3→0 and then clears
//                            caches + hard-reloads into the new build on its own.
export function ConnectionBanner(props: ConnectionBannerProps): ReactNode {
  const { store, countdownSecs = DEFAULT_UPDATE_COUNTDOWN_SECS } = props;
  const banner = store.useConnectionBanner();
  const labels = useShellLabels();
  const isUpdate = banner?.kind === "update";
  const [secs, setSecs] = useState(countdownSecs);
  const [updating, setUpdating] = useState(false);
  const [updateFailed, setUpdateFailed] = useState(false);

  // Drive the update countdown (and only it). Resets whenever we're not on the
  // update state so a later redeploy starts a fresh 3→0.
  useEffect(() => {
    if (!isUpdate || props.updateLabel) {
      setSecs(countdownSecs);
      return;
    }
    // 3 means three real seconds: show 3, 2, 1, then apply as the counter reaches
    // zero. Waiting for -1 made the nominal three-second countdown last four.
    if (secs <= 0) {
      void store.applyUpdate();
      return;
    }
    const t = setTimeout(() => setSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [isUpdate, secs, countdownSecs, store, props.updateLabel]);

  if (!banner) {
    return null;
  }

  const palette = bannerPalette(banner.kind);
  const label = bannerLabel(banner.kind, secs, labels);

  if (isUpdate && props.updateLabel && props.updateBottomOffset !== undefined) {
    const applyUpdate = (): void => {
      setUpdating(true);
      setUpdateFailed(false);
      void store.applyUpdate().catch(() => {
        setUpdateFailed(true);
        setUpdating(false);
      });
    };
    return (
      <Box
        role="status"
        aria-live="polite"
        sx={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: `max(calc(${props.updateBottomOffset} + 12px), calc(env(safe-area-inset-bottom, 0px) + 12px))`,
          display: "flex",
          justifyContent: "center",
          px: 2,
          // Only the pill takes taps; the strip around it stays transparent.
          pointerEvents: "none",
          zIndex: (t) => t.zIndex.tooltip + 1,
          // The open spatial drawer owns the bottom edge with its own controls.
          "html[data-lv-spatial-drawer-open] &": { display: "none" },
        }}
      >
        <Button
          variant="contained"
          disableElevation
          disabled={updating}
          onClick={applyUpdate}
          startIcon={updating
            ? <CircularProgress size={14} color="inherit" thickness={5} />
            : undefined}
          sx={{
            pointerEvents: "auto",
            minHeight: 40,
            px: 2,
            borderRadius: 999,
            textTransform: "none",
            fontWeight: 600,
            maxWidth: "100%",
          }}
        >
          {updateFailed
            ? props.updateFailedLabel ?? "Update failed. Try again."
            : props.updateLabel}
        </Button>
      </Box>
    );
  }

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
      {banner.kind === "down" && (store.offlineCapable
        ? <CloudOffIcon sx={{ fontSize: "1.125rem" }} />
        : <CircularProgress size={14} color="inherit" thickness={5} />)}
      {banner.kind === "reconnected" && <CheckIcon sx={{ fontSize: "1.125rem" }} />}
      {!(isUpdate && props.updateLabel) && <span>{label}</span>}
      {isUpdate && props.updateLabel && <Button color="inherit" size="small" disabled={updating} sx={{ pointerEvents: "auto" }} onClick={() => {
        setUpdating(true);
        setUpdateFailed(false);
        void store.applyUpdate().catch(() => {
          setUpdateFailed(true);
          setUpdating(false);
        });
      }}>{props.updateLabel}</Button>}
      {updateFailed && <span role="alert">{props.updateFailedLabel ?? "Update failed. Try again."}</span>}
    </Box>
  );
}
