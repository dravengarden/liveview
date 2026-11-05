// Browser history policy for reader navigation. The shelf is layer 0 and the
// reader is layer 1; what a navigation does to the history stack depends on
// why it happened, not on where it goes (a Contents tap and an in-text link
// can reach the same chapter but must behave differently on Back).

/** Why the reader is moving. */
export type NavSource =
  /** A shelf card or Continue entry. */
  | "shelf"
  /** A row in the Contents pane: a lateral move within the book. */
  | "contents"
  /** A cross-reference link inside the chapter text. */
  | "link"
  /** The previous/next chapter pager under the text. */
  | "pager"
  /** The edition (language) switcher. */
  | "lang"
  /** The read ⇄ listen switch. */
  | "rendition"
  /** "Go to what is playing" from the now-playing surfaces. */
  | "playing"
  /** A missing path replaced by the book's first chapter. */
  | "redirect"
  /** Playback carried the reader into the next chapter. */
  | "engine";

/**
 * Whether a navigation pushes a new entry or replaces the current one.
 *
 * Contents is lateral inside the reader layer, so Back from any chapter
 * returns to the shelf; entering a book from the shelf through Contents (not
 * possible today, kept for safety) still pushes. Links, the pager, the
 * edition switcher and jumps to what is playing push, so Back returns to the
 * place the reader came from. In-place changes (read ⇄ listen, a redirect,
 * playback advancing) replace.
 */
export function historyMode(source: NavSource, fromShelf: boolean): "push" | "replace" {
  switch (source) {
    case "contents":
      return fromShelf ? "push" : "replace";
    case "rendition":
    case "redirect":
    case "engine":
      return "replace";
    case "shelf":
    case "link":
    case "pager":
    case "lang":
    case "playing":
      return "push";
  }
}
