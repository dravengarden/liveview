// ShellLabels — the user-visible strings the shell primitives render on their
// own (close buttons, navigation landmarks, lightbox controls, connection
// banner). The primitives stay business-free and dependency-free: they read
// these through a context whose default is plain English, and the host app
// supplies translated labels once, near its i18n root.

import { createContext, type ReactNode, useContext, useMemo } from "react";

export interface ShellLabels {
  readonly close: string;
  readonly back: string;
  readonly navigation: string;
  readonly openNavigation: string;
  readonly closeNavigation: string;
  readonly collapseNavigation: string;
  readonly imagePreview: string;
  readonly previousImage: string;
  readonly nextImage: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly connectionLost: string;
  readonly reconnected: string;
  /** The redeploy banner, with its live reload countdown in seconds. */
  readonly updateReloading: (seconds: number) => string;
}

export const DEFAULT_SHELL_LABELS: ShellLabels = {
  close: "Close",
  back: "Back",
  navigation: "Navigation",
  openNavigation: "Open navigation",
  closeNavigation: "Close navigation",
  collapseNavigation: "Collapse navigation",
  imagePreview: "Image preview",
  previousImage: "Previous image",
  nextImage: "Next image",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  connectionLost: "Connection lost — reconnecting…",
  reconnected: "Reconnected",
  updateReloading: (seconds) => `New version · reloading in ${String(seconds)}s`,
};

const ShellLabelsContext = createContext<ShellLabels>(DEFAULT_SHELL_LABELS);

export function ShellLabelsProvider(
  { labels, children }: { readonly labels: Partial<ShellLabels>; readonly children: ReactNode },
): ReactNode {
  const value = useMemo(() => ({ ...DEFAULT_SHELL_LABELS, ...labels }), [labels]);
  return <ShellLabelsContext.Provider value={value}>{children}</ShellLabelsContext.Provider>;
}

export function useShellLabels(): ShellLabels {
  return useContext(ShellLabelsContext);
}
