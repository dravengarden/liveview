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
      "assets/index-new.js",
    ),
    "lvsync://localhost/app/?theme=dark&lv-ota=assets%2Findex-new.js#sui/chapter-2",
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
      return Promise.resolve(new Response("assets/index-old.js", { status: 200 }));
    }
    if (url.includes("/app-dist/manifest.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: "assets/index-new.js",
            files: ["index.html", "assets/chunk.js"],
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
    "assets/index-new.js",
  );
  assert.equal(replaced.length, 1);
  assert.equal(
    replaced[0],
    otaReloadUrl(href, "assets/index-new.js"),
  );
  assert.ok(replaced[0]?.startsWith("lvsync://localhost/app/"));
});
