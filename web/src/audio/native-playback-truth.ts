/** One native position sample used to distinguish real playback from an older
 * protocol-v1 shell's optimistic `playing` event. */
export interface NativePositionSample {
  readonly position: number;
  readonly at: number;
}

/**
 * Confirm that native media time advanced at a physically plausible rate.
 *
 * Older installed shells emit `playing` immediately after assigning AVPlayer's
 * requested rate, even when the player is still paused or stalled. A genuine
 * periodic time tick advances gradually; a resume seek can jump by minutes and
 * must only establish a new baseline.
 */
export function nativePositionConfirmsPlayback(
  previous: NativePositionSample | null,
  position: number,
  at: number,
): boolean {
  if (
    previous == null || !Number.isFinite(position) ||
    !Number.isFinite(previous.position) || !Number.isFinite(at) ||
    !Number.isFinite(previous.at)
  ) return false;

  const delta = position - previous.position;
  const elapsedSeconds = Math.max(0, (at - previous.at) / 1000);
  // Playback tops out at 3x today. Leave margin for a delayed WKWebView event,
  // while rejecting seek/resume jumps as evidence that sound is advancing.
  const plausibleAdvance = Math.max(0.5, elapsedSeconds * 4 + 0.5);
  return delta > 0.01 && delta <= plausibleAdvance;
}
