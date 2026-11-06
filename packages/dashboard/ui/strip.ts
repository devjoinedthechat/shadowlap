import { ORIGIN_RANK, type Origin7 } from './origins.js';

/**
 * The origin strip's cells: one per call, or one per range of calls in a long run. No DOM here: the
 * tests import it.
 */

/** The run page groups calls past this many: a cell narrower than about 2px reads as noise. */
export const MAX_CELLS = 360;
/** The Runs table's small strip, and the Overview's rows, group past this many. */
export const MINI_CELLS = 60;

export interface StripItem {
  n: number;
  origin: Origin7;
}

export interface Bin {
  first: number;
  last: number;
  /** The range's most notable origin. */
  origin: Origin7;
  /** The call of that origin, which a click opens. */
  notable: number;
  counts: Partial<Record<Origin7, number>>;
  size: number;
}

/** Calls grouped into at most `max` ranges of equal size, or null when they fit one cell each. */
export function binCalls(items: readonly StripItem[], max: number): Bin[] | null {
  if (items.length <= max) return null;
  const size = Math.ceil(items.length / max);
  const out: Bin[] = [];
  for (let i = 0; i < items.length; i += size) {
    const range = items.slice(i, i + size);
    let notable = range[0]!;
    const counts: Partial<Record<Origin7, number>> = {};
    for (const c of range) {
      counts[c.origin] = (counts[c.origin] ?? 0) + 1;
      if (ORIGIN_RANK[c.origin] > ORIGIN_RANK[notable.origin]) notable = c;
    }
    out.push({ first: range[0]!.n, last: range[range.length - 1]!.n, origin: notable.origin, notable: notable.n, counts, size: range.length });
  }
  return out;
}

export interface Cell {
  key: string;
  first: number;
  last: number;
  /** The call a click opens: the fork or lost call in the range, the selection, or the most notable call. */
  target: number;
  origin: Origin7;
  /** How many calls of each origin the cell stands for (one call: just its own). */
  counts: Partial<Record<Origin7, number>>;
  selected: boolean;
  mark: 'fork' | 'lost' | null;
  /** Outside the picked scope. */
  dim: boolean;
}

export interface StripOptions {
  selected: number | null;
  forkAt: number | null;
  lostAt: number | null;
  /** Calls outside the scope are dimmed; null for every call. */
  inScope?: ((n: number) => boolean) | null;
  max?: number;
}

/** The run page's strip. */
export function stripCells(items: readonly StripItem[], o: StripOptions): Cell[] {
  const bins = binCalls(items, o.max ?? MAX_CELLS);
  const inScope = o.inScope ?? null;
  if (!bins) {
    return items.map((c) => ({
      key: String(c.n),
      first: c.n,
      last: c.n,
      target: c.n,
      origin: c.origin,
      counts: { [c.origin]: 1 },
      selected: c.n === o.selected,
      mark: c.n === o.forkAt ? 'fork' : c.n === o.lostAt ? 'lost' : null,
      dim: inScope ? !inScope(c.n) : false,
    }));
  }
  const within = (b: Bin, n: number | null): n is number => n !== null && n >= b.first && n <= b.last;
  return bins.map((b) => {
    let dim = false;
    if (inScope) {
      dim = true;
      for (let n = b.first; n <= b.last && dim; n++) if (inScope(n)) dim = false;
    }
    const forkHere = within(b, o.forkAt);
    const lostHere = within(b, o.lostAt);
    return {
      key: `${b.first}-${b.last}`,
      first: b.first,
      last: b.last,
      target: forkHere ? o.forkAt! : lostHere ? o.lostAt! : within(b, o.selected) ? o.selected : b.notable,
      origin: b.origin,
      counts: b.counts,
      selected: within(b, o.selected),
      mark: forkHere ? 'fork' : lostHere ? 'lost' : null,
      dim,
    };
  });
}

/**
 * The strip is one stop for Tab: the cell that takes it is the one the arrow keys last moved to
 * while the focus stayed in the strip (`focused`), else the selected call's, else the first.
 */
export function stripTabStop(cells: readonly Pick<Cell, 'selected'>[], focused: number | null): number {
  if (focused !== null && focused >= 0 && focused < cells.length) return focused;
  const selected = cells.findIndex((c) => c.selected);
  return selected >= 0 ? selected : 0;
}

/** The cell a key moves the focus to, as on the Runs calendar: ← and → one cell, Home and End the ends. Null for another key or past the ends. */
export function moveCell(at: number, key: string, count: number): number | null {
  const to = key === 'ArrowLeft' ? at - 1 : key === 'ArrowRight' ? at + 1 : key === 'Home' ? 0 : key === 'End' ? count - 1 : null;
  return to !== null && to >= 0 && to < count && to !== at ? to : null;
}

/** A small strip's cells: each call's origin, or each range's most notable origin past `max` calls. */
export function miniCells(origins: readonly Origin7[], max = MINI_CELLS): Origin7[] {
  const bins = binCalls(
    origins.map((origin, i) => ({ n: i + 1, origin })),
    max,
  );
  return bins ? bins.map((b) => b.origin) : [...origins];
}

/** The Overview's family rows share one scale, at least this many calls wide, so a fork's prefix lines up under its parent. */
export const GRID_MIN = 30;

