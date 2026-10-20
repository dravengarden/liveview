import type { NativeAudioTrack, NativePlaybackSnapshot } from "../native-audio.ts";
import type { NowPlaying, Track } from "./player.tsx";
import { selectPreferredVoice, type ChapterVoices } from "./speech.ts";
import type { ChapterMedia } from "../audioHash.ts";

export const NATIVE_QUEUE_BATCH = 16;

export function nativeTrack(
  np: NowPlaying, media: ChapterMedia, position: number, rate: number, origin: string, last: boolean,
): NativeAudioTrack {
  const query = new URLSearchParams({ path: np.chapterPath, lang: np.lang, rendition: np.rendition });
  return {
    url: media.audioHash ? `${origin}/api/blob/${media.audioHash}` : `${origin}/api/audio?${query}${last ? "&tail=bookend" : ""}`,
    ...(media.audioHash ? { hash: media.audioHash } : {}),
    ...(media.audioBytes ? { bytes: media.audioBytes } : {}),
    position, rate, title: np.chapterLabel, artist: np.bookLabel, album: np.bookLabel,
    artworkUrl: `${origin}/api/artwork?book=${encodeURIComponent(np.bookSlug)}`,
    context: JSON.stringify(np),
  };
}

/** Resolve from one voice snapshot, without per-track IDB/timing/network reads.
 * A not-yet-generated selected voice is a hole, never another voice's audio. */
export function queuedNativeTrack(
  base: NowPlaying, track: Track, catalog: ReadonlyMap<string, ChapterVoices>, preference: string | null,
  rate: number, origin: string, last: boolean,
  resume: (np: NowPlaying) => number = () => 0,
): NativeAudioTrack | null {
  const rel = track.path.startsWith(`${base.bookSlug}/`) ? track.path.slice(base.bookSlug.length + 1) : track.path;
  const chapter = catalog.get(`${base.rendition}/${base.lang}/${rel}`);
  if (!chapter) return null;
  const voice = selectPreferredVoice(chapter, preference);
  if (voice?.status !== "ready" || !voice.audio_hash || !voice.marks_hash) return null;
  const np = { ...base, chapterPath: track.path, chapterLabel: track.label, voice: voice.id, marksHash: voice.marks_hash };
  return nativeTrack(np, {
    audioHash: voice.audio_hash, marksHash: voice.marks_hash,
    ...(voice.bytes ? { audioBytes: voice.bytes } : {}),
  }, resume(np), rate, origin, last);
}

/** Generic host contexts are untrusted on the wire; never adopt a malformed one. */
export function nativeNowPlaying(context: string | null | undefined): NowPlaying | null {
  if (!context) return null;
  try {
    const value: unknown = JSON.parse(context);
    if (!value || typeof value !== "object") return null;
    const np = value as Record<string, unknown>;
    if (["bookSlug", "bookLabel", "chapterPath", "chapterLabel", "lang", "rendition"].some(key => typeof np[key] !== "string")) return null;
    if (typeof np["cover"] !== "boolean" || (np["voice"] !== undefined && typeof np["voice"] !== "string") ||
        (np["marksHash"] !== undefined && typeof np["marksHash"] !== "string")) return null;
    return np as unknown as NowPlaying;
  } catch { return null; }
}

/** A late event from an old source cannot advance or overwrite the new source. */
export function nativeEventMatches(
  event: { queueId?: string; index?: number }, queueId: string | null, index: number,
): boolean {
  return !event.queueId || (event.queueId === queueId && (event.index === undefined || event.index === index));
}

export function nativeSessionQueue(snapshot: NativePlaybackSnapshot, saved: { nowPlaying: NowPlaying; queue: Track[] } | null): Track[] {
  const np = nativeNowPlaying(snapshot.context);
  if (!np || !saved) return [];
  const prev = saved.nowPlaying;
  return prev.bookSlug === np.bookSlug && prev.lang === np.lang && prev.rendition === np.rendition &&
      saved.queue[snapshot.index]?.path === np.chapterPath
    ? saved.queue : [];
}
