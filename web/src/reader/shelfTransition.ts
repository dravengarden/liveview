// Ordering of the native shell's snapshot navigation around shelf ⇄ book.
// The host captures the current pixels synchronously, so the capture must
// happen before the route changes, and the held shelf snapshot may only be
// released after the live shelf has painted. Off the native shell every host
// call is a no-op and `pop` reports false.

export interface SnapshotNav {
  /** Capture the current view (the shelf) as the pop destination. */
  push: (slug: string) => void;
  /** Capture the current book and show the held shelf; false off-shell. */
  pop: () => boolean;
  /** The live shelf has painted; swap the snapshot for the web view. */
  ready: () => void;
  /** Run after the next animation frame. */
  frame: (cb: () => void) => void;
}

/** Shelf → book: capture the shelf, then commit the route. */
export function leaveShelf(nav: SnapshotNav, slug: string, commit: () => void): void {
  nav.push(slug);
  commit();
}

/** Book → shelf: show the held snapshot, commit, release after two frames
 *  (through the first painted frame of the live shelf). */
export function returnToShelf(nav: SnapshotNav, commit: () => void): void {
  const held = nav.pop();
  commit();
  if (held) nav.frame(() => nav.frame(() => nav.ready()));
}
