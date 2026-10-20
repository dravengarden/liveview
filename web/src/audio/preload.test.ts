import assert from "node:assert/strict";
import { test } from "node:test";
import { AudioPreloader, audioPreloadOrder, audioPreloadStrategy, type AudioDownload, type AudioDownloadEnvironment } from "./preload";

const job = (path: string, bytes = 10): AudioDownload => ({ path, hash: `hash-${path}`, marksHash: `marks-${path}`, bytes });
const allowed: AudioDownloadEnvironment = { blocked: null, capBytes: 1000 };
function harness(cached: string[] = [], used = 0) {
  const present = new Set(cached);
  const started: string[] = [];
  const inspected: string[] = [];
  const pending = new Map<string, { resolve(): void; reject(): void }>();
  let now = 0;
  const loader = new AudioPreloader({
    inspect: async j => {
      inspected.push(j.path);
      return { ready: present.has(j.path), bytesToDownload: present.has(j.path) ? 0 : j.bytes };
    },
    usedBytes: async () => used,
    download: async j => {
      started.push(j.path);
      await new Promise<void>((resolve, reject) => pending.set(j.path, {
        resolve: () => { present.add(j.path); used += j.bytes; resolve(); },
        reject: () => reject(new Error("Disconnected")),
      }));
    },
    now: () => now, changed: () => {}, yield: async () => {},
  });
  return { loader, started, inspected, pending, present, advance: (ms: number) => { now += ms; } };
}
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); };

test("whole-book priority follows listening intent, covers every chapter once", () => {
  const spine = ["a", "b", "c", "d", "e", "f", "g"];
  assert.deepEqual(audioPreloadOrder(spine, "c", "book"), ["c", "d", "e", "b", "f", "g", "a"]);
  assert.deepEqual(audioPreloadOrder(spine, "c", "ahead"), ["c", "d", "e"]);
  assert.deepEqual(audioPreloadOrder(spine, "g", "book"), ["g", "f", "e", "d", "c", "b", "a"]);
  assert.deepEqual(audioPreloadOrder(spine, "missing", "book"), spine);
  assert.deepEqual(audioPreloadOrder(spine, "a", "off"), []);
});

test("two transfers at a time eventually cache the entire book, skipping verified files", async () => {
  const h = harness(["a"]);
  const jobs = ["a", "b", "c", "d", "e"].map(p => job(p));
  h.loader.configure(jobs, audioPreloadOrder(jobs.map(j => j.path), "c", "book"), allowed);
  await Promise.all([h.loader.tick(), h.loader.tick()]);
  assert.deepEqual(h.started, ["c", "d"]);
  assert.equal(h.loader.states.get("hash-a"), "cached");
  for (const path of ["c", "d", "e", "b"]) {
    h.pending.get(path)!.resolve();
    await settle();
    await h.loader.tick();
  }
  assert.deepEqual(h.started, ["c", "d", "e", "b"]);
  assert.ok(jobs.every(j => h.loader.states.get(j.hash) === "cached"));
});

test("chapters sharing an audio identity reserve and download that payload once", async () => {
  const h = harness();
  h.loader.configure([job("a"), { ...job("a"), path: "repeat" }, job("b")], ["a", "repeat", "b"], allowed);
  await h.loader.tick();
  assert.deepEqual(h.started, ["a", "b"]);
  h.pending.get("a")!.resolve();
  h.pending.get("b")!.resolve();
  await settle();
  assert.equal(h.loader.nextWakeDelay(), null);
});

test("navigation reprioritizes the next free slot; off never submits queued work", async () => {
  const h = harness();
  const jobs = ["a", "b", "c", "d", "e"].map(p => job(p));
  h.loader.configure(jobs, jobs.map(j => j.path), allowed);
  await h.loader.tick();
  h.loader.pause(); // React effect cleanup before navigation installs the plan.
  h.loader.configure(jobs, audioPreloadOrder(jobs.map(j => j.path), "e", "book"), allowed);
  h.pending.get("a")!.resolve();
  await settle();
  await h.loader.tick();
  assert.deepEqual(h.started, ["a", "b", "e"]);
  assert.equal(h.inspected.length, jobs.length, "navigation preserves inspected hashes");
  h.loader.configure(jobs, [], allowed);
  h.pending.get("b")!.resolve();
  h.pending.get("e")!.resolve();
  await settle();
  await h.loader.tick();
  assert.deepEqual(h.started, ["a", "b", "e"]);
});

test("network policy blocks downloads, then resumes; cap reserves in-flight bytes", async () => {
  const h = harness([], 80);
  const jobs = ["a", "b", "c"].map(p => job(p, 15));
  h.loader.configure(jobs, ["a", "b", "c"], { blocked: "waiting-wifi", capBytes: 100 });
  await h.loader.tick();
  assert.equal(h.started.length, 0);
  assert.equal(h.loader.states.get("hash-a"), "waiting-wifi");
  h.loader.configure(jobs, ["a", "b", "c"], { blocked: null, capBytes: 100 });
  await h.loader.tick();
  assert.deepEqual(h.started, ["a"]);
  assert.equal(h.loader.states.get("hash-b"), "storage-full");
  await h.loader.tick();
  assert.deepEqual(h.started, ["a"]);
  h.pending.get("a")!.resolve();
  await settle();
  await h.loader.tick();
  assert.equal(h.loader.states.get("hash-c"), "storage-full");
});

test("failed downloads back off without starving the remaining chapters", async () => {
  const h = harness();
  const jobs = ["a", "b", "c"].map(p => job(p));
  h.loader.configure(jobs, ["a", "b", "c"], allowed);
  await h.loader.tick();
  h.pending.get("a")!.reject();
  await settle();
  h.loader.pause();
  h.loader.configure(jobs, ["c", "a", "b"], allowed);
  await h.loader.tick();
  assert.deepEqual(h.started, ["a", "b", "c"]);
  assert.equal(h.loader.states.get("hash-a"), "failed");
  h.pending.get("b")!.resolve();
  await settle();
  h.advance(5000);
  await h.loader.tick();
  assert.deepEqual(h.started, ["a", "b", "c", "a"]);
});

test("large books inspect at most 32 files per pass and prioritize the current chapter", async () => {
  const h = harness();
  const jobs = Array.from({ length: 1000 }, (_, i) => job(String(i)));
  h.loader.configure(jobs, audioPreloadOrder(jobs.map(j => j.path), "900", "book"), allowed);
  await h.loader.tick();
  assert.equal(h.inspected.length, 32);
  assert.deepEqual(h.started, ["900", "901"]);
});

test("foreground invalidation detects lost cache; a changed voice never borrows cached status", async () => {
  const h = harness(["a"]);
  h.loader.configure([job("a")], [], allowed);
  await h.loader.tick();
  assert.equal(h.loader.states.get("hash-a"), "cached");
  h.present.clear();
  h.loader.invalidate();
  await h.loader.tick();
  assert.equal(h.loader.states.get("hash-a"), "not-cached");
  h.loader.configure([{ ...job("a"), hash: "new-voice" }], [], allowed);
  await h.loader.tick();
  assert.equal(h.loader.states.get("new-voice"), "not-cached");
  assert.equal(h.loader.states.has("hash-a"), false);
});

test("preload preference defaults to whole book and preserves explicit opt-out", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let value: string | null = null;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => value } });
  try {
    assert.equal(audioPreloadStrategy(), "book");
    value = "off";
    assert.equal(audioPreloadStrategy(), "off");
    value = "ahead";
    assert.equal(audioPreloadStrategy(), "ahead");
    value = "corrupt";
    assert.equal(audioPreloadStrategy(), "book");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("completion for an old timing identity must be checked again after a snapshot changes", async () => {
  const h = harness();
  h.loader.configure([job("a")], ["a"], allowed);
  await h.loader.tick();
  h.loader.configure([{ ...job("a"), marksHash: "new-timing" }], ["a"], allowed);
  h.pending.get("a")!.resolve();
  await settle();
  assert.equal(h.loader.states.get("hash-a"), "checking");
  assert.equal(h.loader.nextWakeDelay(), 50);
});

test("cached audio can repair missing timing even when the audio budget is full", async () => {
  const started: string[] = [];
  const loader = new AudioPreloader({
    inspect: async () => ({ ready: false, bytesToDownload: 0 }),
    usedBytes: async () => 100,
    download: async j => { started.push(j.path); },
    changed: () => {}, now: Date.now, yield: async () => {},
  });
  loader.configure([job("a", 90)], ["a"], { blocked: null, capBytes: 100 });
  await loader.tick();
  await settle();
  assert.deepEqual(started, ["a"]);
  assert.equal(loader.states.get("hash-a"), "cached");
});

test("completion during the aggregate read cannot free an unaccounted reservation", async () => {
  let resolveDownload: (() => void) | undefined;
  let finishDuringRead = false;
  const started: string[] = [];
  const loader = new AudioPreloader({
    inspect: async () => ({ ready: false, bytesToDownload: 15 }),
    usedBytes: async () => {
      if (finishDuringRead) { resolveDownload?.(); await settle(); }
      return 80; // The read began before the download committed its 15 bytes.
    },
    download: j => {
      started.push(j.path);
      return new Promise(resolve => { resolveDownload = resolve; });
    },
    changed: () => {}, now: Date.now, yield: async () => {},
  });
  loader.configure([job("a", 15), job("b", 15)], ["a", "b"], { blocked: null, capBytes: 100 });
  await loader.tick();
  finishDuringRead = true;
  await loader.tick();
  assert.deepEqual(started, ["a"]);
  assert.equal(loader.states.get("hash-b"), "storage-full");
});

test("one failed cache probe backs off while other chapters download", async () => {
  let now = 0;
  let broken = true;
  const probes: string[] = [];
  const started: string[] = [];
  const loader = new AudioPreloader({
    inspect: async j => {
      probes.push(j.path);
      if (j.path === "a" && broken) throw new Error("Native reply unavailable");
      return { ready: j.path === "a", bytesToDownload: 10 };
    },
    usedBytes: async () => 0,
    download: async j => { started.push(j.path); },
    changed: () => {}, now: () => now, yield: async () => {},
  });
  loader.configure([job("a"), job("b"), job("c")], ["a", "b", "c"], allowed);
  await loader.tick();
  await settle();
  assert.deepEqual(started, ["b", "c"]);
  assert.equal(loader.states.get("hash-a"), "failed");
  assert.equal(loader.nextWakeDelay(), 5000);
  await loader.tick();
  assert.deepEqual(probes, ["a", "b", "c"]);
  now = 5000;
  broken = false;
  await loader.tick();
  assert.equal(loader.states.get("hash-a"), "cached");
  assert.equal(loader.nextWakeDelay(), null);
});

test("unknown aggregate usage blocks transfers with backoff instead of bypassing the cap", async () => {
  let reads = 0;
  let now = 0;
  let broken = true;
  const started: string[] = [];
  const loader = new AudioPreloader({
    inspect: async () => ({ ready: false, bytesToDownload: 10 }),
    usedBytes: async () => { reads++; if (broken) throw new Error("IDB unavailable"); return 0; },
    download: async j => { started.push(j.path); },
    changed: () => {}, now: () => now, yield: async () => {},
  });
  loader.configure([job("a")], ["a"], allowed);
  await loader.tick();
  assert.equal(loader.states.get("hash-a"), "failed");
  assert.equal(loader.nextWakeDelay(), 5000);
  await loader.tick();
  assert.equal(reads, 1);
  assert.deepEqual(started, []);
  now = 5000;
  await loader.tick();
  assert.equal(loader.nextWakeDelay(), 10_000);
  broken = false;
  now = 15_000;
  await loader.tick();
  await settle();
  assert.deepEqual(started, ["a"]);
  assert.equal(loader.states.get("hash-a"), "cached");
});
