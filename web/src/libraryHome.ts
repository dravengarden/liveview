import type { Book, BookProgress } from "./types/index.ts";

/** Resume the most recently used rendition; finished tracks stay in history. */
export function resumableLibraryBooks(
  books: Book[],
  progress: Record<string, BookProgress>,
  limit: number,
): Book[] {
  const latest = (book: Book) => {
    const tracks = progress[book.slug];
    const text = tracks?.text;
    const audio = tracks?.audio;
    return text && audio
      ? (text.updatedAt >= audio.updatedAt ? text : audio)
      : text ?? audio;
  };
  return books.filter((book) => {
    const track = latest(book);
    return track != null && track.fraction < 0.98;
  }).sort((a, b) => latest(b)!.updatedAt - latest(a)!.updatedAt)
    .slice(0, limit);
}

export function recentLibraryBooks(books: Book[], limit: number): Book[] {
  return [...books].sort((a, b) =>
    (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0)
  ).slice(0, limit);
}
