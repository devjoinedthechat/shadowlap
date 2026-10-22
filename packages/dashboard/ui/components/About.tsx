import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { aboutHtml, fitAbouts, forgetWidths } from '../about.js';
import { useLatest } from '../hooks.js';
import type { RunAbout } from '../types.js';

/**
 * A run's about line and a fitted hint, as every place that names a run draws them (decision 10:
 * the id is the run's name, the about line one quiet line under or beside it), and the hook that
 * fits them to their room once laid out (about.ts).
 */

/**
 * A run's about line on one line, fitted at whole words to the room it gets; its hover has all of
 * it. Nothing for a run without one (an older server's). The line's text is the fitter's: React
 * writes it whole when it changes, and `useFitAbouts` fits it after each render.
 */
export function AboutLine({ about, className, mark, title }: { about: Pick<RunAbout, 'text' | 'from'> | null | undefined; className?: string; mark?: string | null; title?: string }) {
  if (!about?.text) return null;
  return (
    <span
      className={`rab${className ? ` ${className}` : ''}`}
      data-about={about.text}
      data-from={about.from}
      {...(mark ? { 'data-mark': mark } : {})}
      title={title ?? about.text}
      dangerouslySetInnerHTML={{ __html: aboutHtml(about.text) }}
    />
  );
}

/** A hint that holds a command or ids, fitted by cutting it only at its end after a whole word (or to `short`). */
export function FitHint({ text, short, className, mark }: { text: string; short?: string | null; className?: string; mark?: string | null }) {
  return (
    <span
      className={`rab${className ? ` ${className}` : ''}`}
      data-fit={text}
      {...(short ? { 'data-short': short } : {})}
      {...(mark ? { 'data-mark': mark } : {})}
      title={text}
      dangerouslySetInnerHTML={{ __html: aboutHtml(text) }}
    />
  );
}

/**
 * Fits the about lines and hints inside `ref` after every render, again whenever its width changes
 * (the window, the sidebar becoming a drawer), and once the web fonts load, which can be wider than
 * the fallback the first fit measured.
 */
export function useFitAbouts(ref: RefObject<HTMLElement | null>, before?: (scope: HTMLElement) => void): void {
  // What the place does first (Runs measures which columns keep their room), read when a fit runs.
  const first = useLatest(before);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    first.current?.(el);
    fitAbouts(el);
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!alive || !ref.current) return;
        first.current?.(ref.current);
        fitAbouts(ref.current);
      });
    };
    let width = el.getBoundingClientRect().width;
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            const w = el.getBoundingClientRect().width;
            if (Math.abs(w - width) < 0.5) return;
            width = w;
            refit();
          });
    ro?.observe(el);
    // The window's own resize too: a table column's room can change while its panel keeps its width.
    addEventListener('resize', refit);
    void document.fonts?.ready.then(() => {
      if (!alive) return;
      forgetWidths();
      refit();
    });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      ro?.disconnect();
      removeEventListener('resize', refit);
    };
  }, [ref, first]);
}
