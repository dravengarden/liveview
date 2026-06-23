// LiveView service worker — offline app shell + content + media.
//
// Hand-rolled (no Workbox). VERSION and SHELL_ASSETS are STAMPED AT BUILD TIME
// by the `lv-stamp-sw` Vite plugin (web/vite.config.ts):
//   - VERSION  → a content hash of the shipped app-shell asset set, so a UI
//     change auto-invalidates the shell/runtime/api caches and an unchanged
//     redeploy is a no-op. No hand-bumped magic string to forget.
//   - SHELL_ASSETS → the exact hashed /assets/*.js + *.css that index.html boots
//     from, so the offline shell is precached ATOMICALLY with the code it needs:
//     install caches index.html AND its chunks together, or fails and leaves the
//     old SW serving — never a half-cached shell that white-screens because a
//     referenced chunk is missing.
// The "lv-dev" / [] values below are the dev placeholders an unstamped build
// carries (the SW only registers in PROD); the plugin asserts it replaced both.
// The immutable content-addressed BLOB cache is version-INDEPENDENT (it survives
// deploys — its keys are content hashes).
const VERSION = "lv-dev";
// Build-stamped: the exact hashed /assets/*.js + *.css index.html loads.
const SHELL_ASSETS = [];
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const API_CACHE = `${VERSION}-api`;
// Audio (path-keyed, mutable) — versioned so a deploy clears it (re-fetched on
// next play). Big bodies; served with Range-from-cache so seeking works offline.
const AUDIO_CACHE = `${VERSION}-audio`;
// Content-addressed immutable blobs (/api/blob/<hash>) — NOT version-prefixed,
// so the offline library survives deploys (an immutable hash never goes stale).
const BLOB_CACHE = "lv-blobs";
// Reader CONTENT (text html, spoken, units, marks, tree, books, raw/cover/artwork,
// manifest) — PERSISTENT (NOT version-prefixed), so what you've read stays
// offline-available ACROSS deploys. Served network-first: fresh when online
// (an author iterating still sees edits immediately), last-good cache when
// offline or right after a deploy. This is the fix for "部署后离线文本失效":
// content used to land in the version-prefixed API_CACHE, which `activate` wipes
// on every deploy. Mutable per-request STATE (progress/settings/tasks/version)
// stays in API_CACHE — it SHOULD reset on deploy and is re-pulled live.
const CONTENT_CACHE = "lv-content";

// Path → which cache. Content endpoints are offline-critical + deploy-stable;
// everything else under /api stays in the version-scoped API_CACHE.
const CONTENT_API = [
  "/api/file",
  "/api/spoken",
  "/api/units",
  "/api/marks",
  "/api/tree",
  "/api/books",
  "/api/raw",
  "/api/cover",
  "/api/artwork",
  "/api/manifest",
  // The lv-sync corpus manifest (root + every resource hash/url). The WASM core
  // fetches this once at init to know what's resolvable; it MUST be cache-first
  // so the core can boot OFFLINE (a network-first miss would hang on iOS and the
  // whole offline data layer would never initialise).
  "/api/dag",
  // Reading progress (shelf % + per-book resume). Mutable, so network-first =
  // fresh online; but persisting it means the shelf %/resume survive OFFLINE and
  // across deploys (last-good) instead of resetting. Covers /api/progress AND
  // /api/progress/recent (prefix match). Writes (PUT) still go straight to the
  // server when online; the active session is also mirrored to IndexedDB.
  "/api/progress",
];
function isContentApi(pathname) {
  return CONTENT_API.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

// The app shell: the static entry points PLUS the build-stamped hashed chunks
// index.html boots from — precached as one atomic unit so the offline / network-
// first-fallback shell is always bootable, never an index.html whose code 404s.
const SHELL = ["/", "/index.html", "/favicon.svg", "/manifest.webmanifest"].concat(
  SHELL_ASSETS,
);

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
            // Keep this VERSION's caches AND the persistent content-addressed
            // (blob) + reader-content caches; drop the rest. The persistent caches
            // are what make the offline library survive a deploy.
            .filter((k) =>
              !k.startsWith(VERSION) && k !== BLOB_CACHE && k !== CONTENT_CACHE
            )
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

  // SPA navigations: serve the cached shell INSTANTLY, revalidate in the
  // background. A network-FIRST navigate HANGS on iOS WKWebView when offline
  // (offline fetch() doesn't fail fast there like Chromium), so the app would
  // sit blank/"connecting". Cache-first boots the shell with zero network.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("/index.html").then((cached) => {
        const net = fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              caches.open(SHELL_CACHE).then((c) => c.put("/index.html", res.clone()));
            }
            return res;
          })
          .catch(() => cached);
        return cached || net;
      }),
    );
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
    if (url.pathname.startsWith("/api/")) {
      // Reader CONTENT → CACHE-FIRST + background revalidate, from the PERSISTENT
      // cache. Serving the cache with NO network wait is essential on iOS
      // WKWebView, where an offline fetch() HANGS for tens of seconds instead of
      // failing fast like Chromium — a network-first content fetch made a card tap
      // / chapter open appear DEAD offline (the real root cause). Mutable state
      // (progress/settings/tasks/version) stays network-first in API_CACHE.
      event.respondWith(
        isContentApi(url.pathname)
          ? cacheFirstRevalidate(req, CONTENT_CACHE)
          : networkFirst(req, API_CACHE),
      );
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

// CACHE-FIRST + background revalidate, for reader content. A cache HIT returns
// INSTANTLY (no network await) — critical on iOS WKWebView, whose offline
// fetch() hangs for tens of seconds rather than failing fast, which made a
// network-first content fetch (a card tap → /api/tree, a chapter open →
// /api/file) appear dead offline. On a MISS we must hit the network, but with a
// short timeout so offline-uncached rejects FAST (the app shows its offline
// placeholder) instead of hanging.
async function cacheFirstRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    // Fire-and-forget refresh; never blocks the response, never throws.
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) cache.put(req, res.clone());
      })
      .catch(() => {});
    return cached;
  }
  // Not cached → go to network, but cap the wait so an offline miss fails fast.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(req, { signal: ctrl.signal });
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch {
    return new Response("offline", {
      status: 504,
      headers: { "Content-Type": "text/plain" },
    });
  } finally {
    clearTimeout(timer);
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
  // Final fallback before a bare network retry: a cross-cache lookup, so a
  // chunk precached in SHELL_CACHE (the offline shell) is still served when the
  // RUNTIME_CACHE misses AND the network is down — without this, an offline
  // boot off the precached shell would 404 its own code.
  return cached || (await network) || (await caches.match(req)) || fetch(req);
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
