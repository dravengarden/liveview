// Pure navigation over a rendition spine (`TreeNode` forest): lookups, the
// first readable chapter, and the ordered playback queue.

import { contentFetch } from "@/native-sync";
import type { Track } from "@/audio/player";
import type { TreeNode } from "@/types";

export function hasFilePath(nodes: TreeNode[], target: string): boolean {
  for (const node of nodes) {
    if (!node.is_dir && node.path === target) return true;
    if (node.is_dir && hasFilePath(node.children, target)) return true;
  }
  return false;
}

export function findNode(nodes: TreeNode[], target: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === target) return node;
    if (node.is_dir) {
      const found = findNode(node.children, target);
      if (found !== null) return found;
    }
  }
  return null;
}

export function findFirstFile(nodes: TreeNode[]): string | null {
  for (const node of nodes) {
    if (!node.is_dir) {
      return node.path;
    }
  }
  for (const node of nodes) {
    if (node.is_dir) {
      const found = findFirstFile(node.children);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** Flatten a rendition spine into ordered chapter tracks — the playback queue
 *  for next/prev + auto-advance. Leaf files in depth-first (reading) order. */
export function flattenTracks(nodes: TreeNode[], uiLang: string): Track[] {
  const out: Track[] = [];
  const walk = (ns: TreeNode[]): void => {
    for (const n of ns) {
      if (n.is_dir) walk(n.children);
      else {out.push({
          path: n.path,
          label: (uiLang && n.titles?.[uiLang]) || n.name,
        });}
    }
  };
  walk(nodes);
  return out;
}

/** First non-dir leaf under a tree node (depth-first), or null. */
function firstLeafPath(node: TreeNode): string | null {
  if (!node.is_dir) return node.path;
  for (const child of node.children ?? []) {
    const p = firstLeafPath(child);
    if (p) return p;
  }
  return null;
}

/**
 * The real first spine chapter of `slug` for a rendition, from the cached tree.
 * Used to self-heal a dead entry path: a brand-new book with no reading progress
 * falls back to `<slug>/README.md` (which authored books — `00-introduction.md`
 * spine, no README — don't have), and a cross-book resume can carry the previous
 * book's path; either 404s. `/api/tree` is cache-first (prefetchTrees warms it),
 * so this stays offline-safe — and a 404 only happens online anyway.
 */
export async function resolveFirstChapter(
  slug: string,
  rendition: string,
): Promise<string | null> {
  try {
    const res = await contentFetch(
      `/api/tree?rendition=${encodeURIComponent(rendition)}`,
    );
    if (!res.ok) return null;
    const forest = (await res.json()) as TreeNode[];
    const book = forest.find((n) => n.path === slug);
    return book ? firstLeafPath(book) : null;
  } catch {
    return null;
  }
}
