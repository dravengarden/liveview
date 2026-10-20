import { useEffect, useMemo, useState } from "react";
import { audioCacheAvailable, audioPreloader } from "@/audio/cache";
import { contentsAudio, contentsPreference, useContentsSnapshot } from "@/audio/contents";
import { audioPreloadOrder, audioPreloadStrategy, type AudioDownload, type AudioDownloadEnvironment } from "@/audio/preload";
import { type NowPlaying } from "@/audio/player";
import { nativeNetworkClass, offlineWifiOnly, onNativeNetworkClass } from "@/native-sync";
import { pwaAudioSupported, pwaDownloadsEnabled, pwaOfflineAvailable } from "@/pwa";
import { capBytesPref } from "@/replica/policy";
import { onPathIndexAdopted, pathRecordForHash } from "@/replica/manifest";
import type { TreeNode } from "@/types";

export function useBookAudioPreload(
  initial: TreeNode[], book: string | null, rendition: string, lang: string,
  path: string | null, nowPlaying: NowPlaying | null, playing: boolean,
): TreeNode[] {
  // Synthesis updates also feed the downloader while the contents drawer is shut.
  const tree = useContentsSnapshot(initial, book ?? undefined, rendition, true);
  const [preferenceRevision, setPreferenceRevision] = useState(0);
  useEffect(() => {
    const update = (): void => setPreferenceRevision(n => n + 1);
    globalThis.addEventListener("lv-voice-preference", update);
    return () => globalThis.removeEventListener("lv-voice-preference", update);
  }, []);
  const preference = useMemo(() => contentsPreference(book ?? undefined, rendition, lang),
    [book, rendition, lang, preferenceRevision]);
  const matching = nowPlaying?.bookSlug === book && nowPlaying?.rendition === rendition && nowPlaying?.lang === lang;
  const rows = useMemo(() => contentsAudio(tree, lang, preference,
    matching ? nowPlaying?.voice : undefined, matching ? nowPlaying?.chapterPath : undefined),
  [tree, lang, preference, matching, nowPlaying?.voice, nowPlaying?.chapterPath]);
  const focus = matching && playing ? nowPlaying!.chapterPath : path;
  // Synthesis polls may change unrelated voices/titles. Only a changed selected
  // identity should replace this effect and interrupt its bounded inspection.
  const plan = JSON.stringify({
    paths: [...rows.keys()],
    jobs: [...rows].flatMap(([path, { voice }]) =>
      voice.status === "ready" && voice.audio_hash && voice.marks_hash
        ? [{ path, hash: voice.audio_hash, marksHash: voice.marks_hash, bytes: voice.bytes ?? 0 }] : []),
  });
  useEffect(() => {
    if (!audioCacheAvailable()) return;
    const { paths, jobs: selected } = JSON.parse(plan) as { paths: string[]; jobs: AudioDownload[] };
    const configure = (): void => {
      const jobs = selected.map(job => ({ ...job, bytes: job.bytes || pathRecordForHash(job.hash)?.bytes || 0 }));
      const net = nativeNetworkClass();
      const browser = pwaOfflineAvailable();
      const blocked: AudioDownloadEnvironment["blocked"] =
        browser && (!pwaDownloadsEnabled() || !pwaAudioSupported()) ? "paused"
        : net === "none" ? "waiting-network"
        : offlineWifiOnly() && net !== "wifi" ? "waiting-wifi" : null;
      audioPreloader.configure(jobs, audioPreloadOrder(paths, focus, audioPreloadStrategy()), {
        blocked, capBytes: capBytesPref(),
      });
    };
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      clearTimeout(timer);
      if (disposed || document.hidden) return;
      void audioPreloader.tick().then(() => {
        if (disposed) return;
        const delay = audioPreloader.nextWakeDelay();
        if (delay !== null) timer = setTimeout(tick, delay);
      }).catch(() => { if (!disposed) timer = setTimeout(tick, 5000); });
    };
    const wake = (): void => { clearTimeout(timer); timer = setTimeout(tick, 200); };
    const policy = (): void => { configure(); tick(); };
    const foreground = (): void => {
      if (document.hidden) return;
      audioPreloader.invalidate();
      policy();
    };
    configure();
    tick();
    const unsubscribeNetwork = onNativeNetworkClass(policy);
    const unsubscribeIndex = onPathIndexAdopted(() => { audioPreloader.retry(); policy(); });
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    connection?.addEventListener("change", policy);
    document.addEventListener("visibilitychange", foreground);
    globalThis.addEventListener("lv-audio-cache-wake", wake);
    for (const event of ["lv-download-policy", "online", "offline"]) globalThis.addEventListener(event, policy);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribeNetwork();
      unsubscribeIndex();
      connection?.removeEventListener("change", policy);
      document.removeEventListener("visibilitychange", foreground);
      globalThis.removeEventListener("lv-audio-cache-wake", wake);
      for (const event of ["lv-download-policy", "online", "offline"]) globalThis.removeEventListener(event, policy);
      audioPreloader.pause();
    };
  }, [plan, focus]);
  return tree;
}
