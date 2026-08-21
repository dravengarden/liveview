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
  nativeNetworkClass,
  nativeSyncAvailable,
  offlineWifiOnly,
  onNativeNetworkClass,
  setOfflineWifiOnly,
} from "@/native-sync";
import {
  evictUnpinnedAudioToFit,
  loadPolicy,
  persistPolicy,
  replicaStats,
} from "@/replica/mod.ts";
import { useI18n } from "@/i18n";

function gb(bytes: number): string {
  const g = bytes / 1_073_741_824;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
}


const MAX_KEY = "lv.offline.maxGB";
// Cached audio-corpus total (bytes) — a tiny "index" so the gauge shows a real
// target instantly on open, before the live /api/dag total arrives.
const TOTAL_KEY = "lv.offline.audioTotalBytes";
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
  const { t } = useI18n();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [audio, setAudio] = useState<{
    usedBytes: number;
    cachedCount: number;
    net: "wifi" | "cell" | "none";
  } | null>(null);
  // Download TOTALS from the cheap server index (/api/sizes), keyed by deploy root
  // — replaces fetching + parsing the ~4 MB /api/dag here just to sum sizes.
  const [sizes, setSizes] = useState<
    { audioBytes: number; audioCount: number; textBytes: number } | null
  >(null);
  const [wifiOnly, setWifiOnly] = useState(offlineWifiOnly());
  const [cap, setCap] = useState(maxGB());
  const [confirmCap, setConfirmCap] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof globalThis.setInterval> | undefined>(undefined);
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
    try {
      const replica = await replicaStats();
      const netRaw = nativeNetworkClass();
      const net: "wifi" | "cell" | "none" =
        netRaw === "cell" || netRaw === "none" ? netRaw : "wifi";
      const a = {
        usedBytes: replica.audioBytes,
        cachedCount: replica.audioCached,
        net,
      };
      setAudio(a);
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
    } catch {
      /* keep last-known */
    }
    if (s && s.cached < s.total) void ensureAutoSync();
  }, []);

  useEffect(() => {
    if (!nativeSyncAvailable()) return undefined;
    const unsubNet = onNativeNetworkClass(() => {
      void tick();
    });
    void (async () => {
      try {
        // Cheap precomputed totals (tiny JSON), NOT the 4 MB dag. Network-first so
        // a deploy's new totals show; offline this throws and the gauge falls back
        // to the cached byte estimate + native count.
        const s = (await (await contentFetch("/api/sizes")).json()) as {
          audio_bytes: number;
          audio_count: number;
          text_bytes: number;
        };
        setSizes({
          audioBytes: s.audio_bytes ?? 0,
          audioCount: s.audio_count ?? 0,
          textBytes: s.text_bytes ?? 0,
        });
      } catch {
        /* offline → totals from native/local fallback only */
      }
    })();
    void tick();
    pollRef.current = globalThis.setInterval(() => void tick(), 2000);
    return () => {
      unsubNet();
      if (pollRef.current !== undefined) clearInterval(pollRef.current);
    };
  }, [tick]);

  // Audio corpus total (compressed estimate) from the server index, + a cached
  // fallback so the gauge isn't 0/0 before /api/sizes loads (offline).
  const audioTotalBytes = sizes?.audioBytes ?? 0;
  const cachedTotal = useMemo(
    () => Number(globalThis.localStorage?.getItem(TOTAL_KEY) ?? 0) || 0,
    [],
  );
  useEffect(() => {
    if (audioTotalBytes > 0) globalThis.localStorage?.setItem(TOTAL_KEY, String(audioTotalBytes));
  }, [audioTotalBytes]);
  // Done = the native O(1) cached count (SQLite aggregate); total = the server's
  // audio_count. No more diffing the full cached-key array against the manifest.
  const audioTotalCount = sizes?.audioCount ?? 0;
  // Clamp to the manifest total: the native O(1) count can transiently exceed it
  // when ORPHAN audio (chapters a later corpus sync removed/re-keyed) is still on
  // disk — that showed the nonsensical "3391/3388". The preload driver GCs those
  // orphans against the manifest, so this converges to the real count; the clamp
  // just guarantees the panel never displays more-cached-than-exists in the gap.
  const rawDoneCount = audio?.cachedCount ?? 0;
  const audioDoneCount = audioTotalCount > 0
    ? Math.min(rawDoneCount, audioTotalCount)
    : rawDoneCount;

  // NOTE: the auto-preload FEED loop now lives at app level
  // (useAudioPreloadDriver), so the download runs whenever the app is open — not
  // only while this panel is mounted. This component is display-only for the fill;
  // it just reflects native stats + the manifest.

  if (!nativeSyncAvailable()) return null;

  const audioUsed = audio?.usedBytes ?? 0;
  const textUsed = sizes?.textBytes
    ? Math.min(stats?.cb ?? 0, sizes.textBytes)
    : (stats?.cb ?? 0);
  const used = audioUsed + textUsed;
  const capBytes = cap * 1_073_741_824;
  // Preliminary total from the cached index (instant) → refined by the live dag.
  // Byte estimates (MP3×0.33) run a bit low vs the real Opus, so for the BAR's
  // target take max(estimate, actual-used) — never let the solid fill overrun the
  // tint, and never show >100%.
  const audioTotal = audioTotalBytes || cachedTotal;
  const target = Math.max((stats?.tb ?? 0) + audioTotal, used);
  const usedPct = capBytes > 0 ? Math.min(100, Math.round((used / capBytes) * 100)) : 0;
  const bufferPct = capBytes > 0
    ? Math.min(100, Math.round((Math.min(target, capBytes) / capBytes) * 100))
    : 0;
  // Progress + completion are COUNT-based (chapters cached / total) — exact, unlike
  // byte estimates which drift (so the old gauge showed a fake clamped 100% while
  // chapters were still downloading). Before the dag loads, fall back to a byte
  // estimate so it isn't 0.
  const haveTotals = audioTotalCount > 0;
  const audioPct = haveTotals
    ? Math.round((audioDoneCount / audioTotalCount) * 100)
    : (cachedTotal > 0 ? Math.min(99, Math.round((audioUsed / cachedTotal) * 100)) : 0);
  const downloadComplete = haveTotals && audioDoneCount >= audioTotalCount
    && (stats == null || stats.cached >= stats.total);
  // net lives with the AUDIO layer now (the WiFi-gated big download); the content
  // store (Rust) isn't net-aware.
  const waitingWifi = wifiOnly && audio != null && audio.net !== "wifi";
  // ACTIVELY transferring = real byte growth in the rolling window. `downloading`
  // used to mean merely "not 100% complete", so the panel said "Downloading · 0
  // KB/s" while idle — and when /api/sizes hadn't loaded, downloadComplete was
  // false forever, so a fully-downloaded library still read "Downloading 0%". Only
  // claim "Downloading" when bytes are actually moving; otherwise show a neutral
  // state and never a fake 0% / 0 KB/s.
  const active = !downloadComplete && !waitingWifi && speed != null && speed > 0;

  const applyCap = (newGB: number): void => {
    if (newGB * 1_073_741_824 < used) {
      setConfirmCap(newGB);
      return;
    }
    setCap(newGB);
    globalThis.localStorage?.setItem(MAX_KEY, String(newGB));
    const policy = loadPolicy();
    policy.capBytes = newGB * 1_073_741_824;
    void persistPolicy(policy).then(() => evictUnpinnedAudioToFit(policy.capBytes));
  };

  return (
    <Stack spacing={1.75}>
      <Typography variant="body2" color="text.secondary">
        {t("offline.description")}
      </Typography>

      <Stack>
        <ToggleRow
          label={t("offline.wifiOnly")}
          hint={t("offline.wifiOnlyHint")}
          checked={wifiOnly}
          onChange={(v) => {
            setWifiOnly(v);
            setOfflineWifiOnly(v);
          }}
        />
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 0.25 }}>
          <Box>
            <Typography variant="body2">{t("offline.maxStorage")}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t("offline.maxStorageHint")}
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
            {active && (
              <CircularProgress size={13} thickness={5} sx={{ color: "text.disabled" }} />
            )}
            <Typography variant="body2">
              {waitingWifi
                ? t("offline.waitingWifi")
                : downloadComplete
                ? t("offline.available")
                : active
                ? t("offline.downloading")
                : t("offline.content")}
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
            {t("offline.text")} {gb(textUsed)} · {t("offline.audio")} {" "}
            {gb(audioUsed)}
            {/* Chapter count + % ONLY when we have the real corpus total (/api/sizes).
                Without it a byte-estimate "0%" is just noise next to GBs of cached
                audio — show the bytes alone instead of a misleading percentage. */}
            {haveTotals
              && ` · ${audioDoneCount}/${audioTotalCount} ${t("offline.chapterAbbr")} · ${audioPct}%`}
          </Typography>
          {/* Speed only while bytes are actually moving — never "↓ 0 KB/s". */}
          {active && speed != null && speed > 0 && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
            >
              ↓ {speed >= 1_048_576
                ? `${(speed / 1_048_576).toFixed(1)} MB/s`
                : `${Math.max(1, Math.round(speed / 1024))} KB/s`}
            </Typography>
          )}
        </Stack>
      </Box>

      <Dialog open={confirmCap != null} onClose={() => setConfirmCap(null)}>
        <DialogTitle>{t("offline.lowerLimit")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("offline.lowerLimitBody", {
              used: gb(used),
              limit: confirmCap ?? 0,
            })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmCap(null)}>{t("audiobook.cancel")}</Button>
          <Button
            color="error"
            onClick={() => {
              const g = confirmCap!;
              setConfirmCap(null);
              setCap(g);
              globalThis.localStorage?.setItem(MAX_KEY, String(g));
              const policy = loadPolicy();
              policy.capBytes = g * 1_073_741_824;
              void persistPolicy(policy).then(() =>
                evictUnpinnedAudioToFit(policy.capBytes)
              );
            }}
          >
            {t("offline.confirmDelete")}
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
