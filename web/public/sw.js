// Build-stamped atomic offline shell. IDB owns content; its browser audio
// worker owns verified immutable payloads, under the shared pin/LRU/byte cap.
const VERSION = "lv-dev";
const SHELL_ASSETS = [];
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const AUDIO_CACHE = "lv-audio-blobs";
const CONTENT_CACHE = "lv-content";
const SHELL = ["/", "/index.html", "/favicon.svg", "/manifest.webmanifest",
  "/icon-192.png", "/icon-512.png", "/maskable-512.png", "/apple-touch-icon.png",
].concat(SHELL_ASSETS);

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(4, SHELL.length) }, async () => {
    while (!failure && next < SHELL.length) {
      const path = SHELL[next++];
      try {
        await cache.addAll([path]);
        const cached = await cache.match(path);
        // SPA fallbacks and expired-login redirects can return HTTP 200 HTML
        // for a missing chunk. Such a shell must never replace the working one.
        if (/\.(?:js|css|woff2?|png|svg|webmanifest)$/.test(path) &&
          cached?.headers.get("Content-Type")?.includes("text/html")) {
          throw new Error("Shell asset returned HTML");
        }
      }
      catch (error) { failure = error || new Error("Shell install failed"); }
    }
  }));
  if (failure) {
    await caches.delete(SHELL_CACHE);
    throw failure;
  }
}

self.addEventListener("install", (event) => {
  // Updates wait for a user tap. First install activates automatically.
  event.waitUntil(precacheShell());
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) =>
      /^lv-[a-f0-9]+-(shell|runtime|api|audio)$/.test(key) &&
      key !== SHELL_CACHE && key !== RUNTIME_CACHE
    ).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Never update index.html independently from its hashed asset graph.
      return await cache.match("/index.html") || fetch(req);
    })());
    return;
  }
  if (/^\/api\/blob\/[a-f0-9]{64}$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await (await caches.open(AUDIO_CACHE)).match(url.href);
      if (cached) return rangeFromResponse(cached, req.headers.get("range"));
      // Existing installs retain listened audio while the replica verifies and
      // migrates each hash into the bounded store on its next download pass.
      const legacy = await (await caches.open("lv-blobs")).match(url.href);
      return legacy ? rangeFromResponse(legacy, req.headers.get("range")) : fetch(req);
    })());
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    event.respondWith((async () => {
      // IDB handles content and queued writes. Legacy cache is read-only during
      // migration, never a second source of truth populated by the new worker.
      try { return await fetch(req); }
      catch (error) {
        const cached = await (await caches.open(CONTENT_CACHE)).match(req);
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      return await cache.match(url.pathname) || fetch(req);
    })());
    return;
  }
  const network = (async () => {
    const response = await fetch(req);
    if (response.status === 200) await (await caches.open(RUNTIME_CACHE)).put(req, response.clone());
    return response;
  })();
  event.waitUntil(network.then(() => undefined).catch(() => undefined));
  event.respondWith((async () => await (await caches.open(RUNTIME_CACHE)).match(req) || network)());
});

async function rangeFromResponse(full, rangeHeader) {
  if (!rangeHeader) return full;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) return full;
  const body = await full.blob();
  const total = body.size;
  const suffix = !match[1];
  const start = suffix ? Math.max(0, total - Number(match[2])) : Number(match[1]);
  const end = suffix || !match[2] ? total - 1 : Math.min(Number(match[2]), total - 1);
  const headers = new Headers(full.headers);
  headers.set("Accept-Ranges", "bytes");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) {
    headers.set("Content-Range", `bytes */${total}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  headers.delete("Content-Encoding");
  headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}
