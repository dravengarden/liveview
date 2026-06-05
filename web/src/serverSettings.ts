// Shared server-side preference store (/api/settings). One memoized GET per
// page load; writes are fire-and-forget. localStorage stays the offline cache
// and first-paint source — this reconciles to the server (cross-device truth).
let cache: Promise<Record<string, string>> | null = null;

export function getServerSettings(): Promise<Record<string, string>> {
  if (cache === null) {
    cache = fetch("/api/settings")
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : {}))
      .catch(() => ({}));
  }
  return cache;
}

export function putServerSetting(key: string, value: string): void {
  // Keep the memoized cache current so a later getServerSettings() in this same
  // session reflects our own write (the GET is fetched once and never refetched).
  if (cache !== null) cache = cache.then((s) => ({ ...s, [key]: value }));
  void fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  }).catch(() => {
    // best-effort; localStorage remains the offline fallback
  });
}
