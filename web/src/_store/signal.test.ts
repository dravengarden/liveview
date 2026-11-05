import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSignal } from "./signal.ts";

test("a signal delivers to every subscriber in order and stops after unsubscribe", () => {
  const signal = createSignal<number>();
  const seen: string[] = [];
  const offA = signal.subscribe((n) => seen.push(`a${n}`));
  signal.subscribe((n) => seen.push(`b${n}`));
  signal.emit(1);
  offA();
  signal.emit(2);
  assert.deepEqual(seen, ["a1", "b1", "b2"]);
});

test("a listener may unsubscribe during delivery without skipping the others", () => {
  const signal = createSignal();
  const seen: string[] = [];
  const offSelf = signal.subscribe(() => {
    seen.push("self");
    offSelf();
  });
  signal.subscribe(() => seen.push("other"));
  signal.emit();
  signal.emit();
  assert.deepEqual(seen, ["self", "other", "other"]);
});
