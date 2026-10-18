/**
 * Long lists drawn a window at a time: a run's views render the rows in view and a screenful either
 * side, with the height of the rest above and below them, so a run of 50,000 calls costs what a
 * screenful costs. No DOM here: the tests import it, and `useWindow` (window-hook.ts) measures.
 *
 * A row's height is its own once it has been drawn, else the height drawn last for a row of its
 * shape (a call with a result line under it, a turn with tools), else the shape's estimate: rows of
 * one shape are one height, so the rows never drawn are placed where they would be.
 */

/** Each row's top from the top of the list, and at `[n]` the list's height. */
export function rowOffsets(count: number, heightOf: (i: number) => number): Float64Array {
  const out = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) out[i + 1] = out[i]! + heightOf(i);
  return out;
}

/** The first row whose bottom is below `y`: the row at `y`, or `count` past the end. */
export function rowAt(offsets: Float64Array, y: number): number {
  const count = offsets.length - 1;
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The rows to draw for a view of the list from `top` (the list's own coordinates, 0 at its first row)
 * and `height` tall: those in it and `over` pixels either side, `start` to `end` (exclusive).
 */
export function windowRange(offsets: Float64Array, top: number, height: number, over: number): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count === 0) return { start: 0, end: 0 };
  const start = Math.min(count - 1, rowAt(offsets, Math.max(0, top - over)));
  const end = Math.max(start + 1, Math.min(count, rowAt(offsets, top + height + over) + 1));
  return { start, end };
}

/**
 * Where to scroll a view so a row shows: `rowTop` and `rowHeight` in the box's own coordinates, the
 * box scrolled to `scrollTop` and `boxHeight` tall, with `head` pixels at its top covered (a table's
 * sticky header). Centred when asked (a run opening on its call), else by as little as it takes;
 * null when the row shows already.
 */
export function scrollFor(rowTop: number, rowHeight: number, scrollTop: number, boxHeight: number, head: number, centre: boolean): number | null {
  if (centre) return Math.max(0, rowTop - boxHeight / 2 + rowHeight / 2);
  if (rowTop - head < scrollTop) return Math.max(0, rowTop - head);
  if (rowTop + rowHeight > scrollTop + boxHeight) return rowTop + rowHeight - boxHeight;
  return null;
}

/** Rows drawn before a box has been measured: about a screenful at the estimate. */
export const FIRST_ROWS = 60;
