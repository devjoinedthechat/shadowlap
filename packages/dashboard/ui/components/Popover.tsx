import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLatest } from '../hooks.js';
import { keepPlaced } from '../place.js';
import { useLayer } from '../state.js';

/**
 * A menu that hangs from the button that opened it (`.pop`, fixed to the viewport so no pane clips
 * it). It keeps to the screen, focuses its first item, moves with ↑ ↓, and closes on Esc, on a
 * click outside or on the opener again. `align: 'right'` puts its right edge under the opener's.
 */

export interface PopoverProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  align?: 'right' | 'left';
  /** At least as wide as the opener. */
  matchWidth?: boolean;
  label?: string;
}

export { placePop } from '../place.js';

export function Popover({ anchor, onClose, children, className = '', align = 'right', matchWidth = false, label }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width?: number } | null>(null);
  const closeRef = useLatest(onClose);
  useLayer('menu', true, onClose);

  // Placed again whenever the window or the menu itself changes size: a menu whose items arrive after
  // it opens grows, and must still end inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const widthOf = (r: DOMRect) => (matchWidth ? Math.max(r.width, 280) : undefined);
    return keepPlaced(
      () => {
        const r = anchor.getBoundingClientRect();
        return { anchor: r, pop: { width: widthOf(r) ?? el.offsetWidth, height: el.offsetHeight }, view: { width: innerWidth, height: innerHeight } };
      },
      align,
      (p) => {
        const width = widthOf(anchor.getBoundingClientRect());
        setPos((cur) => (cur && cur.top === p.top && cur.left === p.left && cur.width === width ? cur : width ? { ...p, width } : p));
      },
      (again) => {
        const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
        sized?.observe(el);
        window.addEventListener('resize', again);
        return () => {
          sized?.disconnect();
          window.removeEventListener('resize', again);
        };
      },
    );
  }, [anchor, align, matchWidth]);

  // Its first item takes the focus once the menu shows: until it is placed it is hidden, and a hidden
  // element can't take it.
  const placed = pos !== null;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('button:not([disabled]), a[href]')?.focus();
  }, [placed]);
  // Closed while it has the focus (Esc, a pick), it hands the focus back to the button that opened it.
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el?.contains(document.activeElement)) anchor?.focus();
    };
  }, [anchor]);

  useEffect(() => {
    anchor?.setAttribute('aria-expanded', 'true');
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      // The opener toggles: its own click closes the menu.
      if (anchor?.contains(t)) return;
      closeRef.current();
    };
    document.addEventListener('mousedown', down);
    return () => {
      document.removeEventListener('mousedown', down);
      anchor?.setAttribute('aria-expanded', 'false');
    };
  }, [anchor, closeRef]);

  const keys = (e: React.KeyboardEvent) => {
    // Tab leaves a menu, as ARIA's menu button pattern has it: the menu closes, its button gets the
    // focus back, and Tab goes on from there.
    if (e.key === 'Tab') {
      closeRef.current();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    // Only what can take the focus: a button hidden until its row is hovered (the switcher's ×) is passed over.
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ?? [])].filter((el) => el === document.activeElement || (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'));
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={ref} className={`pop${className ? ` ${className}` : ''}`} role="menu" aria-label={label} onKeyDown={keys} style={pos ?? { visibility: 'hidden', top: 0, left: 0 }}>
      {children}
    </div>
  );
}

/** A menu item: its words, and a second line or a flag on the right. */
export function MenuItem({ label, note, onPick, disabled, title }: { label: ReactNode; note?: ReactNode; onPick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} title={title} onClick={onPick}>
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
