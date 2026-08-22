import { MAIN_THREAD_BUDGET_MS, TEXT_ART_CONCURRENCY } from "./schema.ts";

export interface ReplicaWorkerInit {
  type: "init";
  remoteBase: string;
  origins: string[];
}

export interface ReplicaWorkerFillItem {
  hash: string;
  url: string;
  kind: string;
  bytes: number;
}

export interface ReplicaWorkerFill {
  type: "fill";
  items: ReplicaWorkerFillItem[];
}

export type ReplicaWorkerIn = ReplicaWorkerInit | ReplicaWorkerFill;

/** Workers never see installApiShim(); every fetch URL must already be absolute. */
export function joinRemoteUrl(remoteBase: string, pathOrUrl: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathOrUrl)) return pathOrUrl;
  const base = remoteBase.endsWith("/") ? remoteBase.slice(0, -1) : remoteBase;
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${path}`;
}

export function replicaWorkerInitMessage(
  remoteBase: string,
  origins: readonly string[],
): ReplicaWorkerInit {
  return { type: "init", remoteBase, origins: [...origins] };
}

export async function runWithTimeBudget<T>(
  items: readonly T[],
  each: (item: T) => Promise<void>,
  budgetMs: number = MAIN_THREAD_BUDGET_MS,
): Promise<void> {
  let i = 0;
  while (i < items.length) {
    const start = performance.now();
    while (i < items.length && performance.now() - start < budgetMs) {
      const item = items[i];
      if (item === undefined) break;
      i += 1;
      await each(item);
    }
    if (i < items.length) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }
}

export function spawnReplicaWorker(init: {
  remoteBase: string;
  origins: readonly string[];
}): Worker | null {
  // Dedicated workers need a window document; Deno tests have Worker but no UI.
  if (typeof Worker === "undefined" || typeof document === "undefined") {
    return null;
  }
  try {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "lv-replica",
    });
    worker.postMessage(replicaWorkerInitMessage(init.remoteBase, init.origins));
    return worker;
  } catch {
    return null;
  }
}

function inDedicatedWorker(): boolean {
  const scope = globalThis as {
    DedicatedWorkerGlobalScope?: { prototype?: object };
    importScripts?: unknown;
    document?: unknown;
  };
  return typeof scope.DedicatedWorkerGlobalScope === "function" &&
    typeof scope.importScripts === "function" &&
    scope.document === undefined;
}

let workerRemoteBase = "";

async function poolMap<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const n = Math.min(Math.max(limit, 1), items.length);
  if (n === 0) return;
  const runners = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i];
      i += 1;
      if (item === undefined) continue;
      await fn(item);
    }
  });
  await Promise.all(runners);
}

async function workerFill(items: ReplicaWorkerFillItem[]): Promise<void> {
  const { putBlob } = await import("./blobs.ts");
  const { isAudioKind } = await import("./schema.ts");
  const textArt: ReplicaWorkerFillItem[] = [];
  for (const item of items) {
    const url = joinRemoteUrl(workerRemoteBase, item.url);
    if (isAudioKind(item.kind)) {
      self.postMessage({ type: "media", hash: item.hash, url });
      continue;
    }
    textArt.push(item);
  }
  let fallback: ReplicaWorkerFillItem[] | null = null;
  await poolMap(textArt, TEXT_ART_CONCURRENCY, async (item) => {
    if (fallback) return;
    const url = joinRemoteUrl(workerRemoteBase, item.url);
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        self.postMessage({
          type: "error",
          hash: item.hash,
          message: `fetch ${response.status}`,
        });
        return;
      }
      const buffer = await response.arrayBuffer();
      await putBlob({
        hash: item.hash,
        kind: item.kind,
        bytes: item.bytes || buffer.byteLength,
        pinned: 0,
        mtime: Date.now(),
        present: 1,
        data: buffer,
      });
      self.postMessage({ type: "filled", hash: item.hash });
    } catch (error) {
      const message = error instanceof Error ? error.message : "fill failed";
      if (
        error instanceof Error &&
        (error.name === "InvalidStateError" || /indexeddb/i.test(message))
      ) {
        fallback = items;
        return;
      }
      self.postMessage({ type: "error", hash: item.hash, message });
    }
  });
  if (fallback) {
    self.postMessage({ type: "fallback", reason: "indexeddb", items: fallback });
  }
}

if (inDedicatedWorker()) {
  self.addEventListener("message", (event: MessageEvent<ReplicaWorkerIn>) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "init") {
      workerRemoteBase = msg.remoteBase;
      self.postMessage({ type: "ready", remoteBase: workerRemoteBase });
      return;
    }
    if (msg.type === "fill") {
      void workerFill(msg.items).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "worker fill";
        self.postMessage({ type: "fallback", reason: message, items: msg.items });
      });
    }
  });
}
