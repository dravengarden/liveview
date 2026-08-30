import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appshellActivate,
  appshellCurrent,
  appshellHas,
  cacheCount,
  cacheDelete,
  cacheFromUrl,
  cacheHas,
  fetchHostOrigins,
  HOST_CMD_HAPTIC_IMPACT,
  HOST_CMD_HAPTIC_NOTIFICATION,
  HOST_CMD_HAPTIC_SELECTION,
  HOST_ORIGIN,
  HOST_PROTOCOL,
  HOST_PROTOCOL_V1_APPSHELL_ROUTES,
  HOST_PROTOCOL_V1_CACHE_KINDS,
  HOST_PROTOCOL_V1_MEDIA_KINDS,
  HOST_PROTOCOL_V1_NAV_TYPES,
  HOST_PROTOCOL_V1_TAURI_COMMANDS,
  hostAppVersion,
  hostAudioAvailable,
  hostInfo,
  hostNavAvailable,
  hostOpenUrl,
  LEGACY_AUDIO_STORE_KINDS,
  putFromUrl,
  setAllowsCellular,
} from "./native-host.ts";

/** LiveView-store kinds protocol v1 must not grow. */
const REJECTED_KINDS = [
  "pin",
  "unpin",
  "reconcile",
  "setCap",
  "audioStats",
  "sync_all",
] as const;

test("host protocol is frozen at v1 on lvsync://localhost", () => {
  assert.equal(HOST_PROTOCOL, 1);
  assert.equal(HOST_ORIGIN, "lvsync://localhost");
});

test("protocol v1 allow-lists reject LiveView-store kinds", () => {
  const allowed = new Set<string>([
    ...HOST_PROTOCOL_V1_MEDIA_KINDS,
    ...HOST_PROTOCOL_V1_NAV_TYPES,
    ...HOST_PROTOCOL_V1_CACHE_KINDS,
    ...HOST_PROTOCOL_V1_APPSHELL_ROUTES,
    ...HOST_PROTOCOL_V1_TAURI_COMMANDS,
    ...LEGACY_AUDIO_STORE_KINDS,
  ]);
  const v1 = new Set<string>([
    ...HOST_PROTOCOL_V1_MEDIA_KINDS,
    ...HOST_PROTOCOL_V1_NAV_TYPES,
    ...HOST_PROTOCOL_V1_CACHE_KINDS,
    ...HOST_PROTOCOL_V1_APPSHELL_ROUTES,
  ]);
  for (const kind of REJECTED_KINDS) {
    assert.equal(
      v1.has(kind),
      false,
      `${kind} must not be in host protocol v1`,
    );
  }
  assert.equal(v1.has("/sync_all"), false);
  assert.equal(v1.has("/resolve"), false);
  assert.equal(v1.has("/stats"), false);
  assert.equal(v1.has("/legacy-index"), false);
  assert.equal(v1.has("/legacy-wipe"), false);
  for (
    const kind of [
      "pin",
      "unpin",
      "reconcile",
      "setCap",
      "audioStats",
    ] as const
  ) {
    assert.ok(
      (LEGACY_AUDIO_STORE_KINDS as readonly string[]).includes(kind),
      `${kind} is listed as rejected, not protocol v1`,
    );
    assert.equal(
      (HOST_PROTOCOL_V1_MEDIA_KINDS as readonly string[]).includes(kind),
      false,
    );
    assert.equal(
      (HOST_PROTOCOL_V1_CACHE_KINDS as readonly string[]).includes(kind),
      false,
    );
  }
  assert.ok(allowed.has("load"));
  assert.ok(allowed.has("push"));
  assert.ok(allowed.has("cacheFromUrl"));
  assert.ok(allowed.has("/host-info"));
  assert.ok(allowed.has("/origins"));
  assert.deepEqual([...HOST_PROTOCOL_V1_NAV_TYPES], ["push", "pop", "ready"]);
});

test("legacy audio store kinds are not protocol v1 media or cache", () => {
  const v1MediaAndCache = new Set<string>([
    ...HOST_PROTOCOL_V1_MEDIA_KINDS,
    ...HOST_PROTOCOL_V1_CACHE_KINDS,
  ]);
  for (const kind of LEGACY_AUDIO_STORE_KINDS) {
    assert.equal(
      v1MediaAndCache.has(kind),
      false,
      `${kind} is legacy-forwarded, not frozen v1`,
    );
  }
});

test("future wrappers exist and no-op when native APIs are absent", async () => {
  assert.equal(typeof cacheFromUrl, "function");
  assert.equal(typeof cacheHas, "function");
  assert.equal(typeof cacheDelete, "function");
  assert.equal(typeof cacheCount, "function");
  assert.equal(typeof setAllowsCellular, "function");
  assert.equal(typeof hostInfo, "function");
  assert.equal(typeof putFromUrl, "function");
  assert.equal(typeof appshellCurrent, "function");
  assert.equal(typeof appshellHas, "function");
  assert.equal(typeof appshellActivate, "function");
  assert.equal(typeof fetchHostOrigins, "function");
  assert.equal(typeof hostAppVersion, "function");
  assert.equal(typeof hostOpenUrl, "function");

  assert.equal(hostAudioAvailable(), false);
  assert.equal(hostNavAvailable(), false);

  assert.equal(
    cacheFromUrl({ url: "https://example.test/a.bin", hash: "abc" }),
    false,
  );
  assert.equal(cacheFromUrl({ url: "/api/blob/abc", hash: "abc" }), false);
  assert.deepEqual(await cacheHas({ hash: "abc" }), { has: false });
  assert.equal(cacheDelete({ hash: "abc" }), false);
  assert.deepEqual(await cacheCount(), { count: 0 });
  assert.equal(setAllowsCellular({ on: false }), false);

  assert.equal(await hostInfo(), null);
  assert.equal(await putFromUrl("assets/index.js"), null);
  assert.equal(await appshellCurrent(), "");
  assert.equal(await appshellHas("assets/index.js"), false);
  assert.equal(await appshellActivate("1"), false);
  assert.equal(await fetchHostOrigins(), null);
  assert.equal(await hostAppVersion(), null);
  assert.equal(await hostOpenUrl("https://example.test"), false);
});

test("cacheFromUrl forwards optional integrity bytes additively", () => {
  const scope = globalThis as unknown as {
    webkit?: {
      messageHandlers?: Record<
        string,
        { postMessage: (message: unknown) => void }
      >;
    };
  };
  const previous = scope.webkit;
  const seen: unknown[] = [];
  scope.webkit = {
    messageHandlers: {
      lvNativeAudio: { postMessage: (message) => seen.push(message) },
    },
  };
  try {
    assert.equal(
      cacheFromUrl({
        url: "https://example.test/audio.caf",
        hash: "abc",
        bytes: 123456,
      }),
      true,
    );
  } finally {
    if (previous) scope.webkit = previous;
    else delete scope.webkit;
  }
  assert.deepEqual(seen, [{
    kind: "cacheFromUrl",
    data: {
      url: "https://example.test/audio.caf",
      hash: "abc",
      bytes: 123456,
    },
  }]);
});

test("putFromUrl is path-only and never sends u=", async () => {
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
    seen.push({ url, method: init?.method ?? "GET" });
    return Promise.reject(new Error("no host"));
  };
  try {
    await putFromUrl("assets/index-abc.js");
    await putFromUrl("index.html", "1.2.3");
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.method, "POST");
    assert.ok(call.url.startsWith(`${HOST_ORIGIN}/appshell/putFromUrl?`));
    const parsed = new URL(call.url);
    assert.equal(parsed.searchParams.has("u"), false);
    assert.ok(parsed.searchParams.has("p"));
  }
  assert.equal(seen[0]?.url.includes("assets"), true);
  assert.equal(new URL(seen[1]!.url).searchParams.get("v"), "1.2.3");
});

test("existing native call sites keep protocol v1 wire shapes", async () => {
  const root = new URL("./", import.meta.url);
  const apiBase = await readFile(new URL("apiBase.ts", root), "utf8");
  const audio = await readFile(new URL("native-audio.ts", root), "utf8");
  const nav = await readFile(new URL("native-nav.ts", root), "utf8");
  const haptics = await readFile(new URL("_shell/haptics.ts", root), "utf8");
  assert.ok(audio.includes("postHostAudio"));
  assert.ok(nav.includes("postHostNav"));
  assert.ok(haptics.includes("invokeHost"));
  for (const kind of HOST_PROTOCOL_V1_MEDIA_KINDS) {
    assert.ok(
      audio.includes(`kind: "${kind}"`),
      `audio still posts { kind: "${kind}" }`,
    );
  }
  for (const type of HOST_PROTOCOL_V1_NAV_TYPES) {
    assert.ok(
      nav.includes(`type: "${type}"`),
      `nav still posts { type: "${type}" }`,
    );
  }
  assert.equal(HOST_CMD_HAPTIC_IMPACT, "plugin:haptics|impact_feedback");
  assert.equal(
    HOST_CMD_HAPTIC_NOTIFICATION,
    "plugin:haptics|notification_feedback",
  );
  assert.equal(HOST_CMD_HAPTIC_SELECTION, "plugin:haptics|selection_feedback");
  assert.ok(haptics.includes("HOST_CMD_HAPTIC_IMPACT"));
  assert.ok(haptics.includes("HOST_CMD_HAPTIC_NOTIFICATION"));
  assert.ok(haptics.includes("HOST_CMD_HAPTIC_SELECTION"));
  assert.ok(apiBase.includes("${HOST_ORIGIN}/origins"));
  assert.equal(apiBase.includes("lvsync://localhost/origins"), false);
});
