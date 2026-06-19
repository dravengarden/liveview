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
}

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
      const slash1 = ch.id.indexOf("/");
      const slash2 = ch.id.indexOf("/", slash1 + 1);
      if (slash1 < 0 || slash2 < 0) continue;
      const rendition = ch.id.slice(0, slash1);
      if (rendition !== "text") continue; // Lane A = text only
      const lang = ch.id.slice(slash1 + 1, slash2);
      const rel = ch.id.slice(slash2 + 1);
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
