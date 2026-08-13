// Global MUI haptic delegation — call installHaptics() ONCE at app startup and
// every MUI control buzzes with the right feel, with zero per-call-site wiring:
//
//   • any .MuiButtonBase-root (Button, IconButton, MenuItem, ListItemButton, Tab,
//     Chip, ToggleButton, AccordionSummary, Select trigger, …) → a light impact on
//     press (medium for a destructive/error button, or one tagged data-haptic).
//   • any .MuiSwitch / .MuiCheckbox / .MuiRadio flip → a selection tick.
//   • any popup (Dialog, Menu, Popover, Drawer, Select dropdown — all mount a
//     .MuiModal-root portal) → a soft impact on OPEN; dismiss buzzes AT THE GESTURE
//     (the option/button press, or a backdrop tap), not on the delayed removal.
//
// Why delegation instead of wrapping components: it covers EVERY MUI surface in the
// app (including ones added later) from one listener set, and it composes with
// explicit haptic() calls for keyboard/semantic actions — the haptics primitive's
// coalesce window collapses a delegated press + an explicit call for the same
// gesture into a single tap, so nothing double-buzzes.
//
// iOS-native in spirit: a tap tick on buttons (fired on pointerup when the finger
// barely moved, so a scroll flick that starts on a clickable row never buzzes), a
// selection tick for toggles, a soft present/dismiss for sheets.

import { haptic, selectionHaptic } from "./haptics.ts";

export interface HapticDelegationOptions {
  /** Buzz on MuiButtonBase press. Default true. */
  readonly buttons?: boolean;
  /** Buzz on Switch/Checkbox/Radio flip. Default true. */
  readonly toggles?: boolean;
  /** Buzz on popup (Modal portal) open/close. Default true. */
  readonly overlays?: boolean;
}

const OVERLAY_SELECTOR = ".MuiModal-root, .MuiPopover-root, .MuiDialog-root, .MuiDrawer-root";
const TOGGLE_SELECTOR = ".MuiSwitch-root, .MuiCheckbox-root, .MuiRadio-root";
// Pressable surfaces. MuiButtonBase covers Button/IconButton/MenuItem/ListItemButton/
// Tab/Chip/ToggleButton, but a MUI Select trigger is a plain role=combobox div (NOT
// a ButtonBase), so add it explicitly — otherwise dropdowns feel dead on tap.
const PRESS_SELECTOR = '.MuiButtonBase-root, .MuiSelect-select, [role="combobox"]';
// A button-triggered popup opens within ~this long of the press; inside the window
// the press already buzzed, so the open is suppressed (no double). A programmatic
// open (no recent press) still buzzes.
const PRESS_TO_OPEN_MS = 250;

function now(): number {
  return globalThis.performance?.now?.() ?? 0;
}

// A custom clickable (a styled Box/Stack with onClick) is NOT a MUI component, so
// the selectors above miss it — but it almost always sets `cursor: pointer`, the
// universal "this is clickable" signal. Walk up a few levels (the event may target
// a text node's parent inside the clickable) and treat a pointer cursor as a tap.
// Bail on form fields (their cursor isn't a tap action). This is what makes custom
// expanders (a "Reading font" summary, a "N Drafts" header) buzz with no per-site
// wiring.
// Tapping into a text field to start typing is a deliberate "enter input" gesture
// that deserves a tap. Covers <textarea>, text-like <input>, contenteditable, and
// CodeMirror (.cm-editor). Non-text inputs (checkbox/radio) are excluded — those
// flip via the change handler. Fires on the pointerdown, i.e. the tap, not on
// programmatic focus.
const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

function isTextEntry(el: Element): boolean {
  const node = el.closest("input, textarea, [contenteditable], .cm-editor");
  if (node === null) {
    return false;
  }
  if (node instanceof HTMLTextAreaElement) {
    return true;
  }
  if (node instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(node.type);
  }
  return true; // contenteditable / CodeMirror
}

function isCustomClickable(el: Element): boolean {
  let node: Element | null = el;
  for (let i = 0; node !== null && i < 4; i += 1) {
    if (node instanceof HTMLElement) {
      const tag = node.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable) {
        return false;
      }
      if (globalThis.getComputedStyle(node).cursor === "pointer") {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

let lastPressAt = -Infinity;

// Tap detection. We DON'T buzz on pointerdown — a touch that starts on a clickable
// row inside a scroll list would then vibrate on every scroll flick (the reported
// bug). Instead record the down point and only buzz on pointerup if the finger
// barely moved (a tap, not a scroll/drag). A scroll moves past the slop — or fires
// pointercancel — and stays silent.
const TAP_SLOP = 10;
let downX = 0;
let downY = 0;
let downTarget: Element | null = null;

function classifyTap(target: Element): void {
  // Tap-outside dismiss: a tap on a popup backdrop closes it. Buzz the dismiss now
  // (Select options / Dialog buttons are MuiButtonBase and buzz on their own; this
  // covers the click-outside path that has no button of its own).
  if (target.closest(".MuiBackdrop-root")) {
    haptic("light");
    return;
  }
  // Tap into a text field → "entering input" tap.
  if (isTextEntry(target)) {
    haptic("light");
    return;
  }
  const btn = target.closest(PRESS_SELECTOR);
  if (btn !== null) {
    if (btn.classList.contains("Mui-disabled") || btn.hasAttribute("disabled")) {
      return;
    }
    lastPressAt = now();
    // Destructive / explicitly-tagged controls get a firmer tap.
    const tag = btn instanceof HTMLElement ? btn.dataset["haptic"] : undefined;
    const strong = tag === "medium" ||
      btn.classList.contains("MuiButton-colorError") ||
      btn.classList.contains("MuiIconButton-colorError");
    haptic(strong ? "medium" : "light");
    return;
  }
  // Fallback: a non-MUI custom clickable (cursor:pointer).
  if (isCustomClickable(target)) {
    lastPressAt = now();
    haptic("light");
  }
}

function onPointerDownTrack(e: Event): void {
  const pe = e as PointerEvent;
  downX = pe.clientX;
  downY = pe.clientY;
  downTarget = e.target as Element | null;
}

function onPointerUpTap(e: Event): void {
  const target = downTarget;
  downTarget = null;
  if (target === null) {
    return;
  }
  const pe = e as PointerEvent;
  if (Math.hypot(pe.clientX - downX, pe.clientY - downY) > TAP_SLOP) {
    return; // a scroll / drag, not a tap
  }
  classifyTap(target);
}

function onPointerCancelTap(): void {
  downTarget = null;
}

function onChangeHaptic(e: Event): void {
  const target = e.target as Element | null;
  if (target?.closest?.(TOGGLE_SELECTOR)) {
    selectionHaptic();
  }
}

function anyOverlay(nodes: NodeList): boolean {
  for (const n of nodes) {
    if (n instanceof Element && n.matches(OVERLAY_SELECTOR)) {
      return true;
    }
  }
  return false;
}

function onOverlayMutations(records: MutationRecord[]): void {
  for (const r of records) {
    // OPEN only: a soft present, UNLESS a button just opened it (the press already
    // buzzed — suppress to avoid a double). The portal is ADDED instantly on open,
    // so this is in sync with the gesture. CLOSE is deliberately NOT handled here:
    // the portal is REMOVED only after the close animation, which feels like a
    // delayed buzz — dismiss is signalled at the gesture instead (the option/button
    // press, or the backdrop pointerdown above).
    if (anyOverlay(r.addedNodes) && now() - lastPressAt > PRESS_TO_OPEN_MS) {
      haptic("soft");
    }
  }
}

/** Install the global delegation. Returns a cleanup fn (remove all listeners). */
export function installHaptics(opts: HapticDelegationOptions = {}): () => void {
  const { buttons = true, toggles = true, overlays = true } = opts;
  const doc = globalThis.document as Document | undefined;
  if (doc?.body === undefined || doc.body === null) {
    return () => {};
  }
  const cleanups: (() => void)[] = [];

  if (buttons) {
    // Tap detection (down records, up buzzes only if it was a tap not a scroll).
    doc.addEventListener("pointerdown", onPointerDownTrack, { capture: true, passive: true });
    doc.addEventListener("pointerup", onPointerUpTap, { capture: true, passive: true });
    doc.addEventListener("pointercancel", onPointerCancelTap, { capture: true, passive: true });
    cleanups.push(() => {
      doc.removeEventListener("pointerdown", onPointerDownTrack, { capture: true });
      doc.removeEventListener("pointerup", onPointerUpTap, { capture: true });
      doc.removeEventListener("pointercancel", onPointerCancelTap, { capture: true });
    });
  }

  if (toggles) {
    doc.addEventListener("change", onChangeHaptic, { capture: true });
    cleanups.push(() => doc.removeEventListener("change", onChangeHaptic, { capture: true }));
  }

  if (overlays && typeof MutationObserver !== "undefined") {
    const obs = new MutationObserver(onOverlayMutations);
    obs.observe(doc.body, { childList: true });
    cleanups.push(() => obs.disconnect());
  }

  return () => {
    for (const c of cleanups) {
      c();
    }
  };
}
