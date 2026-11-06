import { memo, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { ktok } from '../format.js';
import { ORIGIN_COLOR, ORIGIN_NAME, ORIGINS, type Origin7 } from '../origins.js';
import { gridCells, miniCells, moveCell, stripCells, stripTabStop, type StripItem } from '../strip.js';
import { tipCard, type TipRow } from './HoverCard.js';

/**
 * The origin strip: a run's calls in the colour of what happened to each, so its shape shows at a
 * glance. Past 360 calls a cell stands for a range and takes its most notable origin; hovering it
 * counts each origin in the range. A fork and a lost call are flagged; a live run grows a pulsing
 * cell for the call to come. The strip is one stop for Tab (the selected call's cell): ← and →, Home
 * and End move between cells, and Enter or Space opens the call, as on the Runs calendar.
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
  // The cell the arrow keys moved to while the focus stays in the strip; once it leaves, Tab comes back to the selected call's.
  const [focused, setFocused] = useState<number | null>(null);
  const stop = stripTabStop(cells, focused);
  const strip = useRef<HTMLDivElement>(null);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = e.target instanceof HTMLElement ? Number(e.target.closest<HTMLElement>('[data-cell]')?.dataset.cell ?? NaN) : NaN;
    if (Number.isNaN(at)) return;
    const to = moveCell(at, e.key, cells.length);
    if (to === null) {
      // At an end: nothing further, and the page doesn't scroll either.
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    } else {
      setFocused(to);
      strip.current?.querySelector<HTMLElement>(`[data-cell="${to}"]`)?.focus();
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const leave = (e: FocusEvent<HTMLDivElement>) => {
    if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setFocused(null);
  };
  return (
    <div
      className={`cells${binned ? ' binned' : ''}`}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }}
      role="group"
      aria-label={binned ? `Calls by origin, ${Math.ceil(calls.length / cells.length)} calls per cell` : 'Calls by origin'}
      ref={strip}
      onKeyDown={key}
      onBlur={leave}
    >
      {cells.map((c, i) => {
        const one = c.first === c.last ? byNo.get(c.first) : undefined;
        const rows: TipRow[] = one
          ? [{ label: ORIGIN_NAME[one.origin], value: one.detail, color: ORIGIN_COLOR[one.origin] }]
          : ORIGINS.filter((o) => c.counts[o]).map((o) => ({ label: ORIGIN_NAME[o], value: (c.counts[o] ?? 0).toLocaleString('en-US'), color: ORIGIN_COLOR[o] }));
        const title = one ? `#${one.n} ${one.name}` : `#${c.first.toLocaleString('en-US')}–${c.last.toLocaleString('en-US')}`;
        const cls = [c.origin, c.mark ? 'mark' : '', c.mark === 'lost' ? 'bl' : '', c.dim ? 'dim' : ''].filter(Boolean).join(' ');
        return (
          <button key={c.key} type="button" className={cls} data-cell={i} tabIndex={i === stop ? 0 : -1} aria-current={c.selected ? 'true' : undefined} data-tip={tipCard(title, rows)} onFocus={() => setFocused(i)} onClick={() => onSelect(c.target)}>
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
export function MiniStrip({ origins, max = 60, className = 'ms', said }: { origins: readonly Origin7[]; max?: number; className?: string; said?: string | undefined }) {
  const cells = useMemo(() => miniCells(origins, max), [origins, max]);
  // With `said`, a screen reader hears the calls by origin, held inside the strip; without, the strip is a picture only.
  return (
    <span className={className} style={{ gridTemplateColumns: `repeat(${Math.max(1, cells.length)}, minmax(0, 1fr))` }} aria-hidden={said ? undefined : 'true'}>
      {cells.map((o, i) => (
        <i key={i} className={o} />
      ))}
      {said ? <span className="sr">{said}</span> : null}
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
