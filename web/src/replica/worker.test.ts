import assert from "node:assert/strict";
import { test } from "node:test";
import {
  joinRemoteUrl,
  replicaWorkerInitMessage,
  runWithTimeBudget,
} from "./worker.ts";

test("worker constructor payload includes remoteBase and origins", () => {
  const msg = replicaWorkerInitMessage("https://example.test", [
    "https://example.test",
    "https://origin.test",
  ]);
  assert.equal(msg.type, "init");
  assert.equal(msg.remoteBase, "https://example.test");
  assert.deepEqual(msg.origins, ["https://example.test", "https://origin.test"]);
});

test("joinRemoteUrl builds absolute URLs for worker fetches", () => {
  assert.equal(
    joinRemoteUrl("https://example.test", "/api/blob/abc"),
    "https://example.test/api/blob/abc",
  );
  assert.equal(
    joinRemoteUrl("https://example.test/", "api/blob/abc"),
    "https://example.test/api/blob/abc",
  );
  assert.equal(
    joinRemoteUrl("https://example.test", "https://cdn.test/x"),
    "https://cdn.test/x",
  );
  assert.equal(
    joinRemoteUrl("https://example.test", "lvsync://localhost/x"),
    "lvsync://localhost/x",
  );
});

test("main-thread fallback honors a 16 ms time budget", async () => {
  const yields: number[] = [];
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    yields.push(ms ?? 0);
    return orig(fn as (...rest: unknown[]) => void, ms, ...args);
  }) as unknown as typeof setTimeout;
  try {
    const seen: number[] = [];
    await runWithTimeBudget([1, 2, 3], async (n) => {
      seen.push(n);
      await new Promise<void>((resolve) => {
        orig(resolve, 10);
      });
    }, 5);
    assert.deepEqual(seen, [1, 2, 3]);
    assert.ok(yields.some((ms) => ms === 0), "yielded between budget slices");
  } finally {
    globalThis.setTimeout = orig;
  }
});
