import {
  Box,
  Button,
  LinearProgress,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CacheStats,
  contentFetch,
  ensureAutoSync,
  nativeCacheStats,
  nativeSyncAvailable,
  offlineAuto,
  offlineWifiOnly,
  setOfflineAuto,
  setOfflineWifiOnly,
} from "@/native-sync";
import {
  type AudioStats,
  nativeAudioPin,
  nativeAudioStats,
  nativeAudioUnpin,
} from "@/native-audio";
import { REMOTE } from "@/apiBase";
import type { Book } from "@/types";
import { useI18n } from "@/i18n";

function mb(bytes: number): string {
  const gb = bytes / 1_073_741_824;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
}

/** One book's audio chapters from the manifest: blob url + content hash + size. */
interface AudioRes {
  url: string;
  hash: string;
  bytes: number;
}

/**
 * Offline-cache section (native shell only). TEXT downloads automatically (small,
 * 100%-able); AUDIO is large (multi-GB) so it's per-book opt-in — tap a book to
 * keep its audio offline (durable, eviction-exempt). Shows overall text progress,
 * the audio store usage, and per-book state.
 */
export function OfflineSection(): React.JSX.Element | null {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [audio, setAudio] = useState<AudioStats | null>(null);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [audioByBook, setAudioByBook] = useState<Map<string, AudioRes[]>>(
    new Map(),
  );
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
    setAudio(await nativeAudioStats());
    void ensureAutoSync();
  }, []);

  useEffect(() => {
    if (!nativeSyncAvailable()) return undefined;
    void (async () => {
      try {
        const list = (await (await contentFetch("/api/books")).json()) as Book[];
        setLabels(new Map(list.map((b) => [b.slug, b.label])));
      } catch {
        /* labels are cosmetic */
      }
      try {
        const dag = (await (await contentFetch("/api/dag")).json()) as {
          resources: { path: string; hash: string; kind: string; bytes: number; url: string }[];
        };
        const m = new Map<string, AudioRes[]>();
        for (const r of dag.resources) {
          if (r.kind !== "audio") continue;
          const slug = r.path.split("/")[0] ?? "?";
          const arr = m.get(slug) ?? [];
          arr.push({ url: r.url, hash: r.hash, bytes: r.bytes ?? 0 });
          m.set(slug, arr);
        }
        setAudioByBook(m);
      } catch {
        /* audio list unavailable offline → per-book audio actions hidden */
      }
    })();
    void tick();
    pollRef.current = globalThis.setInterval(() => void tick(), 2000);
    return () => {
      if (pollRef.current !== undefined) clearInterval(pollRef.current);
    };
  }, [tick]);

  if (!nativeSyncAvailable()) return null;

  const cached = stats?.cached ?? 0;
  const total = stats?.total ?? 0;
  const cb = stats?.cb ?? 0;
  const tb = stats?.tb ?? 0;
  const pct = tb > 0 ? Math.min(100, Math.round((cb / tb) * 100)) : 0;
  const waitingWifi = auto && wifiOnly && stats != null && stats.net !== "wifi";

  const cachedSet = new Set(audio?.cached ?? []);
  const pinnedSet = new Set(audio?.pinned ?? []);

  const books = (stats?.books ?? [])
    .map((b) => ({ ...b, label: labels.get(b.slug) ?? b.slug }))
    .sort((a, b) => {
      const ap = a.cached < a.total ? 0 : 1;
      const bp = b.cached < b.total ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.label.localeCompare(b.label);
    });

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        {zh
          ? "文字会自动下载到本机(很小);音频较大,按需点书下载,下载后离线可听。"
          : "Text downloads automatically (small). Audio is large — download per book to keep it offline."}
      </Typography>

      <Stack>
        <ToggleRow
          label={zh ? "自动下载文字" : "Auto-download text"}
          hint={zh ? "新内容自动缓存" : "Cache new content automatically"}
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

      {/* Text overall */}
      <Box>
        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
          <Typography variant="body2">
            {waitingWifi
              ? (zh ? "文字 · 等待 WiFi" : "Text · waiting for WiFi")
              : cached >= total && total > 0
              ? (zh ? "文字 · 已全部缓存" : "Text · all cached")
              : (zh ? "文字 · 下载中…" : "Text · downloading…")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {pct}%
          </Typography>
        </Stack>
        <LinearProgress
          variant={stats == null ? "indeterminate" : "determinate"}
          value={pct}
          color={waitingWifi ? "warning" : "primary"}
          sx={{ borderRadius: 1, height: 8, mt: 0.75 }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {mb(cb)} / {mb(tb)}
        </Typography>
      </Box>

      {/* Audio store overall */}
      {audio && (
        <Typography variant="caption" color="text.secondary">
          {zh ? "音频 · 已下载 " : "Audio · downloaded "}
          {mb(audio.pinnedBytes)}
          {zh ? " · 自动缓存 " : " · auto-cache "}
          {mb(audio.autoBytes)} / {mb(audio.cap)}
        </Typography>
      )}

      {/* Per-book */}
      {books.length > 0 && (
        <Stack spacing={1.25} sx={{ mt: 0.5 }}>
          {books.map((b) => {
            const bp = Math.min(
              100,
              b.tb > 0
                ? Math.round((b.cb / b.tb) * 100)
                : b.total > 0
                ? Math.round((b.cached / b.total) * 100)
                : 0,
            );
            const textFull = b.cached >= b.total;
            const av = audioByBook.get(b.slug) ?? [];
            const aTotal = av.length;
            const aDone = av.filter((r) => cachedSet.has(r.hash)).length;
            const aPinned = aTotal > 0 && av.every((r) => pinnedSet.has(r.hash));
            const aPct = aTotal > 0 ? Math.round((aDone / aTotal) * 100) : 0;
            const aBytes = av.reduce((s, r) => s + r.bytes, 0);

            return (
              <Box key={b.slug}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                  <Typography
                    variant="caption"
                    sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
                  >
                    {b.label}
                  </Typography>
                  {aTotal > 0 && (
                    <AudioAction
                      zh={zh}
                      pinned={aPinned}
                      done={aDone}
                      total={aTotal}
                      pct={aPct}
                      bytes={aBytes}
                      onDownload={() =>
                        nativeAudioPin(av.map((r) => ({ url: `${REMOTE}${r.url}`, hash: r.hash })))}
                      onRemove={() => nativeAudioUnpin(av.map((r) => r.hash))}
                    />
                  )}
                  <Typography
                    variant="caption"
                    color={textFull ? "success.main" : "text.secondary"}
                    sx={{ flexShrink: 0, width: 18, textAlign: "right" }}
                  >
                    {textFull ? "✓" : ""}
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={aPinned ? aPct : bp}
                  color={aPinned ? (aDone >= aTotal ? "success" : "primary") : textFull ? "success" : "primary"}
                  sx={{ borderRadius: 1, height: 4, mt: 0.25, opacity: textFull && !aPinned ? 0.5 : 1 }}
                />
              </Box>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

function AudioAction({
  zh,
  pinned,
  done,
  total,
  pct,
  bytes,
  onDownload,
  onRemove,
}: {
  zh: boolean;
  pinned: boolean;
  done: number;
  total: number;
  pct: number;
  bytes: number;
  onDownload: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  if (pinned && done >= total) {
    return (
      <Button size="small" color="success" onClick={onRemove} sx={{ minWidth: 0, px: 1, py: 0 }}>
        {zh ? "🎧 已下载" : "🎧 saved"}
      </Button>
    );
  }
  if (pinned) {
    return (
      <Typography variant="caption" color="primary" sx={{ flexShrink: 0 }}>
        {pct}%
      </Typography>
    );
  }
  return (
    <Button size="small" onClick={onDownload} sx={{ minWidth: 0, px: 1, py: 0 }}>
      {zh ? `🎧 ${mb(bytes)}` : `🎧 ${mb(bytes)}`}
    </Button>
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
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 0.25 }}>
      <Box>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      </Box>
      <Switch checked={checked} onChange={(e) => onChange(e.target.checked)} size="small" />
    </Stack>
  );
}
