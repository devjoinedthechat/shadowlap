import { useEffect, useLayoutEffect } from 'react';
import { useLatest } from '../hooks.js';

/**
 * Where each view of Runs was left, by its address, so Back, the crumbs and the nav's Runs land on
 * its list where it was: kept as a view is left (a commit, Back or Forward, a link, the page going)
 * and given back once its rows are in, then once more after a tick. The scroller is the page when it
 * scrolls, else the window, as on a phone, where the page grows with what it holds.
 */
const left = new Map<string, number>();

function pageScroller(): HTMLElement | null {
  const pg = document.querySelector<HTMLElement>('#view .page');
  if (!pg || typeof getComputedStyle !== 'function') return null;
  return /(auto|scroll)/.test(getComputedStyle(pg).overflowY) && pg.scrollHeight > pg.clientHeight + 1 ? pg : null;
}

const scrolled = (): number => pageScroller()?.scrollTop ?? window.scrollY ?? 0;

function scrollBack(y: number): void {
  const pg = pageScroller();
  if (pg) pg.scrollTop = y;
  else window.scrollTo?.(0, y);
}

/** Notes where the view `href` is scrolled to, as it is left. */
export function keepScroll(href: string): void {
  left.set(href, scrolled());
}

/** A view committed to starts where the page is, not where it was left before. */
export function forgetScroll(href: string): void {
  left.delete(href);
}

/** Runs showing `href`: kept as it is left, and where it was left given back once `ready` (its rows are in). */
export function useKeptScroll(href: string, ready: boolean): void {
  const at = useLatest(href);
  useEffect(() => {
    // The address has moved (Back, Forward, a link, a commit), the page not yet: `at` is the view left.
    const on = () => keepScroll(at.current);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [at]);
  // The page going, by a row, a link or the nav: still drawn as it was.
  useLayoutEffect(() => () => keepScroll(at.current), [at]);
  useEffect(() => {
    const y = ready ? left.get(href) : undefined;
    if (y === undefined) return;
    left.delete(href);
    scrollBack(y);
    const t = setTimeout(() => scrollBack(y), 0);
    return () => clearTimeout(t);
  }, [href, ready]);
}
