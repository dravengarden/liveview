// PERSISTENT per-chapter media index (audio + marks content hashes), in
// localStorage. The offline-bulletproof source of the cache keys the native
// AVPlayer store + the read-along marks are addressed by.
//
// WHY this exists (the offline-playback bug it fixes):
//   The native audio store keys each downloaded chapter by its CONTENT HASH. At
//   playback the web must hand the native player that same hash so it finds the
//   on-disk file. Until now the only source of that hash was /api/manifest/<slug>,
//   resolved network-first through the native url-cache (cache-first). That made
//   offline playback depend on a fragile chain — the manifest had to have been
//   fetched AND still be in the url-cache. When any link broke, the player had no
//   hash, the native store fell back to a URL-digest key, MISSED the hash-keyed
//   file that was sitting right there on disk, and playback died at 0:00 offline.
//
//   This index breaks that dependency. The download driver fetches /api/dag
//   (which carries every audio + marks resource's hash) while ONLINE — exactly
//   when the audio is downloaded — and ingests it here. So the invariant becomes:
//   "if a chapter's audio is on disk, its hash is in this index" — a single,
//   durable localStorage read, no network, no manifest. `chapterMedia` reads this
//   FIRST and only falls back to the manifest when the index has no entry.
//
// Key = `<slug>|<lang>|<rel>` (rel = chapter path without the slug). The text
// read-aloud (.md) and audiobook (.spoken.md) renditions have distinct rel paths,
// so one map serves both without collision — same disambiguation chapterMedia
// already relies on.

const LS_KEY = "lv.audioMediaIndex.v1";

interface Entry {
  a?: string; // audio content hash
  m?: string; // marks blob hash
}

// In-memory mirror of the persisted map, loaded once. `null` until first load.
let mem: Map<string, Entry> | null = null;

function load(): Map<string, Entry> {
  if (mem) return mem;
  mem = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, Entry>;
      for (const [k, v] of Object.entries(obj)) mem.set(k, v);
    }
  } catch {
    // corrupt / unavailable (private mode) — start empty, non-fatal.
  }
  return mem;
}

function persist(m: Map<string, Entry>): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch {
    // quota / unavailable — the in-memory map still serves this session.
  }
}

export function keyOf(slug: string, lang: string, rel: string): string {
  return `${slug}|${lang}|${rel}`;
}

/** Look up a chapter's persisted hashes (offline-safe, no network). */
export function getMedia(
  slug: string,
  lang: string,
  rel: string,
): { audioHash?: string; marksHash?: string } | undefined {
  const e = load().get(keyOf(slug, lang, rel));
  if (!e) return undefined;
  const out: { audioHash?: string; marksHash?: string } = {};
  if (e.a) out.audioHash = e.a;
  if (e.m) out.marksHash = e.m;
  return out.audioHash || out.marksHash ? out : undefined;
}

/** Record one chapter's hashes (opportunistic, e.g. from a manifest hit). Merges
 *  into the existing entry so an audio-only or marks-only update never clobbers
 *  the other half. Persists immediately (single small write). */
export function putMedia(
  slug: string,
  lang: string,
  rel: string,
  media: { audioHash?: string; marksHash?: string },
): void {
  const m = load();
  const k = keyOf(slug, lang, rel);
  const prev = m.get(k) ?? {};
  const next: Entry = { ...prev };
  if (media.audioHash) next.a = media.audioHash;
  if (media.marksHash) next.m = media.marksHash;
  if (next.a === prev.a && next.m === prev.m) return; // no change
  m.set(k, next);
  persist(m);
}

/** Bulk-ingest /api/dag resources (the download driver calls this online). Parses
 *  the audio + marks resources — whose `path` is `<slug>/<rendition>/<lang>/<rel>#<kind>`
 *  — into the index, then persists once. This is what makes "downloaded ⇒ hash is
 *  available offline" hold. */
export function ingestDag(
  resources: { hash: string; kind: string; path: string }[],
): void {
  const m = load();
  let changed = false;
  for (const r of resources) {
    if (r.kind !== "audio" && r.kind !== "marks") continue;
    const hash = r.kind === "audio"
      ? r.hash
      // marks resources are keyed by the raw blob hash already; audio's `hash`
      // is the source audio_hash. Both are exactly what the player needs.
      : r.hash;
    // path = "<slug>/<rendition>/<lang>/<rel...>#<kind>"
    const hashIdx = r.path.lastIndexOf("#");
    const body = hashIdx >= 0 ? r.path.slice(0, hashIdx) : r.path;
    const parts = body.split("/");
    if (parts.length < 4) continue;
    const slug = parts[0] ?? "";
    const lang = parts[2] ?? "";
    const rel = parts.slice(3).join("/");
    if (!slug || !lang || !rel) continue;
    const k = keyOf(slug, lang, rel);
    const prev = m.get(k) ?? {};
    const next: Entry = { ...prev };
    if (r.kind === "audio") next.a = hash;
    else next.m = hash;
    if (next.a !== prev.a || next.m !== prev.m) {
      m.set(k, next);
      changed = true;
    }
  }
  if (changed) persist(m);
}
