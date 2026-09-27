import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { centerWithin } from "./scrollWithin.ts";

test("following a sentence in a translated reader only scrolls its own vertical axis", () => {
  const calls: ScrollToOptions[] = [];
  const scroller = {
    scrollTop: 100,
    scrollHeight: 2000,
    clientHeight: 600,
    clientTop: 2,
    getBoundingClientRect: () => ({ top: 50, left: 336 }),
    scrollTo: (options: ScrollToOptions) => calls.push(options),
  } as unknown as HTMLElement;
  const target = {
    getBoundingClientRect: () => ({ top: 752, left: 352, height: 40 }),
    scrollIntoView: () => {
      throw new Error("Ancestor scrolling is forbidden");
    },
  } as unknown as Element;
  centerWithin(scroller, target);
  deepStrictEqual(calls, [{ top: 520, behavior: "smooth" }]);
});

test("sentence centering clamps at both content edges and skips an already centered line", () => {
  const calls: ScrollToOptions[] = [];
  const scroller = {
    scrollTop: 100,
    scrollHeight: 1000,
    clientHeight: 600,
    clientTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo: (options: ScrollToOptions) => calls.push(options),
  } as unknown as HTMLElement;
  for (const top of [0, 990, 290]) {
    centerWithin(scroller, {
      getBoundingClientRect: () => ({ top, height: 20 }),
    } as unknown as Element);
  }
  deepStrictEqual(calls, [
    { top: 0, behavior: "smooth" },
    { top: 400, behavior: "smooth" },
  ]);
});
