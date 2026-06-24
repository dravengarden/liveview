// Build-time platform target — the seam the app/pwa split (A2) is built on.
//
// A2 will inject `__TARGET__` via a vite `define` per `--mode app|pwa`, letting
// Rollup tree-shake the unused platform stack (no service worker in the app
// build; no native bridge in the pwa build). UNTIL then `__TARGET__` is not
// defined, so we fall back to a runtime guess that exactly matches today's
// behavior — the Tauri shell is the native "app", everything else is "pwa". So
// introducing this constant changes nothing at runtime now; it just gives the
// rest of the code one build-time switch to branch on instead of scattered
// `"__TAURI_INTERNALS__" in globalThis` / `nativeSyncAvailable()` checks.

export type Target = "app" | "pwa";

// `typeof` on a never-declared identifier is the one safe way to probe it without
// a ReferenceError when vite hasn't replaced it (pre-A2 builds).
declare const __TARGET__: Target | undefined;

function resolveTarget(): Target {
  // @ts-ignore — __TARGET__ may be undefined until the build define lands (A2).
  if (typeof __TARGET__ !== "undefined" && __TARGET__) return __TARGET__;
  // Runtime fallback (pre-build-split): the native shell is the app target.
  return "__TAURI_INTERNALS__" in globalThis ? "app" : "pwa";
}

/** The platform this bundle is for. After A2 this is a build-time constant, so
 *  `if (IS_APP)` / `if (IS_PWA)` branches dead-code-eliminate the other stack. */
export const TARGET: Target = resolveTarget();

/** Native app (Tauri iOS/macOS): bundled SPA, native data layer, NO service worker. */
export const IS_APP = TARGET === "app";

/** Browser / installable PWA: remote origin, service-worker offline layer. */
export const IS_PWA = TARGET === "pwa";
