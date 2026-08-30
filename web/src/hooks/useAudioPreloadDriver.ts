import { useEffect } from "react";
import {
  ensureAutoSync,
  nativeAudioIndex,
  nativeCacheStats,
  nativeRefreshManifest,
  nativeSyncAvailable,
  offlineWifiOnly,
} from "@/native-sync";
import { setAllowsCellular } from "@/native-audio";
import { contentFetch } from "@/native-sync";
import { ingestDag } from "@/audioMediaIndex";
import {
  enqueueMissingAudio,
  evictUnpinnedAudioToFit,
  loadPolicy,
  persistPolicy,
} from "@/replica/mod.ts";

// Mirror of OfflineSection's storage budget key (the Settings → Downloads
// "Max storage" select writes it). Read live each tick so a change takes effect
// without a relaunch.
const MAX_KEY = "lv.offline.maxGB";
const AUDIO_INDEX_ROOT_KEY = "lv.audio.indexRoot";
function maxBytes(): number {
  const gb = Number(globalThis.localStorage?.getItem(MAX_KEY) ?? "20") || 20;
  return gb * 1_073_741_824;
}

/**
 * Drive the offline AUDIO preload from APP level, so the download runs whenever
 * the app is open — NOT only while the Settings → Downloads panel is mounted.
 *
 * TS owns pin/LRU/cap and the persisted worklist. Native only enqueues
 * `cacheFromUrl` (bounded 6-wide `.default` pool). Those sessions suspend when
 * the app backgrounds — that is the accepted ceiling; do not claim background
 * URLSession continuation.
 */
export function useAudioPreloadDriver(): void {
  useEffect(() => {
    if (!nativeSyncAvailable()) return undefined;
    let cancelled = false;
    const warmedManifests = new Set<string>();
    let refreshing = false;

    setAllowsCellular({ on: !offlineWifiOnly() });

    const refreshWorkingSet = async (): Promise<void> => {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        const root = await nativeRefreshManifest();
        const policy = loadPolicy();
        policy.capBytes = maxBytes();
        policy.wifiOnly = offlineWifiOnly();
        await persistPolicy(policy);
        setAllowsCellular({ on: !policy.wifiOnly });
        await enqueueMissingAudio();
        await evictUnpinnedAudioToFit(policy.capBytes);
        // Re-ingest the hydrated DAG index on every foreground. Older installs
        // already have hashes in localStorage but not the newer byte lengths;
        // waiting for a Merkle-root change would leave those entries unmigrated.
        const resources = await nativeAudioIndex();
        if (cancelled) return;
        ingestDag(resources);
        if (
          !root ||
          globalThis.localStorage?.getItem(AUDIO_INDEX_ROOT_KEY) === root
        ) {
          return;
        }
        globalThis.localStorage?.setItem(AUDIO_INDEX_ROOT_KEY, root);
        const slugs = [
          ...new Set(resources.map((r) => r.path.split("/")[0] ?? "")),
        ].filter((s) => s.length > 0 && !warmedManifests.has(s));
        for (const slug of slugs) {
          if (cancelled) break;
          warmedManifests.add(slug);
          await contentFetch(`/api/manifest/${encodeURIComponent(slug)}`)
            .catch(() => undefined);
        }
      } catch {
        /* offline / transient — retried on the next foreground */
      } finally {
        refreshing = false;
      }
    };

    void refreshWorkingSet();

    const ensureTextSync = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const cs = await nativeCacheStats();
        if (!cancelled && cs && cs.cached < cs.total) void ensureAutoSync();
      } catch {
        /* stats unavailable → skip this round */
      }
    };

    void ensureTextSync();

    const onVisible = (): void => {
      if (globalThis.document?.visibilityState === "visible") {
        void refreshWorkingSet().then(() => {
          if (!cancelled) void ensureTextSync();
        });
      }
    };
    globalThis.document?.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      globalThis.document?.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
