import { useSyncExternalStore } from "react";
import { useMediaQuery, useTheme } from "@mui/material";

// Where the nav bar sits on the mobile/compact tier. "top" is the classic
// placement; "bottom" makes it a mobile-browser-style bottom bar (the content
// fills above it, the nav drawer slides up from it). The setting is mobile-only
// — desktop is always "top" — and it applies to BOTH liveview navbars: the
// in-book NavShell (via its `barPosition` prop) and the bookshelf's own bar.
//
// A per-device preference (your phone wants bottom; the desktop is top
// regardless), so it lives in localStorage only — not the cross-device server
// settings. useSyncExternalStore + a change event, mirroring cowboy.

export type NavbarPosition = "top" | "bottom";

const KEY = "lv:navbar-pos";
const EVENT = "lv:navbar-pos-change";
const DEFAULT: NavbarPosition = "bottom";

function read(): NavbarPosition {
  const v = globalThis.localStorage?.getItem(KEY);
  return v === "bottom" || v === "top" ? v : DEFAULT;
}

// The snapshot is a primitive, so it's referentially stable by value.
let snapshot: NavbarPosition = read();

function subscribe(onChange: () => void): () => void {
  const handler = (): void => {
    snapshot = read();
    onChange();
  };
  globalThis.addEventListener?.(EVENT, handler);
  globalThis.addEventListener?.("storage", handler); // other tabs
  return () => {
    globalThis.removeEventListener?.(EVENT, handler);
    globalThis.removeEventListener?.("storage", handler);
  };
}

export function useNavbarPosition(): NavbarPosition {
  return useSyncExternalStore(subscribe, () => snapshot, () => DEFAULT);
}

export function setNavbarPosition(pos: NavbarPosition): void {
  globalThis.localStorage?.setItem(KEY, pos);
  // dispatchEvent runs listeners synchronously, so `snapshot` is refreshed
  // before this returns — the caller's next render sees the new value.
  globalThis.dispatchEvent?.(new Event(EVENT));
}

// True when the bar is actually at the bottom: the compact tier (`< lg`, the
// same breakpoint the in-book NavShell uses for its mobile drawer, tablets
// included) AND the user picked "bottom". The single source of truth shared by
// the bookshelf bar and the NavShell `barPosition`.
export function useNavbarAtBottom(): boolean {
  // Both hooks run unconditionally, then combine (never gate a hook behind `&&`).
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down("lg"));
  const pos = useNavbarPosition();
  return compact && pos === "bottom";
}
