import type { Mark } from "@/types";

/** Map playback time to the current narration mark.
 *
 * Marks normally touch end-to-start, but generated audio can contain a short
 * silence between them. Hold the previous sentence through that gap instead of
 * dropping the read-along cue until the next mark starts.
 */
export function activeMarkIndex(marks: Mark[], ms: number): number {
  if (!Number.isFinite(ms) || marks.length === 0) return -1;

  let lo = 0;
  let hi = marks.length - 1;
  let previous = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const mark = marks[mid];
    if (!mark) break;
    if (ms < mark.start_ms) {
      hi = mid - 1;
    } else {
      previous = mid;
      if (ms < mark.end_ms) return mid;
      lo = mid + 1;
    }
  }
  return previous;
}

/** Prefer marks fetched by the visible reader over the engine's best-effort
 * index. This lets highlighting recover even when the engine's first marks
 * request failed while audio continued playing. */
export function resolveReadAlongIndex(
  marks: Mark[],
  ms: number,
  engineIndex: number,
): number {
  const local = activeMarkIndex(marks, ms);
  return local >= 0 ? local : engineIndex;
}
