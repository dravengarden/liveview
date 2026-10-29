/** Centre a target vertically without scrolling any translated ancestor panes. */
export function centerWithin(
  scroller: HTMLElement,
  target: Element,
  behavior: ScrollBehavior = "smooth",
): void {
  const frame = scroller.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  const top = scroller.scrollTop + item.top - frame.top - scroller.clientTop +
    item.height / 2 - scroller.clientHeight / 2;
  const clamped = Math.max(
    0,
    Math.min(top, scroller.scrollHeight - scroller.clientHeight),
  );
  if (Math.abs(clamped - scroller.scrollTop) > 1) {
    scroller.scrollTo({ top: clamped, behavior });
  }
}

/** Whether `target` is entirely inside the scroller's visible box. */
export function fullyVisibleWithin(
  scroller: HTMLElement,
  target: Element,
): boolean {
  const frame = scroller.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  return item.top >= frame.top && item.bottom <= frame.bottom;
}

/** Whether `target` sits in the middle of the scroller, or is a leading row
 *  shown with the list at its top (it cannot be centred). The bottom bound is
 *  not final: a list still expanding keeps growing its scroll range. */
export function centredWithin(scroller: HTMLElement, target: Element): boolean {
  const frame = scroller.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  const offset = item.top + item.height / 2 - (frame.top + frame.height / 2);
  if (Math.abs(offset) <= Math.max(item.height, 1)) return true;
  return offset < 0 && scroller.scrollTop <= 0 &&
    fullyVisibleWithin(scroller, target);
}
