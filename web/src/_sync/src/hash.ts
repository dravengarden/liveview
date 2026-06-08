// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/sync (shared-utils
// `state-sync-engine` branch). Edit there + re-vendor. See _sync/mod.ts.
// Deterministic CONTENT hash for convergence + integrity checks. NOT
// cryptographic — its job is to DETECT divergence (two replicas disagreeing, or
// a value not surviving a JSON/pg round-trip), not to resist an adversary. So a
// fast non-crypto hash (sync — `crypto.subtle` is async and can't sit in the
// applyPatch hot path) over a CANONICAL encoding (object keys sorted, so key
// order never changes the hash) is exactly right.
//
// The `>>> 0` below is uint32 wraparound (FNV needs it); the prefer-math-trunc
// rule's `Math.trunc` has different semantics and would corrupt the hash.
// oxlint-disable prefer-math-trunc

/** Canonical JSON: sorted keys, so `{a:1,b:2}` and `{b:2,a:1}` hash identically. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** FNV-1a/32 over the canonical encoding → 8-hex-digit string. Stable across
 *  runs and engines for the same JSON-plain value. */
export function hashValue(value: unknown): string {
  const s = canonical(value);
  let h = 0x81_1C_9D_C5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93); // FNV prime
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
