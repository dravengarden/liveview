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
