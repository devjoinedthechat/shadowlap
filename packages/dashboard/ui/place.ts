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
