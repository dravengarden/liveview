# LiveView design system

LiveView is an editorial product with live state, not a glass dashboard. Its
identity is the **Living Book**: a quiet open volume illuminated by one precise
spark. The visual system should feel calm enough for long reading and exact
enough for synchronization, progress, and playback.

## Identity

- Wordmark: `LiveView`. Use the mark as a separate leading or trailing element;
  never substitute it for a letter.
- Mark: two tall, curved open pages and a paired four-point sparkle. The navy page is the
  durable publication, the plum page is its alternate renditions, and the amber
  spark is the live moment of reading, listening, or discovery. Preserve the
  narrow open centre, shallow lower edge, flat colour, and generous clear space.
- Ink: `#17191f`; paper: `#f8f1e5`; raised paper: `#fffaf2`; book navy:
  `#19376d`; rendition plum: `#754b86`; activity amber: `#f0a51f`; deep
  backdrop: `#101b38`; secondary backdrop: `#3c294d`. The launcher icon uses
  midnight indigo `#182353`, warm ivory `#f5eadb`, magic plum `#bd91cd`,
  luminous amber `#f5b63b`, and a soft-gold secondary sparkle `#ffda72`; it
  never uses a white or near-white background.
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
- Plum is the primary interaction colour. Amber is reserved for live,
  playing, syncing, or newly changed state; it is not a generic selection colour
  or large decorative background.
- UI typography is a neutral sans with tight display spacing. Reading typography
  remains content-controlled and may use serif faces.
- Controls use 14 px corners, cards use 24 px corners, and semantic chips may be
  pills. Do not make every container a pill.

## Motion and performance

Fluid interaction is a product invariant, not a visual polish pass. Follow the
[performance architecture and acceptance gate](core-requirements.md#reading-must-stay-fluid)
for every feature that can affect rendering or background work.

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
