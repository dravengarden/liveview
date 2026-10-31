import { useEffect, useState } from "react";
import { isLikelyOffline, onNativeNetworkClass } from "@/native-sync";
import { storedTextPaths } from "@/replica/mod.ts";
import { onServerReachability, serverReachability } from "@/serverReachability";

/** Whether reads cannot reach the server: no network (airplane mode), or a
 *  network that does not lead to it (in-flight Wi-Fi before purchase, captive
 *  portals, an outage). Either way only downloaded content can open. */
export function readingOffline(): boolean {
  return isLikelyOffline() || serverReachability() === "unreachable";
}

/** {@link readingOffline}, kept current as connectivity changes. */
export function useReadingOffline(): boolean {
  const [offline, setOffline] = useState(readingOffline);
  useEffect(() => {
    const update = (): void => setOffline(readingOffline());
    update();
    globalThis.addEventListener("online", update);
    globalThis.addEventListener("offline", update);
    const offNetwork = onNativeNetworkClass(update);
    const offServer = onServerReachability(update);
    return () => {
      globalThis.removeEventListener("online", update);
      globalThis.removeEventListener("offline", update);
      offNetwork();
      offServer();
    };
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
