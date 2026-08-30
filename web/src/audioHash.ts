// Per-chapter MEDIA resolution (audio + marks content hashes) from the book
// manifest, for the native engine's content-addressed offline cache.
//
// CACHE-FIRST + memoized per slug: the manifest is deploy-stable and this sits on
// the audio-playback HOT PATH (the player awaits a hash before it can point the
// native player at the LOCAL file). A network-first fetch that stalls would hang
// playback on "loading" even though the manifest + the audio/marks blobs are all
// already on disk — so we serve the cached manifest instantly (the download driver
// still refreshes it network-first on launch).
//
// Both the audio and the marks are content-addressed and downloaded:
//   - audio  → the native AVPlayer store, keyed by `audio.hash`
//   - marks  → /api/blob/<audio.marks_hash> (the dag caches marks as a blob; the
//              live `/api/marks?…` URL is NOT a cached resource, so resolving marks
//              by HASH is the only offline-safe path)
// Returns empty fields when unavailable — callers degrade (audio falls back to URL
// keying, marks highlighting is skipped) rather than failing. Best-effort, never
// throws.

import { contentFetch } from "@/native-sync";
import { getMedia, putMedia } from "@/audioMediaIndex";

export interface ChapterMedia {
  /** Audio content hash — the offline cache key the native player shares. */
  audioHash?: string;
  /** Exact cached audio body length, used by native to reject partial files. */
  audioBytes?: number;
  /** Marks (word/sentence timing) blob hash — fetch `/api/blob/<hash>` (cached). */
  marksHash?: string;
}

const EMPTY: ChapterMedia = {};

// slug → ("<lang>/<rel>" → media). Memoized; a populated map is immutable
// (content-addressed) so it stays cached, an empty one is dropped to retry.
const cache = new Map<string, Promise<Map<string, ChapterMedia>>>();

async function fetchMap(slug: string): Promise<Map<string, ChapterMedia>> {
  const m = new Map<string, ChapterMedia>();
  try {
    const res = await contentFetch(
      `/api/manifest/${encodeURIComponent(slug)}`,
      {
        cacheFirst: true,
      },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        chapters: {
          id: string;
          audio?: {
            hash?: string | null;
            marks_hash?: string | null;
            bytes?: number | null;
          } | null;
        }[];
      };
      for (const ch of data.chapters) {
        // id = "<rendition>/<lang>/<rel>" → key by "<lang>/<rel>" (rendition
        // stripped). BOTH renditions ship read-aloud audio — the audiobook
        // (audio/<lang>/<rel>.spoken.md) AND the text read-aloud
        // (text/<lang>/<rel>.md) — and their rel paths differ (.spoken.md vs .md),
        // so the keys never collide. Mapping only one rendition was why 边看边听
        // couldn't resolve its hash offline.
        const a = ch.id.indexOf("/");
        const b = ch.id.indexOf("/", a + 1);
        if (a < 0 || b < 0 || !ch.audio) continue;
        const media: ChapterMedia = {};
        if (ch.audio.hash) media.audioHash = ch.audio.hash;
        const bytes = ch.audio.bytes;
        if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0) {
          media.audioBytes = Math.floor(bytes);
        }
        if (ch.audio.marks_hash) media.marksHash = ch.audio.marks_hash;
        if (media.audioHash || media.marksHash) {
          m.set(`${ch.id.slice(a + 1, b)}/${ch.id.slice(b + 1)}`, media);
        }
      }
    }
  } catch {
    // offline + uncached / transient — leave empty (dropped below so a later call
    // retries once the manifest is cached / the network returns).
  }
  return m;
}

function loadMap(slug: string): Promise<Map<string, ChapterMedia>> {
  const existing = cache.get(slug);
  if (existing) return existing;
  const p = fetchMap(slug);
  cache.set(slug, p);
  void p.then((m) => {
    if (m.size === 0) cache.delete(slug);
  });
  return p;
}

function relOf(bookSlug: string, chapterPath: string): string {
  return chapterPath.startsWith(`${bookSlug}/`)
    ? chapterPath.slice(bookSlug.length + 1)
    : chapterPath;
}

/** Audio + marks content hashes for a chapter (cache-first), or empty fields.
 *  `chapterPath` is `<slug>/<rel>`. */
export async function chapterMedia(
  bookSlug: string,
  chapterPath: string,
  lang: string,
): Promise<ChapterMedia> {
  const rel = relOf(bookSlug, chapterPath);
  // 1) PERSISTENT INDEX FIRST — a synchronous localStorage read, offline-safe and
  // network-free. Populated from /api/dag by the download driver while online, so
  // a downloaded chapter ALWAYS has its hash here. This is the offline-playback
  // fix: no dependency on the manifest being in the url-cache.
  const persisted = getMedia(bookSlug, lang, rel);
  if (persisted) return persisted;
  // 2) Fall back to the manifest (e.g. an online book never warmed by the driver),
  // and write any hit through to the index so the next (possibly offline) lookup
  // is instant + self-sufficient.
  const m = (await loadMap(bookSlug)).get(`${lang}/${rel}`);
  if (m) {
    putMedia(bookSlug, lang, rel, m);
    return m;
  }
  return EMPTY;
}

/** Just the audio content hash (back-compat for the web `<audio>` path). */
export async function audioHash(
  bookSlug: string,
  chapterPath: string,
  lang: string,
): Promise<string | undefined> {
  return (await chapterMedia(bookSlug, chapterPath, lang)).audioHash;
}
