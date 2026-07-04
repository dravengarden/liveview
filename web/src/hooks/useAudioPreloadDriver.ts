import { useEffect } from "react";
import { REMOTE } from "@/apiBase";
import {
  ensureAutoSync,
  nativeCacheStats,
  nativeRefreshManifest,
  nativeSyncAvailable,
  offlineWifiOnly,
} from "@/native-sync";
import {
  nativeAudioPreload,
  nativeAudioSetCap,
  nativeAudioStats,
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
    // Per-session guard so each book's /api/manifest is warmed at most once.
    const warmedManifests = new Set<string>();
    // Reentrancy guard: refreshWorkingSet fires from mount, the pump (when the set
    // is empty) AND every foreground, so it must not overlap itself.
    let refreshing = false;

    nativeAudioSetCap(maxBytes());

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
        // (e.g. audio `spoken` transcripts) are known before we read the dag.
        await nativeRefreshManifest();
        // contentFetch: network-first when online (picks up newly-baked audio),
        // cache fallback offline + timed (a raw fetch of the ~4 MB dag hung offline).
        const dag = (await (await contentFetch("/api/dag")).json()) as {
          resources: { hash: string; kind: string; url: string; path: string }[];
        };
        if (cancelled) return;
        // PERSIST the per-chapter audio + marks hashes to the durable localStorage
        // index FIRST — the offline-playback fix. We're online here (the dag fetch
        // succeeded), which is exactly when audio gets downloaded, so this guarantees
        // "downloaded ⇒ hash available offline" without depending on the manifest
        // still being in the url-cache. (player reads this index before the manifest.)
        ingestDag(dag.resources);
        // Reassigned ONLY after a successful fetch+parse, so a failed refresh keeps
        // the prior good set instead of clobbering it to [].
        audioRes = dag.resources
          .filter((r) => r.kind === "audio")
          .map((r) => ({ hash: r.hash, url: r.url }));
        // Warm each book's /api/manifest into the cache ONCE per session (cache-first
        // → cheap). The native player keys its offline store by each chapter's content
        // HASH, read from this manifest; without it cached, offline playback can't
        // resolve the hash → no offline play. Warming makes EVERY downloaded book
        // playable offline, not only ones played online once.
        const slugs = [
          ...new Set(dag.resources.map((r) => r.path.split("/")[0] ?? "")),
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
      // WiFi-only heuristic: don't auto-fill the bulk audio on cellular when the
      // pref is set. Unknown network → proceed (best effort).
      const a = await nativeAudioStats();
      if (cancelled || !a) return;
      // WiFi-only gate reads net from the AUDIO layer now (it owns the WiFi-gated
      // big download); the content store (nativeCacheStats) is Rust + not net-aware.
      if (offlineWifiOnly() && a.net !== "wifi") return;
      const cached = new Set(a.cached);
      // NOTE: an orphan-GC (delete cached audio whose hash isn't in the manifest)
      // was REMOVED here. It was meant to tidy the "3391/3388" count, but it could
      // MASS-DELETE the user's downloaded audio: if the server's corpus re-keyed any
      // audio (new hashes), every on-disk blob reads as an "orphan" and gets wiped
      // before the (WiFi-gated, slow) re-download finishes — leaving offline playback
      // dead across whole books. The cosmetic count is already handled by the
      // Downloads panel's min(cached,total) clamp; deleting the user's 5GB to fix a
      // label is the wrong trade. Orphans (rare) just age out via the LRU cap.
      const items = audioRes
        .filter((r) => !cached.has(r.hash))
        .slice(0, 300)
        .map((r) => ({ url: `${REMOTE}${r.url}`, hash: r.hash }));
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
