import { useSyncExternalStore } from "react";
import { probeCachedAudio, hostAudioAvailable } from "@/native-host";
import { contentFetch, nativeRefreshManifest, offlineWifiOnly } from "@/native-sync";
import { pwaOfflineAvailable } from "@/pwa";
import { getBlobRecord, hasBlob, putBlob, setPresent } from "@/replica/blobs";
import { enqueueFetch, removeFetch } from "@/replica/worklist";
import { enqueueCacheFromUrl, forgetCacheQueued, onCacheSettled } from "@/replica/media-bridge";
import { remoteUrl } from "@/apiBase";
import { AudioPreloader, type AudioCacheState, type AudioDownload } from "./preload";
import { readAgg } from "@/replica/agg";
import { pathRecordForHash } from "@/replica/manifest";

let snapshot: ReadonlyMap<string, AudioCacheState> = new Map();
const listeners = new Set<() => void>();
let notification: ReturnType<typeof setTimeout> | undefined;
function publish(): void {
  if (notification !== undefined) return;
  notification = setTimeout(() => {
    notification = undefined;
    if (snapshot.size === audioPreloader.states.size &&
      [...snapshot].every(([hash, state]) => audioPreloader.states.get(hash) === state)) return;
    snapshot = new Map(audioPreloader.states);
    for (const listener of listeners) listener();
  }, 200);
}

export function useAudioCache(): ReadonlyMap<string, AudioCacheState> {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => snapshot);
}

export function audioCacheAvailable(): boolean {
  return hostAudioAvailable() || pwaOfflineAvailable();
}

async function inspect(job: AudioDownload): Promise<{ ready: boolean; bytesToDownload: number }> {
  const marks = await hasBlob(job.marksHash);
  let audio = false;
  if (hostAudioAvailable()) {
    const present = await probeCachedAudio({ hash: job.hash });
    if (present === null) throw new Error("Audio cache probe unavailable");
    audio = present;
  } else if (pwaOfflineAvailable()) {
    const key = new URL(`/api/blob/${job.hash}`, location.origin).href;
    for (const name of ["lv-audio-blobs", "lv-blobs"]) {
      if (await (await caches.open(name)).match(key)) { audio = true; break; }
    }
  }
  await setPresent(job.hash, audio ? 1 : 0);
  return { ready: audio && marks, bytesToDownload: audio ? 0 : job.bytes > 0 ? job.bytes : -1 };
}

async function download(job: AudioDownload): Promise<void> {
  if (!pathRecordForHash(job.marksHash)) await nativeRefreshManifest();
  // The contents snapshot can precede the next DAG refresh after synthesis.
  if (!await getBlobRecord(job.hash)) {
    await putBlob({ hash: job.hash, bytes: job.bytes, kind: "audio", present: 0, pinned: 0, mtime: Date.now() });
  }
  const marks = await contentFetch(`/api/blob/${job.marksHash}`, { cacheFirst: true });
  if (!marks.ok || !await hasBlob(job.marksHash)) throw new Error("Timing is not cached yet");
  const url = remoteUrl(`/api/blob/${job.hash}`);
  const absolute = new URL(url, location.href).href;
  await enqueueFetch(job.hash, absolute);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const wifiOnly = offlineWifiOnly();
    const policyChanged = (): void => {
      // Installed native hosts rebuild their URLSession pool when this changes,
      // and intentionally omit completion events for the cancelled old pool.
      if (hostAudioAvailable() && wifiOnly !== offlineWifiOnly()) finish(false);
    };
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      stop();
      globalThis.removeEventListener("lv-download-policy", policyChanged);
      forgetCacheQueued(job.hash);
      if (ok) resolve(); else reject(new Error("Audio download interrupted"));
    };
    const stop = onCacheSettled((hash, ok) => {
      if (hash !== job.hash) return;
      finish(ok);
    });
    // Keep the slot until the host reports completion. Its request idle timeout
    // tolerates slow large chapters without starting extra native transfers.
    globalThis.addEventListener("lv-download-policy", policyChanged);
    forgetCacheQueued(job.hash);
    if (!enqueueCacheFromUrl(job.hash, absolute, job.bytes)) {
      finish(false);
    }
  });
  await removeFetch(job.hash);
}

export const audioPreloader = new AudioPreloader({
  inspect, download, usedBytes: async () => (await readAgg("audio")).cachedBytes,
  changed: publish, now: Date.now, yield: () => new Promise(resolve => setTimeout(resolve, 0)),
  wake: () => globalThis.dispatchEvent(new Event("lv-audio-cache-wake")),
});
onCacheSettled(hash => audioPreloader.invalidateHash(hash));
