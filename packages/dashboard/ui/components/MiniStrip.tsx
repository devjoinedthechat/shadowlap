import { useMemo } from 'react';
import type { Origin7 } from '../origins.js';
import { binCalls, MINI_CELLS } from '../strip.js';

/**
 * The small strips, the Runs table's and the Overview's, in the colour of each call's origin: apart
 * from the run page's own strip (ui/run/RunStrip.tsx), so that page loads none of them.
 */

/** A small strip's cell: its call's origin, or a range's, with the notch of its rarer notable call where it has one. */
export interface MiniCell {
  origin: Origin7;
  tick: Origin7 | null;
  tickAt: number;
}

/**
 * A small strip's cells: each call's origin, or past `max` calls each range in the origin most of its
 * calls have, its rarer notable call (a failure, what a fork changed or fenced) marked by a notch at
 * its place, as the run page's strip marks it: a few failures among many calls read as a few marks.
 */
export function miniCells(origins: readonly Origin7[], max = MINI_CELLS): MiniCell[] {
  const bins = binCalls(
    origins.map((origin, i) => ({ n: i + 1, origin })),
    max,
  );
  return bins ? bins.map((b) => ({ origin: b.major as Origin7, tick: b.tick as Origin7 | null, tickAt: b.tickAt })) : origins.map((origin) => ({ origin, tick: null, tickAt: 0 }));
}

/** The small strip in tables and lists: grouped past 60 cells. */
export function MiniStrip({ origins, max = 60, className = 'ms', said }: { origins: readonly Origin7[]; max?: number; className?: string; said?: string | undefined }) {
  const cells = useMemo(() => miniCells(origins, max), [origins, max]);
  // With `said`, a screen reader hears the calls by origin, held inside the strip; without, the strip is a picture only.
  return (
    <span className={className} style={{ gridTemplateColumns: `repeat(${Math.max(1, cells.length)}, minmax(0, 1fr))` }} aria-hidden={said ? undefined : 'true'}>
      {cells.map((c, i) => (
        <i key={i} className={c.origin}>
          {c.tick ? <span className={`tk ${c.tick}`} style={{ left: `${c.tickAt * 100}%` }} /> : null}
        </i>
      ))}
      {said ? <span className="sr">{said}</span> : null}
    </span>
  );
}
