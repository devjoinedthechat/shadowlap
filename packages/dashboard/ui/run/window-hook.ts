import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLatest } from '../hooks.js';
import { FIRST_ROWS, rowOffsets, scrollFor, windowRange } from './windowed.js';

/**
 * A long list of a run's view drawn a window at a time (windowed.ts): the rows in its scroll box's
 * view and `over` pixels either side, with spacers for the rest. Each row drawn carries its index as
 * `data-wi` and sits directly in the element given `listRef` (a table's body, a list's box), whose top
 * is the first row's top; the spacers go before and after the rows, in that same element.
 */

export interface WindowOptions<R> {
  keyOf: (row: R) => string | number;
  /** Rows of one shape are one height: a call with a result line, a turn with tools. */
  shapeOf: (row: R) => string;
  /** A shape's height before a row of it has been drawn. */
  estimate: (shape: string) => number;
  /** Pixels drawn beyond the view, above and below. */
  over?: number;
  /**
   * The box that scrolls the list up and down, when it is neither a run's views pane nor the nearest
   * box that scrolls: a page whose table scrolls sideways in a box of its own (Runs) names its page.
   */
  box?: (list: HTMLElement) => HTMLElement | null;
}

export interface Windowed {
  start: number;
  end: number;
  /** The height of the rows not drawn, above and below. */
  before: number;
  after: number;
  listRef: (el: HTMLElement | null) => void;
  /** Scrolls the view so row `i` shows: centred, or by as little as it takes, with `head` pixels at the box's top covered. */
  show: (i: number, o?: { centre?: boolean; head?: number }) => void;
}

/**
 * The box around `el` that scrolls up and down: a run's views pane, else the nearest that can. A box
 * that scrolls only sideways (a wide table's) reads as scrolling both ways, so the pane comes first.
 */
function scrollBox(el: HTMLElement): HTMLElement | null {
  const pane = el.closest<HTMLElement>('.vbody');
  if (pane) return pane;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return null;
}

/** Where the list's first row is in the box's own coordinates. */
const listTop = (box: HTMLElement, list: HTMLElement) => list.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;

export function useWindow<R>(rows: readonly R[], o: WindowOptions<R>): Windowed {
  const opts = useLatest(o);
  const list = useRef<HTMLElement | null>(null);
  const box = useRef<HTMLElement | null>(null);
  const measured = useRef(new Map<string | number, number>());
  const byShape = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const [view, setView] = useState<{ top: number; height: number } | null>(null);
  const offsets = useMemo(
    () =>
      rowOffsets(rows.length, (i) => {
        const { keyOf, shapeOf, estimate } = opts.current;
        const r = rows[i]!;
        const shape = shapeOf(r);
        return measured.current.get(keyOf(r)) ?? byShape.current.get(shape) ?? estimate(shape);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` moves when a row drawn turned out another height, which `measured` holds
    [rows, version, opts],
  );
  const offsetsNow = useLatest(offsets);
  const rowsNow = useLatest(rows);
  // The row asked to show (`show`), kept until the heights it was placed by have settled: rows are
  // placed by estimates until one of each shape has been drawn. A scroll of the reader's own lets go of it.
  const wanted = useRef<{ key: string | number; centre: boolean; head: number } | null>(null);
  const placedAt = useRef<number | null>(null);

  const read = useCallback(() => {
    const b = box.current;
    const l = list.current;
    if (!b || !l) return;
    const top = b.scrollTop - listTop(b, l);
    const height = b.clientHeight;
    setView((v) => (v && Math.abs(v.top - top) < 1 && v.height === height ? v : { top, height }));
  }, []);

  // Follows the box's scrolling and size, a frame at a time.
  const detach = useRef<(() => void) | null>(null);
  const listRef = useCallback(
    (el: HTMLElement | null) => {
      if (el === list.current) return;
      detach.current?.();
      detach.current = null;
      list.current = el;
      box.current = el ? (opts.current.box ? opts.current.box(el) : scrollBox(el)) : null;
      const b = box.current;
      if (!b) return;
      let frame = 0;
      const soon = () => {
        // Scrolled from where the view was put: the reader's own scroll.
        if (placedAt.current !== null && Math.abs(b.scrollTop - placedAt.current) > 2) {
          wanted.current = null;
          placedAt.current = null;
        }
        if (!frame) frame = requestAnimationFrame(() => ((frame = 0), read()));
      };
      b.addEventListener('scroll', soon, { passive: true });
      const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null;
      sized?.observe(b);
      detach.current = () => {
        b.removeEventListener('scroll', soon);
        sized?.disconnect();
        if (frame) cancelAnimationFrame(frame);
      };
      read();
    },
    [read, opts],
  );

  // After each draw: the rows drawn are measured, and a height that differs from the one assumed moves the rows after it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- after each draw, as the rows drawn change with every scroll; only a height that differs moves `version`
  useLayoutEffect(() => {
    const l = list.current;
    if (!l) return;
    const { keyOf, shapeOf } = opts.current;
    let changed = false;
    // The rows drawn: the list's own children that carry their index.
    for (const el of Array.from(l.children) as HTMLElement[]) {
      const wi = el.getAttribute('data-wi');
      if (wi === null) continue;
      const r = rows[Number(wi)];
      if (r === undefined) continue;
      const h = el.getBoundingClientRect().height;
      if (!h) continue;
      const k = keyOf(r);
      if (measured.current.get(k) !== h) {
        measured.current.set(k, h);
        changed = true;
      }
      // The first row drawn of a shape stands for the others not drawn yet.
      const shape = shapeOf(r);
      if (!byShape.current.has(shape)) {
        byShape.current.set(shape, h);
        changed = true;
      }
    }
    if (changed) setVersion((n) => n + 1);
    // The heights drawn match those assumed: the row asked for is placed for good once it is where it should be.
    else if (wanted.current && !place()) wanted.current = null;
  });

  /** Scrolls the box to the row asked for; false when it is where it should be already (or gone). */
  const place = useCallback((): boolean => {
    const w = wanted.current;
    const b = box.current;
    const l = list.current;
    if (!w || !b || !l) return false;
    const { keyOf } = opts.current;
    const i = rowsNow.current.findIndex((r) => keyOf(r) === w.key);
    const at = offsetsNow.current;
    if (i < 0 || i >= at.length - 1) return false;
    const to = scrollFor(listTop(b, l) + at[i]!, at[i + 1]! - at[i]!, b.scrollTop, b.clientHeight, w.head, w.centre);
    if (to === null || Math.abs(to - b.scrollTop) < 1) return false;
    b.scrollTop = to;
    placedAt.current = b.scrollTop;
    return true;
  }, [opts, rowsNow, offsetsNow]);

  const show = useCallback(
    (i: number, s: { centre?: boolean; head?: number } = {}) => {
      const r = rowsNow.current[i];
      if (r === undefined) return;
      wanted.current = { key: opts.current.keyOf(r), centre: !!s.centre, head: s.head ?? 0 };
      if (!place()) wanted.current = null;
    },
    [opts, rowsNow, place],
  );

  const { start, end } = view ? windowRange(offsets, view.top, view.height, o.over ?? 600) : { start: 0, end: Math.min(rows.length, FIRST_ROWS) };
  const total = offsets[rows.length]!;
  return { start, end, before: offsets[start] ?? 0, after: total - (offsets[end] ?? total), listRef, show };
}
