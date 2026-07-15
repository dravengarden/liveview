import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { haptic } from "../_shell";
import { contentFetch } from "@/native-sync";
import { useAudioPlayer, useAudioTime } from "@/audio/player";
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

// An INVISIBLE repaint-forcer over already-read sentences (NOT a visible trail).
// See the focus effect: iOS WebKit doesn't repaint a region when its highlight is
// REMOVED (so clearAll leaves a ghost of the previous sentence's wipe), but it
// does when a highlight is ADDED. Painting this near-zero-alpha layer over the
// vacated sentences forces them to repaint ghost-free, while showing nothing.
const HL_GHOSTBUST = "lv-read-done"; // invisible; only forces a repaint
const HL_SENTENCE = "lv-reading"; // whole current sentence (focus)
const HL_ACTIVE = "lv-reading-active"; // read-so-far wipe within the current sentence

interface HighlightLike {
  add(range: Range): void;
  // Paint order: higher wins. ghostbust(0) < sentence(1) < active(2). The first
  // is invisible (alpha ~0.01), present only to force WebKit to repaint vacated
  // regions; the visible cue is the current sentence + its read-so-far wipe.
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
    // SKIP text inside KaTeX-rendered math. The server DROPS inline math from a
    // unit's text, but the DOM has KaTeX glyph nodes (and a hidden MathML copy) —
    // so a sentence with math never char-matched, and the indexOf fell onto a
    // later duplicate or a wrong interpolation (the scroll-to-the-wrong-place
    // bug). Excluding `.katex` text aligns both streams, so a math sentence
    // locates EXACTLY. The highlight Range still spans the math visually: a DOM
    // Range between two kept chars includes everything (incl. KaTeX) in between.
    if (tn.parentElement?.closest(".katex")) {
      node = walker.nextNode();
      continue;
    }
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

/** The rendered block element for a unit, found by the SERVER-emitted
 *  `data-sourcepos="<line>:…"` anchor (robust — by id, not by counting
 *  `body.children`, which desyncs when one source block renders to ≠ 1 top-level
 *  element). Falls back to the client-numbered `data-blk` so an older server
 *  (no sourcepos) still highlights. Null when neither anchor is present. */
function blockElForUnit(
  body: HTMLElement,
  unit: Unit | undefined,
): HTMLElement | null {
  if (!unit) return null;
  return (
    body.querySelector<HTMLElement>(`[data-sourcepos^="${unit.line}:"]`) ??
    body.querySelector<HTMLElement>(`[data-blk="${unit.blk}"]`)
  );
}

// All "this non-prose block is being narrated" marker classes — a STABLE DOM
// style (iOS WebKit never purges element styles, unlike a CSS Custom Highlight),
// so the cue holds while PAUSED too. Removed together when the line moves.
const READING_BLOCK_CLASSES = [
  "lv-reading-table",
  "lv-reading-chart",
  "lv-reading-block",
];

/** Which marker a non-prose block gets, by what it actually renders as:
 *  a TABLE reuses the text-tint style (cells lit); a chart (mermaid/SVG) gets a
 *  designed "being read" focus box; anything else (code, image) a plain box. */
function blockReadingClass(el: HTMLElement): string {
  if (el.tagName === "TABLE" || el.querySelector("table")) return "lv-reading-table";
  if (
    el.tagName === "SVG" ||
    el.classList.contains("mermaid") ||
    el.querySelector("svg, .mermaid")
  ) return "lv-reading-chart";
  return "lv-reading-block";
}

/** Scroll a non-prose block into MAXIMUM view (tables/charts are tall and the
 *  line-band follow truncates them): centre it if it fits, else pin its top near
 *  the top so as much as possible shows. scrollBy (not scrollIntoView) so it
 *  never fires the manual-scroll cancel wheel/touch do. */
function fitScroll(scroller: HTMLElement, el: HTMLElement): void {
  const er = el.getBoundingClientRect();
  const elTop = contentTop(scroller, er.top);
  const fits = er.height <= scroller.clientHeight * 0.9;
  // Same clamped-absolute approach as followScroll: a block that fits is centred;
  // one taller than the viewport is top-aligned (a notch below the top edge).
  const target = fits
    ? elTop + er.height / 2 - scroller.clientHeight / 2
    : elTop - scroller.clientHeight * 0.1;
  scrollTopTo(scroller, target);
}

// The smallest element to anchor the PAUSED prose tint on — the list item /
// paragraph / cell that CONTAINS the current sentence, NOT the top-level block.
// A top-level block can be a whole <ul> (many bullets) or <blockquote>; tinting
// it ballooned a one-sentence pause to the entire list. Climbing to the nearest
// LI/P/cell keeps the paused anchor at the sentence's container. Falls back to
// the block when the sentence isn't located.
const ANCHOR_TAGS = ["LI", "P", "BLOCKQUOTE", "TD", "TH", "DD", "DT", "FIGCAPTION"];
function pausedAnchorEl(
  curRange: Range | null,
  blockEl: HTMLElement,
): HTMLElement {
  if (!curRange) return blockEl;
  const n = curRange.commonAncestorContainer;
  let el: HTMLElement | null = n.nodeType === 1
    ? (n as HTMLElement)
    : n.parentElement;
  while (el && el !== blockEl && !ANCHOR_TAGS.includes(el.tagName)) {
    el = el.parentElement;
  }
  return el ?? blockEl;
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
 *  Blocks are found by the server-emitted `data-sourcepos` anchor (see
 *  {@link blockElForUnit}). */
/** Locate the prose units of ONE block (all share `blk`) into `out`. Split out so
 *  a single block can be re-located cheaply after its text nodes were mutated
 *  (paused-span wrap/unwrap) WITHOUT re-walking the whole chapter — re-locating
 *  the entire chapter on every play/pause toggle janked long chapters. */
function locateBlock(
  body: HTMLElement,
  blkUnits: Unit[],
  out: Map<number, Located>,
): void {
  const first = blkUnits[0];
  if (!first) return;
  const blockEl = blockElForUnit(body, first);
  if (!blockEl) return;
  const { norm, map } = normalizeBlock(blockEl);
  // Pass 1: locate what matches exactly, forward cursor. A sentence with inline
  // math fails here — the server's unit text DROPS the math, but the DOM has
  // KaTeX-rendered glyphs, so the char streams differ. Record null, DON'T
  // advance the cursor (the next sentence still starts after this one's slot).
  const pos: ({ at: number; len: number } | null)[] = [];
  let cursor = 0;
  for (const u of blkUnits) {
    const needle = u.text.replace(/\s+/g, "");
    if (!needle) { pos.push(null); continue; }
    const at = norm.indexOf(needle, cursor); // forward cursor disambiguates repeats
    if (at < 0) { pos.push(null); continue; }
    pos.push({ at, len: needle.length });
    cursor = at + needle.length;
  }
  // Pass 2: a math-broken sentence gets the GAP between its located neighbours
  // (end of the previous match → start of the next) — its real slice, math
  // included — instead of the whole paragraph. This keeps the highlight
  // SENTENCE-level on math lines instead of ballooning to the block.
  for (let i = 0; i < blkUnits.length; i++) {
    const p = pos[i];
    if (p) { out.set(blkUnits[i]!.idx, { map, at: p.at, len: p.len }); continue; }
    let prevEnd = 0;
    for (let j = i - 1; j >= 0; j--) {
      const q = pos[j];
      if (q) { prevEnd = q.at + q.len; break; }
    }
    let nextStart = norm.length;
    for (let j = i + 1; j < blkUnits.length; j++) {
      const q = pos[j];
      if (q) { nextStart = q.at; break; }
    }
    if (nextStart > prevEnd) {
      out.set(blkUnits[i]!.idx, { map, at: prevEnd, len: nextStart - prevEnd });
    }
  }
}

/** Prose units of `blk`, in unit order (the input order locateBlock relies on). */
function proseUnitsOfBlock(units: Unit[], blk: number): Unit[] {
  return units.filter((u) => u.kind === "prose" && !!u.text.trim() && u.blk === blk);
}

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
  for (const [, blkUnits] of byBlk) locateBlock(body, blkUnits, out);
  return out;
}

/** Wrap a sentence Range in per-text-node `<span class>` so the PAUSED cue is
 *  EXACTLY the sentence — a paragraph / blockquote / list-item holds many
 *  sentences, so a block-level background tints them all. A DOM span (unlike a
 *  CSS Custom Highlight) is NOT purged by iOS when idle, so the paused line holds.
 *  Per-text-node so it spans inline `<strong>`/`<code>`; each piece-range lives
 *  inside ONE text node, where `surroundContents` always succeeds. Returns the
 *  spans for {@link unwrapSpans}. */
function wrapSpans(range: Range, cls: string): HTMLElement[] {
  const root = range.commonAncestorContainer;
  const host = root.nodeType === 1 ? (root as Element) : root.parentElement;
  if (!host) return [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    if (range.intersectsNode(n)) texts.push(n as Text);
    n = walker.nextNode();
  }
  const spans: HTMLElement[] = [];
  for (const tn of texts) {
    const s = tn === range.startContainer ? range.startOffset : 0;
    const e = tn === range.endContainer ? range.endOffset : tn.length;
    if (e <= s) continue;
    const r = document.createRange();
    r.setStart(tn, s);
    r.setEnd(tn, e);
    const span = document.createElement("span");
    span.className = cls;
    try {
      r.surroundContents(span); // single-text-node range → always valid
      spans.push(span);
    } catch {
      // skip a piece we can't wrap; the rest still mark the sentence
    }
  }
  return spans;
}

/** Undo {@link wrapSpans}: lift each span's children back out and remove it,
 *  then normalize so the split text nodes merge — the block returns to the exact
 *  DOM the locator measured (callers then recompute the located map). */
function unwrapSpans(spans: HTMLElement[]): void {
  const parents = new Set<Node>();
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
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

/** Sticky follow: CENTRE the spoken line in `scroller` — identical to the
 *  audiobook reader's `scrollIntoView({block:"center"})`, so the two playback
 *  modes follow the narration the same way (the line stays comfortably centred
 *  instead of drifting to a band edge and off-screen when paused). Uses scrollBy
 *  (not scrollIntoView) so it never fires the manual-scroll cancel that
 *  wheel/touch do — a programmatic scroll must not turn follow off. */
/** Scroll `scroller` so `top..top+height` (content-relative coords) sits where we
 *  want it, CLAMPED to the scrollable range and issued as an ABSOLUTE scrollTo.
 *
 *  Why not `scrollBy(delta)` off live rects (the old way): a relative scroll
 *  computed from getBoundingClientRect races an in-flight smooth scroll — read
 *  mid-animation, `delta` is wrong, and consecutive line changes fight each other
 *  → jitter. And with no clamp, centring a line near the END asks to scroll past
 *  the content, so the view over-scrolls into blank and RE-tries every line → the
 *  "growing blank at the bottom". An absolute, clamped target is idempotent
 *  (re-running with the line already placed is a no-op) and can never reveal blank
 *  past the last content. */
function scrollTopTo(scroller: HTMLElement, target: number): void {
  const max = scroller.scrollHeight - scroller.clientHeight;
  const clamped = Math.max(0, Math.min(target, max));
  if (Math.abs(clamped - scroller.scrollTop) > 1) {
    scroller.scrollTo({ top: clamped, behavior: "smooth" });
  }
}

/** Content-relative top of a rect within the scroller (INVARIANT during scroll:
 *  rect.top and scrollTop both shift while scrolling, but their sum — the offset
 *  inside the content — is fixed, so this is safe to read even mid-animation). */
function contentTop(scroller: HTMLElement, top: number): number {
  return top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function followScroll(scroller: HTMLElement, range: Range): void {
  const rr = range.getBoundingClientRect();
  const lineTop = contentTop(scroller, rr.top);
  // Centre the line.
  scrollTopTo(scroller, lineTop + rr.height / 2 - scroller.clientHeight / 2);
}

/** Centre the line like {@link followScroll}, but CLAMP the scroll so the unit's
 *  BLOCK stays on screen. On formula-heavy lines the per-sentence locate can drift
 *  WITHIN the block (a math-stripped needle matches at the wrong offset), so
 *  centring the raw range could scroll to the wrong spot; the block (located by
 *  the server's `data-sourcepos`) is reliable, so the scroll can never leave it. */
function followScrollClamped(
  scroller: HTMLElement,
  range: Range,
  block: HTMLElement | null,
): void {
  const vh = scroller.clientHeight;
  if (block) {
    const bRect = block.getBoundingClientRect();
    const bTop = contentTop(scroller, bRect.top);
    const bH = bRect.height;
    // Block FITS the viewport → centre the whole BLOCK, not the sentence range.
    // Two bugs this fixes, both from anchoring on a text-range rect:
    //  • JITTER: every sentence in a multi-sentence paragraph has a slightly
    //    different range rect, so centring each one micro-scrolled the page line
    //    by line ("上下抖动"). The block rect is the SAME for every sentence in it,
    //    so advancing within a paragraph is now a no-op (idempotent target).
    //  • FLY-OFF: a range can mis-locate on rich lines (inline math/list/table —
    //    the math-stripped needle matches the wrong offset), and centring that
    //    wrong rect scrolled the line off-screen ("飞到页面外"). An element rect
    //    (located by the server's data-sourcepos) can't drift, so it can't fly off.
    // This mirrors the audiobook reader, which centres a real DOM element and never
    // jitters/flies.
    if (bH <= vh) {
      scrollTopTo(scroller, bTop + bH / 2 - vh / 2);
      return;
    }
    // Block TALLER than the viewport (big table/quote) → centre the line but CLAMP
    // so the block always fills the viewport (the line can't leave its own block).
    const rr = range.getBoundingClientRect();
    const t = contentTop(scroller, rr.top) + rr.height / 2 - vh / 2;
    const lo = bTop + bH - vh; // block bottom at viewport bottom
    const hi = bTop; // block top at viewport top
    scrollTopTo(scroller, Math.min(Math.max(t, Math.min(lo, hi)), Math.max(lo, hi)));
    return;
  }
  // No block anchor (rare: no data-sourcepos/data-blk) → centre the range.
  const rr = range.getBoundingClientRect();
  scrollTopTo(scroller, contentTop(scroller, rr.top) + rr.height / 2 - vh / 2);
}

export function useInPlaceHighlight(
  scrollerRef: RefObject<HTMLElement | null>,
  currentPath: string | null,
): ReadAlongFollow {
  const { nowPlaying, currentIdx, playing, seekToSentence } = useAudioPlayer();
  const active = nowPlaying?.rendition === "text" &&
    nowPlaying.chapterPath === currentPath;
  // A background audiobook still ticks ~4 times per second. Do not make an
  // unrelated text chapter re-render its entire markdown tree for that clock.
  const { currentTime } = useAudioTime(active);
  const [units, setUnits] = useState<Unit[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  // Sticky follow: auto-scroll keeps the spoken line in view; a manual scroll
  // turns it off (so re-reading isn't fought), the jump button turns it back on.
  const [following, setFollowing] = useState(true);
  // True WHILE the user is actively scrolling (drag + its momentum/bounce). The
  // per-tick karaoke wipe is frozen during this window: iOS runs the scroll-edge
  // rubber-band as an async compositor animation, and a main-thread CSS-Highlight
  // repaint mid-bounce cancels it — so the wipe (4–10×/s) was eating the bounce.
  const scrollSuspendRef = useRef(false);
  // Bumped when a user scroll settles, to re-run the wipe once and snap the
  // highlight back to the live playback position after the freeze.
  const [scrollSettle, setScrollSettle] = useState(0);
  // (No paused heartbeat: the paused cue is always a DOM span/class now, which
  // iOS never purges — so nothing needs periodic re-asserting. The old 300ms
  // heartbeat forced a repaint thrice a second and made the line flicker.)
  // The spoken line's live range, so the jump button can re-centre on it.
  const curRangeRef = useRef<Range | null>(null);
  // Which unit idx `curRangeRef` was located for. The follow effect must NOT
  // scroll to it unless it's for the CURRENT idx — otherwise, the instant the line
  // advances but the new sentence isn't located yet (DOM/units still settling),
  // we'd scroll to the STALE previous range (often far off-screen) and snap back
  // once it relocates ("突然跳到不存在的行，然后又回去").
  const curRangeIdxRef = useRef<number>(-1);
  // The block element currently carrying the paused DOM-background tint (see the
  // focus effect), so we can clear it when the line moves or playback resumes.
  const litBlockRef = useRef<HTMLElement | null>(null);
  // The per-text-node spans wrapping the PAUSED prose sentence (exact, iOS-purge-
  // proof), with the unit idx they're for, so we unwrap on resume / line change.
  const pausedRef = useRef<{ idx: number; spans: HTMLElement[] } | null>(null);
  // The (idx, block) of the PREVIOUS spoken sentence, so when the line advances we
  // can force a real repaint of the just-vacated block. The 0.01-alpha ghostbust
  // highlight is supposed to do this, but some iOS WebKit builds optimize an
  // (near-)invisible highlight away → the removed wipe leaves a stale underline-
  // ghost on already-read lines ("前面高亮的变成下划线没消失"). An opacity nudge
  // (below) guarantees the recomposite, theme-agnostic and imperceptible.
  const prevSpokenRef = useRef<{ idx: number; block: HTMLElement | null }>({
    idx: -1,
    block: null,
  });
  // Per-chapter located map (unit idx → block slice), computed ONCE per units
  // array (it's positional, so it's stable for the rendered chapter) and reused
  // by the trail + wipe effects. Keyed by the `units` identity it was built for.
  const locatedRef = useRef<Map<number, Located>>(new Map());
  const locatedForRef = useRef<Unit[] | null>(null);
  const ensureLocated = useCallback((body: HTMLElement): Map<number, Located> => {
    // Rebuild when `units` changed OR the cached map is STALE — its located ranges
    // point at a DETACHED DOM. The latter is the auto-advance bug: the new chapter's
    // markdown commits asynchronously (view-transition + diagramTick), so the
    // rAF-based invalidation can re-locate against the OLD DOM (or before the swap)
    // and then never refresh — the highlight range stays bound to the previous
    // chapter's now-removed nodes ("播放到新 section 没有高亮", range detached).
    // Checking whether a sample located node is still connected self-heals
    // regardless of render timing.
    const sample: Located | undefined = locatedRef.current.values().next().value;
    const stale = !!sample && sample.map[0]?.node.isConnected === false;
    if (locatedForRef.current !== units || stale) {
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

  // Fetch units + marks for the active chapter (both cheap / already cached by
  // the engine's own load). Cleared when inactive.
  useEffect(() => {
    if (!active || !nowPlaying) {
      setUnits([]);
      setMarks([]);
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    const q = `path=${encodeURIComponent(nowPlaying.chapterPath)}&lang=${
      encodeURIComponent(nowPlaying.lang)
    }&rendition=text`;
    // RETRY-WHILE-EMPTY: the units/marks are produced by audio generation, so a
    // chapter opened/played WHILE it's still being generated (or right as it
    // finishes) returns 404 / empty here. The engine refetches marks on play,
    // but this hook fired once on activation and used to give up — so the
    // "you are here" highlight stayed blank until you reopened the chapter ("刚
    // 生成完没高亮"). Re-poll until the units land (bounded), then stop.
    const load = (): void => {
      void Promise.all([
        contentFetch(`/api/units?${q}`).then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        contentFetch(`/api/marks?${q}`).then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]).then(([u, m]: [SpokenUnits | null, Mark[] | null]) => {
        if (cancelled) return;
        const gotUnits = !!u && u.units.length > 0;
        if (gotUnits) setUnits(u.units);
        if (m && m.length > 0) setMarks(m);
        // Units drive the locate; if they're not ready yet, the content is
        // still generating — try again shortly, up to ~30s.
        if (!gotUnits && attempts < 15) {
          attempts += 1;
          timer = window.setTimeout(load, 2000);
        }
      });
    };
    load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, nowPlaying?.chapterPath, nowPlaying?.lang]);

  // A fresh chapter should auto-follow from the top again.
  useEffect(() => {
    setFollowing(true);
  }, [nowPlaying?.chapterPath]);

  // On an ADVANCE to another chapter (auto-advance at end-of-chapter, or next/prev),
  // snap to the TOP and drop the stale spoken range, so the new page starts at its
  // BEGINNING. Two things otherwise strand it mid-page with the spoken line off-
  // screen until the new units load: (1) the scroller is REUSED across chapters,
  // so it keeps the previous chapter's offset; (2) `curRangeRef` still holds the
  // PREVIOUS chapter's range, so the follow effect would scroll to a stale line.
  // The follow effect then refines to the exact line once units locate — for an
  // advance that's sentence 0 ≈ the top, so no visible jump. Guarded to fire ONLY
  // on a real chapter CHANGE while already active — NOT on first activation of
  // read-aloud on the current page (that must start where you are, not jump up).
  const prevChapRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !nowPlaying) {
      prevChapRef.current = null;
      return;
    }
    const prev = prevChapRef.current;
    prevChapRef.current = nowPlaying.chapterPath;
    if (prev === null || prev === nowPlaying.chapterPath) return;
    curRangeRef.current = null;
    curRangeIdxRef.current = -1;
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = 0;
    // Re-run locate/focus + follow once the NEW chapter's DOM has had a frame to
    // mount — otherwise, if units land before the new markdown renders, the focus
    // effect locates against stale/absent DOM and the new page shows NO highlight
    // ("播放到新页面没有高亮"). A double-rAF clears the swap.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // INVALIDATE the per-chapter located map now that the new DOM is mounted.
        // ensureLocated keys the map on `units` IDENTITY alone, so a rebuild that
        // raced ahead of the markdown swap (units landed before React committed the
        // new chapter) bound the ranges to the OLD DOM and was never refreshed —
        // the new page then showed no highlight at all. Nulling it forces the
        // scrollSettle-triggered focus re-run below to relocate against the NEW DOM.
        locatedForRef.current = null;
        setScrollSettle((s) => s + 1);
      })
    );
  }, [active, nowPlaying?.chapterPath, scrollerRef]);

  // RETURN FROM BACKGROUND = a RE-ENTRY: re-orient to the spoken line, always.
  // Backgrounding suspends the page JS, so on return three things were wrong:
  //   1. iOS WebKit PURGES the CSS Custom Highlight while hidden → the line's
  //      highlight is gone.
  //   2. `scrollSuspendRef` could be stuck `true` — its 200ms disarm setTimeout
  //      (armed by a scroll gesture before backgrounding) was suspended too, so
  //      the focus / wipe / follow effects all early-return and NOTHING repaints
  //      or scrolls. Clear it on return.
  //   3. the page sits wherever it was (often the top), with the live line off-
  //      screen below.
  // A background round-trip is NOT an in-app scroll-away, so we re-centre
  // UNCONDITIONALLY (force `following` back on) — you left and came back to see
  // where it's reading. Deferred one frame: iOS fires visibilitychange before
  // layout settles, and the engine re-syncs currentIdx on the SAME event (see
  // player.tsx), so we wait a frame to recenter against a laid-out page at the
  // CURRENT line. The scrollSettle bump re-runs focus (REPAINT, fixes the purge)
  // + follow (the scroll).
  useEffect(() => {
    if (!active) return undefined;
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      scrollSuspendRef.current = false;
      setFollowing(true);
      requestAnimationFrame(() => setScrollSettle((s) => s + 1));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active]);

  // ENTER the now-playing chapter (active false→true: you navigated to the page
  // that's currently narrating). You came here to see where it is, so re-enable
  // follow and re-centre on the spoken line — even if you'd scrolled away in a
  // different chapter (that `following=false` shouldn't carry into a fresh entry).
  const prevActiveRef = useRef(false);
  useEffect(() => {
    const was = prevActiveRef.current;
    prevActiveRef.current = active;
    if (active && !was) {
      scrollSuspendRef.current = false;
      setFollowing(true);
      // Defer one frame: a fresh mount / chapter swap hasn't laid out yet, so a
      // synchronous recenter would target an unmeasured page.
      requestAnimationFrame(() => setScrollSettle((s) => s + 1));
    }
  }, [active]);

  // A manual scroll (wheel / touch drag) means the reader took over — stop
  // auto-following so we don't yank them back, AND open the wipe-suspend window so
  // the boundary rubber-band survives (see scrollSuspendRef). Programmatic
  // scrollBy (followScroll) fires neither wheel nor touchmove, so it never arms
  // the window — only a genuine user gesture does.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!active || !scroller) return undefined;
    let idle: number | undefined;
    const disarm = (): void => {
      scrollSuspendRef.current = false;
      setScrollSettle((s) => s + 1); // re-run the wipe → snap to the live position
    };
    // A user gesture: drop follow + suspend the wipe, (re)arming the idle timer.
    const arm = (): void => {
      setFollowing(false);
      scrollSuspendRef.current = true;
      if (idle !== undefined) clearTimeout(idle);
      idle = window.setTimeout(disarm, 200);
    };
    // Momentum/bounce after the finger lifts fires `scroll` but no touchmove —
    // keep the window open while it's still moving, but ONLY if a gesture armed it
    // (so a programmatic followScroll's scroll events never suspend the wipe).
    const keepAlive = (): void => {
      if (!scrollSuspendRef.current) return;
      if (idle !== undefined) clearTimeout(idle);
      idle = window.setTimeout(disarm, 200);
    };
    scroller.addEventListener("wheel", arm, { passive: true });
    scroller.addEventListener("touchmove", arm, { passive: true });
    scroller.addEventListener("scroll", keepAlive, { passive: true });
    return () => {
      if (idle !== undefined) clearTimeout(idle);
      scroller.removeEventListener("wheel", arm);
      scroller.removeEventListener("touchmove", arm);
      scroller.removeEventListener("scroll", keepAlive);
    };
  }, [active, scrollerRef]);


  // Focus on the CURRENT sentence only — no VISIBLE trail. Rebuilt only when the
  // current sentence changes (NOT every audio tick); the per-tick wipe (effect
  // below) layers the strong read-so-far cue on top.
  //
  // Ghost-busting: iOS WebKit doesn't repaint a region when a highlight is merely
  // REMOVED — clearAll() leaves stale "ghost" paint of the previous sentence's
  // wipe (the bug the user hit after the visible trail was dropped). But WebKit
  // DOES repaint a region when a highlight is ADDED. So we paint an INVISIBLE
  // (alpha ~0.01) highlight over every already-read sentence: it forces those
  // vacated regions to repaint ghost-free while showing nothing. Only the current
  // sentence + its wipe are ever visible.
  useEffect(() => {
    const api = highlightApi();
    const body = scrollerRef.current?.querySelector<HTMLElement>(
      ".markdown-body",
    );
    // The paused sentence is shown as DOM spans (iOS doesn't purge those), so the
    // heartbeat needn't repaint — and tearing them down + re-wrapping every beat
    // would flicker. While still paused on the same line, hold them and bail.
    if (
      active && api && body && pausedRef.current && !playing &&
      pausedRef.current.idx === currentIdx && !scrollSuspendRef.current
    ) {
      return undefined;
    }
    // State changed (resumed / moved / inactive): remove the paused spans. The
    // wrap had split ONLY this sentence's block text nodes, so its cached offset
    // map is stale — re-locate JUST that block, not the whole chapter. (Nulling
    // the entire map here forced a full-chapter re-locate on EVERY play/pause
    // toggle → "点击暂停和播放会卡" on long chapters.)
    if (pausedRef.current) {
      const pausedIdx = pausedRef.current.idx;
      unwrapSpans(pausedRef.current.spans);
      pausedRef.current = null;
      const blk = units[pausedIdx]?.blk;
      if (
        body && blk !== undefined && locatedForRef.current === units
      ) {
        // Patch the affected block's entries in place; keep the map keyed to the
        // current `units` so ensureLocated doesn't rebuild the whole thing.
        locateBlock(body, proseUnitsOfBlock(units, blk), locatedRef.current);
      } else {
        // No usable map to patch (chapter changed, etc.) → let ensureLocated rebuild.
        locatedForRef.current = null;
      }
    }
    if (!active || !api || !body) {
      api?.clearAll();
      // Read-aloud closed (or no body): drop the block marker classes too.
      if (litBlockRef.current) {
        litBlockRef.current.classList.remove(
          "lv-reading-paused",
          ...READING_BLOCK_CLASSES,
        );
        litBlockRef.current = null;
      }
      return undefined;
    }
    // Frozen during a user scroll, same as the wipe — so the highlight doesn't
    // jump sentence-to-sentence (its clearAll would also blink the wipe off)
    // while you scroll. It holds still, then snaps to live on settle
    // (scrollSettle). The cleanup below must NOT clear while suspended, or a
    // sentence change mid-scroll would blank everything.
    if (scrollSuspendRef.current) return undefined;
    const located = ensureLocated(body);

    // Invisible repaint-forcer over the already-read sentences (see header).
    const ghostbust = api.make();
    ghostbust.priority = 0;
    for (let i = 0; i < currentIdx; i++) {
      const loc = located.get(i);
      const r = loc && rangeOf(loc, 0, 1);
      if (r) ghostbust.add(r);
    }

    // The current line. PROSE → a precise CSS-Highlight tint over the sentence
    // (+ the per-word wipe below). NON-PROSE (table / chart / code / image) has
    // no per-word mapping — its narration is a summary — so it gets a STABLE DOM
    // MARKER CLASS on the whole block instead (handled after, so it survives the
    // iOS highlight purge and shows while paused).
    const unit = units[currentIdx];
    const blockEl = blockElForUnit(body, unit);
    const isNonProse = !!unit && unit.kind !== "prose";
    const curLoc = located.get(currentIdx);
    const curRange = curLoc ? rangeOf(curLoc, 0, 1) : null;
    // Paused located prose is shown by wrapping the sentence in DOM spans (below),
    // not a CSS Highlight (purged when idle) — so DON'T also add the CSS sentence
    // tint here (the wrap mutates the DOM the range points at anyway).
    const willWrapPaused = !playing && !isNonProse && !!curRange;
    const sentence = api.make();
    sentence.priority = 1;
    if (curRange && !willWrapPaused) {
      sentence.add(curRange);
    } else if (blockEl && !isNonProse && !curRange) {
      // Unlocatable PROSE only (e.g. inline KaTeX renders as spans with no
      // matching text node) — fall back to the whole-block range so the line is
      // still lit. Non-prose is handled by the marker class below, not here.
      const block = document.createRange();
      block.selectNodeContents(blockEl);
      sentence.add(block);
    }

    api.clearAll();
    api.set(HL_GHOSTBUST, ghostbust);
    api.set(HL_SENTENCE, sentence);

    // Block markers (a REAL DOM class — iOS WebKit never purges element styles,
    // unlike the CSS Custom Highlight, so this holds while PAUSED too). Always
    // clear the previous block first, then mark the current one:
    //   • NON-PROSE → its type marker (table cells lit / chart focus-box), shown
    //     PLAYING and PAUSED alike (no per-word cue exists for a summary).
    //   • PROSE, paused → the background "you are here" anchor (the CSS wipe is
    //     purged when idle); PROSE, playing → none (the precise wipe paints it).
    // Clear the previous marker wherever it sat (a non-prose BLOCK, or a paused
    // prose sentence-ANCHOR), then mark the current target.
    const prevLit = litBlockRef.current;
    if (prevLit) {
      prevLit.classList.remove("lv-reading-paused", ...READING_BLOCK_CLASSES);
    }
    litBlockRef.current = null;
    if (blockEl && isNonProse) {
      blockEl.classList.add(blockReadingClass(blockEl));
      litBlockRef.current = blockEl;
    } else if (willWrapPaused && curRange && curLoc) {
      // Paused located prose → wrap the sentence in DOM spans (iOS-purge-proof,
      // precise even inside a multi-sentence paragraph / blockquote / list).
      // SPLIT at the FROZEN playback position so the read-so-far words keep the
      // stronger tint (matching the PLAYING wipe) instead of the whole line going
      // uniform — paused should read as a frozen frame of playing. `currentTime`
      // is frozen in this branch (it only runs while !playing), so it's not an
      // effect dep (adding it would re-wrap every tick during playback).
      const mk = marks[currentIdx];
      const ms = mk ? mk.end_ms - mk.start_ms : 0;
      const frac = mk && ms > 0
        ? Math.min(1, Math.max(0, (currentTime * 1000 - mk.start_ms) / ms))
        : 1;
      let spans: HTMLElement[];
      if (frac >= 1) {
        spans = wrapSpans(curRange, "lv-reading-paused-active");
      } else if (frac <= 0) {
        spans = wrapSpans(curRange, "lv-reading-paused");
      } else {
        // Wrap the LATER part FIRST: wrapSpans splits text nodes (surroundContents),
        // so wrapping [frac,1] first leaves [0,frac]'s node refs intact.
        const unread = rangeOf(curLoc, frac, 1);
        const read = rangeOf(curLoc, 0, frac);
        spans = [
          ...(unread ? wrapSpans(unread, "lv-reading-paused") : []),
          ...(read ? wrapSpans(read, "lv-reading-paused-active") : []),
        ];
      }
      pausedRef.current = { idx: currentIdx, spans };
    } else if (blockEl && !playing) {
      // Paused but unlocatable (no sentence range) → fall back to the smallest
      // container background (li / p / cell), never the whole top-level block.
      const anchor = pausedAnchorEl(curRange, blockEl);
      anchor.classList.add("lv-reading-paused");
      litBlockRef.current = anchor;
    }

    // GHOST-BUST (the real one): when the line ADVANCES, force a true repaint of
    // the just-vacated block. The clearAll above removed the previous sentence's
    // wipe, but iOS WebKit doesn't always repaint a region on highlight REMOVE,
    // and the invisible 0.01-alpha re-add gets optimized away on some builds — so
    // the old wipe lingers as an underline-ghost. An opacity nudge (0.999 → "")
    // for one frame guarantees the element recomposites WITHOUT the removed
    // highlight; theme-agnostic, no colour-matching, imperceptible. Only on a
    // genuine sentence change, never per-tick, and never mid-scroll (frozen).
    const prev = prevSpokenRef.current;
    if (
      prev.idx !== currentIdx && prev.block && prev.block.isConnected &&
      !scrollSuspendRef.current
    ) {
      const el = prev.block;
      el.style.opacity = "0.999";
      requestAnimationFrame(() => {
        el.style.opacity = "";
      });
    }
    prevSpokenRef.current = { idx: currentIdx, block: blockEl };

    // Remember the spoken line so the jump button + the auto-follow effect can
    // re-centre it. (The actual scrolling lives in the dedicated follow effect
    // below, so it fires on sentence CHANGE only — not on every repaint tick.)
    if (curRange) {
      curRangeRef.current = curRange;
      curRangeIdxRef.current = currentIdx;
    }
    // Conditional: a re-run mid-scroll (suspended) must keep the frozen paint, not
    // clear it. When the scroll settles the effect re-runs with suspend already
    // off, so this clears normally and the body repaints to the live position.
    return () => {
      if (!scrollSuspendRef.current) api.clearAll();
    };
  }, [
    active,
    units,
    marks,
    currentIdx,
    playing,
    following,
    scrollerRef,
    ensureLocated,
    scrollSettle,
  ]);

  // Auto-follow: centre the spoken line whenever following, on sentence CHANGE —
  // exactly the audiobook reader's follow (which has no `playing` gate). currentIdx
  // is stable while paused, so this simply doesn't fire then; it re-centres when
  // playback advances or when the follow button flips `following` back on. A real
  // user scroll already set `following=false`, so a reader who wandered is left
  // alone until they tap follow.
  useEffect(() => {
    if (!active || !following) return undefined;
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    // A non-prose block (table / chart) is tall — centre/fit the whole block so
    // it isn't truncated, instead of centring a (stale) sentence range.
    const unit = units[currentIdx];
    const body = scroller.querySelector<HTMLElement>(".markdown-body");
    if (unit && unit.kind !== "prose" && body) {
      const el = blockElForUnit(body, unit);
      if (el) {
        fitScroll(scroller, el);
        return undefined;
      }
    }
    // Only follow a range that belongs to the CURRENT line. A stale range (the
    // new sentence hasn't located yet) would scroll far off then snap back; skip
    // it — the next locate (focus effect → scrollSettle) re-runs this and centres.
    if (curRangeRef.current && curRangeIdxRef.current === currentIdx) {
      // Clamp the scroll to the unit's block (reliable via data-sourcepos) so a
      // formula-heavy line whose sentence range drifted can never scroll to the
      // wrong place — worst case it's off by a paragraph, not off-screen.
      const blk = unit && body ? blockElForUnit(body, unit) : null;
      followScrollClamped(scroller, curRangeRef.current, blk);
    }
    return undefined;
  }, [active, following, currentIdx, scrollSettle, scrollerRef, units]);

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
    // Paused sentence is shown as DOM spans, which split this block's text nodes —
    // the located map is stale, so don't compute a wipe range against it. (The
    // spans ARE the paused cue; the wipe is the PLAYING progress.)
    if (pausedRef.current) {
      api.remove(HL_ACTIVE);
      return undefined;
    }
    // Frozen while the user is scrolling: skip the repaint so iOS's rubber-band
    // isn't cancelled (the last-painted wipe simply stays). The scrollSettle bump
    // re-runs this the moment the scroll stops, snapping the wipe to live.
    if (scrollSuspendRef.current) return undefined;
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
    scrollSettle, // re-run once a user scroll settles → snap the wipe back to live
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
