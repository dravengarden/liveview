// The two rules that keep the reader and the playback engine together.
//
// View → engine: opening an audiobook chapter makes the engine play it. Only
// view-led changes trigger this (opening a book, a Contents tap, a deep link,
// back/forward); the caller must not re-run it when the engine changes
// chapter, or the view (still on the old chapter) would drag the engine back
// while the engine → view rule moves the view forward, forever.
//
// Engine → view: when the engine advances to the next chapter while the
// reader was following it (same book, same rendition, same chapter), the
// reader moves with it. When the reader is somewhere the engine is not, it is
// never hijacked.

export interface ReaderView {
  slug: string | null;
  /** The rendition the reader shows (text or audio). */
  rendition: string | undefined;
  path: string | null;
}

export interface PlayingChapter {
  bookSlug: string;
  rendition: string;
  chapterPath: string;
  lang: string;
}

/** Whether the engine should load the chapter the audiobook view shows. */
export function engineShouldLoad(
  view: ReaderView,
  spineReady: boolean,
  playingPath: string | null,
): boolean {
  return view.rendition === "audio" && view.path !== null && view.slug !== null &&
    spineReady && playingPath !== view.path;
}

export interface FollowStep {
  /** The chapter the view and engine last agreed on, or null. */
  synced: string | null;
  /** The chapter the view should move to, if any. */
  follow: PlayingChapter | null;
}

/** Engine → view: decide whether the reader follows the engine. */
export function followEngine(
  view: ReaderView,
  playing: PlayingChapter | null,
  synced: string | null,
): FollowStep {
  if (!playing || view.slug !== playing.bookSlug || view.rendition !== playing.rendition) {
    return { synced: null, follow: null };
  }
  if (view.path === playing.chapterPath) {
    return { synced: playing.chapterPath, follow: null };
  }
  // The reader went somewhere the engine is not: leave it there.
  if (synced !== view.path) return { synced, follow: null };
  return { synced: playing.chapterPath, follow: playing };
}
