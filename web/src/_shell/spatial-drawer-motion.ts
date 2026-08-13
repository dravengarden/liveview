export interface SpatialDrawerVisual {
  readonly progress: number;
  readonly scale: number;
  readonly opacity: number;
}

/** Bound the one-frame projection used to keep a composited surface under a
 * fast finger without making slow drags feel spring-loaded. */
export function predictSpatialDrawerOffset(
  sampledOffset: number,
  velocityPxPerMs: number,
  sampleAgeMs: number,
): number {
  const age = Math.max(0, Math.min(12, sampleAgeMs));
  const lead = Math.max(-10, Math.min(10, velocityPxPerMs * age));
  return sampledOffset + lead;
}

export function spatialDrawerVisual(
  offset: number,
  width: number,
  { phone, reducedMotion = false }: { readonly phone: boolean; readonly reducedMotion?: boolean },
): SpatialDrawerVisual {
  const progress = width > 0 ? Math.max(0, Math.min(1, offset / width)) : 0;
  // The revealed workspace must read as a separate receding card, not merely a
  // translated full-size page. Pure-black themes otherwise erase the corner
  // silhouette and make even a 4% scale change effectively invisible.
  let openScale = phone ? 0.92 : 0.955;
  let openOpacity = phone ? 0.52 : 0.66;
  if (reducedMotion) {
    openScale = 1;
    openOpacity = 0.84;
  }
  const fadePosition = Math.max(0, Math.min(1, (progress - 0.1) / 0.9));
  const fadeProgress = fadePosition * fadePosition * (3 - 2 * fadePosition);

  return {
    progress,
    scale: 1 - (1 - openScale) * progress,
    opacity: 1 - (1 - openOpacity) * fadeProgress,
  };
}
