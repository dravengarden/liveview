import { type RefObject, useCallback, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { fetchChapterResponse } from "@/contentLoad";
import { isLikelyOffline, readingOffline } from "@/connectivity";
import { contentFetch } from "@/native-sync";
import { resolveFirstChapter } from "@/readerTree";
import type { FileType } from "@/types";
import {
  type ChapterError,
  type ChapterRequest,
  loadChapter,
  type UntranslatedNotice,
} from "./chapter.ts";

export interface ChapterContent {
  fileType: FileType;
  /** Rendered body; null while the first chapter is loading. */
  content: string | null;
  untranslated: UntranslatedNotice | null;
  error: ChapterError | null;
  /** Load a chapter. Claims the navigation epoch; a later claim wins. */
  load: (req: ChapterRequest) => Promise<void>;
  /** Drop the shown chapter (back to the shelf). */
  reset: () => void;
  clearUntranslated: () => void;
  /** Apply a live server push if it is for the edition currently shown. */
  applyLive: (lang: string, fileType: FileType, content: string) => void;
}

/** Run a state swap inside a view transition where supported, so only the
 *  `lv-content` element cross-fades between chapters. */
function crossFade(apply: () => void): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> };
  };
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || typeof doc.startViewTransition !== "function") {
    apply();
    return;
  }
  const transition = doc.startViewTransition(() => flushSync(apply));
  // A newer navigation legitimately cancels the transition; do not report
  // the expected rejection.
  void transition.finished.catch(() => undefined);
}

/**
 * The reader's chapter body. The navigation epoch is owned by the caller
 * (`epoch`), because restores and returns to the shelf also claim it; this
 * hook only checks it. `redirect` re-enters navigation when a path is missing.
 */
export function useChapterContent(
  epoch: RefObject<number>,
  redirect: (req: ChapterRequest) => void,
): ChapterContent {
  const [fileType, setFileType] = useState<FileType>("markdown");
  const [content, setContent] = useState<string | null>(null);
  const [untranslated, setUntranslated] = useState<UntranslatedNotice | null>(null);
  const [error, setError] = useState<ChapterError | null>(null);
  // The edition actually shown, for matching live pushes.
  const shownLang = useRef("");
  const redirectRef = useRef(redirect);
  redirectRef.current = redirect;

  const load = useCallback(async (req: ChapterRequest) => {
    const seq = ++epoch.current;
    setError(null);
    const outcome = await loadChapter(req, {
      fetch: (url) => fetchChapterResponse(url, contentFetch, isLikelyOffline),
      offline: readingOffline,
      firstChapter: resolveFirstChapter,
      current: () => seq === epoch.current,
    });
    switch (outcome.kind) {
      case "stale":
        return;
      case "redirect":
        redirectRef.current({ ...req, path: outcome.path });
        return;
      case "error":
        console.error("Failed to load chapter:", req.path, outcome.error);
        setError(outcome.error);
        return;
      case "loaded":
        shownLang.current = outcome.data.lang;
        crossFade(() => {
          if (seq !== epoch.current) return;
          setFileType(outcome.data.file_type);
          setContent(outcome.data.content);
          setUntranslated(outcome.untranslated);
        });
    }
  }, [epoch]);

  const reset = useCallback(() => {
    setContent(null);
    setUntranslated(null);
  }, []);

  const clearUntranslated = useCallback(() => setUntranslated(null), []);

  const applyLive = useCallback((lang: string, nextType: FileType, body: string) => {
    if (lang !== shownLang.current) return;
    setFileType(nextType);
    setContent(body);
  }, []);

  return { fileType, content, untranslated, error, load, reset, clearUntranslated, applyLive };
}
