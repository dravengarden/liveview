import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  nativeAudioPreload,
  nativeAudioSetCap,
  nativeAudioStats,
} from "@/native-audio";
import { REMOTE } from "@/apiBase";
import { useI18n } from "@/i18n";

function gb(bytes: number): string {
  const g = bytes / 1_073_741_824;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
}

interface AudioRes {
  hash: string;
  url: string;
  bytes: number;
}

const MAX_KEY = "lv.offline.maxGB";
const CAP_PRESETS = [2, 5, 10, 20, 30, 50];
function maxGB(): number {
  return Number(globalThis.localStorage?.getItem(MAX_KEY) ?? "20") || 20;
}

/**
 * Offline-cache section (native shell only). Deliberately MINIMAL: text downloads
 * automatically (tiny) and audio (compressed) preloads to fill the storage budget,
 * so there's nothing to micro-manage per book — just a storage gauge + one audio
 * progress line. Lowering the budget below current usage confirms before evicting.
 */
export function OfflineSection(): React.JSX.Element | null {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [audio, setAudio] = useState<AudioStats | null>(null);
  const [audioRes, setAudioRes] = useState<AudioRes[]>([]);
  const [auto, setAuto] = useState(offlineAuto());
  const [wifiOnly, setWifiOnly] = useState(offlineWifiOnly());
  const [cap, setCap] = useState(maxGB());
  const [confirmCap, setConfirmCap] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof globalThis.setInterval> | undefined>(undefined);
  const preloadedRef = useRef(false);
  // Rolling (t, audioUsedBytes) samples over the last ~10s → average download speed.
  const samplesRef = useRef<{ t: number; used: number }[]>([]);

  const tick = useCallback(async () => {
    let s: CacheStats | null = null;
    try {
      s = await nativeCacheStats();
      setStats(s);
    } catch {
      /* keep last-known */
    }
    const a = await nativeAudioStats();
    setAudio(a);
    // Average download speed over a ~10s window (audio is the bulk that grows;
    // text is static). The window itself smooths; we only report once we have a
    // ≥2s span so the very first sample doesn't show a wild number.
    if (a) {
      const now = Date.now();
      const arr = samplesRef.current;
      arr.push({ t: now, used: a.usedBytes });
      while (arr.length > 1 && now - (arr[0]?.t ?? now) > 10_000) arr.shift();
      const first = arr[0];
      if (first && arr.length >= 2 && now - first.t >= 2000) {
        const dB = a.usedBytes - first.used;
        const dT = (now - first.t) / 1000;
        setSpeed(dB > 0 ? dB / dT : 0);
      } else {
        setSpeed(null);
      }
    }
    if (s && s.cached < s.total) void ensureAutoSync();
  }, []);

  useEffect(() => {
    if (!nativeSyncAvailable()) return undefined;
    nativeAudioSetCap(maxGB() * 1_073_741_824);
    void (async () => {
      try {
        const dag = (await (await contentFetch("/api/dag")).json()) as {
          resources: { hash: string; kind: string; bytes: number; url: string }[];
        };
        setAudioRes(
          dag.resources
            .filter((r) => r.kind === "audio")
            .map((r) => ({ hash: r.hash, url: r.url, bytes: r.bytes ?? 0 })),
        );
      } catch {
        /* offline → audio totals from native only */
      }
    })();
    void tick();
    pollRef.current = globalThis.setInterval(() => void tick(), 2000);
    return () => {
      if (pollRef.current !== undefined) clearInterval(pollRef.current);
    };
  }, [tick]);

  const cachedSet = useMemo(() => new Set(audio?.cached ?? []), [audio]);

  // Audio totals from the manifest (compressed estimate) ∩ what's actually cached.
  const audioTotalBytes = useMemo(() => audioRes.reduce((s, r) => s + r.bytes, 0), [audioRes]);
  const audioDoneBytes = useMemo(
    () => audioRes.reduce((s, r) => (cachedSet.has(r.hash) ? s + r.bytes : s), 0),
    [audioRes, cachedSet],
  );
  const audioDoneCount = useMemo(
    () => audioRes.reduce((n, r) => (cachedSet.has(r.hash) ? n + 1 : n), 0),
    [audioRes, cachedSet],
  );

  // One-shot auto-preload: fill the budget with every not-yet-cached chapter
  // (evictable). Gated on auto + WiFi-only; native downloads in the background.
  useEffect(() => {
    if (preloadedRef.current || !audio || audioRes.length === 0 || !auto) return;
    if (wifiOnly && stats != null && stats.net !== "wifi") return;
    const items = audioRes
      .filter((r) => !cachedSet.has(r.hash))
      .map((r) => ({ url: `${REMOTE}${r.url}`, hash: r.hash }));
    if (items.length > 0) {
      preloadedRef.current = true;
      nativeAudioPreload(items);
    }
  }, [audio, audioRes, auto, wifiOnly, stats, cachedSet]);

  if (!nativeSyncAvailable()) return null;

  const audioUsed = audio?.usedBytes ?? 0;
  const textUsed = stats?.cb ?? 0;
  const used = audioUsed + textUsed;
  const capBytes = cap * 1_073_741_824;
  const target = (stats?.tb ?? 0) + audioTotalBytes; // bytes for "fully offline"
  const usedPct = capBytes > 0 ? Math.min(100, Math.round((used / capBytes) * 100)) : 0;
  const bufferPct = capBytes > 0
    ? Math.min(100, Math.round((Math.min(target, capBytes) / capBytes) * 100))
    : 0;
  const audioPct = audioTotalBytes > 0
    ? Math.min(100, Math.round((audioDoneBytes / audioTotalBytes) * 100))
    : 0;
  const downloadComplete = audioRes.length > 0 && audioDoneCount >= audioRes.length
    && (stats == null || stats.cached >= stats.total);
  const waitingWifi = auto && wifiOnly && stats != null && stats.net !== "wifi";
  const downloading = auto && !downloadComplete;

  const applyCap = (newGB: number): void => {
    if (newGB * 1_073_741_824 < used) {
      setConfirmCap(newGB);
      return;
    }
    setCap(newGB);
    globalThis.localStorage?.setItem(MAX_KEY, String(newGB));
    nativeAudioSetCap(newGB * 1_073_741_824);
  };

  return (
    <Stack spacing={1.75}>
      <Typography variant="body2" color="text.secondary">
        {zh
          ? "文字与音频(已压缩)会在存储上限内自动下载到本机,断网也能读和听。"
          : "Text and (compressed) audio download automatically within your storage budget for fully offline reading + listening."}
      </Typography>

      <Stack>
        <ToggleRow
          label={zh ? "自动下载" : "Auto-download"}
          hint={zh ? "在上限内自动缓存全部内容" : "Cache everything within the budget"}
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
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 0.25 }}>
          <Box>
            <Typography variant="body2">{zh ? "最大存储" : "Max storage"}</Typography>
            <Typography variant="caption" color="text.secondary">
              {zh ? "超出后淘汰最久未用的音频" : "Evicts least-recently-used audio over budget"}
            </Typography>
          </Box>
          <Select size="small" value={cap} onChange={(e) => applyCap(Number(e.target.value))} sx={{ minWidth: 90 }}>
            {CAP_PRESETS.map((g) => <MenuItem key={g} value={g}>{g} GB</MenuItem>)}
          </Select>
        </Stack>
      </Stack>

      {/* One merged bar: solid = downloaded, buffer (animated dots = active
          loading) = target (text+audio total), track = budget. */}
      <Box>
        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
          <Typography variant="body2">
            {waitingWifi
              ? (zh ? "等待 WiFi" : "Waiting for WiFi")
              : downloadComplete
              ? (zh ? "已全部下载" : "All downloaded")
              : downloading
              ? (zh ? "下载中…" : "Downloading…")
              : (zh ? "离线内容" : "Offline content")}
          </Typography>
          <Typography variant="body2" color="text.secondary">{gb(used)} / {cap} GB</Typography>
        </Stack>
        <LinearProgress
          variant={audio == null
            ? "indeterminate"
            : (downloading && !waitingWifi ? "buffer" : "determinate")}
          value={usedPct}
          valueBuffer={bufferPct}
          color={waitingWifi ? "warning" : downloadComplete ? "success" : "primary"}
          sx={{ borderRadius: 1, height: 8, mt: 0.75 }}
        />
        <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            {zh ? "文字 " : "Text "}{gb(textUsed)} · {zh ? "音频 " : "Audio "}
            {gb(audioDoneBytes)} / {gb(audioTotalBytes)} ({audioPct}%)
          </Typography>
          {downloading && !waitingWifi && speed != null && (
            <Typography variant="caption" color="primary">
              ↓ {speed >= 1_048_576
                ? `${(speed / 1_048_576).toFixed(1)} MB/s`
                : `${Math.max(0, Math.round(speed / 1024))} KB/s`}
            </Typography>
          )}
        </Stack>
      </Box>

      <Dialog open={confirmCap != null} onClose={() => setConfirmCap(null)}>
        <DialogTitle>{zh ? "降低存储上限" : "Lower storage limit"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {zh
              ? `当前已用 ${gb(used)},超过新上限 ${confirmCap} GB。确认后会删除最久未用的音频直到符合上限。`
              : `${gb(used)} in use exceeds the new ${confirmCap} GB limit. Confirming evicts least-recently-used audio to fit.`}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmCap(null)}>{zh ? "取消" : "Cancel"}</Button>
          <Button
            color="error"
            onClick={() => {
              const g = confirmCap!;
              setConfirmCap(null);
              setCap(g);
              globalThis.localStorage?.setItem(MAX_KEY, String(g));
              nativeAudioSetCap(g * 1_073_741_824);
            }}
          >
            {zh ? "确认删除" : "Confirm"}
          </Button>
        </DialogActions>
      </Dialog>
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
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 0.25 }}>
      <Box>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="caption" color="text.secondary">{hint}</Typography>
      </Box>
      <Switch checked={checked} onChange={(e) => onChange(e.target.checked)} size="small" />
    </Stack>
  );
}
