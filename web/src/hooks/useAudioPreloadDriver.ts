import { useEffect } from "react";
import { REMOTE } from "@/apiBase";
import {
  ensureAutoSync,
  nativeAudioIndex,
  nativeCacheStats,
  nativeRefreshManifest,
  nativeSyncAvailable,
  offlineWifiOnly,
} from "@/native-sync";
import {
  nativeAudioReconcile,
  nativeAudioSetCap,
  nativeAudioSetWifiOnly,
} from "@/native-audio";
import { contentFetch } from "@/native-sync";
import { ingestDag } from "@/audioMediaIndex";

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
 * The feed loop used to live inside <OfflineSection>, which only mounts when that
 * panel is open, so closing it silently stopped the fill ("下载应该打开 app 就
 * 自动运行"). This hook is mounted once at the app root instead.
 *
 * Native shell only. The web expresses policy and lifecycle events; Swift reads
 * lv-sync's durable Merkle manifest and owns the download queue. There is no
 * recurring bridge work on the reader's scroll path.
 */
export function useAudioPreloadDriver(): void {
  useEffect(() => {
    if (!nativeSyncAvailable()) return undefined;
    let cancelled = false;
    // Per-session guard so each book's /api/manifest is warmed at most once.
    const warmedManifests = new Set<string>();
    // Reentrancy guard: refreshWorkingSet runs at mount and on every foreground.
    let refreshing = false;

    nativeAudioSetCap(maxBytes());
    // Seed the native downloader's WiFi-only policy at startup so its background
    // sessions carry the right allowsCellularAccess before the first task — the web
    // gate below can't reach transfers that continue while the app is suspended.
    nativeAudioSetWifiOnly(offlineWifiOnly());

    // Refresh on mount and foreground so a recovered network or changed Merkle
    // root self-heals without a relaunch. Swift reconciles the durable plan even
    // when the root is unchanged; the web index is rebuilt only for a new root.
    const refreshWorkingSet = async (): Promise<void> => {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        // Refresh the native content manifest FIRST so newly-added corpus resources
        // are known before reading its compact audio/marks subset.
        const root = await nativeRefreshManifest();
        if (root) nativeAudioReconcile(root, REMOTE);
        if (!root || globalThis.localStorage?.getItem(AUDIO_INDEX_ROOT_KEY) === root) {
          return;
        }
        // Read from the plugin's in-memory manifest. The previous path fetched the
        // whole /api/dag over the network a second time after refresh.
        const resources = await nativeAudioIndex();
        if (cancelled) return;
        // PERSIST the per-chapter audio + marks hashes to the durable localStorage
        // index FIRST — the offline-playback fix. We're online here (the dag fetch
        // succeeded), which is exactly when audio gets downloaded, so this guarantees
        // "downloaded ⇒ hash available offline" without depending on the manifest
        // still being in the url-cache. (player reads this index before the manifest.)
        ingestDag(resources);
        globalThis.localStorage?.setItem(AUDIO_INDEX_ROOT_KEY, root);
        // Warm each book's /api/manifest into the cache ONCE per session (cache-first
        // → cheap). The native player keys its offline store by each chapter's content
        // HASH, read from this manifest; without it cached, offline playback can't
        // resolve the hash → no offline play. Warming makes EVERY downloaded book
        // playable offline, not only ones played online once.
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
      // TEXT sync, app-level + self-healing. The text/units/marks fill (the bytes
      // a book needs to OPEN + read offline) used to be kicked only once per books
      // load (App) and re-nudged only while the Downloads panel was open — so if
      // that one run failed / was starved by the audio fill / refused on a network
      // blip, text stayed at 0 and a book wouldn't open offline ("断网点 card 无法
      // 扩展"). Re-check at mount/foreground; ensureAutoSync self-guards and the
      // native cache stats make a complete store a cheap no-op.
      try {
        const cs = await nativeCacheStats();
        if (!cancelled && cs && cs.cached < cs.total) void ensureAutoSync();
      } catch {
        /* stats unavailable → skip this round */
      }
      if (cancelled) return;
    };

    void ensureTextSync();

    // Rebuild the working set on EVERY foreground (not just cold launch): it
    // re-reads /api/dag (refreshing the manifest first), so audio baked server-side
    // since launch enters the fill and a warm-resumed device isn't frozen at its
    // launch-time %. Native reconciliation downloads whatever is newly listed.
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
