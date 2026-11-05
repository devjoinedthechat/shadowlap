/**
 * Where a menu goes, and where a hover card goes. No DOM here: the tests import it, and
 * `components/Popover.tsx` and `components/HoverCard.tsx` measure what they place.
 */

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A menu's edge to its button, and its least distance from the window's edges. */
const GAP = 6;
const EDGE = 12;
/** A menu is never squeezed below this: it scrolls, at the height of about three rows. */
const LEAST_ROOM = 120;
/** A picker's or a project menu's least width, the narrower of a menu's two. */
const NARROW = 280;

/** What placing a menu says: its corner, a height to scroll within where it doesn't fit, and whether it went over its button. */
export interface MenuPlace {
  top: number;
  left: number;
  maxHeight: number | null;
  up: boolean;
}

/**
 * Where a menu goes: under its button, else over it when there is more room there, else on the side
 * with more room, as tall as that room and scrolling, so it never covers its own button; 6px from the
 * button and 12px from the window's edges. Its edge lines up with the button's edge nearer the
 * window's middle, or the one `align` names (`start`, a project switcher's, a picker's).
 */
export function placeMenu(anchor: Box, pop: { width: number; height: number }, view: { width: number; height: number }, align?: 'start' | 'end'): MenuPlace {
  const below = view.height - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  const up = pop.height > below && above > below;
  const room = Math.max(LEAST_ROOM, up ? above : below);
  const height = Math.min(pop.height, room);
  const start = align ? align === 'start' : (anchor.left + anchor.right) / 2 < view.width / 2;
  const left = Math.max(EDGE, Math.min(start ? anchor.left : anchor.right - pop.width, view.width - pop.width - EDGE));
  return { top: up ? anchor.top - GAP - height : anchor.bottom + GAP, left, maxHeight: pop.height > room ? room : null, up };
}

/** A picker's width: its button's, at least the narrower of a menu's two, within the window's margins. */
export function menuWidthAt(button: number, view: number): number {
  return Math.min(view - 2 * EDGE, Math.max(button, NARROW));
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
export function keepPlaced(measure: () => PopMeasure, align: 'start' | 'end' | undefined, set: (place: MenuPlace) => void, watch: (again: () => void) => () => void): () => void {
  const place = () => {
    const m = measure();
    set(placeMenu(m.anchor, m.pop, m.view, align));
  };
  place();
  return watch(place);
}

/** A card's edge to what it describes, and its least distance from the window's edges. */
const TIP_GAP = 8;
const TIP_EDGE = 8;
/** Wider than this, a card starts near the pointer rather than at the far left of a wide row. */
const WIDE = 240;

/**
 * Where a hover card goes, anchored to its element: under it, or over it where there is no room, at
 * its left edge, a wide row's near the pointer (`x`). A menu row's goes beside the menu (`menu`), so
 * it never covers the rows after it. In a dialog a card that would cover the footer (`foot`, its top)
 * goes over its element instead. Kept 8px inside the window.
 */
export function placeTip(el: Box, card: { width: number; height: number }, view: { width: number; height: number }, o: { x?: number | null; menu?: { left: number; right: number } | null; foot?: number | null } = {}): { left: number; top: number } {
  let left: number;
  let top: number;
  if (o.menu) {
    left = o.menu.right + TIP_GAP;
    if (left + card.width > view.width - TIP_EDGE) left = o.menu.left - TIP_GAP - card.width;
    top = el.top;
  } else {
    const floor = Math.min(view.height - TIP_EDGE, o.foot ?? Infinity);
    top = el.bottom + TIP_GAP;
    if (top + card.height > floor && el.top - TIP_GAP - card.height >= TIP_EDGE) top = el.top - TIP_GAP - card.height;
    left = o.x != null && el.right - el.left > WIDE ? o.x - 24 : el.left;
  }
  return { left: Math.max(TIP_EDGE, Math.min(left, view.width - card.width - TIP_EDGE)), top: Math.max(TIP_EDGE, Math.min(top, view.height - card.height - TIP_EDGE)) };
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
