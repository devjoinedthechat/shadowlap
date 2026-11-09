import { useMemo } from 'react';
import { ktok } from '../format.js';
import type { Origin7 } from '../origins.js';
import { miniCells } from '../strip.js';

/**
 * The small strips (the Runs table's and the Overview's), in the colour of each call's origin, and
 * what a strip cell says of a call. The run page's own strip is ui/run/RunStrip.tsx.
 */

/** What a strip cell says about one call: its tokens for a model call, else its effect or kind. */
export function stripDetail(c: { kind: string; effect: string | null; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null }): string {
  if (c.kind === 'api') return c.usage ? `${ktok(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)} → ${ktok(c.usage.output)}` : 'model call';
  return c.effect ?? c.kind;
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

