/** px → rem string. Use for ICON GLYPH sizes so they scale with the app-wide
 *  font-size setting (applied as the root <html> font-size; see App.tsx), while
 *  the surrounding IconButton tap targets stay in fixed px — usability first:
 *  the hit area never shrinks, only the glyph inside it does. 16px == 1rem at
 *  scale 1, so `rem(33)` renders identically to the old `33` until the user
 *  changes the font size. */
export const rem = (px: number): string => `${px / 16}rem`;

/** A tap-target size that scales with the font setting but never drops below the
 *  44px mobile minimum: `max(44px, rem(px))`. Use for IconButton width/height so
 *  the button (and the air around its glyph) grows/shrinks with the font, yet
 *  the hit area stays usable on a phone — the floor is the physical
 *  finger-target constraint, so it's a fixed 44px, not font-relative. */
export const tap = (px: number): string => `max(44px, ${px / 16}rem)`;
