import { Button, LinearProgress, Stack, Typography } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  nativeCacheStats,
  nativeSyncAll,
  nativeSyncAvailable,
} from "@/native-sync";
import { useI18n } from "@/i18n";

/** Stats tuple: [cachedCount, totalCount, cachedBytes, totalBytes]. */
type Stats = [number, number, number, number];

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Offline-cache section for the settings sheet — ONLY on the native shell (where
 * the lvsync plugin runs). Shows how much reader content (non-audio) is cached
 * for offline + a "download everything" action that eager-pulls the whole corpus
 * into the native store, with a live progress poll. This is the visible answer to
 * "did it sync?".
 */
export function OfflineSection(): React.JSX.Element | null {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const [stats, setStats] = useState<Stats | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof globalThis.setInterval> | undefined>(
    undefined,
  );

  const refresh = useCallback(async () => {
    try {
      setStats(await nativeCacheStats());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (nativeSyncAvailable()) void refresh();
    return () => {
      if (pollRef.current !== undefined) clearInterval(pollRef.current);
    };
  }, [refresh]);

  // Off the native shell there's nothing to cache here (the PWA uses the SW).
  if (!nativeSyncAvailable()) return null;

  const download = async (): Promise<void> => {
    setError(null);
    setSyncing(true);
    // Poll stats while sync_all runs (both IPC calls run concurrently), so the
    // numbers climb live and the user can SEE it working.
    pollRef.current = globalThis.setInterval(() => void refresh(), 1000);
    try {
      await nativeSyncAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (pollRef.current !== undefined) {
        clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
      await refresh();
      setSyncing(false);
    }
  };

  const [cached, total, cb, tb] = stats ?? [0, 0, 0, 0];
  const pct = total > 0 ? Math.round((cached / total) * 100) : 0;

  return (
    <Stack spacing={1}>
      <Typography variant="overline" color="text.secondary">
        {zh ? "离线缓存" : "Offline"}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {stats
          ? `${zh ? "已缓存" : "Cached"} ${cached}/${total} · ${mb(cb)} / ${
            mb(tb)
          } · ${pct}%`
          : (zh ? "读取中…" : "Loading…")}
      </Typography>
      <LinearProgress
        variant={syncing && pct === 0 ? "indeterminate" : "determinate"}
        value={pct}
        sx={{ borderRadius: 1, height: 6 }}
      />
      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
      <Button
        variant="outlined"
        size="small"
        onClick={() => void download()}
        disabled={syncing}
      >
        {syncing
          ? (zh ? "下载中…（可关闭设置）" : "Downloading…")
          : (zh ? "下载全部用于离线" : "Download all for offline")}
      </Button>
    </Stack>
  );
}
