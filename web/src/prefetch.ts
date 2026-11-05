// Warm the rendition spines on load. Chapter bodies, artwork and audio are
// filled by the IDB replica (`replica/sync.ts`, `audio/cache.ts`); this module
// only makes sure a shelf card can be opened offline.

import { contentFetch } from "@/native-sync";

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
