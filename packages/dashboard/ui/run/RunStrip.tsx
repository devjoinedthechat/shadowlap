import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { stripDetail } from '../components/Strip.js';
import { tipCard, type TipRow } from '../components/HoverCard.js';
import { callName } from '../format.js';
import { useMedia } from '../hooks.js';
import { ORIGIN_COLOR, ORIGIN_NAME, ORIGIN_RANK, ORIGINS, type Origin7 } from '../origins.js';
import { dimRanges, markRanges, stripCapacity, stripRanges, stripStep, stripTabStop, type Cell, type StripItem, type StripKey } from '../strip.js';
import type { CallRow } from '../types.js';
import { originOf } from './calls.js';
import { callKind, isKind, KIND_COLOR, KIND_NAME, KIND_RANK, KINDS, kindLabel, kindValue, kindWords, ownKind, type Kind } from './kinds.js';

/**
 * The run page's strip: every call in the colour of what it was (a recording or a capture, by kind)
 * or of what happened to it (a replay, a fork, a test, by origin), so a run's shape shows at a
 * glance. Where the calls don't fit a cell of 6px (24px to a finger) with 3px between, they are drawn
 * 1px apart, a range a cell where that takes more room than the strip has: a range is drawn in what
 * most of its calls are and notches its rarer notable call. It groups again as it resizes. A fork and
 * a lost call are flagged; a live run grows a pulsing cell for the call to come. The strip is one Tab
 * stop, a listbox: ← and → select the next call, a range at a time where grouped, Home and End the
 * ends, and the focus follows the selection.
 */

/** A call on the strip: its origin and kind (from the run's strings while its page isn't read), and its row once read. */
export interface RunStripCall extends StripItem {
  kind: Kind | null;
  call: CallRow | null;
}

export interface RunStripProps {
  calls: readonly RunStripCall[];
  byKind: boolean;
  selected: number | null;
  forkAt: number | null;
  lostAt: number | null;
  inScope: ((n: number) => boolean) | null;
  /** The call filter's pick, dimming the cells it leaves out; null for all. */
  pick: string | null;
  live: boolean;
  onSelect: (n: number) => void;
}

const BY_KIND: StripKey<RunStripCall> = { of: (c) => c.kind ?? (c.origin === 'fail' ? 'k-err' : 'none'), rank: KIND_RANK };
const BY_ORIGIN: StripKey<RunStripCall> = { of: (c) => c.origin, rank: ORIGIN_RANK };

/** The room the cells have, measured a frame at a time as the strip resizes; 600px before a measure (the test renderer has none). */
function useRoom(el: React.RefObject<HTMLDivElement | null>): number {
  const [room, setRoom] = useState(600);
  useLayoutEffect(() => {
    const box = el.current;
    if (!box || typeof ResizeObserver !== 'function') return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const cs = getComputedStyle(box);
      const w = Math.floor(box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      if (w > 0) setRoom(w);
    };
    measure();
    const ro = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(measure);
    });
    ro.observe(box);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [el]);
  return room;
}

/** A call's name, as its option says it: `#18 issue_refund · write · live`, the fork point or the lost call said after. */
function callWord(c: RunStripCall, cell: Cell): string {
  const at = cell.mark === 'fork' ? ' · fork point' : cell.mark === 'lost' ? ' · lost here' : '';
  if (!c.call) return `#${c.n.toLocaleString('en-US')}${c.kind ? ` · ${KIND_NAME[c.kind]}` : ''} · ${ORIGIN_NAME[c.origin]} · not read yet${at}`;
  return `#${c.n.toLocaleString('en-US')} ${callName(c.call.kind, c.call.name)} · ${ownKind(c.call)} · ${ORIGIN_NAME[c.origin]}${at}`;
}

/** A call's card: its name, and a row of its kind or origin with what it says beside it. */
function callTip(c: RunStripCall, byKind: boolean): string {
  const color = byKind ? (c.kind ? KIND_COLOR[c.kind] : undefined) : ORIGIN_COLOR[c.origin];
  const title = c.call ? `#${c.n.toLocaleString('en-US')} ${callName(c.call.kind, c.call.name)}` : `#${c.n.toLocaleString('en-US')}`;
  if (!c.call) return tipCard(title, [{ label: byKind && c.kind ? KIND_NAME[c.kind] : ORIGIN_NAME[c.origin], value: 'not read yet', ...(color ? { color } : {}) }]);
  const row: TipRow = byKind ? { label: kindLabel(c.call), value: kindValue(c.call), ...(color ? { color } : {}) } : { label: ORIGIN_NAME[c.origin], value: stripDetail(c.call), ...(color ? { color } : {}) };
  return tipCard(title, [row]);
}

/** A range's rows: each kind or origin it holds, with its count. */
function rangeRows(cell: Cell, byKind: boolean): TipRow[] {
  const keys: readonly string[] = byKind ? KINDS : ORIGINS;
  return keys.filter((k) => cell.counts[k]).map((k) => {
    const n = cell.counts[k]!;
    return { label: isKind(k) ? kindWords(k, n) : ORIGIN_NAME[k as Origin7], value: n.toLocaleString('en-US'), color: isKind(k) ? KIND_COLOR[k] : ORIGIN_COLOR[k as Origin7] };
  });
}

export const RunStrip = memo(function RunStrip({ calls, byKind, selected, forkAt, lostAt, inScope, pick, live, onSelect }: RunStripProps) {
  const strip = useRef<HTMLDivElement>(null);
  const room = useRoom(strip);
  const coarse = useMedia('(pointer: coarse)');
  const capacity = stripCapacity(calls.length, room, coarse, live);
  const key = byKind ? BY_KIND : BY_ORIGIN;
  // Grouped once for the calls, the room and the key; the selection and the marks are a walk over the cells drawn.
  const ranges = useMemo(() => stripRanges(calls, capacity, key), [calls, capacity, key]);
  const dims = useMemo(() => dimRanges(ranges, inScope, pick), [ranges, inScope, pick]);
  const cells = useMemo(() => markRanges(ranges, dims, { selected, forkAt, lostAt }), [ranges, dims, selected, forkAt, lostAt]);
  const binned = capacity !== null;
  const stop = stripTabStop(cells);
  // After a key moved the selection, its cell takes the focus.
  const follow = useRef(false);
  useEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    strip.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus();
  }, [selected]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    // At an end nothing further, and the page doesn't scroll; the run's own ← → never see these.
    e.preventDefault();
    e.stopPropagation();
    const to = stripStep(cells, selected, e.key, binned);
    if (to === null) return;
    follow.current = true;
    onSelect(to);
  };
  const byNo = (n: number) => calls[n - 1]?.n === n ? calls[n - 1] : calls.find((c) => c.n === n);
  return (
    <div className={`cells${binned ? ' binned' : ''}`} style={{ gridTemplateColumns: `repeat(${Math.max(1, cells.length + (live ? 1 : 0))}, minmax(0, 1fr))` }} role="listbox" aria-orientation="horizontal" aria-label={byKind ? 'Calls, by kind' : 'Calls, by origin'} ref={strip} onKeyDown={onKey}>
      {cells.map((c, i) => {
        const one = c.first === c.last ? byNo(c.first) : undefined;
        const name = one ? callWord(one, c) : `Calls #${c.first.toLocaleString('en-US')} to #${c.last.toLocaleString('en-US')}: ${rangeRows(c, byKind).map((r) => `${r.value} ${r.label}`).join(', ')}`;
        const tip = one ? callTip(one, byKind) : tipCard(`#${c.first.toLocaleString('en-US')}–${c.last.toLocaleString('en-US')}`, rangeRows(c, byKind));
        const cls = [c.cls, c.mark ? 'mark' : '', c.mark === 'lost' ? 'bl' : '', c.dim ? 'dim' : ''].filter(Boolean).join(' ');
        return (
          <button key={c.key} type="button" role="option" className={cls} aria-selected={c.selected} aria-current={c.selected ? 'true' : undefined} tabIndex={i === stop ? 0 : -1} aria-label={name} data-tip={tip} onClick={() => onSelect(c.target)}>
            {c.tick && !one ? <i className={`tk ${c.tick}`} style={{ left: `${(8 + c.tickAt * 84).toFixed(1)}%` }} aria-hidden="true" /> : null}
            {c.mark ? <span className="flag">{c.mark}</span> : null}
          </button>
        );
      })}
      {live ? <button type="button" className="pending next" tabIndex={-1} aria-hidden="true" /> : null}
    </div>
  );
});

/** The strip's calls: each read call's origin and kind, and while a long run's pages come, every other call's from the run's strings. */
export function useStripCalls(calls: readonly CallRow[], origins: readonly Origin7[] | null | undefined, kinds: readonly Kind[] | null | undefined): RunStripCall[] {
  return useMemo(() => {
    const own = (c: CallRow): RunStripCall => ({ n: c.callNo, origin: originOf(c), kind: callKind(c), call: c });
    if (!origins) return calls.map(own);
    const byNo = new Map(calls.map((c) => [c.callNo, c]));
    return origins.map((origin, i) => {
      const c = byNo.get(i + 1);
      return c ? own(c) : { n: i + 1, origin, kind: kinds?.[i] ?? null, call: null };
    });
  }, [calls, origins, kinds]);
}
