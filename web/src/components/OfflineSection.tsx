import {
  Box,
  Button,
  Collapse,
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
  nativeAudioPin,
  nativeAudioPreload,
  nativeAudioSetCap,
  nativeAudioStats,
  nativeAudioUnpin,
} from "@/native-audio";
import { REMOTE } from "@/apiBase";
import type { Book } from "@/types";
import { useI18n } from "@/i18n";

function gb(bytes: number): string {
  const g = bytes / 1_073_741_824;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
}

interface AudioRes {
  url: string;
  hash: string;
  bytes: number;
}

const MAX_KEY = "lv.offline.maxGB";
const CAP_PRESETS = [2, 5, 10, 20, 50];
function maxGB(): number {
  return Number(globalThis.localStorage?.getItem(MAX_KEY) ?? "20") || 20;
}

/**
 * Offline-cache section (native shell only). Text downloads automatically (tiny,
 * 100%-able). Audio (compressed Opus, ~3.7GB total) is governed by a storage
 * budget: it preloads to fill the budget and can be pinned per-book; over budget,
 * the least-recently-used un-pinned audio is evicted (text never is).
 */
export function OfflineSection(): React.JSX.Element | null {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [audio, setAudio] = useState<AudioStats | null>(null);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [audioByBook, setAudioByBook] = useState<Map<string, AudioRes[]>>(new Map());
  const [auto, setAuto] = useState(offlineAuto());
  const [wifiOnly, setWifiOnly] = useState(offlineWifiOnly());
  const [cap, setCap] = useState(maxGB());
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [showSaved, setShowSaved] = useState(false);
  const [confirmCap, setConfirmCap] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof globalThis.setInterval> | undefined>(undefined);
  const preloadedRef = useRef(false);

  const tick = useCallback(async () => {
    let s: CacheStats | null = null;
    try {
      s = await nativeCacheStats();
      setStats(s);
    } catch {
      /* keep last-known */
    }
    setAudio(await nativeAudioStats());
    if (s && s.cached < s.total) void ensureAutoSync();
  }, []);

  useEffect(() => {
    if (!nativeSyncAvailable()) return undefined;
    nativeAudioSetCap(maxGB() * 1_073_741_824);
    void (async () => {
      try {
        const list = (await (await contentFetch("/api/books")).json()) as Book[];
        setLabels(new Map(list.map((b) => [b.slug, b.label])));
      } catch { /* cosmetic */ }
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
      } catch { /* per-book audio hidden offline */ }
    })();
    void tick();
    pollRef.current = globalThis.setInterval(() => void tick(), 2000);
    return () => {
      if (pollRef.current !== undefined) clearInterval(pollRef.current);
    };
  }, [tick]);

  const cachedSet = useMemo(() => new Set(audio?.cached ?? []), [audio]);

  // Auto-preload: once (per mount) fill the budget with all not-yet-cached audio
  // (evictable). Gated on auto-download + the WiFi-only pref. Fires a single
  // native call; native downloads in the background + stops at the cap.
  useEffect(() => {
    if (preloadedRef.current || !audio || audioByBook.size === 0) return;
    if (!auto) return;
    if (wifiOnly && stats != null && stats.net !== "wifi") return;
    const items: { url: string; hash: string }[] = [];
    for (const arr of audioByBook.values()) {
      for (const r of arr) {
        if (!cachedSet.has(r.hash)) items.push({ url: `${REMOTE}${r.url}`, hash: r.hash });
      }
    }
    if (items.length > 0) {
      preloadedRef.current = true;
      nativeAudioPreload(items);
    }
  }, [audio, audioByBook, auto, wifiOnly, stats, cachedSet]);

  if (!nativeSyncAvailable()) return null;

  const txtPct = stats && stats.tb > 0
    ? Math.min(100, Math.round((stats.cb / stats.tb) * 100))
    : 0;
  const audioUsed = audio?.usedBytes ?? 0;
  const textUsed = stats?.cb ?? 0;
  const used = audioUsed + textUsed; // total durable storage (audio dominates)
  const capBytes = cap * 1_073_741_824;
  const storagePct = Math.min(100, Math.round((used / capBytes) * 100));

  // Group books by audio download state.
  type Row = { slug: string; label: string; items: AudioRes[]; done: number; total: number; bytes: number };
  const rows: Row[] = [...audioByBook.entries()].map(([slug, items]) => ({
    slug,
    label: labels.get(slug) ?? slug,
    items,
    done: items.filter((r) => cachedSet.has(r.hash)).length,
    total: items.length,
    bytes: items.reduce((s, r) => s + r.bytes, 0),
  })).sort((a, b) => a.label.localeCompare(b.label));

  const saved = rows.filter((r) => r.total > 0 && r.done >= r.total);
  const active = rows.filter((r) => r.done < r.total && (downloading.has(r.slug) || r.done > 0));
  const available = rows.filter((r) => r.total > 0 && r.done === 0 && !downloading.has(r.slug));
  const savedBytes = saved.reduce((s, r) => s + r.bytes, 0);

  const applyCap = (newGB: number): void => {
    if (newGB * 1_073_741_824 < used) {
      setConfirmCap(newGB); // destructive — confirm first
      return;
    }
    setCap(newGB);
    globalThis.localStorage?.setItem(MAX_KEY, String(newGB));
    nativeAudioSetCap(newGB * 1_073_741_824);
  };

  const download = (r: Row): void => {
    setDownloading((s) => new Set(s).add(r.slug));
    nativeAudioPin(r.items.map((x) => ({ url: `${REMOTE}${x.url}`, hash: x.hash })));
  };
  const remove = (r: Row): void => {
    setDownloading((s) => {
      const n = new Set(s);
      n.delete(r.slug);
      return n;
    });
    nativeAudioUnpin(r.items.map((x) => x.hash));
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        {zh
          ? "文字自动下载(很小)。音频已压缩,会在存储上限内自动预加载;也可按书下载长期保留。"
          : "Text downloads automatically (tiny). Audio is compressed and preloads within your storage budget; you can also keep specific books."}
      </Typography>

      <Stack>
        <ToggleRow
          label={zh ? "自动下载" : "Auto-download"}
          hint={zh ? "文字 + 在上限内预加载音频" : "Text + preload audio within budget"}
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
              {zh ? "超出后自动淘汰最久未用的音频" : "Evicts least-recently-used audio over budget"}
            </Typography>
          </Box>
          <Select
            size="small"
            value={cap}
            onChange={(e) => applyCap(Number(e.target.value))}
            sx={{ minWidth: 90 }}
          >
            {CAP_PRESETS.map((g) => <MenuItem key={g} value={g}>{g} GB</MenuItem>)}
          </Select>
        </Stack>
      </Stack>

      {/* Storage budget bar */}
      <Box>
        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
          <Typography variant="body2">{zh ? "已用存储" : "Storage used"}</Typography>
          <Typography variant="body2" color="text.secondary">
            {gb(used)} / {cap} GB · {storagePct}%
          </Typography>
        </Stack>
        <LinearProgress
          variant="determinate"
          value={storagePct}
          sx={{ borderRadius: 1, height: 8, mt: 0.75 }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {zh ? "文字 " : "Text "}{txtPct}% · {gb(textUsed)}
          {audio && ` · ${zh ? "音频 " : "audio "}${gb(audioUsed)}`}
        </Typography>
      </Box>

      {/* Downloading (expanded) */}
      {active.length > 0 && (
        <Stack spacing={1}>
          <Typography variant="caption" color="text.secondary">
            {zh ? `下载中 (${active.length})` : `Downloading (${active.length})`}
          </Typography>
          {active.map((r) => {
            const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0;
            return (
              <Box key={r.slug}>
                <Stack direction="row" justifyContent="space-between" spacing={1}>
                  <Typography variant="caption" sx={ellipsis}>{r.label}</Typography>
                  <Typography variant="caption" color="primary" sx={{ flexShrink: 0 }}>{pct}%</Typography>
                </Stack>
                <LinearProgress variant="determinate" value={pct} sx={{ borderRadius: 1, height: 4, mt: 0.25 }} />
              </Box>
            );
          })}
        </Stack>
      )}

      {/* Downloaded (collapsed summary) */}
      {saved.length > 0 && (
        <Box>
          <Button
            onClick={() => setShowSaved((v) => !v)}
            sx={{ justifyContent: "space-between", textTransform: "none", px: 0, width: "100%" }}
          >
            <Typography variant="body2" color="success.main">
              🎧 {zh ? `已下载 ${saved.length} 本` : `${saved.length} saved`} · {gb(savedBytes)}
            </Typography>
            <Typography variant="caption" color="text.secondary">{showSaved ? "▲" : "▼"}</Typography>
          </Button>
          <Collapse in={showSaved}>
            <Stack spacing={0.5} sx={{ pt: 0.5 }}>
              {saved.map((r) => (
                <Stack key={r.slug} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                  <Typography variant="caption" sx={ellipsis}>{r.label}</Typography>
                  <Button size="small" color="inherit" onClick={() => remove(r)} sx={{ minWidth: 0, px: 1, py: 0, flexShrink: 0 }}>
                    {gb(r.bytes)} · {zh ? "移除" : "remove"}
                  </Button>
                </Stack>
              ))}
            </Stack>
          </Collapse>
        </Box>
      )}

      {/* Available */}
      {available.length > 0 && (
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            {zh ? `可下载 (${available.length})` : `Available (${available.length})`}
          </Typography>
          {available.map((r) => (
            <Stack key={r.slug} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Typography variant="caption" sx={ellipsis}>{r.label}</Typography>
              <Button size="small" onClick={() => download(r)} sx={{ minWidth: 0, px: 1, py: 0, flexShrink: 0 }}>
                🎧 {gb(r.bytes)}
              </Button>
            </Stack>
          ))}
        </Stack>
      )}

      <Dialog open={confirmCap != null} onClose={() => setConfirmCap(null)}>
        <DialogTitle>{zh ? "降低存储上限" : "Lower storage limit"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {zh
              ? `当前已用 ${gb(used)},超过新上限 ${confirmCap} GB。确认后会删除最久未用的音频直到符合上限(手动下载的书不删)。`
              : `${gb(used)} in use exceeds the new ${confirmCap} GB limit. Confirming evicts least-recently-used audio to fit (manually-downloaded books are kept).`}
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

const ellipsis = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
} as const;

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
