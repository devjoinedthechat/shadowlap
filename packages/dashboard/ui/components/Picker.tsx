import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { opensOnField } from '../overlays/modal-store.js';
import { Popover } from './Popover.js';
import { useFitAbouts } from './About.js';

/**
 * A picker (Compare's runs, the redaction preview's run): a combobox, a filter field over its list,
 * the field keeping the focus and naming the option the arrows light (`aria-activedescendant`).
 * Arrows, Home, End, PageUp and PageDown move, Enter picks, Esc closes, a check marks the one picked
 * now, and "Nothing matches." says when the filter leaves none. It opens at its button's width, under
 * the button or over it as the room allows; on a phone it is a sheet with 44px rows and a 44px
 * filter. Opened from a key it focuses its filter, a touch screen included; opened by a tap it
 * focuses its list, so a screen reader follows the option and the phone's keyboard stays closed until
 * the filter is tapped.
 */

export interface PickerItem {
  id: string;
  /** What the filter reads: an id, an about line, labels. */
  text: string;
  /** The one picked now. */
  current: boolean;
  /** What the row draws, in its button's form. */
  node: ReactNode;
}

/** The items every typed word finds, as the palette matches. */
export function matchPicks<T extends Pick<PickerItem, 'text'>>(items: readonly T[], filter: string): T[] {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? items.filter((x) => words.every((w) => x.text.toLowerCase().includes(w))) : [...items];
}

/** How many rows PageUp and PageDown jump. */
const PAGE = 8;

/** Where a key moves the lit option among `count`: round the ends with the arrows, to the first or last, a page at a time without going round; null for any other key. */
export function pickMove(key: string, at: number, count: number): number | null {
  if (!count) return null;
  if (key === 'ArrowDown') return (at + 1) % count;
  if (key === 'ArrowUp') return (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'PageDown') return Math.min(count - 1, at + PAGE);
  if (key === 'PageUp') return Math.max(0, at - PAGE);
  return null;
}

export function Picker({ anchor, label, placeholder, items, onPick, onClose, className }: { anchor: HTMLElement; label: string; placeholder: string; items: readonly PickerItem[]; onPick: (id: string) => void; onClose: () => void; className?: string }) {
  const base = useId();
  const listId = `${base}list`;
  const optionId = (id: string) => `${base}o${items.findIndex((x) => x.id === id)}`;
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => matchPicks(items, filter), [items, filter]);
  const [lit, setLit] = useState(() => Math.max(0, items.findIndex((x) => x.current)));
  const at = shown.length ? Math.min(lit, shown.length - 1) : -1;
  // The ring is the keyboard's: the pointer's place shows by the ground alone.
  const [byKeys, setByKeys] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useFitAbouts(list);

  // The field or the list takes the focus as it opens, before the first paint: the store's menu has its button to go back to.
  useLayoutEffect(() => {
    if (opensOnField()) field.current?.focus();
    else list.current?.focus({ preventScroll: true });
  }, []);
  const litId = at >= 0 ? optionId(shown[at]!.id) : null;
  useLayoutEffect(() => {
    if (litId) list.current?.querySelector(`[data-pick="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [litId, at]);

  const keys = (e: KeyboardEvent): boolean => {
    const to = pickMove(e.key, Math.max(at, 0), shown.length);
    if (to !== null) {
      e.preventDefault();
      setByKeys(true);
      setLit(to);
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const x = shown[at];
      if (x) onPick(x.id);
      return true;
    }
    return false;
  };

  return (
    <Popover anchor={anchor} onClose={onClose} align="start" matchWidth role="dialog" label={label} keepFocus className={`picker curmark${className ? ` ${className}` : ''}`} onKeys={keys}>
      <input
        ref={field}
        className="pfilter"
        type="text"
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-controls={shown.length ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={litId ?? undefined}
        autoComplete="off"
        spellCheck={false}
        aria-label={`Filter the ${label.toLowerCase()}`}
        placeholder={placeholder}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setLit(0);
        }}
      />
      {shown.length ? (
        <div ref={list} id={listId} className={`pklist${byKeys ? ' kb' : ''}`} role="listbox" aria-label={label} tabIndex={-1} aria-activedescendant={litId ?? undefined}>
          {shown.map((x, i) => (
            <div
              key={x.id}
              id={optionId(x.id)}
              data-pick={i}
              role="option"
              aria-selected={x.current}
              className={`opt${i === at ? ' on' : ''}`}
              // The field keeps the focus: a click picks without taking it.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => {
                setByKeys(false);
                if (i !== at) setLit(i);
              }}
              onClick={() => onPick(x.id)}
            >
              {x.node}
            </div>
          ))}
        </div>
      ) : (
        <p className="pnone" role="status">
          Nothing matches.
        </p>
      )}
    </Popover>
  );
}
