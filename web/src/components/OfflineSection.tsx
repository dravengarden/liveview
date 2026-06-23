import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
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
  offlineWifiOnly,
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
  // (evictable). Auto-download is always on; only the WiFi-only gate applies.
  useEffect(() => {
    if (preloadedRef.current || !audio || audioRes.length === 0) return;
    if (wifiOnly && stats != null && stats.net !== "wifi") return;
    const items = audioRes
      .filter((r) => !cachedSet.has(r.hash))
      .map((r) => ({ url: `${REMOTE}${r.url}`, hash: r.hash }));
    if (items.length > 0) {
      preloadedRef.current = true;
      nativeAudioPreload(items);
    }
  }, [audio, audioRes, wifiOnly, stats, cachedSet]);

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
  const waitingWifi = wifiOnly && stats != null && stats.net !== "wifi";
  const downloading = !downloadComplete;

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
          label={zh ? "仅 WiFi 预加载" : "Prefetch on WiFi only"}
          hint={zh ? "蜂窝网络下不自动预加载" : "Don't auto-preload on cellular"}
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

      {/* Clean two-tone gauge: a soft tint shows the target (text+audio total),
          a solid fill shows what's downloaded, on a quiet track. No busy dots —
          a small spinner is the only motion, and only while actively downloading. */}
      <Box>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minWidth: 0 }}>
            {downloading && !waitingWifi && (
              <CircularProgress size={13} thickness={5} sx={{ color: "text.disabled" }} />
            )}
            <Typography variant="body2">
              {waitingWifi
                ? (zh ? "等待 WiFi" : "Waiting for WiFi")
                : downloadComplete
                ? (zh ? "已离线" : "Available offline")
                : downloading
                ? (zh ? "下载中" : "Downloading")
                : (zh ? "离线内容" : "Offline content")}
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {gb(used)} / {cap} GB
          </Typography>
        </Stack>
        <Box
          sx={{
            position: "relative",
            height: 6,
            mt: 1,
            borderRadius: 3,
            overflow: "hidden",
            bgcolor: "action.hover",
          }}
        >
          <Box sx={{
            position: "absolute",
            inset: 0,
            width: `${bufferPct}%`,
            bgcolor: "primary.main",
            opacity: 0.22,
            transition: "width .5s ease",
          }} />
          <Box sx={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: `${usedPct}%`,
            borderRadius: 3,
            bgcolor: downloadComplete ? "success.main" : waitingWifi ? "warning.main" : "primary.main",
            transition: "width .5s ease",
          }} />
        </Box>
        <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.75 }} spacing={1}>
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0 }}>
            {zh ? "文字 " : "Text "}{gb(textUsed)} · {zh ? "音频 " : "Audio "}
            {gb(audioDoneBytes)} / {gb(audioTotalBytes)} · {audioPct}%
          </Typography>
          {downloading && !waitingWifi && speed != null && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
            >
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
