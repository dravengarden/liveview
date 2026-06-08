// ⚠️ VENDORED — DO NOT EDIT. From @shared-utils/store-react; the `@shared-utils/
// store` import is rewritten to the sibling vendored copy. See _store/mod.ts.
import { useSyncExternalStore } from "react";
import type { ReadableStore } from "./store.ts";

/** Subscribe a React component to ANY `ReadableStore` — a per-device `persisted`
 *  pref or a sync client (which exposes the same `{ get, subscribe }` shape). One
 *  hook for all reactive state in the app.
 *
 *  `store.get` is passed STRAIGHT to useSyncExternalStore as getSnapshot — never
 *  wrapped in a deriving closure — because a getSnapshot that allocates a fresh
 *  value per call makes React loop forever. The store contract guarantees `get()`
 *  is referentially stable while unchanged, so this is safe by construction. The
 *  same `get` doubles as getServerSnapshot (SSR-safe). */
export function useStore<T>(store: ReadableStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
