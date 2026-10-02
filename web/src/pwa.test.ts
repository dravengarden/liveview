import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  deleteCachedAudio,
  verifyAudioBody,
} from "./replica/pwa-audio-worker.ts";

const source = await readFile(
  new URL("../public/sw.js", import.meta.url),
  "utf8",
);

test("updates never force a reload from the shelf while downloads or playback are active", async () => {
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /if\s*\(currentPath\s*===\s*null\).*applyUpdate\(/);
});
function harness(failPath?: string, htmlPath?: string) {
  const stores = new Map<string, Map<string, Response>>();
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const fetched: string[] = [];
  let skipped = 0;
  let activeAdds = 0;
  let maxAdds = 0;
  const cache = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    return {
      match: async (key: string | Request) =>
        store.get(typeof key === "string" ? key : key.url)?.clone(),
      addAll: async (keys: string[]) => {
        activeAdds += 1;
        maxAdds = Math.max(maxAdds, activeAdds);
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (keys.includes(failPath ?? "")) {
            throw new Error("Shell install failed");
          }
          for (const key of keys) {
            store.set(
              key,
              new Response(key, {
                headers: {
                  "Content-Type": key === htmlPath ? "text/html" : "text/plain",
                },
              }),
            );
          }
        } finally {
          activeAdds -= 1;
        }
      },
      put: async (key: string | Request, response: Response) => {
        store.set(typeof key === "string" ? key : key.url, response);
      },
    };
  };
  const context = vm.createContext({
    self: {
      location: { origin: "https://reader.test" },
      addEventListener: (
        name: string,
        fn: (event: Record<string, unknown>) => void,
      ) => listeners.set(name, fn),
      skipWaiting: async () => {
        skipped += 1;
      },
      clients: { claim: async () => {} },
    },
    caches: {
      open: async (name: string) => cache(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    fetch: async (request: Request) => {
      fetched.push(request.url);
      throw new Error("offline");
    },
    URL,
    Request,
    Response,
    Headers,
    Promise,
  });
  vm.runInContext(source, context);
  return {
    context,
    stores,
    cache,
    listeners,
    fetched,
    skipped: () => skipped,
    maxAdds: () => maxAdds,
  };
}

test("shell installation bounds requests and a failed install leaves the old shell intact", async () => {
  const h = harness("/icon-512.png");
  await h.cache("lv-abcdef-shell").put(
    "/index.html",
    new Response("last good"),
  );
  let done: Promise<void> | undefined;
  h.listeners.get("install")?.({
    waitUntil: (value: Promise<void>) => {
      done = value;
    },
  });
  await assert.rejects(done!, /Shell install failed/);
  assert.ok(h.maxAdds() <= 4);
  assert.ok(h.maxAdds() > 1);
  assert.equal(h.stores.has("lv-dev-shell"), false);
  assert.equal(
    await (await h.cache("lv-abcdef-shell").match("/index.html"))?.text(),
    "last good",
  );
  assert.equal(h.skipped(), 0);
});

test("an HTTP 200 HTML fallback cannot replace a working offline shell", async () => {
  const h = harness(undefined, "/manifest.webmanifest");
  await h.cache("lv-abcdef-shell").put(
    "/index.html",
    new Response("last good"),
  );
  let done: Promise<void> | undefined;
  h.listeners.get("install")?.({
    waitUntil: (value: Promise<void>) => {
      done = value;
    },
  });
  await assert.rejects(done!, /Shell asset returned HTML/);
  assert.equal(h.stores.has("lv-dev-shell"), false);
  assert.equal(
    await (await h.cache("lv-abcdef-shell").match("/index.html"))?.text(),
    "last good",
  );
});

test("offline audio accepts suffix/open ranges and returns HTTP 416 for unsatisfiable ranges", async () => {
  const { context } = harness();
  const range = context["rangeFromResponse"] as (
    body: Response,
    header: string,
  ) => Promise<Response>;
  for (
    const [header, status, body, contentRange] of [
      ["bytes=-3", 206, "789", "bytes 7-9/10"],
      ["bytes=7-", 206, "789", "bytes 7-9/10"],
      ["bytes=1-3", 206, "123", "bytes 1-3/10"],
      ["bytes=20-", 416, "", "bytes */10"],
      ["bytes=-0", 416, "", "bytes */10"],
      ["bytes=7-2", 416, "", "bytes */10"],
      ["bytes=0-1,4-5", 200, "0123456789", null],
    ] as const
  ) {
    const response = await range(new Response("0123456789"), header);
    assert.equal(response.status, status, header);
    assert.equal(await response.text(), body, header);
    assert.equal(response.headers.get("Content-Range"), contentRange, header);
  }
});

test("offline navigation uses only its installed index, with no mixed-version revalidation", async () => {
  const h = harness();
  await h.cache("lv-dev-shell").put(
    "/index.html",
    new Response("installed shell"),
  );
  await h.cache("lv-other-shell").put(
    "/index.html",
    new Response("wrong shell"),
  );
  let response: Promise<Response> | undefined;
  h.listeners.get("fetch")?.({
    request: {
      url: "https://reader.test/deep/chapter",
      method: "GET",
      mode: "navigate",
    },
    respondWith: (value: Promise<Response>) => {
      response = value;
    },
  });
  assert.equal(await (await response)?.text(), "installed shell");
  assert.deepEqual(h.fetched, []);
});

test("install waits for complete shell and an explicit update tap", async () => {
  const h = harness();
  let done: Promise<void> | undefined;
  h.listeners.get("install")?.({
    waitUntil: (value: Promise<void>) => {
      done = value;
    },
  });
  await done;
  assert.equal(h.skipped(), 0);
  assert.ok(await h.cache("lv-dev-shell").match("/icon-192.png"));
  h.listeners.get("message")?.({
    data: { type: "SKIP_WAITING" },
    waitUntil: (value: Promise<void>) => {
      done = value;
    },
  });
  await done;
  assert.equal(h.skipped(), 1);
});

test("activation preserves audio, content and unrelated origin caches", async () => {
  const h = harness();
  for (
    const name of [
      "lv-abcdef-shell",
      "lv-audio-blobs",
      "lv-blobs",
      "lv-content",
      "another-app",
    ]
  ) h.cache(name);
  let done: Promise<void> | undefined;
  h.listeners.get("activate")?.({
    waitUntil: (value: Promise<void>) => {
      done = value;
    },
  });
  await done;
  assert.equal(h.stores.has("lv-abcdef-shell"), false);
  for (
    const name of ["lv-audio-blobs", "lv-blobs", "lv-content", "another-app"]
  ) assert.ok(h.stores.has(name), name);
});

test("audio is served from the shared payload store with offline seeking", async () => {
  const h = harness();
  const url = "https://reader.test/api/blob/" + "a".repeat(64);
  await h.cache("lv-audio-blobs").put(url, new Response("0123456789"));
  let response: Promise<Response> | undefined;
  h.listeners.get("fetch")?.({
    request: new Request(url, { headers: { Range: "bytes=-2" } }),
    respondWith: (value: Promise<Response>) => {
      response = value;
    },
  });
  assert.equal(await (await response)?.text(), "89");
  assert.deepEqual(h.fetched, []);
});

test("foreign origins and writes bypass LiveView's service worker", () => {
  const h = harness();
  for (
    const request of [
      new Request("https://other.test/assets/app.js"),
      new Request("https://reader.test/api/progress", { method: "PUT" }),
    ]
  ) {
    let intercepted = false;
    h.listeners.get("fetch")?.({
      request,
      respondWith: () => {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false);
  }
});

test("audio payload integrity uses the server's BLAKE3 identity", () => {
  const emptyHash =
    "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";
  assert.equal(verifyAudioBody(emptyHash, new Uint8Array()), true);
  assert.equal(verifyAudioBody(emptyHash, new Uint8Array([1])), false);
  assert.equal(verifyAudioBody("invalid", new Uint8Array()), false);
});

test("audio eviction removes both current and legacy playback payloads", async () => {
  const key = "https://reader.test/api/blob/evicted";
  const stores = new Map([
    ["lv-audio-blobs", new Set([key, "keep-current"])],
    ["lv-blobs", new Set([key, "keep-legacy"])],
  ]);
  await deleteCachedAudio(key, {
    open: async (name) =>
      ({
        delete: async (url: string) => stores.get(name)!.delete(url),
      }) as Cache,
  });
  assert.deepEqual([...stores.get("lv-audio-blobs")!], ["keep-current"]);
  assert.deepEqual([...stores.get("lv-blobs")!], ["keep-legacy"]);
});
