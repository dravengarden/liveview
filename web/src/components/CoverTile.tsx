import { rem } from "@/px";
import { Box } from "@mui/material";
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
            src={`/api/cover?book=${encodeURIComponent(slug)}`}
            alt=""
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
