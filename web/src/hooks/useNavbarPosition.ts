import { useMediaQuery } from "@mui/material";

// Where the nav bar sits. On the compact (mobile/tablet) tier it's ALWAYS at the
// bottom — the mobile-browser-style bar — and on desktop it's a top bar / left
// sidebar. There's no longer a user choice for this: liveview committed to a
// bottom bar on mobile, so this is just "are we on the compact tier".

export function useNavbarAtBottom(): boolean {
  // Below 1000px the in-book NavShell uses a temporary navigation surface.
  // This keeps iPad portrait compact while giving iPad landscape a useful
  // persistent contents pane; it also follows Stage Manager window width.
  return useMediaQuery("(max-width:999.95px)");
}
