import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { backRowKey } from './focus.js';
import { focusPage, focusQuiet, landRowsWith, settleFocus } from './focus-manager.js';
import { useLatest } from './hooks.js';
import type { PaletteCommand } from './state.js';

/**
 * One list hook with a roving focus, for every list a page holds. j and k move through a page's lists
 * top to bottom; the row in focus is drawn `.krow`, takes the keyboard's focus (Tab goes on from it)
 * and comes into view; ↓ and ↑ move too while the focus is in it. Enter opens it, x selects it where
 * rows have a checkbox, ⌘K offers its actions, and Esc lets go of it. It keeps its place when the
 * page draws again, and a list Esc comes back to has the row you left in focus. A list hands the
 * hook its rows as data, since a window or a page may not have drawn them, and spreads the key it
 * returns as `krow` and each row's as `data-rowkey`. The keys themselves come from
 * `shell/Keyboard.tsx`.
 */

/** A row's actions, for ⌘K on it: the palette shows them under the row's name, and ⌫ shows everything. */
export interface RowScope {
  name: string;
  items: () => Array<Omit<PaletteCommand, 'group'>>;
}

export interface ListOptions<T> {
  rows: readonly T[];
  /** The row's `data-rowkey`: its own key, else where it leads. */
  keyOf: (row: T) => string;
  /** The box that holds the rows. */
  root: RefObject<HTMLElement | null>;
  /** Enter on the row. A row with none offers its actions instead. */
  open?: ((row: T) => void) | null;
  /** `x`, where rows have a checkbox. */
  pick?: ((row: T) => void) | null;
  /** ⌘K on the row. */
  actions?: ((row: T) => RowScope | null) | null;
  /** A window's `show`, before a row not drawn takes the focus. */
  show?: ((i: number) => void) | null;
  /** A row drawn as its cells takes the focus in the box this finds; the row itself by default. */
  box?: ((row: HTMLElement) => HTMLElement) | null;
  /** A list beside the page (the sidebar's): its keys only work with the focus in it, and it draws no `.krow`. */
  beside?: boolean;
}

interface Entry {
  o: { current: ListOptions<unknown> };
  key: string | null;
  /** The row that takes the focus once it is drawn. */
  wanted: string | null;
  draw: (key: string | null) => void;
}

const lists = new Set<Entry>();

/** A key as a selector's quoted value. */
const quoted = (key: string) => key.replace(/["\\]/g, '\\$&');

const rowEl = (l: Entry, key: string) => l.o.current.root.current?.querySelector<HTMLElement>(`[data-rowkey="${quoted(key)}"]`) ?? null;

const keysOf = (l: Entry) => l.o.current.rows.map((r) => l.o.current.keyOf(r));

const rowOf = (l: Entry, key: string): unknown => l.o.current.rows.find((r) => l.o.current.keyOf(r) === key);

/** The row's box takes the focus and comes into view up or down only, a wide table keeping its sideways scroll. */
function focusRow(l: Entry, el: HTMLElement): void {
  const box = l.o.current.box?.(el) ?? el;
  if (!box.matches('a, button') && !box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
  const wrap = box.closest<HTMLElement>('.tscroll');
  const left = wrap?.scrollLeft ?? 0;
  focusQuiet(box);
  box.scrollIntoView?.({ block: 'nearest' });
  if (wrap) wrap.scrollLeft = left;
}

function setRow(l: Entry, key: string): void {
  for (const other of lists)
    if (other !== l && other.key !== null) {
      other.key = null;
      other.draw(null);
    }
  if (!l.o.current.beside) {
    l.key = key;
    l.draw(key);
  }
  const el = rowEl(l, key);
  if (el) return focusRow(l, el);
  l.wanted = key;
  l.o.current.show?.(keysOf(l).indexOf(key));
}

/** The page's lists, top to bottom as it reads. */
function pageLists(): Entry[] {
  const before = (a: Entry, b: Entry) => {
    const [x, y] = [a.o.current.root.current, b.o.current.root.current];
    if (!x?.compareDocumentPosition || !y) return 0;
    return x.compareDocumentPosition(y) & 4 ? -1 : 1;
  };
  return [...lists].filter((l) => !l.o.current.beside && l.o.current.root.current).sort(before);
}

/** The row the keys act from: the one the focus is in (the row, its checkbox or its link), else the row in focus, the focus having gone elsewhere. */
function rowNow(): { l: Entry; key: string; el: HTMLElement | null } | null {
  const a = document.activeElement;
  const held = a?.closest?.('[data-rowkey]');
  const key = held?.getAttribute('data-rowkey');
  if (key)
    for (const l of lists)
      if (l.o.current.root.current?.contains(held!)) return { l, key, el: held as HTMLElement };
  for (const l of pageLists()) if (l.key !== null) return { l, key: l.key, el: rowEl(l, l.key) };
  return null;
}

/** Moves along the lists: from no row, j starts at the first and k at the last; it stops at the ends. */
function moveRow(seq: readonly Entry[], d: 1 | -1, at: { l: Entry; key: string } | null): boolean {
  const all = seq.flatMap((l) => keysOf(l).map((key) => ({ l, key })));
  if (!all.length) return false;
  const i = at ? all.findIndex((x) => x.l === at.l && x.key === at.key) : -1;
  const to = all[i < 0 ? (d > 0 ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, i + d))]!;
  setRow(to.l, to.key);
  return true;
}

/** The sidebar's keys, from a run in it: ahead of the page's, a run page's j and k among them. */
export function besideKeys(e: KeyboardEvent): boolean {
  const at = rowNow();
  if (!at?.l.o.current.beside) return false;
  if (e.key === 'j' || e.key === 'ArrowDown') return moveRow([at.l], 1, at);
  if (e.key === 'k' || e.key === 'ArrowUp') return moveRow([at.l], -1, at);
  return false;
}

/** A page's list keys, once a page's own have had theirs. True when one acted. `openScope` opens the palette on a row's actions. */
export function listKeys(e: KeyboardEvent, openScope: () => void): boolean {
  const k = e.key;
  const at = rowNow();
  const onRow = !!at?.el?.contains(document.activeElement);
  if (k === 'j' || k === 'k' || ((k === 'ArrowDown' || k === 'ArrowUp') && onRow)) return moveRow(pageLists(), k === 'j' || k === 'ArrowDown' ? 1 : -1, at);
  if (!at || !onRow) return false;
  const row = rowOf(at.l, at.key);
  if (row === undefined) return false;
  const o = at.l.o.current;
  if (k === 'x' && o.pick) return o.pick(row), true;
  if (k !== 'Enter' || document.activeElement !== (o.box?.(at.el!) ?? at.el) || at.el!.matches('a, button')) return false;
  if (o.open) return o.open(row), true;
  if (!o.actions) return false;
  scope = o.actions(row);
  if (scope) openScope();
  return !!scope;
}

/**
 * Esc: the row in focus lets go, wherever the focus has gone since, and the page's heading takes the
 * focus. With none in focus nothing moves, the focus on a row's link or checkbox included: Tab keeps
 * its place. A list beside the page keeps no row in focus: Esc in it goes to the heading.
 */
export function letGoOfRow(): boolean {
  if (!inBesideList()) {
    const held = pageLists().find((l) => l.key !== null);
    if (!held) return false;
    held.key = null;
    held.draw(null);
  }
  focusPage();
  return true;
}

/** Whether the focus is in a list beside the page: Esc lets go of it before it goes up. */
export const inBesideList = (): boolean => !!rowNow()?.l.o.current.beside;

/** Where Esc lands in a page's lists, for the focus manager: the row you left, or one that leads to the page left. */
function landOnRow(left: string, own: string | null): boolean {
  for (const l of pageLists()) {
    const key = backRowKey(keysOf(l), left, own);
    if (key) return setRow(l, key), true;
  }
  return false;
}
landRowsWith(landOnRow);

let scope: RowScope | null = null;

/** ⌘K, just before the palette opens: the actions of the row the focus is in, none with the focus elsewhere. */
export function takeRowScope(): void {
  const at = rowNow();
  scope = null;
  if (!at?.el?.contains(document.activeElement)) return;
  const row = rowOf(at.l, at.key);
  if (row === undefined) return;
  const found = at.l.o.current.actions?.(row) ?? null;
  if (!found) return;
  scope = found;
  if (at.l.key !== at.key) setRow(at.l, at.key);
}

/** What the palette opens on. */
export const rowScopeNow = (): RowScope | null => scope;

/** The palette has closed, or ⌫ took it back to everything. */
export function dropRowScope(): void {
  scope = null;
}

/**
 * Draws a list into the keys' reach while it is mounted, and hands back the row in focus to draw
 * `.krow`. Each list on a page calls this once; a row that leaves the rows (a filter, a delete) lets
 * go, and j starts over.
 */
export function useListKeys<T>(o: ListOptions<T>): string | null {
  const [at, setAt] = useState<string | null>(null);
  const latest = useLatest(o as unknown as ListOptions<unknown>);
  const entry = useRef<Entry | null>(null);
  entry.current ??= { o: latest, key: null, wanted: null, draw: setAt };
  const l = entry.current;
  useLayoutEffect(() => {
    lists.add(l);
    return () => {
      lists.delete(l);
    };
  }, [l]);
  // A row asked for, once a window has drawn it.
  useLayoutEffect(() => {
    if (l.wanted === null) return;
    const el = rowEl(l, l.wanted);
    if (!el) return;
    l.wanted = null;
    focusRow(l, el);
  });
  // keyOf is new on every render, so it comes through `latest`: only the rows ask for this.
  useLayoutEffect(() => {
    if (l.key !== null && !o.rows.some((r) => latest.current.keyOf(r) === l.key)) {
      l.key = null;
      l.wanted = null;
      setAt(null);
    }
    settleFocus();
  }, [o.rows, l, latest]);
  return at;
}

/** The runs a list shows, in its order, for `[` and `]`: Runs as it was last shown, else nothing noted. */
export interface ShownRuns {
  ids: readonly string[];
  /** Reads the next page of that list; none when it has come to its end. */
  more: (() => Promise<readonly string[]>) | null;
}

export const shownRuns: { current: ShownRuns | null } = { current: null };
