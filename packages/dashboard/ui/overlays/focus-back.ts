/**
 * Where the focus goes as an overlay opens and closes, in the page as it stands: what Tab stops at,
 * which of a dialog's elements takes it first (`dialogFocus` in focus.ts says by what rule), and how
 * what opened an overlay is found again once it closes. Nothing here runs at import time.
 */

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]';

/** Whether an element shows and can be reached: laid out, not hidden by its visibility, and not behind a modal. */
function reachable(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0 || el.closest('[inert]')) return false;
  return typeof getComputedStyle !== 'function' || getComputedStyle(el).visibility !== 'hidden';
}

/** What Tab stops at inside an element, in order: a control or a stop, enabled, shown and in reach. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest('[hidden]') && reachable(el));
}

/**
 * The element a dialog's focus starts on: its drop zone, where it asks for a file (Import capture),
 * else the first that `selector` (`dialogFocus`) finds that shows and is enabled: a field a choice
 * hides never takes it. A dialog that only shows something starts on its Close; one whose way on
 * waits for something, on the first thing in it that takes it; with nothing, on itself.
 */
export function firstFocus(root: HTMLElement, selector: string): HTMLElement {
  const takes = (el: HTMLElement) => !(el as HTMLButtonElement).disabled && reachable(el);
  const drop = selector === '.dlg-cancel' ? null : root.querySelector<HTMLElement>('.drop[tabindex]');
  if (drop && takes(drop)) return drop;
  const found = [...root.querySelectorAll<HTMLElement>(selector)].find(takes);
  if (found) return found;
  const close = root.querySelector('.dlg-ok') ? null : root.querySelector<HTMLElement>('.dlg-cancel');
  return (close && takes(close) ? close : tabbables(root)[0]) ?? root;
}

/** What a control is, to find its counterpart once the page has drawn it anew. */
export interface ControlKey {
  tag: string;
  id: string | null;
  /** Its data attributes, where it leads and its name: what it is, whatever draws it. */
  attrs: ReadonlyArray<readonly [string, string]>;
  text: string;
  /** Which of its likes it was: the third row's × among every row's. */
  nth: number;
}

/** What changes as a control's state does, or says nothing of what it is. */
const FLEETING = /^data-(tip|why|fit|short|mark|about|from)$/;

const attrsOf = (el: Element) =>
  el
    .getAttributeNames()
    .filter((a) => (a.startsWith('data-') && !FLEETING.test(a)) || a === 'href' || a === 'aria-label')
    .map((a) => [a, el.getAttribute(a) ?? ''] as const);

const wordsOf = (el: Element) => (el.textContent ?? '').trim();

function isLike(el: Element, key: ControlKey): boolean {
  const attrs = attrsOf(el);
  return attrs.length === key.attrs.length && key.attrs.every(([a, v]) => el.getAttribute(a) === v) && wordsOf(el) === key.text;
}

function likes(key: ControlKey): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(key.tag)].filter((el) => isLike(el, key));
}

/** A control's key: its id, else its data attributes, where it leads, its name and its words, and which of its likes it is. Null for one with nothing that tells it from another: a bare field. */
export function controlKey(el: HTMLElement | null): ControlKey | null {
  if (!el?.getAttributeNames) return null;
  const key: ControlKey = { tag: el.tagName.toLowerCase(), id: el.getAttribute('id'), attrs: attrsOf(el), text: wordsOf(el), nth: 0 };
  if (!key.id && !key.attrs.length && !key.text) return null;
  return { ...key, nth: Math.max(0, likes(key).indexOf(el)) };
}

/** The control a key names, as the page stands: by its id, else the same of its likes, else the first. */
export function findControl(key: ControlKey): HTMLElement | null {
  const byId = key.id ? [...document.querySelectorAll<HTMLElement>(key.tag)].find((el) => el.getAttribute('id') === key.id) : undefined;
  if (byId) return reachable(byId) ? byId : null;
  const found = likes(key).filter(reachable);
  return found[key.nth] ?? found[0] ?? null;
}

const focusOn = (el: HTMLElement) => el.focus({ preventScroll: true });

/** How long after an overlay closes a page drawn anew still hands the focus to the opener's counterpart. */
const REDRAWN_MS = 1000;

/** What a close is still watching for: the opener drawn anew just after it. */
let watching: (() => void) | null = null;

/**
 * For a second after a close, a page drawn anew that took the focus with it (or that gave the opener
 * back only now) hands the focus to the opener's counterpart. Focus moved anywhere else stays there.
 */
function watchRedraw(key: ControlKey, fallback: HTMLElement | null): void {
  watching?.();
  watching = null;
  if (typeof MutationObserver !== 'function') return;
  const until = Date.now() + REDRAWN_MS;
  const page = location.hash;
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    if (watching === stop) watching = null;
  };
  const observer = new MutationObserver(() => {
    // Another page drawn is no redraw: what it has is its own.
    if (Date.now() > until || location.hash !== page) return stop();
    const a = document.activeElement;
    if (a && a !== document.body && a !== fallback && a.isConnected) return;
    const el = findControl(key);
    if (!el) return;
    stop();
    focusOn(el);
  });
  const timer = setTimeout(stop, REDRAWN_MS);
  observer.observe(document.body, { childList: true, subtree: true });
  watching = stop;
}

/** What opened an overlay: the element, and how to find it again. */
export interface Opener {
  el: HTMLElement | null;
  key: ControlKey | null;
}

export const openerOf = (el: HTMLElement | null): Opener => ({ el, key: controlKey(el) });

/**
 * Gives the focus back to what opened an overlay, or to the control drawn in its place: the first of
 * `openers` still there (a dialog's opener can have gone with the dialog before it). An opener the
 * phone's closed sidebar hides hands it to the sidebar's button; with none left, to the page.
 */
export function focusBack(...openers: readonly Opener[]): void {
  for (const o of openers) {
    const el = o.el?.isConnected && reachable(o.el) ? o.el : o.key ? findControl(o.key) : null;
    if (!el) continue;
    focusOn(el);
    if (document.activeElement !== el) continue;
    if (o.key) watchRedraw(o.key, null);
    return;
  }
  const first = openers[0];
  if (first?.el?.closest('#side')) {
    const toggle = document.querySelector<HTMLElement>('.menu-toggle');
    if (toggle && reachable(toggle)) return toggle.focus();
  }
  const page = document.querySelector<HTMLElement>('#view');
  if (page) focusOn(page);
  if (first?.key) watchRedraw(first.key, page);
}
