# LiveView design system

LiveView is an editorial product with live state, not a glass dashboard. Its
identity is the **Knowledge Sprout**: reading and listening grow from a shared
live point. The visual system should feel quiet enough for long reading and
precise enough for synchronization, progress, and playback.

## Identity

- Wordmark: `LiveView`. Use the mark as a separate leading or trailing element;
  never substitute it for a letter.
- Mark: a shared stem, two asymmetric leaves, and one live node. The paper leaf
  represents reading, the violet leaf represents alternate renditions, and the
  amber junction is the current live state. Preserve their proportions and
  asymmetric silhouette.
- Ink: `#17191f`; paper: `#f8f0df`; raised paper: `#fffaf0`; interaction violet:
  `#7d61ff`; activity amber: `#ffb51b`; deep backdrop: `#071b1d`; backdrop teal:
  `#174f4a`.
- Use the full-colour mark when colour is available. Monochrome is for print and
  system contexts that remove colour.

Canonical code tokens live in `web/src/brand.ts`; canonical vector assets live
in `web/public/brand-mark.svg`, `favicon.svg`, and `app-icon.svg`.
After changing the icon geometry, run `tools/generate-brand-icons.sh`. The script
forces RGBA output because Tauri rejects grayscale-plus-alpha PNGs at startup.

## Product surfaces

- Page backgrounds are flat ink or paper. Raised surfaces use a small tonal
  step, a hairline, and spacing before they use shadow.
- Artwork remains content, not chrome. Text sits on a static high-opacity scrim
  so covers stay legible without live blur.
- Violet is the primary interaction colour. Amber is reserved for live,
  playing, syncing, or newly changed state; it is not a generic selection colour
  or large decorative background.
- UI typography is a neutral sans with tight display spacing. Reading typography
  remains content-controlled and may use serif faces.
- Controls use 14 px corners, cards use 24 px corners, and semantic chips may be
  pills. Do not make every container a pill.

## Motion and performance

- Motion communicates navigation, progress, or state change; it is never ambient
  decoration.
- Never use `backdrop-filter`, CSS `filter`, or blend modes inside a scrolling
  shelf/card tree or on fixed chrome overlapping it. WKWebView re-rasterizes those
  layers while scrolling.
- Prefer static alpha surfaces. A blur may be used only in a bounded, non-scrolling
  modal after Simulator profiling proves it does not affect interaction.
- `web/src/scrollMaterials.test.ts` is the mechanical gate for the shelf hot path.

## Responsive behavior

- iPhone is touch-first and one-column. Preserve 40-44 px targets and bottom
  reachability.
- iPad adds columns and density but keeps touch targets and explicit state.
- Desktop exposes hierarchy and parallel navigation; it should not imitate a
  stretched phone or float mobile back controls over persistent sidebars.
