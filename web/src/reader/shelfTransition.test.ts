import { test } from "bun:test";
import assert from "node:assert/strict";
import { leaveShelf, returnToShelf, type SnapshotNav } from "./shelfTransition.ts";

function recorder(held: boolean): { nav: SnapshotNav; log: string[]; flush: () => void } {
  const log: string[] = [];
  let frames: (() => void)[] = [];
  return {
    log,
    nav: {
      push: (slug) => log.push(`push:${slug}`),
      pop: () => {
        log.push("pop");
        return held;
      },
      ready: () => log.push("ready"),
      frame: (cb) => {
        log.push("frame");
        frames.push(cb);
      },
    },
    flush: () => {
      const run = frames;
      frames = [];
      run.forEach((cb) => cb());
    },
  };
}

test("entering a book captures the shelf before the route commits", () => {
  const { nav, log } = recorder(true);
  leaveShelf(nav, "book", () => log.push("commit"));
  assert.deepEqual(log, ["push:book", "commit"]);
});

test("returning shows the snapshot first and releases it after two painted frames", () => {
  const { nav, log, flush } = recorder(true);
  returnToShelf(nav, () => log.push("commit"));
  assert.deepEqual(log, ["pop", "commit", "frame"]);
  flush();
  assert.deepEqual(log, ["pop", "commit", "frame", "frame"]);
  flush();
  assert.deepEqual(log, ["pop", "commit", "frame", "frame", "ready"]);
});

test("off the native shell the return commits without waiting for frames", () => {
  const { nav, log } = recorder(false);
  returnToShelf(nav, () => log.push("commit"));
  assert.deepEqual(log, ["pop", "commit"]);
});
