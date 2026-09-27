/** Centre a target vertically without scrolling any translated ancestor panes. */
export function centerWithin(scroller: HTMLElement, target: Element): void {
  const frame = scroller.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  const top = scroller.scrollTop + item.top - frame.top - scroller.clientTop +
    item.height / 2 - scroller.clientHeight / 2;
  const clamped = Math.max(
    0,
    Math.min(top, scroller.scrollHeight - scroller.clientHeight),
  );
  if (Math.abs(clamped - scroller.scrollTop) > 1) {
    scroller.scrollTo({ top: clamped, behavior: "smooth" });
  }
}
