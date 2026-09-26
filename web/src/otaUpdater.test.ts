import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { otaReloadUrl } from "./otaReloadUrl.ts";
import { HOST_ORIGIN } from "./native-host.ts";
import { runOtaCheck } from "./otaUpdater.ts";

test("OTA updater retries across every iOS foreground recovery surface", async () => {
  const source = await readFile(new URL("./otaUpdater.ts", import.meta.url), "utf8");
  for (const event of ["visibilitychange", "pageshow", "focus", "online"]) {
    assert.match(source, new RegExp(`addEventListener\\(\"${event}\"`));
  }
  assert.match(source, /setInterval\(checkForUpdate, 60_000\)/);
  assert.match(source, /visibilityState !== "hidden"/);
});

test("OTA reload URL cache-busts the WebView while preserving reader state", () => {
  assert.equal(
    otaReloadUrl(
      "lvsync://localhost/app/?theme=dark#sui/chapter-2",
      "index-new.js",
    ),
    "lvsync://localhost/app/?theme=dark&lv-ota=index-new.js#sui/chapter-2",
  );
});

test("runOtaCheck uses path-only putFromUrl and reloads lvsync://localhost/app", async () => {
  Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: () => Promise.resolve() },
  });
  const href = "lvsync://localhost/app/?theme=dark#sui/chapter-2";
  const replaced: string[] = [];
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      href,
      protocol: "lvsync:",
      replace: (url: string) => {
        replaced.push(url);
      },
    },
  });

  const seen: { url: string; method: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const method = init?.method ?? "GET";
    seen.push({ url, method });
    if (url === `${HOST_ORIGIN}/host-info`) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            protocol: 1,
            nativeVersion: "0.1.0",
            debugEmbedded: false,
          }),
          { status: 200 },
        ),
      );
    }
    if (url === `${HOST_ORIGIN}/appshell/current`) {
      return Promise.resolve(new Response("index-old.js", { status: 200 }));
    }
    if (url.includes("/app-dist/manifest.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: "index-new.js",
            files: ["index.html", "chunk.js"],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.startsWith(`${HOST_ORIGIN}/appshell/has?`)) {
      return Promise.resolve(new Response("0", { status: 200 }));
    }
    if (url.startsWith(`${HOST_ORIGIN}/appshell/putFromUrl?`)) {
      return Promise.resolve(new Response("ok", { status: 200 }));
    }
    if (url.startsWith(`${HOST_ORIGIN}/appshell/activate?`)) {
      return Promise.resolve(new Response("ok", { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  };

  try {
    await runOtaCheck();
  } finally {
    globalThis.fetch = orig;
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
  }

  assert.equal(
    seen.some((c) => c.url.includes("/ota-check")),
    false,
    "TS must not call native /ota-check",
  );
  const puts = seen.filter((c) => c.url.includes("/appshell/putFromUrl"));
  assert.ok(puts.length >= 2);
  for (const call of puts) {
    assert.equal(call.method, "POST");
    const parsed = new URL(call.url);
    assert.equal(parsed.searchParams.has("u"), false);
    assert.ok(parsed.searchParams.has("p"));
  }
  const indexPut = puts.find((c) =>
    new URL(c.url).searchParams.get("p") === "index.html"
  );
  assert.equal(
    indexPut && new URL(indexPut.url).searchParams.get("v"),
    "index-new.js",
  );
  assert.equal(replaced.length, 1);
  assert.equal(
    replaced[0],
    otaReloadUrl(href, "index-new.js"),
  );
  assert.ok(replaced[0]?.startsWith("lvsync://localhost/app/"));
});

test("runOtaCheck does not activate when a deploy lands during the download", async () => {
  Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
    configurable: true,
    value: { invoke: () => Promise.resolve() },
  });
  const replaced: string[] = [];
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      href: "lvsync://localhost/app/",
      protocol: "lvsync:",
      replace: (url: string) => {
        replaced.push(url);
      },
    },
  });

  let indexStored = false;
  const seen: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    seen.push(url);
    if (url === `${HOST_ORIGIN}/host-info`) {
      return Promise.resolve(
        new Response(JSON.stringify({ protocol: 1, debugEmbedded: false }), {
          status: 200,
        }),
      );
    }
    if (url === `${HOST_ORIGIN}/appshell/current`) {
      return Promise.resolve(new Response("index-old.js", { status: 200 }));
    }
    if (url.includes("/app-dist/manifest.json")) {
      // The server moves to index-next.js once the index has been downloaded.
      const version = indexStored ? "index-next.js" : "index-new.js";
      return Promise.resolve(
        new Response(
          JSON.stringify({ version, files: ["index.html", "chunk.js"] }),
          { status: 200 },
        ),
      );
    }
    if (url.startsWith(`${HOST_ORIGIN}/appshell/has?`)) {
      return Promise.resolve(new Response("0", { status: 200 }));
    }
    if (url.startsWith(`${HOST_ORIGIN}/appshell/putFromUrl?`)) {
      if (new URL(url).searchParams.get("p") === "index.html") {
        indexStored = true;
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    }
    if (url.startsWith(`${HOST_ORIGIN}/appshell/activate?`)) {
      return Promise.resolve(new Response("ok", { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  };

  try {
    // A fresh module instance: the earlier test leaves `applying` set, as a
    // real reload would discard the page.
    const specifier: string = "./otaUpdater.ts?mixed-deploy";
    const fresh = (await import(specifier)) as {
      runOtaCheck: typeof runOtaCheck;
    };
    await fresh.runOtaCheck();
  } finally {
    globalThis.fetch = orig;
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
  }

  assert.ok(indexStored);
  assert.equal(
    seen.some((url) => url.includes("/appshell/activate")),
    false,
    "a mixed-deploy index must never be activated",
  );
  assert.equal(replaced.length, 0);
});
