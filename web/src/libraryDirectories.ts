import type { Book } from "./types/index.ts";
import { sortCollectionNames } from "./libraryDiscovery.ts";

/** Authored collections are folders; unfiled books remain at the library root.
 * Names are opaque: punctuation does not create invented subdirectories. */
export function libraryDirectories(
  books: Book[],
  locale: string,
): Array<{ name: string; books: Book[] }> {
  const groups = new Map<string, Book[]>();
  for (const book of books) {
    const name = book.collection?.trim();
    if (!name) continue;
    const entries = groups.get(name) ?? [];
    entries.push(book);
    groups.set(name, entries);
  }
  return sortCollectionNames([...groups.keys()], locale).map((name) => ({
    name,
    books: groups.get(name)!,
  }));
}
