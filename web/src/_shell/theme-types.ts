// Theme vocabulary shared by the theme + theme-mode + settings primitives.
// Kept local on purpose: these are plain string unions, not a wire protocol, so
// the kit carries no portal/handshake dependency.

/** The concrete light/dark mode a theme renders. */
export type ThemeMode = "light" | "dark";

/** A user's theme selection: "system" follows the OS, otherwise a concrete mode.
 *  Resolved to a {@link ThemeMode} before it reaches MUI. */
export type ThemeChoice = "system" | "light" | "dark";
