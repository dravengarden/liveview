// Platform data layer — the SINGLE import surface for everything the SPA reads,
// so app code never reaches into native-sync / native-audio / apiBase directly.
// Two implementations sit behind it, chosen by the build target (see target.ts):
//   • app  — native (Tauri lvsync plugin / Swift bridges + native AVPlayer audio)
//   • pwa  — web (fetch + service worker)
//
// A1 step: establish the seam by RE-EXPORTING the existing modules through here
// (behavior-preserving). A2/A3 move call sites onto `@/platform` and branch the
// two implementations on IS_APP/IS_PWA so each build tree-shakes the other out.

export { IS_APP, IS_PWA, TARGET, type Target } from "./target";

// Content + origin (native lvSync / fetch + SW under the hood).
export { BUNDLED, installApiShim, REMOTE, remoteUrl } from "@/apiBase";
export {
  type CacheStats,
  contentFetch,
  ensureAutoSync,
  nativeCacheStats,
  nativeSyncAll,
  nativeSyncAvailable,
  offlineWifiOnly,
  setOfflineWifiOnly,
} from "@/native-sync";

// Audio store + native player bridge.
export {
  type AudioStats,
  nativeAudioAvailable,
  nativeAudioLoad,
  nativeAudioPause,
  nativeAudioPin,
  nativeAudioPlay,
  nativeAudioPreload,
  nativeAudioRequestState,
  nativeAudioSeek,
  nativeAudioSetCap,
  nativeAudioSetRate,
  nativeAudioStats,
  nativeAudioStop,
  nativeAudioUnpin,
} from "@/native-audio";
