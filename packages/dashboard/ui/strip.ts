import { ORIGIN_RANK, type Origin7 } from './origins.js';

/**
 * The strip's cells: one per call, or one per range of calls where they don't fit. The run page's
 * strip draws a recording's calls by kind and every other run's by origin (ui/run/kinds.ts), so a
 * cell's colour is a key passed in with its rank; the small strips draw origins. No DOM here: the
 * tests import it.
 */

/** A strip given no room to fit (the tests) groups past this many. */
export const MAX_CELLS = 360;
/** The Runs table's small strip, and the Overview's rows, group past this many. */
export const MINI_CELLS = 60;

export interface StripItem {
  n: number;
  origin: Origin7;
}

/** What a cell is drawn by: its call's kind or origin, and which of those a range marks first. */
export interface StripKey<T extends StripItem = StripItem> {
  of: (c: T) => string;
  rank: Readonly<Record<string, number>>;
}

const BY_ORIGIN: StripKey = { of: (c) => c.origin, rank: ORIGIN_RANK };

/** What a range marks with a notch where the rest of it is something else: an error, a write, and what a fork changed or fenced. */
const TICKED: ReadonlySet<string> = new Set(['k-err', 'k-write', 'fail', 'inject', 'block', 'stub', 'over']);

export interface Bin {
  first: number;
  last: number;
  /** The origin of the range's most notable call. */
  origin: Origin7;
  /** The range's most notable call by the key's rank, which a click opens. */
  notable: number;
  /** How many calls of each key the range holds. */
  counts: Partial<Record<string, number>>;
  size: number;
  /** What most of the range is (ties to the more notable): the colour it is drawn in. */
  major: string;
  /** Its most notable call's key where that is rarer than `major`, marked with a notch at `tickAt` (0 to 1). */
  tick: string | null;
  tickAt: number;
}

/** Calls grouped into at most `max` ranges of equal size, or null when they fit one cell each. */
export function binCalls<T extends StripItem>(items: readonly T[], max: number, key: StripKey<T> = BY_ORIGIN): Bin[] | null {
  if (items.length <= max) return null;
  const rank = (k: string) => key.rank[k] ?? 0;
  const size = Math.ceil(items.length / max);
  const out: Bin[] = [];
  for (let i = 0; i < items.length; i += size) {
    const range = items.slice(i, i + size);
    let notable = range[0]!;
    let top = key.of(notable);
    const counts: Partial<Record<string, number>> = {};
    for (const c of range) {
      const k = key.of(c);
      counts[k] = (counts[k] ?? 0) + 1;
      if (rank(k) > rank(top)) {
        notable = c;
        top = k;
      }
    }
    let major = top;
    for (const [k, n] of Object.entries(counts)) if (n! > counts[major]! || (n === counts[major] && rank(k) > rank(major))) major = k;
    const first = range[0]!.n;
    const last = range[range.length - 1]!.n;
    const tick = top !== major && rank(top) > rank(major) && TICKED.has(top) ? top : null;
    out.push({ first, last, origin: notable.origin, notable: notable.n, counts, size: range.length, major, tick, tickAt: last > first ? (notable.n - first) / (last - first) : 0.5 });
  }
  return out;
}

/** A cell narrower than this reads as noise: 6px, or 24px to a finger. */
export const minCell = (coarse: boolean): number => (coarse ? 24 : 6);

/**
 * How many cells the strip has room for: null while every call fits a cell of its least width with
 * 3px between (and a live run's next cell with them), else the ranges that fit 1px apart, never fewer
 * than four, one fewer while a live run's next cell takes a place.
 */
export function stripCapacity(calls: number, width: number, coarse: boolean, waiting: boolean): number | null {
  const min = minCell(coarse);
  if ((calls + (waiting ? 1 : 0)) * (min + 3) <= width + 3) return null;
  return Math.max(4, Math.floor((width + 1) / (min + 1)) - (waiting ? 1 : 0));
}

/** A cell before the selection and the marks are known: a call, or a range of calls. */
export interface Range {
  key: string;
  first: number;
  last: number;
  /** What it is drawn in: a range's major key, or the call's own. */
  cls: string;
  /** The origin of its most notable call (a call's own). */
  origin: Origin7;
  /** Its most notable call. */
  notable: number;
  /** How many calls of each key it stands for (one call: just its own). */
  counts: Partial<Record<string, number>>;
  tick: string | null;
  tickAt: number;
}

/**
 * The strip's ranges, worked out once for the calls, the room and the key, whatever is selected:
 * one a call while they fit (`capacity` null), else at most `capacity` ranges, or a call each 1px
 * apart where there are no more calls than that.
 */
export function stripRanges<T extends StripItem>(items: readonly T[], capacity: number | null, key: StripKey<T> = BY_ORIGIN): Range[] {
  const bins = capacity === null ? null : binCalls(items, capacity, key);
  if (!bins) {
    return items.map((c) => {
      const k = key.of(c);
      return { key: String(c.n), first: c.n, last: c.n, cls: k, origin: c.origin, notable: c.n, counts: { [k]: 1 }, tick: null, tickAt: 0.5 };
    });
  }
  return bins.map((b) => ({ key: `${b.first}-${b.last}`, first: b.first, last: b.last, cls: b.major, origin: b.origin, notable: b.notable, counts: b.counts, tick: b.tick, tickAt: b.tickAt }));
}

/**
 * Which ranges are dimmed: those with no call in the scope, or none of the key picked (`pick`, the
 * call filter). Apart from the selection, so a pick walks no range again.
 */
export function dimRanges(ranges: readonly Range[], inScope: ((n: number) => boolean) | null, pick: string | null = null): boolean[] {
  return ranges.map((r) => {
    if (pick !== null && !r.counts[pick]) return true;
    if (!inScope) return false;
    for (let n = r.first; n <= r.last; n++) if (inScope(n)) return false;
    return true;
  });
}

export interface Cell extends Range {
  /** The call a click opens: the fork or lost call in the range, the selection, or the most notable call. */
  target: number;
  selected: boolean;
  mark: 'fork' | 'lost' | null;
  /** Outside the picked scope or the call filter. */
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

/** The ranges with the selection, the fork, the lost call and the dimmed marked: a walk over the cells alone. */
export function markRanges(ranges: readonly Range[], dims: readonly boolean[], o: Pick<StripOptions, 'selected' | 'forkAt' | 'lostAt'>): Cell[] {
  const within = (r: Range, n: number | null): n is number => n !== null && n >= r.first && n <= r.last;
  return ranges.map((r, i) => {
    const forkHere = within(r, o.forkAt);
    const lostHere = within(r, o.lostAt);
    const selected = within(r, o.selected);
    return { ...r, target: forkHere ? o.forkAt! : lostHere ? o.lostAt! : selected ? o.selected! : r.notable, selected, mark: forkHere ? 'fork' : lostHere ? 'lost' : null, dim: dims[i] ?? false };
  });
}

/** The strip's cells by origin, grouped past `max` (360 by default): the ranges and their marks at once. */
export function stripCells(items: readonly StripItem[], o: StripOptions): Cell[] {
  const ranges = stripRanges(items, items.length > (o.max ?? MAX_CELLS) ? (o.max ?? MAX_CELLS) : null);
  return markRanges(ranges, dimRanges(ranges, o.inScope ?? null), o);
}

/**
 * The strip is one stop for Tab: the selected call's cell, else the first. While the focus is in the
 * strip, ← and → select the call next to it, or where it is grouped the next range's call.
 */
export function stripTabStop(cells: readonly Pick<Cell, 'selected'>[]): number {
  const selected = cells.findIndex((c) => c.selected);
  return selected >= 0 ? selected : 0;
}

/** The call a key on the strip selects: ← and → the next call or range, Home and End the ends. Null for another key, or nothing to move to. */
export function stripStep(cells: readonly Pick<Cell, 'first' | 'last' | 'target' | 'selected'>[], selected: number | null, key: string, binned: boolean): number | null {
  if (!cells.length) return null;
  const at = cells.findIndex((c) => c.selected);
  let to: number | null = null;
  if (key === 'Home') to = 0;
  else if (key === 'End') to = cells.length - 1;
  else if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const d = key === 'ArrowLeft' ? -1 : 1;
    if (!binned && selected !== null && at >= 0) {
      const n = selected + d;
      return n >= cells[0]!.first && n <= cells[cells.length - 1]!.last && n !== selected ? n : null;
    }
    to = at < 0 ? (d > 0 ? 0 : cells.length - 1) : at + d;
  }
  if (to === null || to < 0 || to >= cells.length || (to === at && cells[to]!.selected)) return null;
  const c = cells[to]!;
  return binned || c.first !== c.last ? c.target : c.first;
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
