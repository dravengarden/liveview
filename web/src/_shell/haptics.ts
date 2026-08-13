// Cross-platform haptic feedback — a reusable primitive + a global MUI delegation
// layer (see ./haptic-delegation.ts). Import { haptic } anywhere you want a tactile
// tap; or call installHaptics() once to auto-buzz every MUI button/switch/popup.
// Adding a call site is pure web — it ships with the next deploy, NO app reinstall,
// because the native shell already carries the generic haptics plugin (all four
// commands granted in its capability).
//
// Resolution order, best → worst:
//   1. Native Tauri haptics plugin — real OS haptics (UIImpactFeedbackGenerator on
//      iOS). The ONLY reliable haptic on iOS: Safari/PWA has no Vibration API.
//      Feature-detected through the injected IPC bridge — NO @tauri-apps import, so
//      a plain browser/PWA is untouched.
//   2. navigator.vibrate — Android web.
//   (There is NO iOS-Safari web fallback any more: the old `<input switch>` toggle
//   trick was unreliable to the point of never firing, so it was removed. On a
//   non-Tauri iOS browser haptics are simply a no-op — a platform limitation.)

/** iOS UIImpactFeedbackGenerator styles. Discrete "something committed" tap. */
export type HapticStyle = "light" | "medium" | "heavy" | "soft" | "rigid";
/** iOS UINotificationFeedbackGenerator types. An async OUTCOME: done / needs-you /
 *  failed. */
export type HapticNotification = "success" | "warning" | "error";

// Tauri 2 injects this IPC bridge on the global inside a native shell. Accessed via
// a string key so the leading-underscore global name doesn't trip the dangle lint.
interface TauriInternals {
  readonly invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
}
type NativeSelectionBridge = Readonly<Record<string, unknown>>;
const TAURI_INTERNALS_KEY = "__TAURI_INTERNALS__";
const PREPARE_SELECTION_KEY = "__nativePrepareSelectionHaptic";
const FIRE_SELECTION_KEY = "__nativeSelectionHaptic";
let preparedSelectionUntil = -Infinity;

// Coalesce window. Overlapping triggers — the global delegation press AND an
// explicit semantic call for the SAME gesture, or two listeners on one tap — can
// fire within a frame or two; collapse them into ONE physical tap so nothing
// double-buzzes. Distinct intentional taps are always > this apart.
const COALESCE_MS = 45;
let lastFireAt = -Infinity;
function shouldFire(): boolean {
  const now = globalThis.performance?.now?.() ?? 0;
  if (now - lastFireAt < COALESCE_MS) {
    return false;
  }
  lastFireAt = now;
  return true;
}

// Fire a native haptics-plugin command. Returns true if we ARE in a native shell
// (so the caller skips the web fallback); the invoke is fire-and-forget, the IIFE
// swallows the rejection that happens if the plugin/permission isn't in the build.
function nativeHaptic(command: string, args?: unknown): boolean {
  try {
    const internals = (globalThis as Record<string, unknown>)[
      TAURI_INTERNALS_KEY
    ] as TauriInternals | undefined;
    const invoke = internals?.invoke;
    if (typeof invoke !== "function") {
      return false;
    }
    void (async (): Promise<void> => {
      try {
        await invoke(command, args);
      } catch {
        // plugin or permission missing in the native build — silent
      }
    })();
    return true;
  } catch {
    return false;
  }
}

function webVibrate(ms: number): void {
  try {
    const nav = globalThis.navigator;
    if (typeof nav?.vibrate === "function") {
      nav.vibrate(ms);
    }
  } catch {
    // unsupported (iOS Safari) — ignore
  }
}

// Android-vibrate durations standing in for each impact style (iOS uses the real
// generator, so these only matter on Android web).
const STYLE_VIBRATE_MS: Record<HapticStyle, number> = {
  light: 8,
  soft: 8,
  rigid: 12,
  medium: 12,
  heavy: 18,
};

/** Fire an impact haptic. Native OS haptic inside a Tauri shell, Android vibrate
 *  otherwise. Coalesced + safe to call anywhere — silent no-op where unsupported. */
export function haptic(style: HapticStyle = "medium"): void {
  if (!shouldFire()) {
    return;
  }
  if (nativeHaptic("plugin:haptics|impact_feedback", { style })) {
    return;
  }
  webVibrate(STYLE_VIBRATE_MS[style]);
}

/** Fire a notification haptic for an async OUTCOME (a turn finished / errored /
 *  needs you). iOS plays the distinct success/warning/error pattern. */
export function notificationHaptic(type: HapticNotification): void {
  if (!shouldFire()) {
    return;
  }
  if (nativeHaptic("plugin:haptics|notification_feedback", { type })) {
    return;
  }
  webVibrate(type === "error" ? 30 : 20);
}

/** Warm a persistent native selection generator before a spatial gesture can
 * cross a magnetic threshold. Older shells and browsers safely no-op here. */
export function prepareSelectionHaptic(): void {
  const bridge = globalThis as typeof globalThis & NativeSelectionBridge;
  const prepare = bridge[PREPARE_SELECTION_KEY];
  if (typeof prepare !== "function") {
    return;
  }
  prepare();
  preparedSelectionUntil = (globalThis.performance?.now?.() ?? 0) + 2000;
}

/** Fire a selection-change haptic — the subtle tick for a toggle / moving through
 *  discrete options (switch, segmented control, reorder step). */
export function selectionHaptic(): void {
  if (!shouldFire()) {
    return;
  }
  const bridge = globalThis as typeof globalThis & NativeSelectionBridge;
  const firePrepared = bridge[FIRE_SELECTION_KEY];
  if (
    (globalThis.performance?.now?.() ?? 0) <= preparedSelectionUntil &&
    typeof firePrepared === "function"
  ) {
    preparedSelectionUntil = -Infinity;
    firePrepared();
    return;
  }
  if (nativeHaptic("plugin:haptics|selection_feedback")) {
    return;
  }
  webVibrate(6);
}
