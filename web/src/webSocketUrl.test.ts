import assert from "node:assert/strict";
import { test } from "node:test";
import { webSocketUrl } from "./webSocketUrl.ts";

test("native WebSocket uses the selected HTTP backend", () => {
  assert.equal(
    webSocketUrl(true, "http://192.168.0.96:4160", {
      protocol: "lvsync:",
      host: "localhost",
    }),
    "ws://192.168.0.96:4160/ws",
  );
});

test("native WebSocket upgrades HTTPS to WSS", () => {
  assert.equal(
    webSocketUrl(true, "https://liveview.example.test", {
      protocol: "lvsync:",
      host: "localhost",
    }),
    "wss://liveview.example.test/ws",
  );
});

test("browser WebSocket remains same-origin", () => {
  assert.equal(
    webSocketUrl(false, "http://ignored.test", {
      protocol: "https:",
      host: "reader.example.test",
    }),
    "wss://reader.example.test/ws",
  );
});
