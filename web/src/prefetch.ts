// Background prefetch — Lane A (offline reading). When a book is opened, quietly
// fetch the REST of its chapters' rendered text so the whole book reads offline,
// not just the chapter you happened to open. The service worker's network-first
// /api/* caching (sw.js) stores each response, so a later offline visit serves
// it from cache. Low-priority (idle-scheduled), bounded, once per book/session.
//
// Lane B (offline AUDIO) needs Range-from-cache + content-addressed blob URLs and
// is a separate follow-up; this module only warms the cheap text lane.

import { setPrefetching } from "@/syncStore";

/** Books already swept this session (cheap dedup; the SW holds the real cache). */
const sweptText = new Set<string>();
const sweptAudio = new Set<string>();
let inFlight = 0;

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
      try {
        await fetch(
          `/api/file?path=${encodeURIComponent(`${slug}/${rel}`)}` +
            `&lang=${encodeURIComponent(lang)}&rendition=text`,
        );
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
        // `prefetch=1` tells the SW to download the full body + cache it (a normal
        // play streams Range and isn't cached). marks are small 200s (auto-cached).
        await fetch(`/api/audio?${q}&prefetch=1`);
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
