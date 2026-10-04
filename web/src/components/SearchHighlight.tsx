import { Box } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { splitHighlight, type TextRange } from "@/librarySearch";

/** Text with the spans a search matched emphasized. A flat tint, never a filter
 * or blend mode, so it stays cheap inside the scrolling shelf. */
export function Highlighted(
  { text, ranges }: {
    text: string;
    ranges: readonly TextRange[] | undefined;
  },
): React.JSX.Element {
  if (!ranges?.length) return <>{text}</>;
  return (
    <>
      {splitHighlight(text, ranges).map((segment, i) =>
        segment.mark
          ? (
            <Box
              component="mark"
              key={i}
              sx={{
                bgcolor: (theme) => alpha(theme.palette.primary.main, 0.28),
                color: "inherit",
                borderRadius: "3px",
                px: "1px",
                mx: "-1px",
              }}
            >
              {segment.text}
            </Box>
          )
          : segment.text
      )}
    </>
  );
}
