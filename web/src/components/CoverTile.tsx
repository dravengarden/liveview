import { rem } from "@/px";
import { coverSrc, recoverCoverImage } from "@/native-sync";
import { Box } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { Headphones as AudiobookIcon } from "@mui/icons-material";

/** Stable hue from a slug → a calm gradient stand-in cover (mirrors the shelf
 *  + mini-player), so a coverless book still reads as itself everywhere. */
export function coverGradient(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `linear-gradient(135deg, hsl(${hue} 52% 52%), hsl(${
    (hue + 38) % 360
  } 48% 42%))`;
}

/** A square book-cover tile: the real cover image when present, else the
 *  slug-keyed gradient + headphones glyph. Shared by the now-playing surfaces
 *  (popup, playback sheet) so a book looks identical everywhere. */
export function CoverTile({
  slug,
  hasCover,
  size,
}: {
  slug: string;
  hasCover: boolean;
  size: number | string;
}): React.JSX.Element {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: 1.5,
        overflow: "hidden",
        position: "relative",
        flexShrink: 0,
        background: coverGradient(slug),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {hasCover
        ? (
          <Box
            component="img"
            src={coverSrc(slug)}
            alt=""
            onError={(event) => recoverCoverImage(event.currentTarget, slug)}
            sx={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        )
        : (
          <AudiobookIcon
            sx={{ fontSize: rem(48), color: "rgba(255,255,255,0.92)" }}
          />
        )}
    </Box>
  );
}

/** A real cover used as a restrained card background rather than a literal
 *  full-height poster. Theme-paper veiling keeps text contrast predictable;
 *  image failure simply reveals the card's slug-keyed gradient beneath. */
export function ShelfCardArtwork(
  { slug, hasCover }: {
    slug: string;
    hasCover: boolean;
  },
): React.JSX.Element | null {
  if (!hasCover) return null;
  return (
    <Box
      aria-hidden="true"
      sx={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <Box
        component="img"
        src={coverSrc(slug)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={(event) => {
          if (!recoverCoverImage(event.currentTarget, slug)) {
            event.currentTarget.style.display = "none";
          }
        }}
        sx={{
          position: "absolute",
          top: 0,
          right: 0,
          width: "64%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "center",
          opacity: (theme) => theme.palette.mode === "dark" ? 0.62 : 0.7,
          filter: "saturate(0.88) contrast(0.92)",
          transform: "scale(1.04)",
        }}
      />
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          background: coverGradient(slug),
          opacity: (theme) => theme.palette.mode === "dark" ? 0.2 : 0.14,
          mixBlendMode: "color",
        }}
      />
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          background: (theme) =>
            `linear-gradient(90deg, ${
              alpha(theme.palette.background.paper, 0.94)
            } 0%, ${alpha(theme.palette.background.paper, 0.78)} 52%, ${
              alpha(theme.palette.background.paper, 0.18)
            } 100%)`,
        }}
      />
    </Box>
  );
}
