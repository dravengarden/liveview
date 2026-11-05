import { useEffect, useState } from "react";
import { onConnectivityChange, readingOffline } from "@/connectivity";
import { storedTextPaths } from "@/replica/mod.ts";

/** {@link readingOffline}, kept current as connectivity changes. */
export function useReadingOffline(): boolean {
  const [offline, setOffline] = useState(readingOffline);
  useEffect(() => {
    const update = (): void => setOffline(readingOffline());
    update();
    return onConnectivityChange(update);
  }, []);
  return offline;
}

const OFFLINE_SETTLE_MS = 1_500;

/**
 * The replica paths of downloaded text chapters while `active`, else `null`.
 * Nothing new arrives while offline, so one read per offline spell is enough;
 * `null` also means "cannot tell", which callers treat as available.
 */
export function useStoredTextPaths(
  active: boolean,
): ReadonlySet<string> | null {
  const [paths, setPaths] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!active) {
      setPaths(null);
      return undefined;
    }
    let cancelled = false;
    // A single failed request also reads as unreachable until the next answer;
    // only a spell that lasts dims the library, so a blip never flickers it.
    const timer = globalThis.setTimeout(() => {
      void storedTextPaths().then((next) => {
        if (!cancelled) setPaths(next);
      });
    }, OFFLINE_SETTLE_MS);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [active]);
  return paths;
}
