import { addressNow, coarsePointer } from '../dom.js';
import { trapTab } from '../focus.js';
import { focusBack, openerOf, tabbables, type Opener } from './focus-back.js';
import { closeMenu, menuKeys, menuOpen, onMenuChange, shownMenu } from './menu-store.js';

/**
 * The modals open (a dialog, the palette, the shortcuts), in the layer slot, the last on top. Opening
 * one closes a menu. While one is open the app behind it is inert (the job's dock and the connection
 * bar too), Tab and Shift-Tab go round its controls, and Esc asks it to close; the focus goes back
 * to what opened it however it closes, but when the page it opened on has gone (`closeLeftBehind`).
 * No React here: components/Dialog.tsx's `Modal` opens and closes it as it mounts and unmounts.
 */

export interface OpenModal {
  root: () => HTMLElement | null;
  /** Esc: it closes, or asks first about what was changed. */
  requestClose: () => void;
  /** The page it opened on has gone: it closes without asking. */
  close: () => void;
  /** What opened it, then what opened the modal it was opened from, which may go with it. */
  openers: readonly Opener[];
}

/** A modal on the stack: the address it opened on, and whether it closes because that page has gone. */
type Stacked = OpenModal & { page: string; left: boolean };

const stack: Stacked[] = [];

export const modalOpen = (): boolean => stack.length > 0;
const topModal = (): OpenModal | null => stack.at(-1) ?? null;

const listeners = new Set<() => void>();

function tell(): void {
  for (const fn of [...listeners]) fn();
}

/** Calls `fn` whenever a menu or a modal opens or closes, until the function it returns is called: what sits at the window's foot places itself again. */
export function onOverlayChange(fn: () => void): () => void {
  listeners.add(fn);
  const stop = onMenuChange(fn);
  return () => {
    listeners.delete(fn);
    stop();
  };
}

/**
 * What takes the focus back when a modal closes, read as it is about to open: a menu's item stands
 * for the menu's button. A modal's control is itself while that modal stays, and its opener once it
 * has gone: what goes with an overlay has no counterpart on the page.
 */
export function openersNow(): readonly Opener[] {
  if (typeof document === 'undefined') return [];
  const a = document.activeElement as HTMLElement | null;
  const menu = shownMenu();
  if (menu && a && menu.root.contains(a)) return [menu.opener];
  const top = topModal();
  if (a && top?.root()?.contains(a)) return [{ el: a, key: null }, ...top.openers];
  return a && a !== document.body ? [openerOf(a)] : [];
}

const BEHIND = '#app, #conn, #dock, a.skip';
/** An ended session's card is over everything, what is open over the page too. */
const BEHIND_ALL = `${BEHIND}, #menu, #layer`;

/** What each reason keeps out of reach: counted, so one ending leaves another's. */
const holds = new Map<string, number>();

function setInert(selector: string, on: boolean): void {
  for (const el of document.querySelectorAll(selector)) {
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }
}

/** Makes the app behind out of reach, until the function it returns is called; `all`: what is open over it too. */
export function holdBehind(all = false): () => void {
  const selector = all ? BEHIND_ALL : BEHIND;
  holds.set(selector, (holds.get(selector) ?? 0) + 1);
  setInert(selector, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds.set(selector, holds.get(selector)! - 1);
    setInert(selector, false);
    // What another reason still holds stays out of reach.
    for (const [held, n] of holds) if (n > 0) setInert(held, true);
  };
}

/** A modal under another is out of reach too, until it is on top again. */
function setUnder(m: OpenModal | null, on: boolean): void {
  const el = m?.root();
  if (!el) return;
  if (on) el.setAttribute('inert', '');
  else el.removeAttribute('inert');
}

/** A modal has opened: a menu closes, handing nothing back, as the modal takes the focus. */
export function modalOpened(m: OpenModal): () => void {
  closeMenu(false);
  setUnder(topModal(), true);
  const stacked: Stacked = { ...m, page: addressNow(), left: false };
  stack.push(stacked);
  const release = holdBehind();
  tell();
  return () => {
    const at = stack.indexOf(stacked);
    const wasTop = at === stack.length - 1;
    if (at >= 0) stack.splice(at, 1);
    release();
    if (wasTop) {
      setUnder(topModal(), false);
      handBack(stacked);
    }
    tell();
  };
}

/** Where the focus goes as the top modal closes: to what opened it, or, with its page gone, to the page drawn in its place unless something there took it. */
function handBack(m: Stacked): void {
  if (!m.left) return focusBack(...m.openers);
  const a = document.activeElement;
  if (!a || a === document.body || !a.isConnected) focusBack();
}

/**
 * The address has moved on (Back, a link, a key that goes to a page): what is open over the page it
 * left closes with that page, without asking, and the focus goes to the page drawn in its place, not
 * back to what opened it. What opened since the address was written stays: a dialog the palette asks
 * for along with its page. A replace (a call or a view picked) is no new page: the router doesn't ask.
 */
export function closeLeftBehind(): void {
  const page = addressNow();
  const menu = shownMenu();
  if (menu && menu.page !== page) closeMenu(false);
  for (const m of [...stack].reverse()) {
    if (m.page === page) continue;
    m.left = true;
    m.close();
  }
}

/** The keys while a modal is open, before anything on the page hears them: Esc asks it to close, Tab stays in it. Its fields keep every other key. */
function modalKeys(e: KeyboardEvent): void {
  const top = topModal()!;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    top.requestClose();
    return;
  }
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
  const root = top.root();
  if (!root) return;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const to = trapTab(tabbables(root), active && root.contains(active) ? active : null, e.shiftKey);
  if (to === null) return;
  e.preventDefault();
  if (to === 'self') {
    if (!root.hasAttribute('tabindex')) root.tabIndex = -1;
    root.focus();
  } else to.focus();
}

/** When a key last pressed what opens a picker: its filter takes the focus then, a touch screen included. */
let pressedAt = 0;
const PRESSED_MS = 600;

/** Whether a picker opening now was opened from a key, or with no finger on the page. */
export const opensOnField = (): boolean => !coarsePointer() || Date.now() - pressedAt < PRESSED_MS;

/** Set as ↑ opens a menu: it starts on its last item. */
let startLast = false;
export function takeStartLast(): boolean {
  const last = startLast;
  startLast = false;
  return last;
}

/**
 * The overlays' keys, in the capture phase, before any of the page's: ↓ or ↑ on a menu's button opens
 * it; then the open menu's keys, else the top modal's. A toast's button keeps its own.
 */
export function overlayKeys(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') pressedAt = Date.now();
  const t = e.target as HTMLElement | null;
  if (!menuOpen() && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.metaKey && !e.ctrlKey && t?.matches?.('[aria-haspopup="menu"], [aria-haspopup="listbox"]') && !(t as HTMLButtonElement).disabled) {
    e.preventDefault();
    e.stopPropagation();
    startLast = e.key === 'ArrowUp';
    t.click();
    return;
  }
  if (t?.closest?.('.toast')) return;
  if (menuOpen()) menuKeys(e);
  else if (modalOpen()) modalKeys(e);
}

/** Whether a menu or a modal is open: the page's own keys wait until it closes. */
export const overlayOpen = (): boolean => menuOpen() || modalOpen();
