import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { setPresent } from "./blobs.ts";
import { removeFetch } from "./worklist.ts";

// Payload store only. The existing IDB replica owns the DAG, worklist, pin/LRU,
// and byte cap. Hashing and complete-body downloads never run on the UI thread.
export const PWA_AUDIO_CACHE = "lv-audio-blobs";
const CONCURRENCY = 2;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
type Job = { hash: string; url: string; bytes?: number };
type Message =
  | ({ type: "cache" } & Job)
  | { type: "delete"; hash: string }
  | { type: "policy"; allowed: boolean; capBytes?: number };

export function verifyAudioBody(hash: string, body: Uint8Array): boolean {
  return /^[a-f0-9]{64}$/.test(hash) && bytesToHex(blake3(body)) === hash;
}

/** Eviction must also remove the legacy payload that the SW can still serve. */
export async function deleteCachedAudio(
  key: string,
  storage: Pick<CacheStorage, "open"> = caches,
): Promise<void> {
  await Promise.all([PWA_AUDIO_CACHE, "lv-blobs"].map(async (name) => {
    const cache = await storage.open(name);
    await cache.delete(key);
  }));
}

const jobs = new Map<string, Job>();
const active = new Map<string, AbortController>();
let allowed = false;
let running = 0;
let capBytes: number | undefined;

async function download(job: Job, ctrl: AbortController): Promise<void> {
  const cache = await caches.open(PWA_AUDIO_CACHE);
  const key = new URL(`/api/blob/${job.hash}`, self.location.origin).href;
  if (await cache.match(key)) return;
  // Never allow malformed URLs to become arbitrary persistent cache keys.
  const source = new URL(job.url);
  if (
    source.origin !== self.location.origin ||
    (source.href !== key && source.pathname !== "/api/audio")
  ) {
    throw new Error("Invalid audio origin");
  }
  const legacy = await caches.open("lv-blobs");
  const response = await legacy.match(key) ??
    await fetch(key, { signal: ctrl.signal, cache: "no-store" });
  if (response.status !== 200 || !response.body) {
    throw new Error("Audio unavailable");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const limit = Math.min(
    job.bytes && job.bytes > 0 ? job.bytes : MAX_BODY_BYTES,
    MAX_BODY_BYTES,
  );
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Audio exceeds byte reservation");
      parts.push(value as Uint8Array<ArrayBuffer>);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  if (!verifyAudioBody(job.hash, body)) throw new Error("Audio hash mismatch");
  if (ctrl.signal.aborted) throw new Error("Cancelled");
  await cache.put(key, new Response(body, { headers: response.headers }));
  if (ctrl.signal.aborted) {
    await cache.delete(key);
    throw new Error("Cancelled");
  }
  await legacy.delete(key);
}

function pump(): void {
  while (allowed && running < CONCURRENCY && jobs.size > 0) {
    const job = jobs.values().next().value as Job;
    jobs.delete(job.hash);
    const ctrl = new AbortController();
    active.set(job.hash, ctrl);
    running += 1;
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    void download(job, ctrl).then(async () => {
      // Worklist normalization can scan the library. Keep it off the UI thread;
      // IDB readwrite transactions serialize these mutations across workers.
      await setPresent(job.hash, 1);
      if (ctrl.signal.reason === "deleted") {
        await setPresent(job.hash, 0);
        throw new Error("Cancelled");
      }
      await removeFetch(job.hash);
    }).then(
      () =>
        self.postMessage({ type: "cacheProgress", hash: job.hash, ok: true }),
      () =>
        self.postMessage({ type: "cacheProgress", hash: job.hash, ok: false }),
    ).finally(() => {
      clearTimeout(timer);
      active.delete(job.hash);
      running -= 1;
      pump();
    });
  }
}

if (
  typeof document === "undefined" && typeof self !== "undefined" &&
  "postMessage" in self
) {
  self.addEventListener("message", (event: MessageEvent<Message>) => {
    const msg = event.data;
    if (msg.type === "policy") {
      if (
        capBytes !== undefined && msg.capBytes !== undefined &&
        msg.capBytes !== capBytes
      ) {
        jobs.clear();
        for (const ctrl of active.values()) ctrl.abort();
      }
      capBytes = msg.capBytes;
      allowed = msg.allowed;
      if (!allowed) { for (const ctrl of active.values()) ctrl.abort(); }
    } else if (msg.type === "cache") {
      if (!active.has(msg.hash)) jobs.set(msg.hash, msg);
    } else if (msg.type === "delete") {
      jobs.delete(msg.hash);
      active.get(msg.hash)?.abort("deleted");
      void deleteCachedAudio(
        new URL(`/api/blob/${msg.hash}`, self.location.origin).href,
      );
    }
    pump();
  });
}
