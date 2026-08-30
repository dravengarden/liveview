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
  b?: number; // expected audio body bytes
  m?: string; // marks blob hash
}

export interface DagMediaResource {
  hash: string;
  kind: string;
  path: string;
  bytes?: number;
}

export interface ParsedMediaResource {
  key: string;
  kind: "audio" | "marks";
  hash: string;
  bytes?: number;
}

/** Parse one DAG audio/marks resource without touching storage. */
export function parseMediaResource(
  resource: DagMediaResource,
): ParsedMediaResource | undefined {
  if (resource.kind !== "audio" && resource.kind !== "marks") return undefined;
  const hashIdx = resource.path.lastIndexOf("#");
  const body = hashIdx >= 0 ? resource.path.slice(0, hashIdx) : resource.path;
  const parts = body.split("/");
  if (parts.length < 4) return undefined;
  const slug = parts[0] ?? "";
  const lang = parts[2] ?? "";
  const rel = parts.slice(3).join("/");
  if (!slug || !lang || !rel) return undefined;
  const parsed: ParsedMediaResource = {
    key: keyOf(slug, lang, rel),
    kind: resource.kind,
    hash: resource.hash,
  };
  const bytes = resource.bytes;
  if (
    resource.kind === "audio" && typeof bytes === "number" &&
    Number.isFinite(bytes) && bytes > 0
  ) {
    parsed.bytes = Math.floor(bytes);
  }
  return parsed;
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
    globalThis.localStorage?.setItem(
      LS_KEY,
      JSON.stringify(Object.fromEntries(m)),
    );
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
): { audioHash?: string; audioBytes?: number; marksHash?: string } | undefined {
  const e = load().get(keyOf(slug, lang, rel));
  if (!e) return undefined;
  const out: { audioHash?: string; audioBytes?: number; marksHash?: string } =
    {};
  if (e.a) out.audioHash = e.a;
  if (e.b && e.b > 0) out.audioBytes = e.b;
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
  media: { audioHash?: string; audioBytes?: number; marksHash?: string },
): void {
  const m = load();
  const k = keyOf(slug, lang, rel);
  const prev = m.get(k) ?? {};
  const next: Entry = { ...prev };
  if (media.audioHash) {
    if (media.audioHash !== prev.a) delete next.b;
    next.a = media.audioHash;
  }
  const bytes = media.audioBytes;
  if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0) {
    next.b = Math.floor(bytes);
  }
  if (media.marksHash) next.m = media.marksHash;
  if (next.a === prev.a && next.b === prev.b && next.m === prev.m) return; // no change
  m.set(k, next);
  persist(m);
}

/** Bulk-ingest /api/dag resources (the download driver calls this online). Parses
 *  the audio + marks resources — whose `path` is `<slug>/<rendition>/<lang>/<rel>#<kind>`
 *  — into the index, then persists once. This is what makes "downloaded ⇒ hash is
 *  available offline" hold. */
export function ingestDag(
  resources: DagMediaResource[],
): void {
  const m = load();
  let changed = false;
  for (const r of resources) {
    const parsed = parseMediaResource(r);
    if (!parsed) continue;
    const prev = m.get(parsed.key) ?? {};
    const next: Entry = { ...prev };
    if (parsed.kind === "audio") {
      if (parsed.hash !== prev.a) delete next.b;
      next.a = parsed.hash;
      if (parsed.bytes) next.b = parsed.bytes;
    } else next.m = parsed.hash;
    if (next.a !== prev.a || next.b !== prev.b || next.m !== prev.m) {
      m.set(parsed.key, next);
      changed = true;
    }
  }
  if (changed) persist(m);
}
