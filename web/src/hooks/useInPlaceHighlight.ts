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
  /** Toggle follow: on→off (let the reader wander), off→on (re-centre + stick). */
  toggleFollow: () => void;
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

/** A located unit: where its text sits in its block's whitespace-stripped char
 *  stream. `map` is the SHARED per-block (node, offset) of stripped char i (units
 *  in the same block share one map); `[at, at+len)` is this unit's slice. */
interface Located {
  map: { node: Text; offset: number }[];
  at: number;
  len: number;
}

/** A block's text with ALL whitespace stripped, plus the DOM (node, offset) of
 *  each kept char. Whitespace is stripped (not collapsed) because a CommonMark
 *  soft line-break renders as a SPACE in the HTML while the server's spoken-unit
 *  text has none — and CJK has no inter-character spaces, so any source line-wrap
 *  inside a sentence injected a space the unit text lacked (broke ≈45% of units in
 *  a wrapped CJK chapter). Matching whitespace-insensitively is unambiguous since
 *  both sides derive from the same source; the Range spans the DOM spaces anyway. */
function normalizeBlock(
  root: HTMLElement,
): { norm: string; map: { node: Text; offset: number }[] } {
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
  return { norm, map };
}

/** Locate EVERY prose unit in the chapter, keyed by unit idx → its block slice.
 *
 *  The fix for repeated text: a unit used to be located independently via
 *  `indexOf(needle)` (FIRST occurrence), so when the same phrase recurred in a
 *  block (e.g. `[论文/预印本]` ending several list items, the whole `<ul>` being
 *  ONE block) the Nth sentence highlighted the FIRST occurrence — the highlight
 *  jumped to the wrong place. Units are the in-order partition of their block's
 *  text, so we instead match per block with a FORWARD CURSOR: each unit is found
 *  AFTER the previous one ended (`indexOf(needle, cursor)`). Position, not just
 *  content, disambiguates — deterministic and correct regardless of repeats.
 *
 *  Blocks must already be numbered with `data-blk`. */
function locateChapter(
  body: HTMLElement,
  units: Unit[],
): Map<number, Located> {
  const out = new Map<number, Located>();
  const byBlk = new Map<number, Unit[]>();
  for (const u of units) {
    if (u.kind !== "prose" || !u.text.trim()) continue;
    const arr = byBlk.get(u.blk);
    if (arr) arr.push(u);
    else byBlk.set(u.blk, [u]);
  }
  for (const [blk, blkUnits] of byBlk) {
    const blockEl = body.querySelector<HTMLElement>(`[data-blk="${blk}"]`);
    if (!blockEl) continue;
    const { norm, map } = normalizeBlock(blockEl);
    let cursor = 0;
    for (const u of blkUnits) {
      const needle = u.text.replace(/\s+/g, "");
      if (!needle) continue;
      const at = norm.indexOf(needle, cursor); // forward cursor disambiguates repeats
      if (at < 0) continue; // markup mismatch — leave this unit unhighlighted
      out.set(u.idx, { map, at, len: needle.length });
      cursor = at + needle.length;
    }
  }
  return out;
}

/** A Range over chars [fromFrac, toFrac] of a located unit (fractions 0..1). */
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
  // Per-chapter located map (unit idx → block slice), computed ONCE per units
  // array (it's positional, so it's stable for the rendered chapter) and reused
  // by the trail + wipe effects. Keyed by the `units` identity it was built for.
  const locatedRef = useRef<Map<number, Located>>(new Map());
  const locatedForRef = useRef<Unit[] | null>(null);
  const ensureLocated = useCallback((body: HTMLElement): Map<number, Located> => {
    if (locatedForRef.current !== units) {
      // Number top-level blocks in document order — the same order spoken_units
      // assigns `blk`. Idempotent.
      const blocks = body.children;
      for (let i = 0; i < blocks.length; i++) {
        (blocks[i] as HTMLElement).dataset["blk"] = String(i);
      }
      locatedRef.current = locateChapter(body, units);
      locatedForRef.current = units;
    }
    return locatedRef.current;
  }, [units]);

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
    const located = ensureLocated(body);

    // The read trail: every sentence before the current one, soft tint.
    const done = api.make();
    done.priority = 0;
    for (let i = 0; i < currentIdx; i++) {
      const loc = located.get(i);
      const r = loc && rangeOf(loc, 0, 1);
      if (r) done.add(r);
    }

    // The current sentence (full extent), medium tint — the focus. Non-prose
    // blocks (image / code / table / math) outline the whole block instead.
    const unit = units[currentIdx];
    const blockEl = unit
      ? body.querySelector<HTMLElement>(`[data-blk="${unit.blk}"]`)
      : null;
    const curLoc = located.get(currentIdx);
    const curRange = curLoc ? rangeOf(curLoc, 0, 1) : null;
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
  }, [active, units, currentIdx, playing, following, scrollerRef, ensureLocated]);

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
    const loc = unit && unit.kind === "prose" && unit.text.trim()
      ? ensureLocated(body).get(currentIdx)
      : undefined;
    if (!loc) {
      api.remove(HL_ACTIVE);
      return undefined;
    }
    // PAUSED: fill the WHOLE current sentence with the strong tint, so the line
    // you stopped on stays clearly highlighted ("you are here") instead of fading
    // to the faint base when the live wipe stops. PLAYING: the wipe tracks the
    // spoken word by time fraction. (Resuming snaps the wipe back to the live
    // position and grows from there.)
    const mk = marks[currentIdx];
    const span = mk ? mk.end_ms - mk.start_ms : 0;
    const frac = !playing
      ? 1
      : mk && span > 0
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
  }, [
    active,
    units,
    marks,
    currentIdx,
    currentTime,
    playing,
    scrollerRef,
    ensureLocated,
  ]);

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

  // The shared <PlaybackBar>'s follow toggle: ON re-centres + sticks, tapping
  // again while following turns it off (lets the reader wander without the page
  // tugging back), symmetric with the audiobook read-along's follow button.
  const toggleFollow = useCallback(() => {
    if (following) setFollowing(false);
    else jumpToCurrent();
  }, [following, jumpToCurrent]);

  return { active, following, jumpToCurrent, toggleFollow };
}
