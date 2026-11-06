import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { dragEnd, dragOver, dragStart, keyPick, moveDay, shownRange, type Drag } from './calendar-model.js';

/**
 * Picking days from the twelve weeks, the calendar's grid and the slim row of days alike: click a
 * day (or a bar), drag across several, Shift-click to extend; the arrow keys move as `steps` says,
 * Enter or Space picks, Shift+Enter extends, Escape clears. A bar that holds a week says its last
 * day in `data-to`, so it picks its seven days.
 */
export interface DayPicks {
  /** The element holding the days, for the pointer and the keys. */
  box: RefObject<HTMLDivElement | null>;
  /** The days shown picked: the drag's while it goes, else the range. */
  shown: [number, number] | null;
  /** The day that takes the focus when Tab comes in (roving tabindex). */
  focusDay: number;
  setFocus: (day: number) => void;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

/** The first day an element holds, and its last: a week's on a phone's row of days. */
function daysOf(el: Element): [number, number] {
  const day = Number(el.getAttribute('data-day'));
  const to = el.getAttribute('data-to');
  return [day, to !== null ? Number(to) : day];
}

export function useDayPicks({ count, range, onPick, steps }: { count: number; range: [number, number] | null; onPick: (range: [number, number] | null) => void; steps: Readonly<Record<string, number>> }): DayPicks {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // A drag ends wherever the pointer is let go, on the days or not. The day it ended on takes the
  // focus, so Escape undoes the pick and the arrow keys go on from there. The pointer focused the day
  // it went down on, so the browser shows no ring for either (the days can't be text-selected, so a
  // drag selects nothing); an arrow key brings the ring back. A browser whose buttons take no focus
  // from a click (Safari, Firefox on a Mac) is asked for no ring instead (`focusVisible`).
  useEffect(() => {
    if (!drag) return;
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      onPick(dragEnd(d));
      setFocus(d.b);
      box.current?.querySelector<HTMLElement>(`[data-day="${d.b}"]`)?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    };
    const cancel = () => {
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [drag, onPick]);

  const dayAt = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el instanceof Element ? el.closest<HTMLElement>('[data-day]') : null;
    return cell && box.current?.contains(cell) ? daysOf(cell) : null;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const at = dayAt(e);
    if (!at) return;
    const d = dragStart(at[0], range, e.shiftKey, at[1]);
    dragRef.current = d;
    setDrag(d);
    setFocus(at[0]);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const cur = dragRef.current;
    if (!cur) return;
    const at = dayAt(e);
    if (!at) return;
    const next = dragOver(cur, at[0], at[1]);
    if (next !== cur) {
      dragRef.current = next;
      setDrag(next);
    }
  };
  const focusOn = (day: number) => {
    setFocus(day);
    box.current?.querySelector<HTMLElement>(`[data-day="${day}"]`)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-day]') : null;
    if (!t) return;
    const [day, to] = daysOf(t);
    const next = moveDay(day, e.key, count, steps);
    if (next !== null) focusOn(next);
    else if (e.key === 'Enter' || e.key === ' ') onPick(keyPick(day, range, e.shiftKey, to));
    else if (e.key === 'Escape' && range) onPick(null);
    else if (e.key in steps) {
      // At the edge: nothing further to move to, but the page does not scroll either.
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return { box, shown: shownRange(drag, range), focusDay: focus ?? (range ? range[0] : count - 1), setFocus, onPointerDown, onPointerMove, onKeyDown };
}
