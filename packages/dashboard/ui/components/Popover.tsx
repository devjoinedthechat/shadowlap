import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLatest, useMedia } from '../hooks.js';
import { focusItem, menuClosed, menuItems, menuOpened } from '../overlays/menu-store.js';
import { takeStartLast } from '../overlays/modal-store.js';
import { InSlot } from '../overlays/slots.js';
import { keepPlaced, menuWidthAt, type MenuPlace } from '../place.js';

/**
 * A menu that hangs from the button that opened it (`.pop`), in the menu slot, fixed to the window so
 * no pane clips it. Placed by the room there is (`placeMenu`), its first item takes the focus; on a
 * phone it is a sheet from the foot of the screen, over a scrim that takes the tap that closes it.
 * Its keys are the menu store's: arrows round the ends, Home, End, PageUp, PageDown, a typed letter,
 * → to a row's second button, Tab and Esc to close. Closed, the focus goes back to the button that
 * opened it, unless a click outside landed on another control. Its rows are one line each: the
 * label left in the UI face, what the item runs right in mono, what it is for on its hover card.
 */

export interface PopoverProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  /** `narrow` is the second of a menu's two widths; `curmark` keeps room for a check before each row. */
  className?: string;
  /** Which of the button's edges it lines up with: by default the one nearer the window's middle. */
  align?: 'start' | 'end';
  /** As wide as the opener, at least the narrower of a menu's two widths: a picker, the project switcher. */
  matchWidth?: boolean;
  label?: string;
  /** A picker is a dialog holding a combobox and a list. */
  role?: 'menu' | 'dialog';
  /** Leaves the focus where it is, for a picker, whose field or list takes it. */
  keepFocus?: boolean;
  /** Its own keys, before the menu's: true when it handled one. */
  onKeys?: (e: KeyboardEvent) => boolean;
}

/** A phone's width: a menu and a picker are sheets from here down, as a dialog is (overlays.css). */
const SHEET = '(max-width: 640px)';

const placed = (el: HTMLElement, p: MenuPlace) => {
  el.style.top = `${p.top}px`;
  el.style.left = `${p.left}px`;
  el.style.maxHeight = p.maxHeight === null ? '' : `${p.maxHeight}px`;
};

/** Places it again as the window or the menu itself changes size: a menu whose items arrive after it opens grows, and must still end inside the window. */
const watchSize = (el: HTMLElement) => (again: () => void) => {
  const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
  sized?.observe(el);
  window.addEventListener('resize', again);
  return () => {
    sized?.disconnect();
    window.removeEventListener('resize', again);
  };
};

export function Popover({ anchor, onClose, children, className = '', align, matchWidth = false, label, role = 'menu', keepFocus = false, onKeys }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const sheet = useMedia(SHEET);
  const closeRef = useLatest(onClose);
  const keysRef = useLatest(onKeys);

  // Tab closes a menu, so its rows take the focus from the arrows alone.
  useLayoutEffect(() => {
    for (const el of ref.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []) el.tabIndex = -1;
  });

  // Drawn in its place before the first paint, so it never shows anywhere else: a sheet by the stylesheet, a menu by its button.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (sheet || !anchor) {
      for (const p of ['top', 'left', 'width', 'maxHeight'] as const) el.style[p] = '';
      return;
    }
    return keepPlaced(
      () => {
        const r = anchor.getBoundingClientRect();
        if (matchWidth) el.style.width = `${menuWidthAt(r.width, innerWidth)}px`;
        el.style.maxHeight = '';
        return { anchor: r, pop: { width: el.offsetWidth, height: el.offsetHeight }, view: { width: innerWidth, height: innerHeight } };
      },
      align,
      (p) => placed(el, p),
      watchSize(el),
    );
  }, [anchor, align, matchWidth, sheet]);

  // Open from here to when its owner takes it away; the store hands the focus back as it goes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = takeStartLast() ? -1 : 0;
    const m = menuOpened({ root: el, anchor, close: () => closeRef.current(), keys: (e) => keysRef.current?.(e) === true });
    // A button that never said so says what it opens, and ↓ opens it from then on.
    if (anchor && !anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-haspopup', role === 'dialog' ? 'listbox' : 'menu');
    anchor?.setAttribute('aria-expanded', 'true');
    if (!keepFocus && menuItems(el).length) focusItem(el, start);
    return () => {
      menuClosed(m);
      anchor?.setAttribute('aria-expanded', 'false');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one menu, opened once at its button: a new button is a new menu
  }, [anchor]);

  return (
    <InSlot name="menu">
      {sheet ? <div className="msheet" data-msheet="" /> : null}
      <div
        ref={ref}
        className={`pop${className ? ` ${className}` : ''}${sheet ? ' sheet' : ''}`}
        role={role}
        aria-label={label}
        // What opens over the page never acts on what drew it: a menu's clicks stay out of the row it hangs from.
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </InSlot>
  );
}

/** A menu item: its words, and what it runs at its right. `checked` makes it the picked one of a choice. */
export function MenuItem({ label, note, onPick, disabled, title, checked }: { label: ReactNode; note?: ReactNode; onPick: () => void; disabled?: boolean; title?: string; checked?: boolean }) {
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} disabled={disabled} title={title} onClick={onPick}>
      <b>{label}</b>
      {note !== undefined && note !== null && note !== '' ? <small>{note}</small> : null}
    </button>
  );
}

/** Opening and closing a menu from a button: the state and the anchor in one. */
export function useMenu(): { open: boolean; anchor: HTMLElement | null; toggle: (el: HTMLElement) => void; openAt: (el: HTMLElement) => void; close: () => void } {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const toggle = useCallback((el: HTMLElement) => setAnchor((cur) => (cur === el ? null : el)), []);
  const openAt = useCallback((el: HTMLElement) => setAnchor(el), []);
  const close = useCallback(() => setAnchor(null), []);
  return { open: anchor !== null, anchor, toggle, openAt, close };
}
