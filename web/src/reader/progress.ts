// Shelf-level reading progress derived from per-chapter progress rows and the
// rendition spines. Pure and O(forest + rows): only the books that have
// progress are indexed, each spine flattened once.

import { flattenTracks } from "@/readerTree";
import { bookSlugOf } from "./location.ts";
import type {
  Book,
  BookProgress,
  ProgressEntry,
  ReadingProgress,
  TreeNode,
} from "@/types";

type Leaves = ReturnType<typeof flattenTracks>;

/**
 * Resolve each book's latest-read chapter into a display-ready entry — chapter
 * title (current UI edition, falling back to the node name, then the file
 * name) plus the in-chapter scroll ratio — split by rendition. A text+audio
 * book carries BOTH its newest text position and its newest audio
 * (`.spoken.md`) position; within a rendition the most recent chapter wins.
 *
 * Audio rows index the audio forest: `.spoken.md` chapters are filtered out
 * of the text spine, so the listening meter would otherwise collapse to the
 * raw in-chapter scroll.
 */
export function shelfProgress(
  recent: readonly ProgressEntry[],
  textForest: readonly TreeNode[],
  audioForest: readonly TreeNode[],
  uiLang: string,
): Record<string, BookProgress> {
  const slugs = new Set(recent.map((r) => bookSlugOf(r.path)));
  const nodeByPath = new Map<string, TreeNode>();
  const textLeaves = new Map<string, Leaves>();
  const audioLeaves = new Map<string, Leaves>();
  const indexNode = (n: TreeNode): void => {
    nodeByPath.set(n.path, n);
    n.children?.forEach(indexNode);
  };
  for (const top of textForest) {
    if (!slugs.has(top.path)) continue;
    indexNode(top);
    textLeaves.set(top.path, flattenTracks(top.children, uiLang));
  }
  for (const top of audioForest) {
    if (!slugs.has(top.path)) continue;
    indexNode(top);
    audioLeaves.set(top.path, flattenTracks(top.children, uiLang));
  }
  const out: Record<string, BookProgress> = {};
  const newest: Record<string, { text: number; audio: number }> = {};
  for (const r of recent) {
    const slug = bookSlugOf(r.path);
    const kind: "text" | "audio" = r.path.endsWith(".spoken.md") ? "audio" : "text";
    const seen = (newest[slug] ??= { text: 0, audio: 0 });
    // The backend returns one row per (book, rendition); keep the newest if
    // that ever changes.
    if (seen[kind] && r.updated_at <= seen[kind]) continue;
    seen[kind] = r.updated_at;
    const node = nodeByPath.get(r.path);
    const chapterLabel = (node && ((uiLang && node.titles?.[uiLang]) || node.name)) ||
      r.path.split("/").pop() || r.path;
    // Book-level progress: the chapter's position in the ordered spine plus
    // its in-chapter scroll, over the chapter count. Raw scroll only when the
    // spine is missing (offline before it loads).
    const scroll = Math.min(1, Math.max(0, r.scroll));
    const leaves = (kind === "audio" ? audioLeaves : textLeaves).get(slug) ?? [];
    const idx = leaves.findIndex((l) => l.path === r.path);
    const fraction = leaves.length > 0 && idx >= 0 ? (idx + scroll) / leaves.length : scroll;
    (out[slug] ??= {})[kind] = {
      path: r.path,
      chapterLabel,
      scroll: r.scroll,
      fraction,
      updatedAt: r.updated_at,
    };
  }
  return out;
}

/** The most recently touched rendition's progress for a book, if any. */
export function latestProgress(bp: BookProgress | undefined): ReadingProgress | undefined {
  if (bp?.text && bp.audio) {
    return bp.text.updatedAt >= bp.audio.updatedAt ? bp.text : bp.audio;
  }
  return bp?.text ?? bp?.audio;
}

/** The home-screen widget's items: the `limit` most recently read books by
 *  book-level fraction, padded with never-opened books at 0. */
export function widgetItems(
  books: readonly Book[],
  progress: Record<string, BookProgress>,
  limit = 4,
): { book: Book; progress: number }[] {
  const recent = books
    .flatMap((book) => {
      const latest = latestProgress(progress[book.slug]);
      return latest ? [{ book, latest }] : [];
    })
    .sort((a, b) => b.latest.updatedAt - a.latest.updatedAt)
    .slice(0, limit);
  const recentSlugs = new Set(recent.map(({ book }) => book.slug));
  return [
    ...recent.map(({ book, latest }) => ({ book, progress: latest.fraction })),
    ...books.filter((book) => !recentSlugs.has(book.slug)).map((book) => ({ book, progress: 0 })),
  ].slice(0, limit);
}
