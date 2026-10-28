import assert from "node:assert/strict";
import { test } from "node:test";
import { KnownSettings } from "./knownSettings.ts";

test("adopting the server's own value is an echo", () => {
  const known = new KnownSettings();
  known.seed({ "audio.rate": "1.5" });
  assert.equal(known.isEcho("audio.rate", "1.5"), true);
  assert.equal(known.isEcho("audio.rate", "2"), false);
  assert.equal(known.isEcho("audio.pos", "{}"), false);
});

test("changing a value and changing it back still sends the second write", () => {
  const known = new KnownSettings();
  known.seed({ "audio.rate": "1.5" });
  known.note("audio.rate", "2");
  assert.equal(known.isEcho("audio.rate", "1.5"), false);
});

test("another device's push replaces the known value", () => {
  const known = new KnownSettings();
  known.seed({ "audio.rate": "1.5" });
  known.note("audio.rate", "1.25");
  assert.equal(known.isEcho("audio.rate", "1.5"), false);
  assert.equal(known.isEcho("audio.rate", "1.25"), true);
});

test("a bulk GET that resolves late never overrides a newer write or push", () => {
  const known = new KnownSettings();
  known.note("audio.rate", "2");
  known.seed({ "audio.rate": "1.5" });
  assert.equal(known.isEcho("audio.rate", "2"), true);
  assert.equal(known.isEcho("audio.rate", "1.5"), false);
});
