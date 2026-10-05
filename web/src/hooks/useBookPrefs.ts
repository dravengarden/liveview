import { useCallback, useEffect, useState } from "react";
import { loadAllServerSettings, putServerSetting } from "@/syncBackends";

export type BookPrefs = Record<string, { rendition?: string; lang?: string }>;

// Per-book card state, SERVER-side (cross-device, survives a reload): which
// rendition (read/listen) and which language edition the book was last opened
// in. Keyed by slug; hydrated from /api/settings (`book.<slug>.{rendition,lang}`)
// and written on every switch. The per-rendition reading position is already
// server-side (it's keyed by chapter path, and text vs audio chapters differ).
export function useBookPrefs(): {
  bookPrefs: BookPrefs;
  saveBookPref: (
    slug: string,
    patch: { rendition?: string; lang?: string },
  ) => void;
} {
  const [bookPrefs, setBookPrefs] = useState<BookPrefs>({});
  useEffect(() => {
    void loadAllServerSettings().then((s) => {
      const out: Record<string, { rendition?: string; lang?: string }> = {};
      for (const [k, v] of Object.entries(s)) {
        const m = /^book\.(.+)\.(rendition|lang)$/.exec(k);
        if (m?.[1] && m[2]) {
          (out[m[1]] ??= {})[m[2] as "rendition" | "lang"] = v;
        }
      }
      setBookPrefs(out);
    });
  }, []);

  const saveBookPref = useCallback(
    (slug: string, patch: { rendition?: string; lang?: string }) => {
      setBookPrefs((prev) => ({
        ...prev,
        [slug]: { ...prev[slug], ...patch },
      }));
      if (patch.rendition !== undefined) {
        putServerSetting(
          `book.${slug}.rendition`,
          patch.rendition,
        );
      }
      if (patch.lang !== undefined) {
        putServerSetting(
          `book.${slug}.lang`,
          patch.lang,
        );
      }
    },
    [],
  );
  return { bookPrefs, saveBookPref };
}
