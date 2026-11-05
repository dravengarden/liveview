// Pure cache rules for the in-place read-along highlight: which chapter
// resources belong to the playing rendition, and when the located unit map
// must be rebuilt against the rendered DOM.

/** The playing chapter fields that identify its units and marks. */
export interface ReadAlongSource {
  chapterPath: string;
  lang: string;
  voice?: string | undefined;
  marksHash?: string | undefined;
}

/** Identity of the units and marks of a playing text chapter; "" when the
 *  read-along is inactive. A voice or marks change is a different key. */
export function readAlongKey(source: ReadAlongSource | null, active: boolean): string {
  if (!active || !source) return "";
  return `${source.chapterPath}\u0000${source.lang}\u0000${source.voice ?? ""}\u0000${source.marksHash ?? ""}`;
}

/** The fetched resource for `key`, or `empty` while the fetched one belongs to
 *  another chapter. One chapter's units never bind to the next one's text
 *  during the render in which both switch. */
export function resourceFor<T>(resources: { key: string; value: T }, key: string, empty: T): T {
  return resources.key === key ? resources.value : empty;
}

/** A snapshot of the rendered chapter's child generation. */
export interface DomGeneration<N> {
  body: { firstChild: N | null; lastChild: N | null };
  first: N | null;
  last: N | null;
}

export function domGeneration<N>(body: { firstChild: N | null; lastChild: N | null }): DomGeneration<N> {
  return { body, first: body.firstChild, last: body.lastChild };
}

/** Whether the located map must be rebuilt: the units changed, a located node
 *  is detached, or the chapter's HTML committed a new child generation since
 *  the map was built (HTML can commit after its units). */
export function locatedMapStale<U, N>(
  locatedFor: U | null,
  units: U,
  sampleDetached: boolean,
  built: DomGeneration<N> | null,
  body: { firstChild: N | null; lastChild: N | null },
): boolean {
  return locatedFor !== units || sampleDetached || !built || built.body !== body ||
    built.first !== body.firstChild || built.last !== body.lastChild;
}
