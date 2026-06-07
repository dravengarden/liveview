import { SvgIcon, type SvgIconProps } from "@mui/material";

// MUI ships Replay5/10/30 + Forward5/10/30 but no 15s variant, so draw our own:
// the standard circular "replay" arrow (counter-clockwise) with a "15" label.
// Forward mirrors the arrow horizontally so its head points the other way. The
// number is a <text> node (no per-digit vector glyphs to maintain).
const ARROW =
  "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z";

function Label(): React.JSX.Element {
  return (
    <text
      x="12"
      y="15.75"
      textAnchor="middle"
      fontSize="8.5"
      fontWeight="700"
      fill="currentColor"
      stroke="none"
    >
      15
    </text>
  );
}

/** Skip-back-15s glyph: counter-clockwise arrow + "15". */
export function Replay15Icon(props: SvgIconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d={ARROW} />
      <Label />
    </SvgIcon>
  );
}

/** Skip-forward-15s glyph: the same arrow mirrored (head points right) + "15". */
export function Forward15Icon(props: SvgIconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d={ARROW} transform="translate(24 0) scale(-1 1)" />
      <Label />
    </SvgIcon>
  );
}
