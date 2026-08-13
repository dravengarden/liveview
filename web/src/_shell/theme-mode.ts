// useThemeMode — the shared light/dark/system selection machine.
//
// A `system | light | dark` choice persisted to localStorage, resolved against
// the OS via `prefers-color-scheme`, advanced by a cycle button. Apps used to
// hand-roll an identical copy each; this is that logic, once.
//
// What stays in the APP: building the MUI `Theme` from the resolved mode (the
// accent, density, and component overrides are legitimately per-app — feed
// `resolved` to `createSharedTheme`) and any status-bar `<meta theme-color>`
// sync (its colour comes from the app's own surfaces). This hook only owns the
// *choice*.

import { useMediaQuery } from "@mui/material";
import { useState } from "react";

import type { ThemeChoice, ThemeMode } from "./theme-types.ts";

const CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

function isChoice(value: string | null): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

export interface ThemeModeState {
  /** The user's selection — drives a System/Light/Dark control or toggle icon. */
  readonly choice: ThemeChoice;
  /** The concrete mode after collapsing "system" via the OS preference. */
  readonly resolved: ThemeMode;
  /** Persist + apply a selection (for a segmented control). */
  setChoice(next: ThemeChoice): void;
  /** Advance system → light → dark → system (for a single toggle button). */
  cycle(): void;
}

/**
 * Persisted three-way theme selection. `appId` keys the localStorage entry
 * (`<appId>-theme-mode`) so co-hosted apps don't clobber each other.
 */
export function useThemeMode(appId: string): ThemeModeState {
  const storageKey = `${appId}-theme-mode`;
  const [choiceState, setChoiceState] = useState<ThemeChoice>(() => {
    const stored = globalThis.localStorage.getItem(storageKey);
    return isChoice(stored) ? stored : "system";
  });
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const systemMode: ThemeMode = systemDark ? "dark" : "light";
  const resolved: ThemeMode = choiceState === "system" ? systemMode : choiceState;

  function setChoice(next: ThemeChoice): void {
    globalThis.localStorage.setItem(storageKey, next);
    setChoiceState(next);
  }

  function cycle(): void {
    setChoiceState((current) => {
      const next = CHOICES[(CHOICES.indexOf(current) + 1) % CHOICES.length] ?? "system";
      globalThis.localStorage.setItem(storageKey, next);
      return next;
    });
  }

  return { choice: choiceState, resolved, setChoice, cycle };
}
