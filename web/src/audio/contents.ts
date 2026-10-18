import { selectPreferredVoice, voicePreferenceKey, type VoiceChoice } from "./speech";
import type { TreeNode } from "@/types";
import { contentFetch } from "@/native-sync";
import { remoteUrl } from "@/apiBase";
import { useEffect, useState } from "react";

export interface ChapterAudioInfo {
  voice: VoiceChoice;
  seconds?: number;
}

/** Book mode hides the book root; docs mode retains it across refreshes. */
export function contentsSnapshotScope(initial: TreeNode[], next: TreeNode[], book: string): TreeNode[] {
  const root = next.find(node => node.path === book);
  if (!root) return initial;
  return initial.some(node => node.path === book) ? [root] : root.children;
}

/** Titles and audio metadata have the same load and offline-cache lifecycle. */
export async function loadContentsTree(book: string, rendition: string, fresh = false): Promise<TreeNode[]> {
  const path = `/api/contents/${encodeURIComponent(book)}?rendition=${encodeURIComponent(rendition)}`;
  const response = await (fresh
    ? fetch(remoteUrl(path), { cache: "no-store", signal: AbortSignal.timeout(5000) })
    : contentFetch(path)).catch(() => null);
  if (response?.ok) return await response.json() as TreeNode[];
  if (fresh) throw new Error("Contents refresh unavailable");
  // Old servers and offline replicas may only have the legacy title spine.
  const legacy = await contentFetch(`/api/tree?rendition=${encodeURIComponent(rendition)}`);
  if (!legacy.ok) throw new Error("Contents unavailable");
  return await legacy.json() as TreeNode[];
}

/** Only unfinished synthesis needs refreshes; the first render uses its title snapshot. */
export function useContentsSnapshot(initial: TreeNode[], book: string | undefined, rendition: string, visible: boolean): TreeNode[] {
  const [updated, setUpdated] = useState<{ source: TreeNode[]; tree: TreeNode[] }>();
  const tree = updated?.source === initial ? updated.tree : initial;
  useEffect(() => {
    if (!book || !visible) return;
    const pending = (nodes: TreeNode[]): boolean => nodes.some(node =>
      Object.values(node.audio ?? {}).some(chapter => chapter.voices.some(voice => voice.status === "queued" || voice.status === "running")) || pending(node.children));
    if (!pending(tree)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        if (!document.hidden) {
          const next = await loadContentsTree(book, rendition, true);
          if (!cancelled) { setUpdated({ source: initial, tree: contentsSnapshotScope(initial, next, book) }); return; }
        }
      } catch { /* Keep the complete snapshot during disconnects. */ }
      if (!cancelled) timer = setTimeout(() => void refresh(), 5000);
    };
    timer = setTimeout(() => void refresh(), 5000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [initial, tree, book, rendition, visible]);
  return tree;
}

/** Synchronous projection: opening contents never fetches or clears row details. */
export function contentsAudio(
  tree: TreeNode[],
  lang: string | undefined,
  preference: string | null,
  selectedVoice?: string,
  playingPath?: string,
): ReadonlyMap<string, ChapterAudioInfo> {
  const rows = new Map<string, ChapterAudioInfo>();
  const visit = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      const chapter = lang ? node.audio?.[lang] : undefined;
      const voice = chapter && selectPreferredVoice(chapter, preference, node.path === playingPath ? selectedVoice : undefined);
      if (voice) rows.set(node.path, { voice, ...(voice.seconds !== undefined ? { seconds: voice.seconds } : {}) });
      visit(node.children);
    }
  };
  visit(tree);
  return rows;
}

export function contentsPreference(bookSlug: string | undefined, rendition: string, lang: string | undefined): string | null {
  return bookSlug && lang ? localStorage.getItem(voicePreferenceKey({ bookSlug, rendition, lang, bookLabel: "", cover: false, chapterPath: "", chapterLabel: "" })) : null;
}
