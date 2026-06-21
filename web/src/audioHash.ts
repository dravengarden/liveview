// Per-book audio content hashes (the manifest's `audio_hash`), for the native
// engine's content-addressed offline cache. Memoized per slug; the manifest is
// small + SW-cached. Returns undefined when unavailable (offline / not baked /
// path mismatch) — native then keys its cache by the URL instead, so caching
// still works, just not content-addressed. Best-effort, never throws.

const cache = new Map<string, Promise<Map<string, string>>>(); // slug → ("lang/rel" → hash)

function loadMap(slug: string): Promise<Map<string, string>> {
  const existing = cache.get(slug);
  if (existing) return existing;
  const p = (async (): Promise<Map<string, string>> => {
    const m = new Map<string, string>();
    try {
      const res = await fetch(`/api/manifest/${encodeURIComponent(slug)}`);
      if (res.ok) {
        const data = (await res.json()) as {
          chapters: { id: string; audio?: { hash: string | null } }[];
        };
        for (const ch of data.chapters) {
          // id = "<rendition>/<lang>/<rel_path>"
          const a = ch.id.indexOf("/");
          const b = ch.id.indexOf("/", a + 1);
          if (a < 0 || b < 0 || ch.id.slice(0, a) !== "audio") continue;
          if (ch.audio?.hash) {
            m.set(`${ch.id.slice(a + 1, b)}/${ch.id.slice(b + 1)}`, ch.audio.hash);
          }
        }
      }
    } catch {
      // offline / transient — leave empty; native falls back to URL keying.
    }
    return m;
  })();
  cache.set(slug, p);
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
