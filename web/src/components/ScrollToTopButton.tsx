import { type RefObject, useEffect, useState } from "react";
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

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return undefined;
    const onScroll = (): void => {
      setShown(el.scrollTop > SHOW_AFTER_PX);
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
        title={t("app.scrollTop")}
        onClick={toTop}
        sx={{
          position: "absolute",
          right: "calc(16px + env(safe-area-inset-right, 0px))",
          bottom:
            `calc(16px + env(safe-area-inset-bottom, 0px) + ${bottomLift})`,
          zIndex: 3,
          // Frosted glass, like the floating now-playing bubble: a theme-adaptive
          // translucent tint over a backdrop blur, so the page shows through it as
          // glass. A hairline divider edge keeps the disc legible over busy text;
          // a muted glyph reads on any theme.
          color: "text.secondary",
          bgcolor: (t) =>
            alpha(
              t.palette.background.paper,
              t.palette.mode === "dark" ? 0.5 : 0.62,
            ),
          backdropFilter: "blur(16px) saturate(180%)",
          WebkitBackdropFilter: "blur(16px) saturate(180%)",
          border: 1,
          borderColor: "divider",
          boxShadow: 2,
          "&:hover": {
            bgcolor: (t) =>
              alpha(
                t.palette.background.paper,
                t.palette.mode === "dark" ? 0.65 : 0.78,
              ),
          },
        }}
      >
        <UpIcon />
      </Fab>
    </Fade>
  );
}
