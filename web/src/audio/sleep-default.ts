import { persisted, type Store } from "@/_store/mod.ts";
import type { RemoteBackend } from "@/_sync/mod.ts";
import { settingBackend } from "@/syncBackends";
import { pendingSettingValue } from "@/syncQueue";
import { parseSleepMinutes } from "./sleep-timer";

export const SLEEP_DEFAULT_KEY = "audio.sleepDefaultMinutes";

/** The preference uses the existing durable settings outbox. All adopted
 * values, including remote edits, also become the next offline startup seed. */
export function sleepPreference(
  local: Store<number>,
  remote: RemoteBackend<number>,
  pending: () => string | null = () => null,
) {
  let revision = 0;
  let ready: Promise<void> | undefined;
  return {
    store: local,
    connect(): Promise<void> {
      return ready ??= (async () => {
        const before = revision;
        remote.subscribe?.(value => {
          revision++;
          local.set(value);
        });
        try {
          const queued = pending();
          const value = await remote.load();
          // A local choice or live push made during the startup GET wins.
          const raw = pending() ?? queued;
          if (before === revision) {
            if (raw !== null) local.set(parseSleepMinutes(raw));
            else if (value !== null) local.set(value);
          }
        } catch { /* Keep the last local preference when offline. */ }
      })();
    },
    set(minutes: number): void {
      parseSleepMinutes(String(minutes));
      revision++;
      local.set(minutes);
      void remote.save(minutes);
    },
  };
}

export const sleepDefault = sleepPreference(
  persisted(SLEEP_DEFAULT_KEY, 0, { deserialize: parseSleepMinutes }),
  settingBackend(SLEEP_DEFAULT_KEY, { enc: String, dec: parseSleepMinutes }),
  () => pendingSettingValue(SLEEP_DEFAULT_KEY),
);
