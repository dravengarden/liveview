import assert from "node:assert/strict";
import { test } from "node:test";
import { persisted, type KvStorage } from "@/_store/mod.ts";
import { sleepPreference } from "./sleep-default";

function memoryStorage(): KvStorage {
  const data = new Map<string, string>();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
}

test("a synced default survives an offline restart without changing the current timer", async () => {
  const storage = memoryStorage();
  const local = persisted("default", 0, { storage });
  const saves: number[] = [];
  let push: ((value: number) => void) | undefined;
  const preference = sleepPreference(local, {
    load: async () => 90,
    save: async value => { saves.push(value); },
    subscribe: listener => { push = listener; return () => {}; },
  });
  await preference.connect();
  assert.equal(local.get(), 90);
  assert.deepEqual(saves, [], "hydration never rewrites the remote preference");
  push?.(60);
  const restarted = persisted("default", 0, { storage });
  const offline = sleepPreference(restarted, {
    load: async () => { throw new Error("offline"); },
    save: async () => {},
  });
  await offline.connect();
  assert.equal(restarted.get(), 60, "remote pushes are persisted locally too");
  preference.set(0);
  assert.deepEqual(saves, [0], "Off is a valid saved default");
});

test("a late startup response cannot overwrite a new local choice or server push", async () => {
  for (const update of ["local", "remote"]) {
    const local = persisted("default", 0, { storage: memoryStorage() });
    let finish!: (value: number) => void;
    let push!: (value: number) => void;
    const preference = sleepPreference(local, {
      load: () => new Promise(resolve => { finish = resolve; }),
      save: async () => {},
      subscribe: listener => { push = listener; return () => {}; },
    });
    const ready = preference.connect();
    if (update === "local") preference.set(45);
    else push(45);
    finish(90);
    await ready;
    assert.equal(local.get(), 45);
  }
});

test("an offline edit awaiting delivery wins over the cached server default on restart", async () => {
  const local = persisted("default", 45, { storage: memoryStorage() });
  const preference = sleepPreference(local, { load: async () => 90, save: async () => {} }, () => "45");
  await preference.connect();
  assert.equal(local.get(), 45);
});
