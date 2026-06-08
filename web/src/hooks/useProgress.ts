import { useCallback, useEffect, useRef } from "react";
import { mirroredStore, type MirroredStore } from "@/_sync/mod.ts";
import { progressBackend } from "@/syncBackends";
import type { ProgressEntry } from "@/types";

const SAVE_DEBOUNCE_MS = 800;

export interface UseProgress {
  /** Fetch a book's saved positions into the cache; returns the most-recently
   *  read entry (for "resume last chapter"), or null. */
  loadBook: (slug: string) => Promise<ProgressEntry | null>;
  /** Fetch the latest-read chapter of every book (newest first), for the
   *  landing "continue reading" indicators. Also seeds the scroll cache. */
  loadRecent: () => Promise<ProgressEntry[]>;
  /** Cached scroll ratio for a doc path, or undefined if none. */
  savedScroll: (path: string) => number | undefined;
  /** Record a doc's scroll ratio; persists to the backend, debounced per path. */
  save: (path: string, scroll: number) => void;
}

/**
 * Reading-progress client. Each open doc's scroll ratio is a `mirroredStore`
 * (state-based tier) over `/api/progress`, lazily created per path (like cowboy's
 * per-session qClient) — debounced server push (800ms), remote-wins reconcile.
 *
 * The synchronous read side (`savedScroll`) is served from a ref cache (no
 * re-render on scroll) seeded by the BULK fetches (`loadBook` / `loadRecent`).
 * Those aggregates stay plain fetches — they are read-only views over many docs,
 * not a per-doc store. A scroll write updates BOTH the cache (instant) and the
 * doc's mirrored store (debounced server save).
 */
export function useProgress(): UseProgress {
  const ratios = useRef<Map<string, number>>(new Map());
  // One mirrored store per open doc path, created on first write.
  const stores = useRef<Map<string, MirroredStore<number>>>(new Map());

  const storeFor = useCallback((path: string): MirroredStore<number> => {
    let store = stores.current.get(path);
    if (!store) {
      store = mirroredStore<number>({
        initial: ratios.current.get(path) ?? 0,
        remote: progressBackend(path),
        // Reading progress: a few hundred ms of scroll settles before we save.
        push: { debounceMs: SAVE_DEBOUNCE_MS },
      });
      stores.current.set(path, store);
    }
    return store;
  }, []);

  const loadBook = useCallback(async (slug: string): Promise<ProgressEntry | null> => {
    try {
      const res = await fetch(`/api/progress?book=${encodeURIComponent(slug)}`);
      if (!res.ok) return null;
      const rows = (await res.json()) as ProgressEntry[];
      for (const r of rows) ratios.current.set(r.path, r.scroll);
      return rows[0] ?? null; // backend orders newest-first
    } catch {
      return null;
    }
  }, []);

  const loadRecent = useCallback(async (): Promise<ProgressEntry[]> => {
    try {
      const res = await fetch("/api/progress/recent");
      if (!res.ok) return [];
      const rows = (await res.json()) as ProgressEntry[];
      for (const r of rows) ratios.current.set(r.path, r.scroll);
      return rows;
    } catch {
      return [];
    }
  }, []);

  const savedScroll = useCallback((path: string): number | undefined => ratios.current.get(path), []);

  const save = useCallback((path: string, scroll: number) => {
    // Instant local cache (drives savedScroll's synchronous read) + the doc's
    // mirrored store (debounced server push).
    ratios.current.set(path, scroll);
    storeFor(path).set(scroll);
  }, [storeFor]);

  // Flush every open doc's debounced progress write before the page is hidden,
  // so a backgrounded/closing tab doesn't drop the last scroll position.
  useEffect(() => {
    const storeMap = stores.current;
    const onPageHide = (): void => {
      for (const s of storeMap.values()) void s.flush();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  return { loadBook, loadRecent, savedScroll, save };
}
