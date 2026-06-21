// Desktop keyboard shortcuts for playback + a `?` cheat-sheet. DESKTOP ONLY:
// gated on a precise pointer + hover (a real keyboard/mouse), so touch
// phones/tablets never mount the handler. One binding per action (QQ Music /
// YouTube style — no aliases). The SHORTCUTS array is the SINGLE SOURCE OF TRUTH:
// the keydown dispatch matches it and the cheat-sheet renders it, so the help
// page can never drift from the real bindings.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@mui/material";
import { useAudioPlayer } from "@/audio/player";
import { RATES } from "@/audio/playback-ui";

const SEEK_STEP_S = 15;

// macOS uses ⌘; everything else uses Ctrl as the primary modifier (QQ Music's
// Cmd+←/→ for prev/next, adapted cross-platform).
const IS_MAC = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

export type ShortcutGroup = "playback" | "chapter" | "speed" | "general";

export interface ShortcutDef {
  /** i18n suffix (sync.<id> label) + dispatch id. */
  readonly id: string;
  readonly group: ShortcutGroup;
  /** Display chips, already platform-resolved (e.g. ["⌘", "←"]). */
  readonly keys: readonly string[];
}

/** Single source of truth — dispatch matches these ids; the cheat-sheet renders
 *  this list. NOTE on chapters: Cmd/Ctrl+←/→ collides with browser back/forward
 *  on the web; we preventDefault to override it (works in the native shell + most
 *  browsers). */
export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "playPause", group: "playback", keys: ["Space"] },
  { id: "back", group: "playback", keys: ["←"] },
  { id: "forward", group: "playback", keys: ["→"] },
  { id: "prevChapter", group: "chapter", keys: [MOD_LABEL, "←"] },
  { id: "nextChapter", group: "chapter", keys: [MOD_LABEL, "→"] },
  { id: "slower", group: "speed", keys: ["<"] },
  { id: "faster", group: "speed", keys: [">"] },
  { id: "help", group: "general", keys: ["?"] },
];

/** Wire up the desktop shortcuts. Returns the cheat-sheet open-state for the
 *  host to render <ShortcutsDialog>. */
export function useKeyboardShortcuts(): {
  helpOpen: boolean;
  closeHelp: () => void;
} {
  const player = useAudioPlayer();
  const [helpOpen, setHelpOpen] = useState(false);
  // A precise pointer + hover ⇒ a real keyboard/mouse. Touch never matches.
  const isDesktop = useMediaQuery("(pointer: fine) and (hover: hover)");

  // The listener attaches ONCE; it reads live player state through this ref so it
  // never goes stale and never re-attaches on a playback tick.
  const ref = useRef(player);
  ref.current = player;

  const stepRate = useCallback((dir: 1 | -1) => {
    const p = ref.current;
    const i = RATES.indexOf(p.rate);
    const idx = i < 0 ? RATES.indexOf(1) : i;
    const next = RATES[Math.min(RATES.length - 1, Math.max(0, idx + dir))];
    if (next != null) p.setRate(next);
  }, []);

  useEffect(() => {
    if (!isDesktop) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      // Never hijack typing (shelf search, settings inputs, contenteditable).
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      ) {
        return;
      }
      const primary = IS_MAC ? e.metaKey : e.ctrlKey;
      const secondary = IS_MAC ? e.ctrlKey : e.metaKey;
      const p = ref.current;

      // `?` — toggle the cheat-sheet (anytime, no audio needed).
      if (e.key === "?" && !primary && !secondary && !e.altKey) {
        e.preventDefault();
        setHelpOpen((o) => !o);
        return;
      }
      // Esc closes the cheat-sheet (NowPlayingPopup also handles Esc — both fine).
      if (e.key === "Escape") {
        setHelpOpen(false);
        return;
      }

      // The rest only when a chapter is loaded — so plain reading keeps Space /
      // arrows for scrolling.
      if (p.nowPlaying == null) return;

      // Chapters: Cmd/Ctrl + ←/→ (override browser back/forward).
      if (primary && !secondary && !e.altKey && !e.shiftKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          p.prevChapter();
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          p.nextChapter();
        }
        return;
      }

      // No primary modifier from here on.
      if (primary || secondary || e.altKey) return;

      // Speed: < / > (the char already carries Shift).
      if (e.key === "<") {
        e.preventDefault();
        stepRate(-1);
        return;
      }
      if (e.key === ">") {
        e.preventDefault();
        stepRate(1);
        return;
      }

      // Play/pause + seek: plain Space / ←/→ (no Shift).
      if (e.shiftKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        p.togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        p.skip(-SEEK_STEP_S);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        p.skip(SEEK_STEP_S);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDesktop, stepRate]);

  const closeHelp = useCallback(() => setHelpOpen(false), []);
  return { helpOpen, closeHelp };
}
