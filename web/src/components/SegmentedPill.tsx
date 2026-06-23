import type { ReactNode } from "react";
import type { SxProps, Theme } from "@mui/material";
import { Box, ButtonBase } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { rem } from "@/px";

// A frosted-glass segmented "pill" switch — the 微信读书 / iOS segmented-control
// shape, MUI-themed: a translucent rounded track with a single filled active pill
// that SLIDES between segments. Generic + dependency-light; tapping a segment
// stops pointer propagation so it never starts the host sheet's drag.
export function SegmentedPill<T extends string>({
  value,
  options,
  onChange,
  sx,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  sx?: SxProps<Theme>;
}): React.JSX.Element {
  const n = options.length;
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <Box
      sx={{
        position: "relative",
        // EQUAL-width columns (not content-width flex) so every segment is the
        // same size as the sliding pill — otherwise a wider label ("Downloads")
        // makes its segment wider than the equal-width pill and the text reads as
        // off-centre. Grid 1fr columns + a centred ButtonBase fix the alignment.
        display: "inline-grid",
        gridTemplateColumns: `repeat(${String(n)}, 1fr)`,
        p: 0.5,
        borderRadius: 999,
        // Translucent track on the frosted sheet — carries its own light blur so
        // the page still diffuses through. Dark: a white tint reads as a clear well.
        // Light: a 7%-black tint went MUDDY (near-black warmed by the lavender) and
        // barely defined the control — use a COOL neutral grey well (iOS segmented
        // control) so it stays crisp + neutral against the warm lilac sheet.
        backgroundColor: (t) =>
          t.palette.mode === "dark"
            ? alpha(t.palette.text.primary, 0.12)
            : "rgba(118,118,128,0.13)",
        backdropFilter: "blur(16px) saturate(180%)",
        WebkitBackdropFilter: "blur(16px) saturate(180%)",
        ...sx,
      }}
    >
      {
        /* The sliding active pill — an ELEVATED neutral surface (iOS / 微信读书
          segmented control), not a saturated brand block: a white (light) /
          lifted-grey (dark) chip whose soft shadow does the separation, with the
          label colour (below) carrying the active state. Reads far softer on the
          frosted lilac sheet than the old solid-primary fill. */
      }
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          top: 4,
          bottom: 4,
          left: 4,
          width: `calc((100% - 8px) / ${String(n)})`,
          transform: `translateX(${String(idx * 100)}%)`,
          transition: "transform .26s cubic-bezier(0.22, 1, 0.36, 1)",
          borderRadius: 999,
          // Light: a CRISP pure-white pill (not the faint lavender `background.paper`,
          // which barely separated from the sheet) lifted by a soft, DIFFUSE shadow
          // — cleaner than the old hard 0.16 shadow that read as a dirty smudge.
          backgroundColor: (t) =>
            t.palette.mode === "dark"
              ? alpha(t.palette.common.white, 0.16)
              : "#ffffff",
          boxShadow: (t) =>
            t.palette.mode === "dark"
              ? "0 1px 2px rgba(0,0,0,0.4)"
              : "0 2px 7px rgba(60,50,90,0.16), 0 1px 2px rgba(0,0,0,0.04)",
        }}
      />
      {options.map((o) => {
        const active = o.value === value;
        return (
          <ButtonBase
            key={o.value}
            onClick={(): void => onChange(o.value)}
            onPointerDown={(e): void => e.stopPropagation()}
            sx={{
              position: "relative",
              zIndex: 1,
              width: "100%",
              justifyContent: "center",
              minWidth: rem(72),
              // rem so the control (text + its breathing room) scales with the
              // app-wide font-size setting, like every other UI surface.
              px: rem(14),
              py: 0.5,
              borderRadius: 999,
              fontSize: rem(13.5),
              fontWeight: 600,
              letterSpacing: 0.1,
              // Active label: neutral in dark; in light a touch of the brand purple
              // on the white pill — ties the control to the lilac sheet and reads as
              // intentional rather than a plain grey switch.
              color: (t) =>
                active
                  ? (t.palette.mode === "dark" ? t.palette.text.primary : t.palette.primary.main)
                  : t.palette.text.secondary,
              transition: "color .2s",
            }}
          >
            {o.label}
          </ButtonBase>
        );
      })}
    </Box>
  );
}
