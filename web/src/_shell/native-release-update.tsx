import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { useEffect, useMemo, useState } from "react";

export type NativeReleaseChannelKind = "sidestore" | "app_store";

export interface NativeReleaseChannel {
  readonly kind: NativeReleaseChannelKind;
  readonly url: string;
  readonly label?: string;
}

export interface NativeReleaseManifest {
  readonly schema_version: 1;
  readonly app_id: string;
  readonly latest_version: string;
  readonly minimum_version?: string;
  readonly release_notes?: string;
  readonly preferred_channel?: NativeReleaseChannelKind;
  readonly channels: readonly NativeReleaseChannel[];
}

export interface NativeReleaseUpdatePromptProps {
  readonly appId: string;
  readonly manifestUrl: string;
  readonly getCurrentVersion?: () => Promise<string | null>;
  readonly openUrl?: (url: string) => Promise<void>;
}

type TauriGlobal = {
  app?: { getVersion?: () => Promise<string> };
  opener?: { openUrl?: (url: string) => Promise<void> };
  core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

const UPDATE_PROTOCOLS = new Set(["https:", "sidestore:", "itms-apps:"]);

function tauri(): TauriGlobal | undefined {
  return (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
}

export async function getNativeAppVersion(): Promise<string | null> {
  const api = tauri();
  if (api?.app?.getVersion) {
    try {
      return await api.app.getVersion();
    } catch {
      return null;
    }
  }
  if (api?.core?.invoke) {
    try {
      const version = await api.core.invoke("plugin:app|version");
      return typeof version === "string" ? version : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function openNativeReleaseUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (!UPDATE_PROTOCOLS.has(parsed.protocol)) throw new Error("Unsupported update URL");
  const api = tauri();
  if (api?.opener?.openUrl) {
    try {
      await api.opener.openUrl(parsed.href);
      return;
    } catch {
      // Tauri's default opener scope intentionally allows only web, mail, and
      // telephone URLs. Store-specific schemes still belong to the OS, so let
      // the WebView hand those schemes to iOS below.
    }
  }
  if (api?.core?.invoke) {
    try {
      await api.core.invoke("plugin:opener|open_url", { url: parsed.href });
      return;
    } catch {
      // Fall through to native URL dispatch for store-specific schemes.
    }
  }
  globalThis.location.href = parsed.href;
}

function versionParts(value: string): { core: number[]; prerelease: string[] } | null {
  const match = value.trim().replace(/^v/, "").match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: match[1]!.split(".").map(Number),
    prerelease: match[2]?.split(".") ?? [],
  };
}

export function compareNativeVersions(left: string, right: string): number | null {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  const width = Math.max(a.core.length, b.core.length);
  for (let index = 0; index < width; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const preWidth = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < preWidth; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Math.sign(Number(av) - Number(bv));
    if (an !== bn) return an ? -1 : 1;
    return av.localeCompare(bv) < 0 ? -1 : 1;
  }
  return 0;
}

function validManifest(value: unknown, appId: string): value is NativeReleaseManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<NativeReleaseManifest>;
  return manifest.schema_version === 1 && manifest.app_id === appId &&
    typeof manifest.latest_version === "string" && Array.isArray(manifest.channels) &&
    manifest.channels.every((channel) =>
      !!channel && typeof channel === "object" &&
      (channel.kind === "sidestore" || channel.kind === "app_store") &&
      typeof channel.url === "string"
    );
}

function channelLabel(channel: NativeReleaseChannel): string {
  return channel.label ?? (channel.kind === "sidestore" ? "Open SideStore" : "View in App Store");
}

export function NativeReleaseUpdatePrompt({
  appId,
  manifestUrl,
  getCurrentVersion = getNativeAppVersion,
  openUrl = openNativeReleaseUrl,
}: NativeReleaseUpdatePromptProps): React.JSX.Element | null {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [manifest, setManifest] = useState<NativeReleaseManifest | null>(null);
  const [openError, setOpenError] = useState(false);

  useEffect(() => {
    let active = true;
    const check = async (): Promise<void> => {
      const current = await getCurrentVersion();
      if (!current || !active) return;
      try {
        const response = await globalThis.fetch(manifestUrl, { cache: "no-store" });
        if (!response.ok) return;
        const candidate: unknown = await response.json();
        if (!active || !validManifest(candidate, appId)) return;
        const comparison = compareNativeVersions(current, candidate.latest_version);
        if (comparison === null || comparison >= 0) return;
        const mandatory = candidate.minimum_version !== undefined &&
          compareNativeVersions(current, candidate.minimum_version) === -1;
        const dismissed = globalThis.localStorage?.getItem(`native-release-dismissed:${appId}`);
        if (!mandatory && dismissed === candidate.latest_version) return;
        setCurrentVersion(current);
        setManifest(candidate);
      } catch {
        // Update discovery must never block launch or the working offline shell.
      }
    };
    void check();
    const onVisible = (): void => {
      if (globalThis.document?.visibilityState === "visible") void check();
    };
    globalThis.document?.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      globalThis.document?.removeEventListener("visibilitychange", onVisible);
    };
  }, [appId, getCurrentVersion, manifestUrl]);

  const mandatory = useMemo(() => {
    if (!manifest?.minimum_version || !currentVersion) return false;
    return compareNativeVersions(currentVersion, manifest.minimum_version) === -1;
  }, [currentVersion, manifest]);
  const channel = useMemo(() => {
    if (!manifest) return null;
    return manifest.channels.find((item) => item.kind === manifest.preferred_channel) ?? manifest.channels[0] ?? null;
  }, [manifest]);

  if (!manifest || !currentVersion || !channel) return null;

  const dismiss = (): void => {
    if (mandatory) return;
    globalThis.localStorage?.setItem(`native-release-dismissed:${appId}`, manifest.latest_version);
    setManifest(null);
  };

  return (
    <Dialog
      open
      fullWidth
      maxWidth="xs"
      disableEscapeKeyDown={mandatory}
      onClose={(_event, reason) => {
        if (mandatory || reason === "backdropClick") return;
        dismiss();
      }}
    >
      <DialogTitle>A new version is available</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip size="small" label={currentVersion} variant="outlined" />
            <Typography color="text.secondary">→</Typography>
            <Chip size="small" color="primary" label={manifest.latest_version} />
          </Stack>
          {mandatory && <Alert severity="warning">This update is required to keep using the native app safely.</Alert>}
          {manifest.release_notes && (
            <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "pre-wrap" }}>
              {manifest.release_notes}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            The store will open so you can review and install the update manually.
          </Typography>
          {openError && <Alert severity="error">Could not open the update destination. Please open the store manually.</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {!mandatory && <Button onClick={dismiss}>Later</Button>}
        <Button
          variant="contained"
          endIcon={<OpenInNewIcon />}
          onClick={() => {
            setOpenError(false);
            void openUrl(channel.url).catch(() => setOpenError(true));
          }}
        >
          {channelLabel(channel)}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
