// Pure resume rules shared by the audio player and its mirrored stores: the
// device-local storage keys and the cross-device server-resume decision.
import type { NowPlaying } from "./player";
import type { AudioPos, PersistedSession } from "./stores";

/** A same-chapter resume from another device only wins (and toasts) when it is
 *  meaningfully ahead of this device's local position. A few seconds of drift
 *  from rounding or last-tick timing must not masquerade as a cross-device sync. */
export const SYNC_POS_LEAD_S = 8;

/** Per-chapter resume position (audio seconds); the synchronous local seed. */
export const posKey = (path: string, lang: string, voice?: string, marksHash?: string): string =>
  `lv-audio-pos:${path}:${lang}${voice ? `:${voice}` : ""}${marksHash ? `:${marksHash}` : ""}`;

/** Last spoken unit of a chapter rendition, used to remap across voices. */
export const unitKey = (np: NowPlaying): string => `lv-audio-unit:${np.chapterPath}:${np.rendition}:${np.lang}`;

/** Parse the server's `audio.session` blob; a corrupt or partial blob is `null`. */
export function parseServerSession(raw: string | null | undefined): PersistedSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedSession;
    return parsed?.nowPlaying && Array.isArray(parsed.queue) ? parsed : null;
  } catch {
    return null;
  }
}

/** Parse the server's `audio.pos` blob; a corrupt or partial blob is `null`. */
export function parseServerPos(raw: string | null | undefined): AudioPos | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AudioPos;
    return typeof parsed?.path === "string" && Number.isFinite(parsed.t) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ServerResume {
  /** Load the server's session (paused) and raise the sync toast. */
  adopt: boolean;
  /** Server position for the server's chapter rendition, or 0 when unknown. */
  serverT: number;
}

/** Decide whether this device adopts the server's resume pointer. It adopts when
 *  the server points at a different chapter (or nothing is loaded locally), or
 *  when it is the same chapter rendition and the server is more than
 *  `SYNC_POS_LEAD_S` ahead of `localPos`. */
export function serverResumeDecision(
  cur: NowPlaying | null,
  localPos: number,
  session: PersistedSession,
  pos: AudioPos | null,
): ServerResume {
  const np = session.nowPlaying;
  const chapterDiffers = !cur || cur.chapterPath !== np.chapterPath || cur.bookSlug !== np.bookSlug;
  const serverT = pos && pos.path === np.chapterPath && pos.voice === np.voice && pos.marksHash === np.marksHash
    ? pos.t
    : 0;
  const posAhead = !chapterDiffers &&
    cur?.voice === np.voice &&
    cur?.marksHash === np.marksHash &&
    serverT > localPos + SYNC_POS_LEAD_S;
  return { adopt: chapterDiffers || posAhead, serverT };
}
