import type { Book, BookProgress } from "./types/index.ts";

/** Pick the latest unfinished mode; document collections have no book-level finish. */
export function resumableLibraryProgress(
  book: Book,
  progress: BookProgress | undefined,
):
  | { kind: "text" | "audio"; track: NonNullable<BookProgress["text"]> }
  | undefined {
  const tracks = (["text", "audio"] as const).flatMap((kind) => {
    const track = progress?.[kind];
    return track && (!book.manifest || track.fraction < 0.98)
      ? [{ kind, track }]
      : [];
  });
  return tracks.sort((a, b) => b.track.updatedAt - a.track.updatedAt)[0];
}
export function resumableLibraryBooks(
  books: Book[],
  progress: Record<string, BookProgress>,
  limit: number,
): Book[] {
  return books.filter((book) =>
    resumableLibraryProgress(book, progress[book.slug])
  )
    .sort((a, b) =>
      resumableLibraryProgress(b, progress[b.slug])!.track.updatedAt -
      resumableLibraryProgress(a, progress[a.slug])!.track.updatedAt
    ).slice(0, limit);
}

export function recentLibraryBooks(books: Book[], limit: number): Book[] {
  return [...books].sort((a, b) =>
    (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0)
  ).slice(0, limit);
}
