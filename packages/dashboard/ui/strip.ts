import type { CallRow } from './api.js';
import { isFailure } from './format.js';

/** The origin strip's cells: one per call, or one per range of calls in a long run. */

/** Above this many calls, one cell stands for a range of calls; a strip cell narrower than ~2px reads as noise. */
export const MAX_CELLS = 360;
/** Which origin a range of calls shows: the rarest wins, so one blocked write among replayed calls stays visible. */
const ORIGIN_RANK: Record<string, number> = { injected: 6, blocked: 5, stubbed: 4, overridden: 3, live: 2, replayed: 1 };

export interface StripCell {
  first: number;
  last: number;
  /** The call a click opens: the fork, the selection, or the most notable call in the range. */
  target: number;
  origin: string;
  error: boolean;
  selected: boolean;
  fork: boolean;
  title: string;
}

export function stripCells(calls: CallRow[], selected: number | null, divergence: number | undefined): StripCell[] {
  if (calls.length <= MAX_CELLS) {
    return calls.map((c) => ({ first: c.callNo, last: c.callNo, target: c.callNo, origin: c.origin, error: isFailure(c), selected: c.callNo === selected, fork: c.callNo === divergence, title: `#${c.callNo} ${c.kind} ${c.name} · ${c.origin}${isFailure(c) ? ' · error' : ''}` }));
  }
  const size = Math.ceil(calls.length / MAX_CELLS);
  const cells: StripCell[] = [];
  for (let i = 0; i < calls.length; i += size) {
    const range = calls.slice(i, i + size);
    const first = range[0]!.callNo;
    const last = range[range.length - 1]!.callNo;
    let notable = range[0]!;
    const counts = new Map<string, number>();
    for (const c of range) {
      counts.set(c.origin, (counts.get(c.origin) ?? 0) + 1);
      if ((ORIGIN_RANK[c.origin] ?? 0) > (ORIGIN_RANK[notable.origin] ?? 0)) notable = c;
    }
    const inRange = (n: number | null | undefined) => n !== null && n !== undefined && n >= first && n <= last;
    const errors = range.filter(isFailure).length;
    cells.push({
      first,
      last,
      target: inRange(divergence) ? divergence! : inRange(selected) ? selected! : notable.callNo,
      origin: notable.origin,
      error: errors > 0,
      selected: inRange(selected),
      fork: inRange(divergence),
      title: `#${first}–${last} · ${[...counts].map(([o, n]) => `${n} ${o}`).join(', ')}${errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}`,
    });
  }
  return cells;
}
