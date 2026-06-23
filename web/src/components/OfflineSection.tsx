import {
  Box,
  LinearProgress,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CacheStats,
  ensureAutoSync,
  nativeCacheStats,
  nativeSyncAvailable,
  offlineAuto,
  offlineWifiOnly,
  setOfflineAuto,
  setOfflineWifiOnly,
} from "@/native-sync";
import { contentFetch } from "@/native-sync";
import type { Book } from "@/types";
import { useI18n } from "@/i18n";

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Offline-cache section for the settings sheet — ONLY on the native shell. Text
 * content downloads AUTOMATICALLY (default on); this panel is the visible status:
 * a WiFi-only toggle, used storage, the overall progress, and a per-book list
 * (what's pending vs done). Audio is cached separately by the player.
 */
export function OfflineSection(): React.JSX.Element | null {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [auto, setAuto] = useState(offlineAuto());
  const [wifiOnly, setWifiOnly] = useState(offlineWifiOnly());
  const pollRef = useRef<ReturnType<typeof globalThis.setInterval> | undefined>(
    undefined,
  );

  const tick = useCallback(async () => {
    try {
      setStats(await nativeCacheStats());
    } catch {
      /* keep last-known */
    }
    // Re-fire on every tick: the native side busy-guards a running sync and
    // refuses politely off-WiFi, so this both starts the download and auto-
    // resumes it the moment WiFi returns — no user action needed.
    void ensureAutoSync();
  }, []);

  useEffect(() => {
    if (!nativeSyncAvailable()) return undefined;
    // Book labels for the per-book list (offline-safe via contentFetch).
    void (async () => {
      try {
        const list = (await (await contentFetch("/api/books")).json()) as Book[];
        setLabels(new Map(list.map((b) => [b.slug, b.label])));
      } catch {
        /* labels are cosmetic; fall back to slug */
      }
    })();
    void tick();
    pollRef.current = globalThis.setInterval(() => void tick(), 1500);
    return () => {
      if (pollRef.current !== undefined) clearInterval(pollRef.current);
    };
  }, [tick]);

  // Off the native shell there's nothing to cache here (the PWA uses the SW).
  if (!nativeSyncAvailable()) return null;

  const cached = stats?.cached ?? 0;
  const total = stats?.total ?? 0;
  const cb = stats?.cb ?? 0;
  const tb = stats?.tb ?? 0;
  const pct = tb > 0 ? Math.round((cb / tb) * 100) : 0;
  const waitingWifi = auto && wifiOnly && stats != null && stats.net !== "wifi";

  const books = (stats?.books ?? [])
    .map((b) => ({ ...b, label: labels.get(b.slug) ?? b.slug }))
    .sort((a, b) => {
      const ap = a.cached < a.total ? 0 : 1;
      const bp = b.cached < b.total ? 0 : 1;
      if (ap !== bp) return ap - bp; // pending first
      return a.label.localeCompare(b.label);
    });
  const pending = books.filter((b) => b.cached < b.total).length;

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        {zh
          ? "文字内容会自动下载到本机,断网也能读。音频由播放器单独缓存。"
          : "Text content downloads to this device automatically for offline reading. Audio is cached separately by the player."}
      </Typography>

      {/* Preferences */}
      <Stack>
        <ToggleRow
          label={zh ? "自动下载" : "Auto-download"}
          hint={zh
            ? "新内容自动缓存到本机"
            : "Cache new content automatically"}
          checked={auto}
          onChange={(v) => {
            setAuto(v);
            setOfflineAuto(v);
          }}
        />
        <ToggleRow
          label={zh ? "仅 WiFi 下载" : "WiFi only"}
          hint={zh ? "避免使用蜂窝数据" : "Avoid using cellular data"}
          checked={wifiOnly}
          onChange={(v) => {
            setWifiOnly(v);
            setOfflineWifiOnly(v);
          }}
        />
      </Stack>

      {/* Overall status */}
      <Box>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="baseline"
        >
          <Typography variant="body2">
            {waitingWifi
              ? (zh ? "已暂停 · 等待 WiFi" : "Paused · waiting for WiFi")
              : auto && cached < total
              ? (zh ? "下载中…" : "Downloading…")
              : cached >= total && total > 0
              ? (zh ? "已全部缓存" : "All cached")
              : (zh ? "离线缓存" : "Offline cache")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {cached}/{total} · {pct}%
          </Typography>
        </Stack>
        <LinearProgress
          variant={stats == null ? "indeterminate" : "determinate"}
          value={pct}
          color={waitingWifi ? "warning" : "primary"}
          sx={{ borderRadius: 1, height: 8, mt: 0.75 }}
        />
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mt: 0.5, display: "block" }}
        >
          {zh ? "已用空间" : "Used"} {mb(cb)} / {mb(tb)}
          {pending > 0 && ` · ${zh ? "待下载" : "pending"} ${pending} ${
            zh ? "本" : ""
          }`}
        </Typography>
      </Box>

      {/* Per-book list */}
      {books.length > 0 && (
        <Stack spacing={1.25} sx={{ mt: 0.5 }}>
          {books.map((b) => {
            const bp = b.tb > 0
              ? Math.round((b.cb / b.tb) * 100)
              : b.total > 0
              ? Math.round((b.cached / b.total) * 100)
              : 0;
            const full = b.cached >= b.total;
            return (
              <Box key={b.slug}>
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="baseline"
                  spacing={1}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {b.label}
                  </Typography>
                  <Typography
                    variant="caption"
                    color={full ? "success.main" : "text.secondary"}
                    sx={{ flexShrink: 0 }}
                  >
                    {full ? "✓" : `${b.cached}/${b.total}`}
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={bp}
                  color={full ? "success" : "primary"}
                  sx={{ borderRadius: 1, height: 4, mt: 0.25, opacity: full ? 0.5 : 1 }}
                />
              </Box>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="center"
      sx={{ py: 0.25 }}
    >
      <Box>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      </Box>
      <Switch
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        size="small"
      />
    </Stack>
  );
}
