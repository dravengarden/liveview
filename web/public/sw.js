// LiveView service worker — offline app shell + runtime caching.
//
// Hand-rolled (no Workbox) to keep the dependency surface minimal. Bump
// VERSION to invalidate all caches on the next visit.
const VERSION = "lv-v94";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const API_CACHE = `${VERSION}-api`;

// The navigation shell, so the app opens offline. Hashed JS/CSS bundles are
// not listed here (their names change every build); they are captured lazily
// by the runtime cache on first online load.
const SHELL = ["/", "/index.html", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => !k.startsWith(VERSION)).map((k) =>
            caches.delete(k)
          ),
        )
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // SPA navigations: network-first, fall back to the cached shell offline.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/index.html")));
    return;
  }

  // API (file/tree): network-first, fall back to the last-seen response.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  // App assets + CDN libraries: serve fast from cache, refresh in background.
  event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      // Cache same-origin OK responses and opaque cross-origin (CDN) ones.
      if (res && (res.status === 200 || res.type === "opaque")) {
        cache.put(req, res.clone());
      }
      return res;
    })
    .catch(() => undefined);
  return cached || (await network) || fetch(req);
}
