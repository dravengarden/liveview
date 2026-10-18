import type { Mark } from "@/types";
import type { NowPlaying } from "./player";

export function voicePreferenceKey(np: NowPlaying): string {
  return `audio.voice:${JSON.stringify([np.bookSlug, np.rendition, np.lang])}`;
}

/** Keep the logical sentence when changing voices, never the old seconds. */
export function sentencePosition(marks: Mark[], index: number): number {
  return (marks[Math.max(0, Math.min(index, marks.length - 1))]?.start_ms ?? 0) / 1000;
}
