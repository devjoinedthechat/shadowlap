import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { fitAbouts, forgetWidths } from '../about.js';
import { useLatest } from '../hooks.js';
import type { RunAbout } from '../types.js';

/**
 * A run's about line and a fitted hint, as every place that names a run draws them (decision 10:
 * the id is the run's name, the about line one quiet line under or beside it), and the hook that
 * fits them to their room once laid out (about.ts).
 */

/**
 * A run's about line on one line, fitted at whole words to the room it gets; its hover has all of
 * it. Nothing for a run without one (an older server's). React draws the line whole, as one text,
 * and draws it again only when the line changes; `useFitAbouts` fits it after each render.
 */
export function AboutLine({ about, className, mark, title }: { about: Pick<RunAbout, 'text' | 'from'> | null | undefined; className?: string; mark?: string | null; title?: string }) {
  if (!about?.text) return null;
  return (
    <span className={`rab${className ? ` ${className}` : ''}`} data-about={about.text} data-from={about.from} {...(mark ? { 'data-mark': mark } : {})} title={title ?? about.text}>
      {about.text}
    </span>
  );
}

/** A hint that holds a command or ids, fitted by cutting it only at its end after a whole word (or to `short`). */
export function FitHint({ text, short, className, mark }: { text: string; short?: string | null; className?: string; mark?: string | null }) {
  return (
    <span className={`rab${className ? ` ${className}` : ''}`} data-fit={text} {...(short ? { 'data-short': short } : {})} {...(mark ? { 'data-mark': mark } : {})} title={text}>
      {text}
    </span>
  );
}

/**
 * Fits the about lines and hints inside `ref` after every render, again whenever its width changes
 * (the window, the sidebar becoming a drawer), and once the web fonts load, which can be wider than
 * the fallback the first fit measured. `before` runs first each time (Runs measures which of its
 * columns keep their room). An element the component draws only later (after loading) is watched
 * from when it is there.
 */
export function useFitAbouts(ref: RefObject<HTMLElement | null>, before?: (scope: HTMLElement) => void): void {
  const first = useLatest(before);
  const fit = (el: HTMLElement) => {
    first.current?.(el);
    fitAbouts(el);
  };
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  });
  const watched = useRef<{ el: HTMLElement; stop: () => void } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (watched.current?.el === el) return;
    watched.current?.stop();
    watched.current = el ? { el, stop: watch(el, () => ref.current && fit(ref.current)) } : null;
  });
  useEffect(
    () => () => {
      watched.current?.stop();
      watched.current = null;
    },
    [],
  );
}

/** Calls `refit` (once a frame at most) when `el`'s width or the window's changes, and once the web fonts have loaded. */
function watch(el: HTMLElement, refit: () => void): () => void {
  // Nothing to watch where nothing is laid out (a test's document).
  if (typeof el.getBoundingClientRect !== 'function' || typeof requestAnimationFrame !== 'function') return () => undefined;
  let alive = true;
  let frame = 0;
  const soon = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => alive && refit());
  };
  let width = el.getBoundingClientRect().width;
  const ro =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const w = el.getBoundingClientRect().width;
          if (Math.abs(w - width) < 0.5) return;
          width = w;
          soon();
        });
  ro?.observe(el);
  // The window's own resize too: a table column's room can change while its panel keeps its width.
  addEventListener('resize', soon);
  void document.fonts?.ready.then(() => {
    if (!alive) return;
    forgetWidths();
    soon();
  });
  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    ro?.disconnect();
    removeEventListener('resize', soon);
  };
}
