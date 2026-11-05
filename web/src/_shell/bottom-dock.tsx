// BottomDock — the single owner of a surface's bottom edge.
//
// A dock stacks, in normal flow: a status strip, an accessory (e.g. a playback
// transport) and the surface's bar. One opaque container is the shared
// material behind all of them, so stacked rows never need matching frosted
// layers or per-row offsets. The dock measures itself once and publishes
//
//   --lv-dock-h   total bottom occlusion: its height plus any lift (keyboard)
//
// on its parent element, which scrollers and floating buttons inside the
// surface read for padding. The dock wraps the surface content so rows
// rendered deeper in it (the transport lives with the reader that owns its
// follow state) can portal into the dock's slots through {@link DockPortal}.
//
// Overlays outside every surface (the update pill) read `--lv-dock-max-h` on
// the document root: the tallest currently laid-out dock. A retained but
// hidden surface measures 0 and does not count.

import { Box, type SxProps, type Theme } from "@mui/material";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

type Slot = "strip" | "accessory";

const DockSlots = createContext<Record<Slot, HTMLElement | null> | null>(null);

// Heights of every mounted dock, for the root-level maximum.
const heights = new Map<symbol, number>();
function publishMax(): void {
  const max = Math.max(0, ...heights.values());
  document.documentElement.style.setProperty("--lv-dock-max-h", `${max}px`);
}

export interface BottomDockProps {
  /** The surface's bar, rendered as the dock's last row. */
  readonly bar?: ReactNode;
  /** Extra bottom offset (a CSS length), e.g. the on-screen keyboard. It
   *  lifts the dock and counts toward the published occlusion. */
  readonly lift?: string;
  /** The surface content; it may portal rows into the dock. */
  readonly children?: ReactNode;
  readonly sx?: SxProps<Theme>;
}

export function BottomDock({ bar, lift = "0px", children, sx }: BottomDockProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const [strip, setStrip] = useState<HTMLElement | null>(null);
  const [accessory, setAccessory] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return undefined;
    const id = Symbol("dock");
    const publish = (): void => {
      const h = el.offsetHeight;
      host.style.setProperty("--lv-dock-h", `calc(${h}px + ${lift})`);
      heights.set(id, h);
      publishMax();
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      heights.delete(id);
      publishMax();
      host.style.removeProperty("--lv-dock-h");
    };
  }, [lift]);

  return (
    <DockSlots.Provider value={{ strip, accessory }}>
      {children}
      <Box
        ref={ref}
        data-lv-dock
        sx={[
          {
            position: "absolute",
            left: 0,
            right: 0,
            bottom: lift,
            zIndex: (t) => t.zIndex.appBar,
            display: "flex",
            flexDirection: "column",
            // The shared opaque material. No backdrop-filter: the reader and
            // shelf scroll underneath, and WebKit would re-rasterize them
            // every frame for a blur invisible at this opacity.
            bgcolor: "background.default",
          },
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
      >
        <Box ref={setStrip} data-lv-dock-slot="strip" sx={{ display: "contents" }} />
        <Box ref={setAccessory} data-lv-dock-slot="accessory" sx={{ display: "contents" }} />
        {bar}
      </Box>
    </DockSlots.Provider>
  );
}

/** True inside a dock: rows may portal into it. */
export function useInDock(): boolean {
  return useContext(DockSlots) !== null;
}

/** Render `children` in a slot of the nearest dock; inline when there is no
 *  dock (e.g. a surface whose layout keeps the row elsewhere). */
export function DockPortal({ slot, children }: { readonly slot: Slot; readonly children: ReactNode }): ReactNode {
  const slots = useContext(DockSlots);
  if (!slots) return children;
  const target = slots[slot];
  return target ? createPortal(children, target) : null;
}
