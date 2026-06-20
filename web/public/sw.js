// LiveView service worker — offline app shell + content + media.
//
// Hand-rolled (no Workbox). Bump VERSION to invalidate the shell/runtime/api
// caches on the next visit; the immutable content-addressed BLOB cache is
// version-INDEPENDENT (it survives deploys — its keys are content hashes).
const VERSION = "lv-v208";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const API_CACHE = `${VERSION}-api`;
// Audio (path-keyed, mutable) — versioned so a deploy clears it (re-fetched on
// next play). Big bodies; served with Range-from-cache so seeking works offline.
const AUDIO_CACHE = `${VERSION}-audio`;
// Content-addressed immutable blobs (/api/blob/<hash>) — NOT version-prefixed,
// so the offline library survives deploys (an immutable hash never goes stale).
const BLOB_CACHE = "lv-blobs";

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
          keys
            // Keep this VERSION's caches AND the persistent blob cache; drop the rest.
            .filter((k) => !k.startsWith(VERSION) && k !== BLOB_CACHE)
            .map((k) => caches.delete(k)),
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

  if (url.origin === self.location.origin) {
    // Immutable content-addressed blobs → cache forever, Range-from-cache.
    if (url.pathname.startsWith("/api/blob/")) {
      event.respondWith(mediaCacheFirst(req, BLOB_CACHE));
      return;
    }
    // Audio (mp3): a normal PLAY streams Range from the network (fast first
    // play) AND caches the full body in the background, so everything you listen
    // to becomes offline-available automatically — no per-book toggle. An
    // explicit `?prefetch=1` (warming an opened book) downloads + caches up front.
    if (url.pathname === "/api/audio") {
      event.respondWith(audioHandler(event, url));
      return;
    }
    // /api/version stays network-first un-cached fallthrough below (deploy probe).
    if (url.pathname.startsWith("/api/")) {
      event.respondWith(networkFirst(req, API_CACHE));
      return;
    }
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
      if (res && (res.status === 200 || res.type === "opaque")) {
        cache.put(req, res.clone());
      }
      return res;
    })
    .catch(() => undefined);
  return cached || (await network) || fetch(req);
}

// Audio: cache hit → Range-from-cache; explicit prefetch (`?prefetch=1`) →
// download the full body + cache it (keyed WITHOUT the prefetch param, so a
// later play hits it); a normal play → stream Range from the network NOW and
// cache the full body in the BACKGROUND (so the next play + offline are served
// from cache — all listened audio becomes offline-available with no toggle). The
// audio element's 206 Range responses are uncacheable, which is why both caching
// paths fetch the full 200 instead.
async function audioHandler(event, url) {
  const req = event.request;
  const cache = await caches.open(AUDIO_CACHE);
  const isPrefetch = url.searchParams.has("prefetch");
  const keyUrl = new URL(url.href);
  keyUrl.searchParams.delete("prefetch");
  const key = new Request(keyUrl.href, { method: "GET" });

  const cached = await cache.match(key);
  if (cached) return rangeFromResponse(cached, req.headers.get("range"));

  if (isPrefetch) {
    try {
      const full = await fetch(key.url); // no Range ⇒ full 200
      if (full && full.status === 200) await cache.put(key, full.clone());
      return full;
    } catch {
      return new Response("offline", { status: 504 });
    }
  }

  // Normal play: warm the cache in the background (once) so the next play +
  // offline hit it, without slowing this first play (which streams Range below).
  event.waitUntil(
    (async () => {
      try {
        if (await cache.match(key)) return; // a concurrent play already cached it
        const full = await fetch(key.url); // no Range ⇒ full 200
        if (full && full.status === 200) await cache.put(key, full.clone());
      } catch {
        // best-effort; the next play retries
      }
    })(),
  );
  return fetch(req); // stream this play from the network meanwhile
}

// Cache-the-full-body, serve-Range media handler (immutable /api/blob). Fetch the
// FULL body once (no Range → 200), cache keyed by URL, slice the requested range.
async function mediaCacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const key = new Request(req.url, { method: "GET" });
  let cached = await cache.match(key);
  if (!cached) {
    try {
      const full = await fetch(req.url); // no Range header ⇒ full 200
      if (full && full.status === 200) {
        await cache.put(key, full.clone());
        cached = full;
      } else {
        // e.g. an on-demand 202/"generating" or an error — don't cache, pass through.
        return fetch(req);
      }
    } catch {
      const c = await cache.match(key);
      if (c) cached = c;
      else return new Response("offline", { status: 504 });
    }
  }
  return rangeFromResponse(cached, req.headers.get("range"));
}

async function rangeFromResponse(full, rangeHeader) {
  if (!rangeHeader) return full;
  const buf = await full.arrayBuffer();
  const total = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if (Number.isNaN(start)) start = 0;
  if (Number.isNaN(end) || end >= total) end = total - 1;
  if (start > end || start >= total) {
    // Unsatisfiable — hand back the whole body.
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": full.headers.get("Content-Type") || "audio/mpeg",
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
      },
    });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": full.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}
