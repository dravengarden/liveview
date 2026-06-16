import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { haptic } from "../_shell";
import { useAudioPlayer } from "@/audio/player";
import type { Mark, SpokenUnits, Unit } from "@/types";

/** Follow-mode controls the hook hands back, so the reader can show a
 *  "back to narration" affordance and re-centre when the reader scrolled away. */
export interface ReadAlongFollow {
  /** Read-aloud is narrating THIS chapter (controls below are meaningful). */
  active: boolean;
  /** Auto-scroll is currently keeping the spoken line in view. */
  following: boolean;
  /** Re-centre on the spoken line and resume following. */
  jumpToCurrent: () => void;
}

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

/** Where `target` sits inside `root`, located over the rendered text with ALL
 *  whitespace stripped (from both sides), so the match is whitespace-insensitive.
 *  Why strip rather than collapse: a CommonMark soft line-break in the markdown
 *  source renders as a SPACE in the HTML, but the server's spoken-unit text has
 *  none — and CJK has no inter-character spaces, so any source line-wrap inside a
 *  sentence injected a space the unit text lacked, breaking the match (≈45% of
 *  units in a wrapped CJK chapter). Both the unit text and the HTML derive from
 *  the same source, and we match whole sentences, so dropping every space on both
 *  sides is unambiguous. `map[i]` is the DOM (node, offset) of stripped char i;
 *  the highlight Range spans the intervening spaces in the DOM regardless. */
interface Located {
  map: { node: Text; offset: number }[];
  at: number;
  len: number;
}
function locateText(root: HTMLElement, target: string): Located | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let norm = "";
  const map: { node: Text; offset: number }[] = [];
  let node = walker.nextNode();
  while (node) {
    const tn = node as Text;
    const s = tn.data;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i] ?? "";
      if (/\s/.test(ch)) continue; // drop every space — match is ws-insensitive
      norm += ch;
      map.push({ node: tn, offset: i });
    }
    node = walker.nextNode();
  }
  const needle = target.replace(/\s+/g, "");
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

/** Sticky follow: keep `range` in a comfortable upper-middle band of `scroller`,
 *  gently scrolling only when it drifts out — so the spoken line stays put without
 *  a jerk on every sentence. Uses scrollBy (not scrollIntoView) so it never fires
 *  the manual-scroll cancel that wheel/touch do. */
function followScroll(scroller: HTMLElement, range: Range): void {
  const rr = range.getBoundingClientRect();
  const sr = scroller.getBoundingClientRect();
  const top = sr.top + sr.height * 0.2;
  const bottom = sr.top + sr.height * 0.62;
  if (rr.top < top || rr.top > bottom) {
    scroller.scrollBy({
      top: rr.top - (sr.top + sr.height * 0.32),
      behavior: "smooth",
    });
  }
}

export function useInPlaceHighlight(
  scrollerRef: RefObject<HTMLElement | null>,
  currentPath: string | null,
): ReadAlongFollow {
  const { nowPlaying, currentIdx, currentTime, playing, seekToSentence } =
    useAudioPlayer();
  const [units, setUnits] = useState<Unit[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  // Sticky follow: auto-scroll keeps the spoken line in view; a manual scroll
  // turns it off (so re-reading isn't fought), the jump button turns it back on.
  const [following, setFollowing] = useState(true);
  // The spoken line's live range, so the jump button can re-centre on it.
  const curRangeRef = useRef<Range | null>(null);

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

  // A fresh chapter should auto-follow from the top again.
  useEffect(() => {
    setFollowing(true);
  }, [nowPlaying?.chapterPath]);

  // A manual scroll (wheel / touch drag) means the reader took over — stop
  // auto-following so we don't yank them back. Programmatic scrollBy (followScroll)
  // doesn't fire these, so the follow never cancels itself.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!active || !scroller) return undefined;
    const off = (): void => setFollowing(false);
    scroller.addEventListener("wheel", off, { passive: true });
    scroller.addEventListener("touchmove", off, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", off);
      scroller.removeEventListener("touchmove", off);
    };
  }, [active, scrollerRef]);

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
    const curRange = unit ? unitRange(body, unit) : null;
    const sentence = api.make();
    sentence.priority = 1;
    if (curRange) {
      sentence.add(curRange);
    } else if (unit && blockEl && unit.kind !== "prose") {
      const block = document.createRange();
      block.selectNodeContents(blockEl);
      sentence.add(block);
    }

    api.clearAll();
    api.set(HL_DONE, done);
    api.set(HL_SENTENCE, sentence);

    // Remember the spoken line (for the jump button) and sticky-follow it on
    // sentence change — only while playing AND following, so a reader who scrolled
    // away to re-read is left alone.
    if (curRange) curRangeRef.current = curRange;
    const scroller = scrollerRef.current;
    if (playing && following && scroller && curRange) {
      followScroll(scroller, curRange);
    }
    return () => api.clearAll();
  }, [active, units, currentIdx, playing, following, scrollerRef]);

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

  // Tap / long-press to seek.
  //   • PLAYING → a plain tap on a paragraph jumps playback to its first sentence
  //     (the "follow my eyes" reposition you want while listening).
  //   • PAUSED  → a tap does NOTHING (a stray touch during silent reading must
  //     never hijack playback — that was the top complaint). A deliberate
  //     LONG-PRESS instead seeks AND starts playback from that paragraph, so you
  //     can begin narration at a chosen spot on purpose.
  // Ignores links/images (the reader's own handlers own those).
  useEffect(() => {
    const body = scrollerRef.current?.querySelector<HTMLElement>(
      ".markdown-body",
    );
    if (!active || !body) return undefined;

    const seekAtTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el || el.closest("a") || el.closest("img")) return false;
      const blockEl = el.closest<HTMLElement>("[data-blk]");
      if (!blockEl) return false;
      const blk = Number(blockEl.dataset["blk"]);
      const unit = units.find((u) => u.blk === blk && u.kind === "prose");
      if (!unit) return false;
      seekToSentence(unit.idx);
      setFollowing(true); // you picked a spot — follow it from here
      return true;
    };

    const onClick = (e: MouseEvent): void => {
      if (playing) seekAtTarget(e.target);
    };

    // Long-press, paused only. Cancelled by a drag or an early release, so it
    // never fires on a tap or a scroll.
    const LONG_MS = 450;
    let timer: number | undefined;
    let sx = 0;
    let sy = 0;
    let pressTarget: EventTarget | null = null;
    const cancel = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const onPointerDown = (e: PointerEvent): void => {
      if (playing) return; // playing uses the plain tap above
      sx = e.clientX;
      sy = e.clientY;
      pressTarget = e.target;
      cancel();
      timer = window.setTimeout(() => {
        timer = undefined;
        if (seekAtTarget(pressTarget)) haptic("medium");
      }, LONG_MS);
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (
        timer !== undefined &&
        (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)
      ) cancel();
    };

    // While read-aloud is loaded but PAUSED, the long-press is OUR gesture — turn
    // off iOS's native text selection / callout so it reads as "seek here", not a
    // text selection. Restored when playing or when read-aloud ends.
    if (!playing) {
      body.style.setProperty("-webkit-user-select", "none");
      body.style.setProperty("user-select", "none");
      body.style.setProperty("-webkit-touch-callout", "none");
    }

    body.addEventListener("click", onClick);
    body.addEventListener("pointerdown", onPointerDown);
    body.addEventListener("pointermove", onPointerMove);
    body.addEventListener("pointerup", cancel);
    body.addEventListener("pointercancel", cancel);
    return () => {
      cancel();
      body.style.removeProperty("-webkit-user-select");
      body.style.removeProperty("user-select");
      body.style.removeProperty("-webkit-touch-callout");
      body.removeEventListener("click", onClick);
      body.removeEventListener("pointerdown", onPointerDown);
      body.removeEventListener("pointermove", onPointerMove);
      body.removeEventListener("pointerup", cancel);
      body.removeEventListener("pointercancel", cancel);
    };
  }, [active, playing, units, seekToSentence, scrollerRef]);

  const jumpToCurrent = useCallback(() => {
    setFollowing(true);
    const scroller = scrollerRef.current;
    if (scroller && curRangeRef.current) {
      followScroll(scroller, curRangeRef.current);
    }
  }, [scrollerRef]);

  return { active, following, jumpToCurrent };
}
