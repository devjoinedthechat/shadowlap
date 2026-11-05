import { useEffect, type RefObject } from 'react';
import { menuSheetRect } from './overlays/menu-store.js';
import { modalOpen, topModalRoot } from './overlays/modal-store.js';

/**
 * Where a toast goes. Centred on the content, over what sits at the content's foot: the status bar,
 * the job's drawer, the bulk bar and a hidden job's pill, each stacked over the one before, none of
 * them while a dialog's scrim covers them. And over what stays open at the window's foot while it
 * shows, so it never covers what you would press next there: a phone's menu sheet, and the footer of
 * a dialog tall enough to reach its place, with that dialog's price line where it holds the body's
 * foot. A toast that shows is placed again whenever any of those comes, goes or changes size.
 */

/** Wider than this, the content sits beside the sidebar and the status bar is fixed at the foot. */
const WIDE = 1000;
const STATUS_BAR = 28;
const GAP = 14;

/** The foot of the stack, in px from the window's bottom, for a toast `h` tall. */
export function stackTop(h = 0): number {
  const high = window.innerHeight;
  let top = window.innerWidth > WIDE ? STATUS_BAR : 0;
  if (!modalOpen()) {
    for (const selector of ['#dock .drawer', '.bulkbar', '.jobchip']) {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el || !el.getClientRects().length || getComputedStyle(el).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > high - 200) top = Math.max(top, high - r.top);
    }
  }
  const sheet = menuSheetRect();
  if (sheet) top = Math.max(top, high - sheet.top);
  const modal = topModalRoot();
  const footer = modal?.querySelector<HTMLElement>('.dialog > footer, .help > footer');
  const fr = footer?.getClientRects().length ? footer.getBoundingClientRect() : null;
  if (!modal || !fr || fr.bottom <= high - top - GAP - h) return top;
  top = Math.max(top, high - fr.top);
  // And over its price line, where that holds the body's foot (stuck there, or last at rest), so the price stays in view too.
  const body = modal.querySelector<HTMLElement>('.dialog > .db');
  const cost = body ? [...body.querySelectorAll<HTMLElement>('.dcost:not(.flow)')].filter((x) => x.getClientRects().length && !x.closest('[hidden]')).at(-1) : null;
  const cr = cost?.getBoundingClientRect();
  const br = body?.getBoundingClientRect();
  if (cr && br && cr.bottom >= br.bottom - 2 && cr.top < br.bottom) top = Math.max(top, high - Math.max(cr.top, br.top));
  return top;
}

const pen = (): CanvasRenderingContext2D | null => document.createElement('canvas').getContext('2d');

/**
 * A toast's button sits beside its words while they keep to two lines there. Where it would leave
 * them more, or where a wide one (a job's way on, a quarter of the toast or more) would push them onto
 * a second line, it goes under them at their left edge, below 1000px.
 */
function toastFit(el: HTMLElement): void {
  el.classList.remove('stack');
  const button = el.querySelector<HTMLElement>('.tbtn');
  const words = el.querySelector<HTMLElement>('span');
  if (!button || !words || window.innerWidth > WIDE) return;
  const ctx = pen();
  if (!ctx) return;
  const cs = getComputedStyle(el);
  const room = window.innerWidth - 32 - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 18;
  const wide = button.getBoundingClientRect().width;
  const beside = room - 10 - wide;
  ctx.font = getComputedStyle(words).font;
  const w = ctx.measureText(words.textContent ?? '').width;
  if (w > beside * 2 * 0.9 || (wide >= room / 4 && w > beside)) el.classList.add('stack');
}

/** Places a toast. */
export function placeToast(el: HTMLElement): void {
  if (window.innerWidth === undefined) return;
  toastFit(el);
  const view = document.querySelector('#view')?.getBoundingClientRect();
  const centre = window.innerWidth > WIDE && view ? view.left + view.width / 2 : window.innerWidth / 2;
  el.style.setProperty('left', `${Math.round(centre)}px`);
  el.style.setProperty('bottom', `${stackTop(el.offsetHeight) + GAP}px`);
}

/** Places the toast that shows again: what sits under it changed. */
export function retoast(): void {
  const t = document.querySelector<HTMLElement>('.toast');
  if (t) placeToast(t);
}

/** For what sits at the content's foot: the toast is placed again as it comes, goes or changes size. */
export function useRetoast(el: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    retoast();
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(retoast) : null;
    if (el.current) watch?.observe(el.current);
    return () => {
      watch?.disconnect();
      retoast();
    };
  }, [el]);
}
