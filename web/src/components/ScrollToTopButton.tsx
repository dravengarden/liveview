import { type RefObject, useEffect, useRef, useState } from "react";
import { Fab, Fade } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { KeyboardArrowUp as UpIcon } from "@mui/icons-material";
import { useI18n } from "@/i18n";

// Reveal the button once the reader has scrolled past ~1.5 screens — far enough
// that "back to top" is a real shortcut, not noise on a short page. The native
// iOS "tap the status bar" gesture never reaches a PWA's inner scroll container,
// so this explicit affordance is the reliable way back up.
const SHOW_AFTER_PX = 700;

/**
 * A floating "scroll to top" button for a scroll container. Watches `targetRef`
 * and fades in past the threshold; tapping it smooth-scrolls that container to
 * the top. Positioned `absolute`, so it must live inside a `position: relative`
 * content area.
 *
 * `bottomLift` is added to the button's bottom offset so it rides ABOVE a
 * frosted bottom bar that now OVERLAYS the same content area (the bar used to be
 * a flex sibling below this area, which lifted the FAB for free; as an overlay
 * it no longer does). Pass the bar's height var, e.g. `var(--lv-toolbar-h, 0px)`
 * (bookshelf) or `var(--shell-bar-h, 0px)` (reader); 0 keeps the old placement.
 */
export function ScrollToTopButton(
  { targetRef, bottomLift = "0px" }: {
    targetRef: RefObject<HTMLElement | null>;
    bottomLift?: string;
  },
): React.JSX.Element {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return undefined;
    const onScroll = (): void => {
      const next = el.scrollTop > SHOW_AFTER_PX;
      // Scroll can fire every display frame. Do not enqueue a React update when
      // the threshold state did not change; the FAB only needs two updates for
      // an entire gesture (entering/leaving the top region).
      if (next === shownRef.current) return;
      shownRef.current = next;
      setShown(next);
    };
    onScroll(); // sync to the current position on mount
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [targetRef]);

  const toTop = (): void => {
    targetRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <Fade in={shown}>
      <Fab
        size="small"
        aria-label={t("app.scrollTop")}
        onClick={toTop}
        sx={{
          position: "absolute",
          right: "calc(16px + env(safe-area-inset-right, 0px))",
          bottom:
            `calc(16px + env(safe-area-inset-bottom, 0px) + ${bottomLift})`,
          zIndex: 3,
          // NO backdrop-filter. This disc floats over the reader's scroller, and a
          // `backdrop-filter: blur()` re-rasterizes the moving content under it
          // EVERY frame — on iPad landscape it sits in the empty side margin, so
          // dragging there janked the whole scroll (root cause of "在这个区域上下
          // 滑动会卡"). Same call already made for the bottom bars. Use a NEAR-OPAQUE
          // solid tint instead: legible over busy text without the per-frame blur.
          color: "text.secondary",
          bgcolor: (t) =>
            alpha(
              t.palette.background.paper,
              t.palette.mode === "dark" ? 0.88 : 0.94,
            ),
          border: 1,
          borderColor: "divider",
          boxShadow: 2,
          "&:hover": {
            bgcolor: (t) =>
              alpha(
                t.palette.background.paper,
                t.palette.mode === "dark" ? 0.95 : 0.99,
              ),
          },
        }}
      >
        <UpIcon />
      </Fab>
    </Fade>
  );
}
