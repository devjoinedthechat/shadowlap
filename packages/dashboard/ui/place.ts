/**
 * Where a menu goes: under the button that opened it, kept inside the viewport with a 12px margin.
 * `align: 'right'` puts its right edge under the opener's. No DOM here: the tests import it, and
 * `components/Popover.tsx` measures the opener and the menu.
 */

export interface Box {
  left: number;
  right: number;
  bottom: number;
}

export function placePop(anchor: Box, pop: { width: number; height: number }, view: { width: number; height: number }, align: 'right' | 'left' = 'right'): { top: number; left: number } {
  const top = Math.max(12, Math.min(anchor.bottom + 6, view.height - pop.height - 12));
  const want = align === 'right' ? anchor.right - pop.width : anchor.left;
  const left = Math.max(12, Math.min(want, view.width - pop.width - 12));
  return { top, left };
}

/**
 * Where a strip that scrolls sideways (a phone's tab strip) has to scroll so one of its items shows
 * whole, `pad` clear of the edge it comes in from: `strip` is its scroll position and visible width,
 * `item` its place from the start of the strip's content. Null when it shows already. The strip
 * moves as little as it can.
 */
export function stripScroll(strip: { scrollLeft: number; width: number }, item: { left: number; width: number }, pad = 16): number | null {
  const start = item.left - pad;
  const end = item.left + item.width + pad;
  if (item.left >= strip.scrollLeft && item.left + item.width <= strip.scrollLeft + strip.width) return null;
  if (item.left < strip.scrollLeft || item.width + 2 * pad > strip.width) return Math.max(0, start);
  return Math.max(0, end - strip.width);
}
