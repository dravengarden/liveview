// The client's view of background work — audio generation (the `/api/tasks`
// rollup + live `chapter-ready` WS pushes) and, later, the SW offline prefetch.
// Drives the ambient filament + the Sync sheet + every "audio not ready" surface.
// A tiny pub/sub (like connectionStore), consumable via `useSyncStatus`.

import { useSyncExternalStore } from "react";

/** Per-book audio-generation counts (from `/api/tasks`). */
export interface BookAudioStatus {
  slug: string;
  done: number;
  total: number;
  pending: number;
  failed: number;
}

export interface SyncStatus {
  /** Per-book audio rollup, books with any tasks only. */
  books: BookAudioStatus[];
  /** Global totals (summed over books). */
  global: { done: number; total: number; pending: number; failed: number };
  /** SW offline prefetch in flight (set in Phase 4); 0 = idle. */
  prefetching: number;
}

const EMPTY: SyncStatus = {
  books: [],
  global: { done: 0, total: 0, pending: 0, failed: 0 },
  prefetching: 0,
};

let state: SyncStatus = EMPTY;
const subs = new Set<() => void>();
const emit = (): void => {
  for (const s of subs) s();
};

/** A chapter whose audio just became ready (a WS `chapter-ready` push). The
 *  audio engine listens so a tap that was "generating…" auto-plays on arrival. */
export interface ChapterReady {
  book: string;
  rendition: string;
  lang: string;
  path: string;
}
const readySubs = new Set<(e: ChapterReady) => void>();

/** Subscribe to chapter-ready events; returns an unsubscribe. */
export function onChapterReady(cb: (e: ChapterReady) => void): () => void {
  readySubs.add(cb);
  return () => {
    readySubs.delete(cb);
  };
}

/** Dispatch a chapter-ready (called by the WS handler) + refresh the rollup. */
export function dispatchChapterReady(e: ChapterReady): void {
  for (const s of readySubs) s(e);
  void refreshSyncStatus();
}

interface RollupRow {
  book_slug: string | null;
  done: number;
  total: number;
  pending: number;
  failed: number;
}

/** Re-fetch `/api/tasks` and publish. Called on app start, on a `chapter-ready`
 *  push, and periodically while anything is pending. */
export async function refreshSyncStatus(): Promise<void> {
  try {
    const res = await fetch("/api/tasks");
    if (!res.ok) return;
    const rows = (await res.json()) as RollupRow[];
    const books: BookAudioStatus[] = rows
      .filter((r): r is RollupRow & { book_slug: string } => r.book_slug !== null)
      .map((r) => ({
        slug: r.book_slug,
        done: r.done,
        total: r.total,
        pending: r.pending,
        failed: r.failed,
      }));
    const global = books.reduce(
      (a, r) => ({
        done: a.done + r.done,
        total: a.total + r.total,
        pending: a.pending + r.pending,
        failed: a.failed + r.failed,
      }),
      { done: 0, total: 0, pending: 0, failed: 0 },
    );
    state = { ...state, books, global };
    emit();
  } catch {
    // offline / transient — keep the last view.
  }
}

/** Set the SW prefetch-in-flight count (Phase 4). */
export function setPrefetching(n: number): void {
  if (n === state.prefetching) return;
  state = { ...state, prefetching: n };
  emit();
}

/** True when anything background is happening — gates the ambient filament. */
export function isSyncActive(s: SyncStatus): boolean {
  return s.global.pending > 0 || s.prefetching > 0;
}

/** Audio readiness for one book: ready (all done), generating (some pending), or
 *  none (no audio tasks). Used by the shelf micro-badge. */
export function bookAudioState(
  s: SyncStatus,
  slug: string,
): "ready" | "generating" | "none" {
  const b = s.books.find((x) => x.slug === slug);
  if (!b || b.total === 0) return "none";
  return b.pending > 0 ? "generating" : "ready";
}

/** React binding. */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => state,
    () => state,
  );
}
