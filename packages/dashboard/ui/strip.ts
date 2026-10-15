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
      target: forkHere ? o.forkAt! : lostHere ? o.lostAt! : within(b, o.selected) ? o.selected! : b.notable,
      origin: b.origin,
      counts: b.counts,
      selected: within(b, o.selected),
      mark: forkHere ? 'fork' : lostHere ? 'lost' : null,
      dim,
    };
  });
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

export interface GridCell {
  /** The cell's most notable origin, or null for calls the run has not made (yet). */
  origin: Origin7 | null;
  /** The cell holds the call a fork left at. */
  fork: boolean;
}

/**
 * One family row of the Overview's grid: `scale` columns of calls (grouped past 60, each range taking
 * its most notable origin), with the run's own calls filled in and the rest left empty.
 */
export function gridCells(origins: readonly Origin7[], scale: number, forkAt: number | null = null, max = MINI_CELLS): GridCell[] {
  const n = Math.max(scale, origins.length, 1);
  const size = n > max ? Math.ceil(n / max) : 1;
  const out: GridCell[] = [];
  for (let i = 0; i < n; i += size) {
    const range = origins.slice(i, Math.min(i + size, origins.length));
    let top: Origin7 | null = null;
    for (const o of range) if (top === null || ORIGIN_RANK[o] > ORIGIN_RANK[top]) top = o;
    out.push({ origin: top, fork: forkAt !== null && forkAt > i && forkAt <= i + size });
  }
  return out;
}
