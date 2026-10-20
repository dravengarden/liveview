import assert from "node:assert/strict";
import { test } from "node:test";
import { ListeningSleepTimer, parseSleepMinutes } from "./sleep-timer";

test("the default arms one listen, not each resume or chapter", () => {
  const timer = new ListeningSleepTimer();
  assert.equal(timer.start(90), 90);
  timer.observe(5200);
  assert.equal(timer.start(90), null);
  assert.equal(timer.start(15), null, "changing the preference cannot shorten an active listen");
  timer.observe(0);
  assert.equal(timer.start(15), 15, "after expiry, the next listen uses the new preference");
});

test("temporary Off survives resume and chapters but not an explicit stop", () => {
  const timer = new ListeningSleepTimer();
  timer.choose(0);
  timer.observe(0);
  assert.equal(timer.start(90), null);
  timer.reset();
  assert.equal(timer.start(90), 90);
});

test("native reload preserves a running timer or a live Off choice", () => {
  const timer = new ListeningSleepTimer();
  timer.observe(4200);
  assert.equal(timer.start(90), null);
  const off = new ListeningSleepTimer();
  off.observe(0, true);
  assert.equal(off.start(90), null);
  const expired = new ListeningSleepTimer();
  expired.observe(0, false);
  assert.equal(expired.start(90), 90);
});

test("corrupt defaults cannot arm unbounded or negative timers", () => {
  for (const minutes of [0, 15, 30, 45, 60, 90]) assert.equal(parseSleepMinutes(String(minutes)), minutes);
  for (const raw of ["", "-15", "Infinity", "NaN", "10000", "1.5"]) {
    assert.throws(() => parseSleepMinutes(raw));
  }
});
