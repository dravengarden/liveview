import { useEffect } from "react";
import { REMOTE } from "@/apiBase";
import {
  ensureAutoSync,
  nativeCacheStats,
  nativeSyncAvailable,
  offlineWifiOnly,
} from "@/native-sync";
import { nativeAudioPreload, nativeAudioSetCap, nativeAudioStats } from "@/native-audio";
import { contentFetch } from "@/native-sync";

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
 * preference is on and the device is on cellular. Each round feeds the next chunk
 * of not-yet-cached chapters to the native scheduler (which dedups what's already
 * queued / in-flight / on-disk and adapts its own concurrency), so a stalled fill
 * self-heals on the next tick. Text is handled separately by ensureAutoSync.
 */
export function useAudioPreloadDriver(): void {
  useEffect(() => {
    if (!nativeSyncAvailable()) return undefined;
    let cancelled = false;
    let audioRes: { hash: string; url: string }[] = [];
    let timer: ReturnType<typeof globalThis.setInterval> | undefined;

    nativeAudioSetCap(maxBytes());

    // Manifest once per launch — FRESH (not the offline cache): a URL-scheme
    // change doesn't move the Merkle root, so a cached dag would keep us pulling
    // the wrong/old audio. Filter to the audio resources; their hashes are the
    // native cache keys we diff against `nativeAudioStats().cached`.
    void (async () => {
      try {
        const dag = (await (await fetch(`${REMOTE}/api/dag`)).json()) as {
          resources: { hash: string; kind: string; url: string; path: string }[];
        };
        if (cancelled) return;
        audioRes = dag.resources
          .filter((r) => r.kind === "audio")
          .map((r) => ({ hash: r.hash, url: r.url }));
        // Warm every book's /api/manifest into the cache (cache-first → cheap when
        // already cached). The native audio player keys its offline store by each
        // chapter's content HASH, which the web reads from this manifest (audioHash
        // → contentFetch). Without it cached, offline playback can't resolve the
        // hash → it looks under a URL key → the hash-keyed downloaded file isn't
        // found → no offline play. Warming all manifests makes EVERY downloaded
        // book playable offline, not only ones played online once.
        const slugs = [
          ...new Set(dag.resources.map((r) => r.path.split("/")[0] ?? "")),
        ].filter((s) => s.length > 0);
        for (const slug of slugs) {
          if (cancelled) break;
          await contentFetch(`/api/manifest/${encodeURIComponent(slug)}`)
            .catch(() => undefined);
        }
      } catch {
        /* offline → nothing to drive until a later launch */
      }
    })();

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
      if (cancelled || audioRes.length === 0) return;
      // Re-read the budget each round so a Settings change applies live.
      nativeAudioSetCap(maxBytes());
      // WiFi-only heuristic: don't auto-fill the bulk audio on cellular when the
      // pref is set. Unknown network → proceed (best effort).
      const a = await nativeAudioStats();
      if (cancelled || !a) return;
      // WiFi-only gate reads net from the AUDIO layer now (it owns the WiFi-gated
      // big download); the content store (nativeCacheStats) is Rust + not net-aware.
      if (offlineWifiOnly() && a.net !== "wifi") return;
      const cached = new Set(a.cached);
      const items = audioRes
        .filter((r) => !cached.has(r.hash))
        .slice(0, 300)
        .map((r) => ({ url: `${REMOTE}${r.url}`, hash: r.hash }));
      if (items.length > 0) nativeAudioPreload(items);
    };

    void pump();
    timer = globalThis.setInterval(() => void pump(), 3000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, []);
}
