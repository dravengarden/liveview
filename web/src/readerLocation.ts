// Reader location persistence: the URL hash deep link and the device-local
// resume slot used when the native shell relaunches without a hash.

export interface HashState {
  path: string | null;
  lang: string | null;
  rendition: string | null;
}

// Hash scheme: `#<encoded-path>` for a file, optionally `&lang=<code>` to pin a
// non-default language edition and `&rendition=<kind>` to pin a non-default
// reading mode. `encodeURIComponent` escapes `&`/`=`, so the path segment can
// never collide with the `&lang=`/`&rendition=` separators. Both are omitted
// when they equal the book's default, to keep URLs clean.
export function getHashState(): HashState {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) {
    return { path: null, lang: null, rendition: null };
  }
  const body = hash.slice(1);
  if (!body) {
    return { path: null, lang: null, rendition: null };
  }
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

export function buildHash(
  path: string | null,
  lang: string | null,
  rendition: string | null,
): string {
  if (!path) {
    return "";
  }
  let h = `#${encodeURIComponent(path)}`;
  if (lang) {
    h += `&lang=${encodeURIComponent(lang)}`;
  }
  if (rendition) {
    h += `&rendition=${encodeURIComponent(rendition)}`;
  }
  return h;
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

// Device-local "resume where I left off". The native shell reopens the BASE url
// (no hash) on a cold relaunch, so a browser-style hash deep link isn't there to
// restore from — we stash the last reading location here and re-enter it on a
// hash-less load. (A normal in-browser reload keeps the hash and never needs
// this.) Cleared on return to the shelf, so relaunching from the shelf stays on
// the shelf. Scroll position within the chapter is restored separately from the
// server progress store.
const RESUME_KEY = "lv-resume";
export interface ResumeLocation {
  path: string;
  lang: string | null;
  rendition: string | null;
}
export function readResume(): ResumeLocation | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<ResumeLocation>) : null;
    return v && typeof v.path === "string" && v.path
      ? { path: v.path, lang: v.lang ?? null, rendition: v.rendition ?? null }
      : null;
  } catch {
    // Unavailable (private mode) or corrupt JSON — resume is best-effort.
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
