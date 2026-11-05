import { addressNow } from '../dom.js';
import { focusBack, openerOf, type Opener } from './focus-back.js';

/**
 * The one menu open (a menu, a listbox, a picker), in the menu slot. Opening one closes the last, and
 * a modal opening closes it. It remembers what opened it and gives the focus back to it however it
 * closes, unless a click outside landed on another control, which keeps it. While it is open the
 * keys are its own: the page's never fire (`menuKeys`, in the capture phase). No React here:
 * components/Popover.tsx opens and closes it as it mounts and unmounts.
 */

export interface OpenMenu {
  root: HTMLElement;
  anchor: HTMLElement | null;
  /** Asks its owner to close it. */
  close: () => void;
  /** Its own keys, before the menu's (a picker's arrows, a project's Delete): true when one handled the key. */
  keys?: (e: KeyboardEvent) => boolean;
  opener: Opener;
  /** The address it opened on (`closeLeftBehind`). */
  page: string;
  typed: string;
  typedAt: number;
}

let open: OpenMenu | null = null;

export const menuOpen = (): boolean => open !== null;
export const shownMenu = (): OpenMenu | null => open;

/**
 * The open menu's rect where it is a phone's sheet, else null: what stays at the window's foot (a
 * toast) sits over it.
 */
export function menuSheetRect(): DOMRect | null {
  const root = open?.root;
  return root?.classList.contains('sheet') && root.getClientRects().length ? root.getBoundingClientRect() : null;
}

const listeners = new Set<() => void>();

/** Calls `fn` whenever a menu opens or closes, until the function it returns is called. `onOverlayChange` (the modal store) hears modals too. */
export function onMenuChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function tell(): void {
  for (const fn of [...listeners]) fn();
}

/** The items the arrows move through: enabled, and shown. A row's second button (`.px`) is reached from its row, with →. */
export function menuItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="menuitem"]:not(.px), [role="menuitemradio"]')].filter((b) => !(b as HTMLButtonElement).disabled && b.getClientRects().length > 0);
}

/** Moves the focus to an item, or to the item at `n` counted round the ends, in view and without scrolling the page behind it. */
export function focusItem(root: HTMLElement, n: number | HTMLElement): void {
  const items = menuItems(root);
  if (!items.length) return;
  const el = typeof n === 'number' ? items[((n % items.length) + items.length) % items.length]! : n;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}

/** What a typed letter or word finds: the next item it starts, from the one after the focus for a first letter. */
export function typeAhead(labels: readonly string[], typed: string, at: number): number | null {
  const from = typed.length === 1 ? at + 1 : Math.max(0, at);
  for (let n = 0; n < labels.length; n++) {
    const i = (from + n) % labels.length;
    if (labels[i]!.startsWith(typed)) return i;
  }
  return null;
}

/** How long a typed word goes on: longer, and the next letter starts a new one. */
const TYPED_MS = 700;

function moved(m: OpenMenu, e: KeyboardEvent): void {
  const k = e.key;
  const items = menuItems(m.root);
  if (!items.length || e.metaKey || e.ctrlKey || e.altKey) return;
  const cur = document.activeElement as HTMLElement | null;
  const row = cur?.closest?.('.prow') ?? null;
  // On a row's second button, the row is where the arrows go on from.
  const at = items.indexOf(row ? (row.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? (cur as HTMLElement)) : (cur as HTMLElement));
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault();
    focusItem(m.root, at < 0 ? (k === 'ArrowDown' ? 0 : -1) : at + (k === 'ArrowDown' ? 1 : -1));
  } else if (k === 'Home' || k === 'PageUp') {
    e.preventDefault();
    focusItem(m.root, 0);
  } else if (k === 'End' || k === 'PageDown') {
    e.preventDefault();
    focusItem(m.root, -1);
  } else if ((k === 'ArrowRight' || k === 'ArrowLeft') && row) {
    // A row's own second button (a project's remove) sits beside it, to the right.
    const buttons = [...row.querySelectorAll<HTMLElement>('button')];
    const next = buttons[buttons.indexOf(cur as HTMLElement) + (k === 'ArrowRight' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  } else if (k.length === 1 && k !== ' ') {
    e.preventDefault();
    const now = Date.now();
    m.typed = (now - m.typedAt < TYPED_MS ? m.typed : '') + k.toLowerCase();
    m.typedAt = now;
    const labels = items.map((b) => (b.querySelector('b') ?? b).textContent?.trim().toLowerCase() ?? '');
    const found = typeAhead(labels, m.typed, at);
    if (found !== null) focusItem(m.root, items[found]!);
  }
}

/** Closes the menu from a key: `back` gives the focus to what opened it first, as Tab, about to move on from there, needs at once. */
export function closeMenu(back: boolean): void {
  const m = open;
  if (!m) return;
  open = null;
  stopListening();
  if (back) focusBack(m.opener);
  m.close();
  tell();
}

/**
 * The keys while a menu is open, before anything on the page hears them: Esc and Tab close it with
 * the focus back on its button (the browser's Tab goes on from there), ⌘K goes on to the palette, and
 * no other key reaches the page. The arrows move round the ends, Home, End, PageUp and PageDown
 * jump, → reaches a row's second button, and a typed letter finds the next item it starts.
 */
export function menuKeys(e: KeyboardEvent): void {
  const m = open!;
  if ((e.metaKey || e.ctrlKey) && /^k$/i.test(e.key)) {
    closeMenu(true);
    return;
  }
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu(true);
    return;
  }
  if (e.key === 'Tab') {
    closeMenu(true);
    return;
  }
  if (m.keys?.(e) === true) return;
  moved(m, e);
}

/**
 * A click outside closes the menu; its button's own click toggles it, and the scrim of a phone's
 * sheet takes the tap, so it never reaches the page. The focus goes back unless the click put it on
 * another control. In the capture phase, so a control that stops its click still closes the menu.
 */
function clicked(e: MouseEvent): void {
  const m = open;
  const t = e.target as HTMLElement | null;
  if (!m || !t || m.root.contains(t)) return;
  if (t.closest?.('[data-msheet]')) {
    e.stopPropagation();
    closeMenu(true);
    return;
  }
  if (m.anchor?.contains(t)) return;
  const a = document.activeElement;
  closeMenu(!a || a === document.body || !a.isConnected);
}

function stopListening(): void {
  document.removeEventListener('click', clicked, true);
}

/** A menu has opened: the one before it closes, handing nothing back, as the new one has the focus. */
export function menuOpened(m: Omit<OpenMenu, 'opener' | 'page' | 'typed' | 'typedAt'>): OpenMenu {
  closeMenu(false);
  const opened: OpenMenu = { ...m, opener: openerOf(m.anchor), page: addressNow(), typed: '', typedAt: 0 };
  open = opened;
  document.addEventListener('click', clicked, true);
  tell();
  return opened;
}

/**
 * A menu's owner took it away (a pick, the opener toggled, its page gone), its element still in the
 * page: the focus, if it was in the menu or nowhere, goes back to what opened it.
 */
export function menuClosed(m: OpenMenu): void {
  if (open !== m) return;
  open = null;
  stopListening();
  const a = document.activeElement;
  if (!a || a === document.body || !a.isConnected || m.root.contains(a)) focusBack(m.opener);
  tell();
}
