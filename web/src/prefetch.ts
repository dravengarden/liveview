// Background prefetch — Lane A (offline reading). When a book is opened, quietly
// fetch the REST of its chapters' rendered text so the whole book reads offline,
// not just the chapter you happened to open. The service worker's network-first
// /api/* caching (sw.js) stores each response, so a later offline visit serves
// it from cache. Low-priority (idle-scheduled), bounded, once per book/session.
//
// Lane B (offline AUDIO) needs Range-from-cache + content-addressed blob URLs and
// is a separate follow-up; this module only warms the cheap text lane.

import { setPrefetching } from "@/syncStore";
import { nativeAudioAvailable, nativeAudioPrefetch } from "@/native-audio";
import { contentFetch } from "@/native-sync";

/** Books already swept this session (cheap dedup; the SW holds the real cache). */
const sweptText = new Set<string>();
const sweptAudio = new Set<string>();
let inFlight = 0;

/**
 * EAGER mode — the native shell (iOS/Mac Tauri). There it pre-loads the WHOLE
 * library so every book reads + plays offline with no per-book "open it first",
 * vs LAZY (web/PWA) which warms only the opened book on demand. Detected by the
 * Tauri IPC global (same key haptics.ts uses); the remote-loaded web page still
 * carries it inside the WKWebView. Lazy = false ⇒ no full-corpus sweep.
 */
export function isEagerShell(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

let sweptTrees = false;

/**
 * Warm the sidebar SPINES — `/api/tree?rendition=text|audio` (each returns the
 * whole forest for that rendition, ALL books, so this is just two cheap fetches).
 * CRITICAL for offline: opening a book first fetches its rendition spine; without
 * it cached, a tap on a shelf card while offline couldn't enter the book at all
 * (the "断网点 card 无法跳转" bug). `contentFetch` caches into the right store per
 * platform — the SW's lv-content on web, the native lv-sync store on the shell
 * (where there is NO service worker). Run on every load, once per session.
 */
export async function prefetchTrees(): Promise<void> {
  if (sweptTrees || !navigator.onLine) return;
  sweptTrees = true;
  try {
    await Promise.all([
      contentFetch("/api/tree?rendition=text").catch(() => undefined),
      contentFetch("/api/tree?rendition=audio").catch(() => undefined),
    ]);
  } catch {
    sweptTrees = false; // let a later load retry
  }
}

/**
 * EAGER full-corpus prefetch: warm EVERY book's text (+ audio) into the SW
 * caches, so the native app is fully offline. Reuses the per-book sweeps (idle-
 * scheduled, online-gated, session-deduped), just across all slugs. Sequential
 * so it stays a low-priority trickle, not a thundering herd. No-op on lazy.
 */
export async function prefetchAllBooks(slugs: readonly string[]): Promise<void> {
  if (!isEagerShell()) return;
  for (const slug of slugs) {
    if (!navigator.onLine) break;
    await prefetchBookText(slug);
    await prefetchBookAudio(slug);
  }
}

const idle = (): Promise<void> =>
  new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
      .requestIdleCallback;
    if (ric) ric(() => resolve());
    else setTimeout(resolve, 60);
  });

interface ManifestChapter {
  id: string; // "rendition/lang/rel_path"
  audio?: { hash: string | null };
}

const splitId = (id: string): [string, string, string] | null => {
  const a = id.indexOf("/");
  const b = id.indexOf("/", a + 1);
  if (a < 0 || b < 0) return null;
  return [id.slice(0, a), id.slice(a + 1, b), id.slice(b + 1)];
};

/**
 * Prefetch every text chapter of `slug` into the SW cache (read-offline). Skips
 * if already swept this session or if offline (nothing to warm). Best-effort: a
 * failed chapter is skipped, never thrown.
 */
export async function prefetchBookText(slug: string): Promise<void> {
  if (sweptText.has(slug) || !navigator.onLine) return;
  sweptText.add(slug);
  inFlight++;
  setPrefetching(inFlight);
  try {
    const res = await fetch(`/api/manifest/${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const data = (await res.json()) as { chapters: ManifestChapter[] };
    for (const ch of data.chapters) {
      const parts = splitId(ch.id);
      if (!parts) continue;
      const [rendition, lang, rel] = parts;
      if (rendition !== "text") continue; // Lane A = text only
      await idle();
      if (!navigator.onLine) break;
      const q = `path=${encodeURIComponent(`${slug}/${rel}`)}` +
        `&lang=${encodeURIComponent(lang)}&rendition=text`;
      try {
        // The rendered page PLUS the read-along pieces (units + spoken), so an
        // offline open can also read-aloud — all land in the persistent
        // lv-content cache. Best-effort; a failed one is just skipped.
        await fetch(`/api/file?${q}`);
        await fetch(`/api/units?${q}`).catch(() => undefined);
        await fetch(`/api/spoken?${q}`).catch(() => undefined);
      } catch {
        // best-effort
      }
    }
  } catch {
    // offline / transient — try again next open (we keep it in sweptText only on
    // a clean run path; remove so a failed sweep can retry).
    sweptText.delete(slug);
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    setPrefetching(inFlight);
  }
}

/**
 * Prefetch a book's AUDIO (mp3 + marks) into the SW cache — Lane B (listen
 * offline). Fired automatically when a book is opened (offline is opt-out-free);
 * a text-only book has no baked-audio chapters, so its sweep is a no-op. The SW
 * caches the full body, so offline playback + seeking work; repeat opens are
 * cheap (the SW short-circuits cache hits, and `sweptAudio` skips the re-loop).
 * Only chapters whose audio is already baked (`audio.hash`) are pulled; the rest
 * become offline-available on first play (the SW caches every play in the
 * background) or fill in as they generate.
 */
export async function prefetchBookAudio(slug: string): Promise<void> {
  if (sweptAudio.has(slug) || !navigator.onLine) return;
  sweptAudio.add(slug);
  inFlight++;
  setPrefetching(inFlight);
  try {
    const res = await fetch(`/api/manifest/${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const data = (await res.json()) as { chapters: ManifestChapter[] };
    for (const ch of data.chapters) {
      if (!ch.audio?.hash) continue; // audio not baked yet
      const parts = splitId(ch.id);
      if (!parts) continue;
      const [rendition, lang, rel] = parts;
      const q = `path=${encodeURIComponent(`${slug}/${rel}`)}` +
        `&lang=${encodeURIComponent(lang)}&rendition=${encodeURIComponent(rendition)}`;
      await idle();
      if (!navigator.onLine) break;
      try {
        if (nativeAudioAvailable()) {
          // Native engine owns the audio cache (the SW one is bypassed under
          // native): hand the absolute URL + hash to native to download offline.
          // marks still go through the SW so the read-along works offline too.
          nativeAudioPrefetch(
            `${globalThis.location.origin}/api/audio?${q}`,
            ch.audio.hash,
          );
        } else {
          // Immutable content-addressed blob → the SW caches it in the PERSISTENT
          // lv-blobs cache (offline-stable across deploys; Range-from-cache on
          // play). Replaces `/api/audio?prefetch=1` (which landed in the
          // version-wiped AUDIO_CACHE and was lost on every deploy).
          await fetch(`/api/blob/${ch.audio.hash}`);
        }
        // marks are small 200s (auto-cached by the SW) — needed for the
        // read-along whichever engine plays the audio.
        await fetch(`/api/marks?${q}`);
      } catch {
        // best-effort
      }
    }
  } catch {
    // offline / transient — let a later open retry the sweep.
    sweptAudio.delete(slug);
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    setPrefetching(inFlight);
  }
}
