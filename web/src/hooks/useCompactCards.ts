import { persisted, useStore } from "@/_store/mod.ts";

// Compact bookshelf cards: drop each card's coloured cover band (the slug-keyed
// gradient header + kind glyph) so the shelf packs more books per screen. A UI
// preference, persisted device-LOCAL like the other shelf/reading prefs
// (theme / font / sort): a `persisted` store over localStorage, free cross-tab
// sync via the `storage` event. Read by the shelf (Landing), written by Settings.
// Not synced to the server (only reading/playback progress is) — density is a
// per-screen choice (you may want compact on a phone, full on a desktop).

export type CompactCards = boolean;

const KEY = "lv:compact-cards";
const DEFAULT: CompactCards = false;

const compactCardsStore = persisted<CompactCards>(KEY, DEFAULT, {
  serialize: (v) => (v ? "1" : "0"),
  // Any non-"1" stored value (legacy/corrupt) reads as false — the safe default.
  deserialize: (raw) => raw === "1",
});

export function useCompactCards(): CompactCards {
  return useStore(compactCardsStore);
}

export function setCompactCards(compact: CompactCards): void {
  compactCardsStore.set(compact);
}
