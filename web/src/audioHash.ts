// Per-book audio content hashes (the manifest's `audio_hash`), for the native
// engine's content-addressed offline cache. Memoized per slug. Returns undefined
// when unavailable (not baked / path mismatch) — native then keys its cache by
// the URL instead. Best-effort, never throws.
//
// CRITICAL for offline playback: the manifest is fetched via `contentFetch`
// (cache-first, offline-safe), NOT a raw fetch. The audio blobs are DOWNLOADED
// under their content-HASH key, so playback MUST resolve that same hash to find
// the local file. A raw fetch returned undefined offline → native fell back to a
// URL key → the hash-keyed downloaded file wasn't found → it tried to stream →
// no offline playback ("播放按钮断网没反应"). contentFetch caches the manifest, so
// the hash resolves offline too and the local file is found.

import { contentFetch } from "@/native-sync";

const cache = new Map<string, Promise<Map<string, string>>>(); // slug → ("lang/rel" → hash)

async function fetchMap(slug: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    const res = await contentFetch(`/api/manifest/${encodeURIComponent(slug)}`);
    if (res.ok) {
      const data = (await res.json()) as {
        chapters: { id: string; audio?: { hash: string | null } }[];
      };
      for (const ch of data.chapters) {
        // id = "<rendition>/<lang>/<rel_path>". Map EVERY chapter that carries an
        // audio hash — keyed by "<lang>/<rel>" with the rendition prefix stripped —
        // NOT just the audio rendition. BOTH renditions ship read-aloud audio that
        // is downloaded under its content hash: the audiobook
        // (audio/<lang>/<rel>.spoken.md) AND the text read-aloud
        // (text/<lang>/<rel>.md). Skipping the text rendition meant 边看边听 could
        // never resolve its hash, so the hash-keyed local file wasn't found and it
        // tried to STREAM — "下完所有数据后切音频一直 loading". The two renditions'
        // rel paths differ (.spoken.md vs .md), so the keys never collide.
        const a = ch.id.indexOf("/");
        const b = ch.id.indexOf("/", a + 1);
        if (a < 0 || b < 0) continue;
        if (ch.audio?.hash) {
          m.set(`${ch.id.slice(a + 1, b)}/${ch.id.slice(b + 1)}`, ch.audio.hash);
        }
      }
    }
  } catch {
    // offline + uncached / transient — leave empty (NOT memoized, so a later
    // call retries once the manifest is cached / network returns).
  }
  return m;
}

function loadMap(slug: string): Promise<Map<string, string>> {
  const existing = cache.get(slug);
  if (existing) return existing;
  const p = fetchMap(slug);
  cache.set(slug, p);
  // Don't memoize an EMPTY result (offline-before-cached / transient miss) — drop
  // it so the next call re-resolves once the manifest is available. A populated
  // map is immutable (content-addressed), so it stays memoized.
  void p.then((m) => {
    if (m.size === 0) cache.delete(slug);
  });
  return p;
}

/** The audio content hash for a chapter, or undefined. `chapterPath` is
 *  `<slug>/<rel>`; `rel` is derived by stripping the slug prefix. */
export async function audioHash(
  bookSlug: string,
  chapterPath: string,
  lang: string,
): Promise<string | undefined> {
  const rel = chapterPath.startsWith(`${bookSlug}/`)
    ? chapterPath.slice(bookSlug.length + 1)
    : chapterPath;
  return (await loadMap(bookSlug)).get(`${lang}/${rel}`);
}
