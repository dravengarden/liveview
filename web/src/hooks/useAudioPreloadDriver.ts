import { useEffect } from "react";
import { REMOTE } from "@/apiBase";
import {
  ensureAutoSync,
  nativeAudioIndex,
  nativeCacheStats,
  nativeNetworkClass,
  nativeRefreshManifest,
  nativeSyncAvailable,
  offlineWifiOnly,
} from "@/native-sync";
import {
  nativeAudioPreload,
  nativeAudioSetCap,
  nativeAudioSetWifiOnly,
} from "@/native-audio";
import { contentFetch } from "@/native-sync";
import { ingestDag } from "@/audioMediaIndex";

// Mirror of OfflineSection's storage budget key (the Settings → Downloads
// "Max storage" select writes it). Read live each tick so a change takes effect
// without a relaunch.
const MAX_KEY = "lv.offline.maxGB";
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
 * Native shell only. Heuristically gated: it skips a round while the WiFi-only
 * preference is on and the device is on cellular. Each round feeds a rotating
 * chapter window to the native scheduler (which dedups what's already
 * queued / in-flight / on-disk and adapts its own concurrency), so a stalled fill
 * self-heals on the next tick. Text is handled separately by ensureAutoSync.
 */
export function useAudioPreloadDriver(): void {
  useEffect(() => {
    if (!nativeSyncAvailable()) return undefined;
    let cancelled = false;
    let audioRes: { hash: string; url: string }[] = [];
    let timer: ReturnType<typeof globalThis.setInterval> | undefined;
    // Per-session guard so each book's /api/manifest is warmed at most once.
    const warmedManifests = new Set<string>();
    // Reentrancy guard: refreshWorkingSet fires from mount, the pump (when the set
    // is empty) AND every foreground, so it must not overlap itself.
    let refreshing = false;
    let preloadCursor = 0;

    nativeAudioSetCap(maxBytes());
    // Seed the native downloader's WiFi-only policy at startup so its background
    // sessions carry the right allowsCellularAccess before the first task — the web
    // gate below can't reach transfers that continue while the app is suspended.
    nativeAudioSetWifiOnly(offlineWifiOnly());

    // (Re)build the audio working set from /api/dag. MUST be repeatable, NOT a
    // once-at-mount IIFE — the old code built `audioRes` exactly once at launch, so
    //  (a) a flaky/offline cold launch left it EMPTY for the whole session: every
    //      pump no-op'd and the audio fill was dead until an app relaunch; and
    //  (b) a frozen set never learned about audio BAKED server-side after launch,
    //      so a long session parked at whatever % was baked at launch time (the
    //      "stuck at 87%, 5.5/20GB, not WiFi-waiting" report — the server kept
    //      baking past 3591 but the client's set never grew to see it).
    // Re-run on foreground + whenever the set is empty so a recovered network and
    // newly-baked chapters both self-heal without a relaunch.
    const refreshWorkingSet = async (): Promise<void> => {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        // Refresh the native content manifest FIRST so newly-added corpus resources
        // are known before reading its compact audio/marks subset.
        await nativeRefreshManifest();
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
        // Reassigned ONLY after a successful fetch+parse, so a failed refresh keeps
        // the prior good set instead of clobbering it to [].
        audioRes = resources
          .filter((r) => r.kind === "audio")
          .map((r) => ({ hash: r.hash, url: r.url }));
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
        /* offline / transient — retried on the next foreground or empty-set pump */
      } finally {
        refreshing = false;
      }
    };

    void refreshWorkingSet();

    const pump = async (): Promise<void> => {
      if (cancelled) return;
      // TEXT sync, app-level + self-healing. The text/units/marks fill (the bytes
      // a book needs to OPEN + read offline) used to be kicked only once per books
      // load (App) and re-nudged only while the Downloads panel was open — so if
      // that one run failed / was starved by the audio fill / refused on a network
      // blip, text stayed at 0 and a book wouldn't open offline ("断网点 card 无法
      // 扩展"). Drive it here every tick: ensureAutoSync self-guards (WiFi-only +
      // concurrent-run guard), and nativeCacheStats Merkle-short-circuits, so once
      // text is complete this is a cheap no-op.
      try {
        const cs = await nativeCacheStats();
        if (!cancelled && cs && cs.cached < cs.total) void ensureAutoSync();
      } catch {
        /* stats unavailable → skip this round */
      }
      if (cancelled) return;
      if (audioRes.length === 0) {
        // Set not built yet (offline/flaky cold launch) — rebuild it so a recovered
        // network self-heals the fill without an app relaunch. `refreshing` guards
        // overlap; a still-offline retry is a cheap cached miss.
        void refreshWorkingSet();
        return;
      }
      // Re-read the budget each round so a Settings change applies live.
      nativeAudioSetCap(maxBytes());
      // WiFi-only gating uses the shared native NWPathMonitor push state. Never
      // poll audioStats here: it enumerates thousands of cache/index entries and
      // its recurring WKWebView bridge response caused visible scroll hitches.
      if (offlineWifiOnly() && nativeNetworkClass() !== "wifi") return;
      // NOTE: an orphan-GC (delete cached audio whose hash isn't in the manifest)
      // was REMOVED here. It was meant to tidy the "3391/3388" count, but it could
      // MASS-DELETE the user's downloaded audio: if the server's corpus re-keyed any
      // audio (new hashes), every on-disk blob reads as an "orphan" and gets wiped
      // before the (WiFi-gated, slow) re-download finishes — leaving offline playback
      // dead across whole books. The cosmetic count is already handled by the
      // Downloads panel's min(cached,total) clamp; deleting the user's 5GB to fix a
      // label is the wrong trade. Orphans (rare) just age out via the LRU cap.
      // Native owns dedup against queued, in-flight and on-disk resources. Feed a
      // rotating window so every resource is eventually offered without pulling
      // the full cached-hash index over the web/native bridge every three seconds.
      const windowSize = Math.min(1500, audioRes.length);
      const items = Array.from({ length: windowSize }, (_, offset) =>
        audioRes[(preloadCursor + offset) % audioRes.length])
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .map((r) => ({ url: `${REMOTE}${r.url}`, hash: r.hash }));
      preloadCursor = (preloadCursor + windowSize) % audioRes.length;
      if (items.length > 0) nativeAudioPreload(items);
    };

    void pump();
    timer = globalThis.setInterval(() => void pump(), 3000);

    // Rebuild the working set on EVERY foreground (not just cold launch): it
    // re-reads /api/dag (refreshing the manifest first), so audio baked server-side
    // since launch enters the fill and a warm-resumed device isn't frozen at its
    // launch-time %. Then pump downloads whatever's newly listed.
    const onVisible = (): void => {
      if (globalThis.document?.visibilityState === "visible") {
        void refreshWorkingSet().then(() => {
          if (!cancelled) void pump();
        });
      }
    };
    globalThis.document?.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
      globalThis.document?.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
