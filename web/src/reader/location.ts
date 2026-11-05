// Reader location persistence: the URL hash deep link and the device-local
// resume slot used when the native shell relaunches without a hash. Everything
// here is pure except the four functions that touch `window`.

import type { Book } from "@/types";

export interface HashState {
  path: string | null;
  lang: string | null;
  rendition: string | null;
}

const EMPTY: HashState = { path: null, lang: null, rendition: null };

/** The book a virtual document path belongs to: its first segment. */
export function bookSlugOf(path: string): string {
  return path.split("/")[0] ?? "";
}

// Hash scheme: `#<encoded-path>` for a file, optionally `&lang=<code>` to pin
// a language edition and `&rendition=<kind>` to pin a reading mode.
// `encodeURIComponent` escapes `&`/`=`, so the path segment can never collide
// with the `&lang=`/`&rendition=` separators.
export function parseHash(hash: string): HashState {
  if (!hash.startsWith("#")) return EMPTY;
  const body = hash.slice(1);
  if (!body) return EMPTY;
  const parts = body.split("&");
  const path = decodeURIComponent(parts[0] ?? "") || null;
  let lang: string | null = null;
  let rendition: string | null = null;
  for (const seg of parts.slice(1)) {
    if (seg.startsWith("lang=")) {
      lang = decodeURIComponent(seg.slice(5)) || null;
    } else if (seg.startsWith("rendition=")) {
      rendition = decodeURIComponent(seg.slice(10)) || null;
    }
  }
  return { path, lang, rendition };
}

export function getHashState(): HashState {
  return parseHash(window.location.hash);
}

export function buildHash(
  path: string | null,
  lang: string | null,
  rendition: string | null,
): string {
  if (!path) return "";
  let h = `#${encodeURIComponent(path)}`;
  if (lang) h += `&lang=${encodeURIComponent(lang)}`;
  if (rendition) h += `&rendition=${encodeURIComponent(rendition)}`;
  return h;
}

/**
 * The tokens a chapter writes into the hash. The language is always pinned:
 * a missing `lang` is re-derived on restore from the UI language, not from the
 * book's default edition, so omitting it would flip a book whose default
 * differs from the UI language on reload. The rendition is omitted when it is
 * the book's default, because the restore default matches that omission.
 */
export function hashTokens(
  lang: string,
  rendition: string,
  book: Pick<Book, "default_rendition"> | undefined,
): { lang: string | null; rendition: string | null } {
  return {
    lang: lang || null,
    rendition: book && rendition !== book.default_rendition ? rendition : null,
  };
}

export function writeHash(
  path: string | null,
  lang: string | null,
  rendition: string | null,
  replace: boolean,
): void {
  const h = buildHash(path, lang, rendition);
  const url = h || window.location.pathname;
  if (replace) {
    window.history.replaceState(null, "", url);
  } else {
    window.history.pushState(null, "", url);
  }
}

// Device-local "resume where I left off". The native shell reopens the BASE
// url (no hash) on a cold relaunch, so the last reading location is stashed
// here and re-entered on a hash-less load. Cleared on return to the shelf, so
// relaunching from the shelf stays on the shelf. The scroll position within
// the chapter is restored separately from the progress store.
const RESUME_KEY = "lv-resume";

export interface ResumeLocation {
  path: string;
  lang: string | null;
  rendition: string | null;
}

export function parseResume(raw: string | null): ResumeLocation | null {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<ResumeLocation>) : null;
    return v && typeof v.path === "string" && v.path
      ? { path: v.path, lang: v.lang ?? null, rendition: v.rendition ?? null }
      : null;
  } catch {
    return null;
  }
}

export function readResume(): ResumeLocation | null {
  try {
    return parseResume(localStorage.getItem(RESUME_KEY));
  } catch {
    // Unavailable (private mode) — resume is best-effort.
    return null;
  }
}

export function writeResume(loc: ResumeLocation | null): void {
  try {
    if (loc) localStorage.setItem(RESUME_KEY, JSON.stringify(loc));
    else localStorage.removeItem(RESUME_KEY);
  } catch {
    // Best-effort; ignore storage failures.
  }
}
