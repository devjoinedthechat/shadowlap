import { memo, useMemo } from 'react';
import { ktok } from '../format.js';
import { ORIGIN_COLOR, ORIGIN_NAME, ORIGINS, type Origin7 } from '../origins.js';
import { gridCells, miniCells, stripCells, type StripItem } from '../strip.js';
import { tipCard, type TipRow } from './HoverCard.js';

/**
 * The origin strip: a run's calls in the colour of what happened to each, so its shape shows at a
 * glance. Past 360 calls a cell stands for a range and takes its most notable origin; hovering it
 * counts each origin in the range. A fork and a lost call are flagged; a live run grows a pulsing
 * cell for the call to come.
 */

export interface StripCall extends StripItem {
  /** Hover: the call's name, and its tokens or effect. */
  name: string;
  detail: string;
}

export interface StripProps {
  calls: readonly StripCall[];
  selected: number | null;
  forkAt: number | null;
  lostAt: number | null;
  inScope?: ((n: number) => boolean) | null;
  live?: boolean;
  onSelect: (n: number) => void;
}

export const Strip = memo(function Strip({ calls, selected, forkAt, lostAt, inScope = null, live = false, onSelect }: StripProps) {
  const byNo = useMemo(() => new Map(calls.map((c) => [c.n, c])), [calls]);
  const cells = useMemo(() => stripCells(calls, { selected, forkAt, lostAt, inScope }), [calls, selected, forkAt, lostAt, inScope]);
  const binned = cells.length < calls.length;
  const columns = cells.length + (live ? 1 : 0);
  return (
    <div className={`cells${binned ? ' binned' : ''}`} style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }} role="group" aria-label={binned ? `Calls by origin, ${Math.ceil(calls.length / cells.length)} calls per cell` : 'Calls by origin'}>
      {cells.map((c) => {
        const one = c.first === c.last ? byNo.get(c.first) : undefined;
        const rows: TipRow[] = one
          ? [{ label: ORIGIN_NAME[one.origin], value: one.detail, color: ORIGIN_COLOR[one.origin] }]
          : ORIGINS.filter((o) => c.counts[o]).map((o) => ({ label: ORIGIN_NAME[o], value: (c.counts[o] ?? 0).toLocaleString('en-US'), color: ORIGIN_COLOR[o] }));
        const title = one ? `#${one.n} ${one.name}` : `#${c.first.toLocaleString('en-US')}–${c.last.toLocaleString('en-US')}`;
        const cls = [c.origin, c.mark ? 'mark' : '', c.mark === 'lost' ? 'bl' : '', c.dim ? 'dim' : ''].filter(Boolean).join(' ');
        return (
          <button key={c.key} type="button" className={cls} aria-current={c.selected ? 'true' : undefined} data-tip={tipCard(title, rows)} onClick={() => onSelect(c.target)}>
            {c.mark ? <span className="flag">{c.mark}</span> : null}
            <span className="sr">{one ? `Call ${one.n}` : `Calls ${c.first} to ${c.last}`}</span>
          </button>
        );
      })}
      {live ? <button type="button" className="pending next" tabIndex={-1} aria-hidden="true" /> : null}
    </div>
  );
});

/** What a strip cell says about one call: its tokens for a model call, else its effect or kind. */
export function stripDetail(c: { kind: string; effect: string | null; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null }): string {
  if (c.kind === 'api') return c.usage ? `${ktok(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)} → ${ktok(c.usage.output)}` : 'model call';
  return c.effect ?? c.kind;
}

/** The small strip in tables and lists: grouped past 60 cells. */
export function MiniStrip({ origins, max = 60, className = 'ms' }: { origins: readonly Origin7[]; max?: number; className?: string }) {
  const cells = useMemo(() => miniCells(origins, max), [origins, max]);
  return (
    <span className={className} style={{ gridTemplateColumns: `repeat(${Math.max(1, cells.length)}, minmax(0, 1fr))` }} aria-hidden="true">
      {cells.map((o, i) => (
        <i key={i} className={o} />
      ))}
    </span>
  );
}

/** A row of the Overview's grid: a family shares one scale, so a fork's replayed prefix lines up under its parent. */
export function GridStrip({ origins, scale, forkAt = null, live = false }: { origins: readonly Origin7[]; scale: number; forkAt?: number | null; live?: boolean }) {
  const cells = useMemo(() => gridCells(origins, scale, forkAt), [origins, scale, forkAt]);
  return (
    <span className="gs" style={{ gridTemplateColumns: `repeat(${Math.max(1, cells.length)}, minmax(0, 1fr))` }} aria-hidden="true">
      {cells.map((c, i) => (
        <i key={i} className={[c.origin ?? (live ? 'pend' : ''), c.fork ? 'fk' : ''].filter(Boolean).join(' ') || undefined} />
      ))}
    </span>
  );
}
