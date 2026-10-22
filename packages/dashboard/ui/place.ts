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

/** What placing a menu reads: its opener, its own size and the window's. */
export interface PopMeasure {
  anchor: Box;
  pop: { width: number; height: number };
  view: { width: number; height: number };
}

/**
 * Keeps an open menu in its place: places it now, and again each time `watch` calls back, which
 * `components/Popover.tsx` asks for when the window resizes and when the menu itself changes size. A
 * menu can open small and grow: the fork menu shows "Loading the call…" until the call arrives,
 * and placed only at that height it ran off the bottom of the window under a low row. `watch`
 * returns what stops it, and so does this.
 */
export function keepPlaced(measure: () => PopMeasure, align: 'right' | 'left', set: (place: { top: number; left: number }) => void, watch: (again: () => void) => () => void): () => void {
  const place = () => {
    const m = measure();
    set(placePop(m.anchor, m.pop, m.view, align));
  };
  place();
  return watch(place);
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

/**
 * Where a run picker's list goes: under its button, or over it when there is more room there, as
 * tall as that room allows (at most 420px); at least as wide as the button and 340px, within the
 * window's 12px margins.
 */
export function placeList(anchor: { left: number; top: number; bottom: number; width: number }, height: number, view: { width: number; height: number }): { top: number; left: number; width: number; maxHeight: number } {
  const below = view.height - anchor.bottom - 18;
  const above = anchor.top - 18;
  const up = height > below && above > below;
  const width = Math.min(view.width - 24, Math.max(anchor.width, 340));
  const maxHeight = Math.min(420, up ? above : below);
  const shown = Math.min(height, maxHeight);
  return { top: up ? anchor.top - 6 - shown : anchor.bottom + 6, left: Math.max(12, Math.min(anchor.left, view.width - width - 12)), width, maxHeight };
}
