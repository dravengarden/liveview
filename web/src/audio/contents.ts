import { useEffect, useState } from "react";
import { contentFetch } from "@/native-sync";
import { preferredVoice, selectPreferredVoice, speechCatalog, voicePreferenceKey, type VoiceChoice } from "./speech";
import type { NowPlaying } from "./player";
import type { Mark } from "@/types";

export interface ChapterAudioInfo {
  voice: VoiceChoice;
  seconds?: number;
}

export function markDuration(data: unknown): number | undefined {
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const end = (data[data.length - 1] as Mark | undefined)?.end_ms;
  return typeof end === "number" && Number.isFinite(end) && end > 0 ? end / 1000 : undefined;
}

/** One book snapshot, two bounded timing reads at a time, no synthesis side effects.
 * Hidden contents and background pages never keep polling. Hash-keyed timings
 * are already stored by the content replica, not a second URL cache. */
export function useContentsAudio(
  book: string | undefined,
  rendition: string,
  lang: string | undefined,
  visible: boolean,
  selectedVoice: string | undefined,
  playingPath: string | undefined,
): ReadonlyMap<string, ChapterAudioInfo> {
  const [rows, setRows] = useState<ReadonlyMap<string, ChapterAudioInfo>>(new Map());
  useEffect(() => {
    setRows(new Map());
    if (!book || !lang || !visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let previous = "";
    const durations = new Map<string, number>();
    const base: NowPlaying = { bookSlug: book, bookLabel: "", chapterPath: "", chapterLabel: "", cover: false, rendition, lang };
    const refresh = async (): Promise<void> => {
      if (busy || cancelled || document.hidden) return;
      busy = true;
      try {
        const catalog = await speechCatalog(base, true).catch(() => null)
          ?? await speechCatalog(base);
        if (!catalog || cancelled || document.hidden) return;
        const prefix = `${rendition}/${lang}/`;
        const chapters = catalog.chapters.filter(c => c.id.startsWith(prefix));
        // Resolve the shared server preference once, not one request per row.
        if (chapters[0]) await preferredVoice(base, chapters[0]);
        const preference = localStorage.getItem(voicePreferenceKey(base));
        const result = new Map<string, ChapterAudioInfo>();
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < chapters.length && !cancelled && !document.hidden) {
            const chapter = chapters[cursor++];
            if (!chapter) break;
            const path = `${book}/${chapter.id.slice(prefix.length)}`;
            const voice = selectPreferredVoice(chapter, preference, path === playingPath ? selectedVoice : undefined);
            if (!voice || cancelled) continue;
            let seconds = voice.marks_hash ? durations.get(voice.marks_hash) : undefined;
            if (voice.status === "ready" && voice.marks_hash && seconds === undefined) {
              try {
                const response = await contentFetch(`/api/blob/${voice.marks_hash}`, { cacheFirst: true, connectMs: 2000 });
                seconds = response.ok ? markDuration(await response.json()) : undefined;
                if (seconds !== undefined) durations.set(voice.marks_hash, seconds);
              } catch { /* A timing miss must not hide a known generation state. */ }
            }
            result.set(path, { voice, ...(seconds !== undefined ? { seconds } : {}) });
          }
        };
        await Promise.all([worker(), worker()]);
        if (!cancelled && !document.hidden) {
          const signature = JSON.stringify([...result].sort(([a], [b]) => a.localeCompare(b)));
          if (signature !== previous) {
            previous = signature;
            setRows(result);
          }
        }
      } catch { /* Keep the last observed state during a transient disconnect. */ }
      finally {
        busy = false;
        if (!cancelled && !document.hidden) timer = setTimeout(() => void refresh(), 5000);
      }
    };
    const visibility = (): void => {
      clearTimeout(timer);
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [book, rendition, lang, visible, selectedVoice, playingPath]);
  return rows;
}
