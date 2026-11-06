import { useEffect, type RefObject } from 'react';
import { fitAbouts, textWidth } from '../about.js';
import { tipText } from '../components/HoverCard.js';
import { overlayOpen } from '../overlays/modal-store.js';

/**
 * The run header's fitting, as the mock's fitHead does it: the eyebrow over the id at the left, the
 * buttons at the right, and under the id the about line with the facts at its right. The buttons go
 * under it all, the next step first (`.stack`), when they don't fit beside the title, and below
 * 1280px always, so runs side by side keep one shape. From 1280px the secondary buttons fold into …
 * first, one at a time, the least needed first, so the next step keeps its place at the right. The
 * about line is what tells runs apart, so it keeps its room beside the facts: half the row while the
 * buttons sit at the top (its whole width where that is less), its whole width once they go under it
 * all; where it can't, the facts go under it, from the left (`.fstack`). The meta card sits under
 * the title. It runs as `useFitAbouts`' first step, before the about lines are fitted to the room it
 * leaves them.
 */

/** What folds into …, in order: each button's `data-fold`. A lime one, the next step, never folds. */
export const FOLDS = ['replay', 'pack', 'editor', 'compare', 'push', 'blame'] as const;

/** From this width the buttons may sit beside the title; below it they go under it all. */
const WIDE = 1280;

const below = (a: HTMLElement, t: HTMLElement) => a.offsetTop > t.offsetTop + 2;

export function fitHead(h: HTMLElement): void {
  // Only a page in a window can be measured: a test's document has none, and nothing folds there.
  if (typeof innerWidth !== 'number' || typeof getComputedStyle !== 'function') return;
  const a = h.querySelector<HTMLElement>(':scope > .actions');
  const t = h.querySelector<HTMLElement>(':scope > .rtitle');
  if (!a || !t) return;
  const ab = h.querySelector<HTMLElement>(':scope > .rabout');
  h.classList.remove('stack', 'fstack');
  const unfold = () => a.querySelectorAll('[data-folded]').forEach((b) => b.removeAttribute('data-folded'));
  unfold();
  if (innerWidth >= WIDE && below(a, t)) {
    FOLDS.some((name) => {
      const b = a.querySelector<HTMLElement>(`[data-fold="${name}"]`);
      if (!b || b.classList.contains('lime')) return false;
      b.setAttribute('data-folded', '');
      return !below(a, t);
    });
  }
  if (innerWidth < WIDE || below(a, t)) {
    unfold();
    h.classList.add('stack');
  }
  a.querySelector('#moreBtn')?.setAttribute('data-tip', tipText(moreCard(a)));
  if (ab) roomForAbout(h, ab);
  const m = h.querySelector<HTMLElement>(':scope > .metrics');
  if (m && ab && m.offsetTop > ab.offsetTop + 2) h.classList.add('fstack');
  watchAbout(ab);
  balanceRow(a);
  const card = h.querySelector<HTMLElement>(':scope > .meta');
  if (card && getComputedStyle(card).position === 'absolute') {
    card.style.left = `${t.offsetLeft}px`;
    card.style.top = `${t.offsetTop + t.offsetHeight + 8}px`;
  }
}

/** …'s card: what it holds, the folded buttons by their words, then Delete. */
export const moreCard = (actions: ParentNode): string => `More: ${[...foldedIn(actions).map((b) => wordsOf(b)), 'Delete'].join(', ')}`;

const foldedIn = (actions: ParentNode): HTMLElement[] => [...actions.querySelectorAll<HTMLElement>('[data-folded]')];
const wordsOf = (b: HTMLElement) => (b.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * The room the about line asks for beside the facts: its whole width, labels included, measured whole
 * whatever form of it shows; with the buttons at the top, no more than half the row.
 */
function roomForAbout(h: HTMLElement, ab: HTMLElement): void {
  const cs = getComputedStyle(h);
  const room = h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  ab.style.flex = '0 0 max-content';
  let whole = ab.offsetWidth;
  const rab = ab.querySelector<HTMLElement>('.rab');
  if (rab) whole += Math.max(0, textWidth(getComputedStyle(rab).font, rab.title) - rab.offsetWidth);
  ab.style.flex = '';
  ab.style.flexBasis = `${Math.ceil(h.classList.contains('stack') ? whole : Math.min(whole, room / 2))}px`;
}

/**
 * The about line is fitted to the box that holds it once everything beside it has its width: when
 * that box narrows later (a label's field opening, a label added or taken off, a font), the line is
 * fitted again, alone. One header shows at a time, so one box is watched.
 */
let watched: HTMLElement | null = null;
let watcher: ResizeObserver | null = null;
function watchAbout(ab: HTMLElement | null): void {
  if (ab === watched || typeof ResizeObserver === 'undefined') return;
  watcher ??= new ResizeObserver(() =>
    requestAnimationFrame(() => {
      const h = watched?.isConnected ? watched.closest<HTMLElement>('.rhead') : null;
      if (h) fitAbouts(h);
    }),
  );
  if (watched) watcher.unobserve(watched);
  watched = ab;
  if (ab) watcher.observe(ab);
}

/**
 * A row of buttons that wraps leaves none alone on its last row: it narrows, as balanced text does,
 * while its rows stay as many. Rows are told by where the items stand, an item that starts below the
 * row's foot beginning the next (items of a row may differ in height).
 */
export function balanceRow(el: HTMLElement): void {
  el.style.maxWidth = '';
  const kids = [...el.children].filter((k): k is HTMLElement => k instanceof HTMLElement && k.getClientRects().length > 0);
  const rows = () => {
    let n = 0;
    let foot = -Infinity;
    kids
      .map((k) => [k.offsetTop, k.offsetTop + k.offsetHeight] as const)
      .sort((x, y) => x[0] - y[0])
      .forEach(([top, bottom]) => {
        if (top >= foot - 1) {
          n++;
          foot = bottom;
        } else foot = Math.max(foot, bottom);
      });
    return n;
  };
  const n = rows();
  if (n < 2) return;
  let lo = 0;
  let hi = el.clientWidth;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    el.style.maxWidth = `${mid}px`;
    if (rows() > n) lo = mid;
    else hi = mid;
  }
  el.style.maxWidth = `${Math.ceil(hi)}px`;
}

/** A button the header folded into …, as its menu shows it: its words, card and way, and a press of the hidden button itself. */
export interface MoreRow {
  key: string;
  label: string;
  tip: string | null;
  href: string | null;
  /** Why it waits: its own `data-why`, or an off button's title. */
  why: string | null;
  /** An off button: a press says why rather than pressing it. */
  off: boolean;
  press: () => void;
}

/** The folded buttons, read when the menu opens: one code path, so each button's own dialog and wait still work. */
export function moreRows(actions: ParentNode | null): MoreRow[] {
  if (!actions) return [];
  return foldedIn(actions).map((b) => {
    const off = b instanceof HTMLButtonElement && b.disabled;
    return {
      key: b.dataset.fold ?? wordsOf(b),
      label: wordsOf(b),
      tip: b.getAttribute('data-tip'),
      href: b instanceof HTMLAnchorElement ? b.getAttribute('href') : null,
      why: b.getAttribute('data-why') ?? (off && b.title ? b.title : null),
      off,
      press: () => b.click(),
    };
  });
}

/**
 * The meta card shows for the id's focus only when Tab brought it there, not when the page put the
 * focus on its heading (after Enter on a link, say, which another key than Tab marks); Esc hides it,
 * until the pointer leaves the id or the focus moves on, and goes no further.
 */
export function useMetaCard(head: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (typeof innerWidth !== 'number' || typeof document === 'undefined') return;
    let tabbedAt = 0;
    const isId = (el: EventTarget | null): el is HTMLElement => el instanceof HTMLElement && el.matches('h1.rnm') && !!head.current?.contains(el);
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Tab') tabbedAt = Date.now();
      else if (e.key !== 'Shift') tabbedAt = 0;
      const h = head.current;
      const card = h?.querySelector<HTMLElement>(':scope > .meta');
      if (e.key !== 'Escape' || !h || !card || overlayOpen()) return;
      const cs = getComputedStyle(card);
      if (cs.position !== 'absolute' || cs.visibility !== 'visible') return;
      e.preventDefault();
      e.stopPropagation();
      h.classList.remove('metaon');
      h.classList.add('metaoff');
    };
    const focusIn = (e: FocusEvent) => {
      if (isId(e.target) && Date.now() - tabbedAt < 500) head.current?.classList.add('metaon');
    };
    const focusOut = (e: FocusEvent) => {
      if (isId(e.target)) head.current?.classList.remove('metaon', 'metaoff');
    };
    const mouseOut = (e: MouseEvent) => {
      const id = e.target instanceof Element ? e.target.closest('h1.rnm') : null;
      if (id && head.current?.contains(id) && !(e.relatedTarget instanceof Node && id.contains(e.relatedTarget))) head.current.classList.remove('metaoff');
    };
    document.addEventListener('keydown', keys, true);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    document.addEventListener('mouseout', mouseOut);
    return () => {
      document.removeEventListener('keydown', keys, true);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
      document.removeEventListener('mouseout', mouseOut);
    };
  }, [head]);
}
