import { useMediaQuery, useTheme } from "@mui/material";

// Where the nav bar sits. On the compact (mobile/tablet) tier it's ALWAYS at the
// bottom — the mobile-browser-style bar — and on desktop it's a top bar / left
// sidebar. There's no longer a user choice for this: liveview committed to a
// bottom bar on mobile, so this is just "are we on the compact tier".

export function useNavbarAtBottom(): boolean {
  const theme = useTheme();
  // `< lg` is the same tier the in-book NavShell uses for its mobile drawer
  // (tablets included).
  return useMediaQuery(theme.breakpoints.down("lg"));
}
