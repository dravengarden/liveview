import { useCallback, useRef } from "react";
import type { ProgressEntry } from "@/types";

const SAVE_DEBOUNCE_MS = 800;

export interface UseProgress {
  /** Fetch a book's saved positions into the cache; returns the most-recently
   *  read entry (for "resume last chapter"), or null. */
  loadBook: (slug: string) => Promise<ProgressEntry | null>;
  /** Cached scroll ratio for a doc path, or undefined if none. */
  savedScroll: (path: string) => number | undefined;
  /** Record a doc's scroll ratio; persists to the backend, debounced per path. */
  save: (path: string, scroll: number) => void;
}

/**
 * Reading-progress client. Backend-backed (`/api/progress`), cached in refs so
 * scroll updates never trigger React re-renders. Progress is global (no auth),
 * so it syncs across the reader's devices.
 */
export function useProgress(): UseProgress {
  const ratios = useRef<Map<string, number>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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

  const savedScroll = useCallback((path: string): number | undefined => ratios.current.get(path), []);

  const save = useCallback((path: string, scroll: number) => {
    ratios.current.set(path, scroll);
    const existing = timers.current.get(path);
    if (existing) clearTimeout(existing);
    timers.current.set(
      path,
      setTimeout(() => {
        timers.current.delete(path);
        void fetch("/api/progress", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, scroll }),
        }).catch(() => {
          // Best-effort: a lost progress write just means a slightly stale resume.
        });
      }, SAVE_DEBOUNCE_MS)
    );
  }, []);

  return { loadBook, savedScroll, save };
}
