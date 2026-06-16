import { type RefObject, useEffect, useState } from "react";
import { useAudioPlayer } from "@/audio/player";
import type { Mark, SpokenUnits, Unit } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// In-place read-along highlight for the rich text reader (ADHD focus mode).
//
// When the audio engine is reading the SAME text chapter this viewer is showing,
// the current sentence is highlighted IN PLACE in the rendered markdown (code /
// diagrams / images stay where they are), and a finer "read-so-far" wipe tracks
// progress within that sentence — proportional to elapsed time in the sentence's
// (accurate) audio mark, re-synced at every sentence boundary so drift can't
// accumulate. Uses the CSS Custom Highlight API (no DOM mutation, spans inline
// elements). Inert unless a text-rendition read-aloud of this exact chapter is
// active, so normal reading is completely unaffected.
// ─────────────────────────────────────────────────────────────────────────────

const HL_DONE = "lv-read-done"; // every already-read sentence (the progress trail)
const HL_SENTENCE = "lv-reading"; // whole current sentence (focus)
const HL_ACTIVE = "lv-reading-active"; // read-so-far wipe within the current sentence

interface HighlightLike {
  add(range: Range): void;
  // Paint order: higher wins. done(0) < sentence(1) < active(2), so the strong
  // wipe sits on top of the sentence tint, both above the soft read trail.
  priority?: number;
}
/** The CSS Custom Highlight API, typed minimally + feature-detected (so we never
 *  conflict with the DOM lib's own defs and degrade cleanly where unsupported,
 *  e.g. older WebKit). Returns null when the API is missing. */
function highlightApi(): {
  set: (name: string, h: HighlightLike) => void;
  remove: (name: string) => void;
  clearAll: () => void;
  make: () => HighlightLike;
} | null {
  const g = globalThis as unknown as {
    CSS?: {
      highlights?: {
        set(n: string, h: HighlightLike): void;
        delete(n: string): void;
        clear(): void;
      };
    };
    Highlight?: { new (): HighlightLike };
  };
  const reg = g.CSS?.highlights;
  const Ctor = g.Highlight;
  if (!reg || !Ctor) return null;
  return {
    set: (name, h) => reg.set(name, h),
    remove: (name) => reg.delete(name),
    clearAll: () => reg.clear(),
    make: () => new Ctor(),
  };
}

/** Where `target` sits inside `root`, located over the rendered text with
 *  whitespace collapsed (so the server's join-wrapped sentence text matches the
 *  HTML). `map[i]` is the DOM (node, offset) of normalized char i. */
interface Located {
  map: { node: Text; offset: number }[];
  at: number;
  len: number;
}
function locateText(root: HTMLElement, target: string): Located | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let norm = "";
  const map: { node: Text; offset: number }[] = [];
  let prevSpace = false;
  let node = walker.nextNode();
  while (node) {
    const tn = node as Text;
    const s = tn.data;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i] ?? "";
      if (/\s/.test(ch)) {
        if (!prevSpace) {
          norm += " ";
          map.push({ node: tn, offset: i });
          prevSpace = true;
        }
      } else {
        norm += ch;
        map.push({ node: tn, offset: i });
        prevSpace = false;
      }
    }
    node = walker.nextNode();
  }
  const needle = target.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const at = norm.indexOf(needle);
  if (at < 0) return null;
  return { map, at, len: needle.length };
}

/** A Range over chars [fromFrac, toFrac] of a located match (fractions 0..1). */
function rangeOf(loc: Located, fromFrac: number, toFrac: number): Range | null {
  const a = loc.at + Math.floor(fromFrac * loc.len);
  const bChar = loc.at + Math.floor(toFrac * loc.len);
  const b = Math.min(Math.max(bChar, a + 1), loc.at + loc.len); // ≥1 char, clamped
  const start = loc.map[a];
  const end = loc.map[b - 1];
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

/** Full DOM range of a prose unit located in the rendered markdown — null if the
 *  unit is non-prose or its text can't be matched in its block (markup mismatch).
 *  Blocks must already be numbered with `data-blk`. */
function unitRange(body: HTMLElement, unit: Unit | undefined): Range | null {
  if (!unit || unit.kind !== "prose" || !unit.text.trim()) return null;
  const blockEl = body.querySelector<HTMLElement>(`[data-blk="${unit.blk}"]`);
  if (!blockEl) return null;
  const loc = locateText(blockEl, unit.text);
  return loc ? rangeOf(loc, 0, 1) : null;
}

export function useInPlaceHighlight(
  scrollerRef: RefObject<HTMLElement | null>,
  currentPath: string | null,
): void {
  const { nowPlaying, currentIdx, currentTime, playing, seekToSentence } =
    useAudioPlayer();
  const [units, setUnits] = useState<Unit[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);

  const active = nowPlaying?.rendition === "text" &&
    nowPlaying.chapterPath === currentPath;

  // Fetch units + marks for the active chapter (both cheap / already cached by
  // the engine's own load). Cleared when inactive.
  useEffect(() => {
    if (!active || !nowPlaying) {
      setUnits([]);
      setMarks([]);
      return undefined;
    }
    let cancelled = false;
    const q = `path=${encodeURIComponent(nowPlaying.chapterPath)}&lang=${
      encodeURIComponent(nowPlaying.lang)
    }&rendition=text`;
    fetch(`/api/units?${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SpokenUnits | null) => {
        if (!cancelled && d) setUnits(d.units);
      })
      .catch(() => {});
    fetch(`/api/marks?${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Mark[] | null) => {
        if (!cancelled && d) setMarks(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, nowPlaying?.chapterPath, nowPlaying?.lang]);

  // Trail + focus. Rebuilt only when the CURRENT sentence changes (NOT every
  // audio tick). Reading leaves a progress trail: every already-read sentence
  // keeps a soft tint, the current sentence a medium tint; the per-tick wipe
  // (effect below) layers the strong read-so-far cue on top.
  //
  // Why clear ALL then repaint: iOS WebKit's CSS-Highlight invalidation is
  // unreliable — replacing a moving highlight left stale paint of already-passed
  // sentences as "ghosts" (the patchy trail the user saw). Clearing the whole
  // registry on each sentence change forces a clean repaint; the read trail is
  // then rebuilt deterministically (and only grows forward), so what shows always
  // matches the real read position — no ghosts, no gaps on bold lead-ins.
  useEffect(() => {
    const api = highlightApi();
    const body = scrollerRef.current?.querySelector<HTMLElement>(
      ".markdown-body",
    );
    if (!active || !api || !body) {
      api?.clearAll();
      return undefined;
    }
    // Number top-level blocks in document order — the same order `spoken_units`
    // assigns `blk`. Idempotent.
    const blocks = body.children;
    for (let i = 0; i < blocks.length; i++) {
      (blocks[i] as HTMLElement).dataset["blk"] = String(i);
    }

    // The read trail: every sentence before the current one, soft tint.
    const done = api.make();
    done.priority = 0;
    for (let i = 0; i < currentIdx; i++) {
      const r = unitRange(body, units[i]);
      if (r) done.add(r);
    }

    // The current sentence (full extent), medium tint — the focus. Non-prose
    // blocks (image / code / table / math) outline the whole block instead.
    const unit = units[currentIdx];
    const blockEl = unit
      ? body.querySelector<HTMLElement>(`[data-blk="${unit.blk}"]`)
      : null;
    const sentence = api.make();
    sentence.priority = 1;
    if (unit && blockEl) {
      const r = unitRange(body, unit);
      if (r) {
        sentence.add(r);
      } else if (unit.kind !== "prose") {
        const block = document.createRange();
        block.selectNodeContents(blockEl);
        sentence.add(block);
      }
    }

    api.clearAll();
    api.set(HL_DONE, done);
    api.set(HL_SENTENCE, sentence);

    // Follow-scroll on sentence change only, and only while playing, so we don't
    // fight a reader who scrolled back to re-read.
    const scroller = scrollerRef.current;
    if (playing && scroller && blockEl) {
      const r = blockEl.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      if (r.top < s.top + 40 || r.bottom > s.bottom - 40) {
        blockEl.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
    return () => api.clearAll();
  }, [active, units, currentIdx, playing, scrollerRef]);

  // The read-so-far wipe WITHIN the current sentence — strongest tint, the
  // precise position. Updates every audio tick: within a sentence it only GROWS
  // (each range is a superset of the last), so replacing it never needs a clear
  // and never ghosts. Moving to the next sentence is the trail effect's job
  // (with its clear()), so this only ever paints the current sentence.
  useEffect(() => {
    const api = highlightApi();
    const body = scrollerRef.current?.querySelector<HTMLElement>(
      ".markdown-body",
    );
    if (!active || !api || !body) return undefined;
    const unit = units[currentIdx];
    if (!unit || unit.kind !== "prose" || !unit.text.trim()) {
      api.remove(HL_ACTIVE);
      return undefined;
    }
    const blockEl = body.querySelector<HTMLElement>(`[data-blk="${unit.blk}"]`);
    if (!blockEl) {
      api.remove(HL_ACTIVE);
      return undefined;
    }
    const loc = locateText(blockEl, unit.text);
    if (!loc) {
      api.remove(HL_ACTIVE);
      return undefined;
    }
    const mk = marks[currentIdx];
    const span = mk ? mk.end_ms - mk.start_ms : 0;
    const frac = mk && span > 0
      ? Math.min(1, Math.max(0, (currentTime * 1000 - mk.start_ms) / span))
      : 1;
    const wipe = rangeOf(loc, 0, frac);
    if (wipe) {
      const h = api.make();
      h.priority = 2;
      h.add(wipe);
      api.set(HL_ACTIVE, h);
    }
    return undefined;
  }, [active, units, marks, currentIdx, currentTime, scrollerRef]);

  // Tap-to-seek: only WHILE PLAYING, clicking a paragraph jumps playback to its
  // first sentence — the "follow my eyes" reposition the user wants while
  // listening. When the narration is PAUSED (or not on this chapter), a tap is
  // just the reader touching the page, so it does NOTHING: it must never seek or
  // auto-start playback (the dominant interaction here is silent reading, and an
  // accidental paragraph tap hijacking playback was the top complaint). Ignores
  // links/images (the reader's own handlers own those). To start narration from a
  // specific spot: play (navbar control), then tap — now it seeks.
  useEffect(() => {
    const body = scrollerRef.current?.querySelector<HTMLElement>(
      ".markdown-body",
    );
    if (!active || !playing || !body) return undefined;
    const onClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (target.closest("a") || target.closest("img")) return;
      const blockEl = target.closest<HTMLElement>("[data-blk]");
      if (!blockEl) return;
      const blk = Number(blockEl.dataset["blk"]);
      const unit = units.find((u) => u.blk === blk && u.kind === "prose");
      if (unit) seekToSentence(unit.idx);
    };
    body.addEventListener("click", onClick);
    return () => body.removeEventListener("click", onClick);
  }, [active, playing, units, seekToSentence, scrollerRef]);
}
