// ⚠️ VENDORED — DO NOT EDIT. A committed copy of @shared-utils/store +
// @shared-utils/store-react (shared-utils `state-sync-engine` branch), bundled
// into one dir for liveview: `persisted()` per-device reactive store + the
// `useStore(store)` React hook. Edit in shared-utils + re-vendor when the lib
// changes; replace with an import once it's on JSR / shared-utils main.

export { persisted } from "./store.ts";
export type { KvStorage, PersistedOpts, ReadableStore, Store } from "./store.ts";
export { useStore } from "./use-store.ts";
