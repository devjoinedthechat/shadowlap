import { memo, useEffect, useRef } from 'react';
import type { CallRow } from '../api.js';
import { Org } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { callName, kindShort } from '../format.js';
import type { CallIndex } from '../recorded.js';
import { callDetail, originOf, resultLine, timeOf, tokensText } from './model.js';
import { useWindow } from './window-hook.js';

/**
 * Calls: #, call, origin, tokens, time. A tool's result sits on a second line under it. A replayed
 * call's time is its recorded duration, in grey: the replay did not wait for it. Each row has a fork
 * button, shown on hover and on the selected row. Only the rows in view and a screenful either side
 * are drawn (window-hook.ts), so a run of 50,000 calls opens and moves as one of fifty does.
 */

export type OriginFilter = 'all' | 'live' | 'rep' | 'over' | 'inject' | 'fail' | 'block';

export function matchesFilter(c: CallRow, f: OriginFilter, text: string, asked?: string | null): boolean {
  const o = originOf(c);
  if (f === 'block' ? o !== 'block' && o !== 'stub' : f !== 'all' && o !== f) return false;
  if (!text) return true;
  const d = callDetail(c, asked).text;
  const res = resultLine(c)?.text ?? '';
  return `${callName(c.kind, c.name)} ${c.name} ${d} ${res} ${c.model ?? ''} #${c.callNo}`.toLowerCase().includes(text.toLowerCase());
}

export function CallsToolbar({ counts, filter, onFilter, text, onText, inputRef }: { counts: Record<OriginFilter, number>; filter: OriginFilter; onFilter: (f: OriginFilter) => void; text: string; onText: (t: string) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const items: Array<[OriginFilter, string]> = [
    ['all', 'All'],
    ['live', 'Live'],
    ['rep', 'Replayed'],
    ...(counts.over ? ([['over', 'Overridden']] as Array<[OriginFilter, string]>) : []),
    ...(counts.inject ? ([['inject', 'Injected']] as Array<[OriginFilter, string]>) : []),
    ...(counts.fail ? ([['fail', 'Failed']] as Array<[OriginFilter, string]>) : []),
    ['block', 'Fenced'],
  ];
  return (
    <div className="toolbar">
      <div className="ofilter" role="group" aria-label="Filter by origin">
        {items.map(([f, label]) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => onFilter(f)}>
            {label}
            <b>{counts[f].toLocaleString('en-US')}</b>
          </button>
        ))}
      </div>
      <label className="filter-in">
        <span className="sr">Filter calls</span>
        <input
          ref={inputRef}
          type="search"
          placeholder="Filter calls"
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && (e.currentTarget.value || document.activeElement === e.currentTarget)) {
              e.stopPropagation();
              if (e.currentTarget.value) onText('');
              else e.currentTarget.blur();
            }
          }}
        />
        <span className="kbd">/</span>
      </label>
    </div>
  );
}

/** A call's row is one line, or two with a result under it: the window places rows by these shapes. */
const callShape = (c: CallRow) => (resultLine(c) ? 'two' : 'one');
const CALL_ROWS = { keyOf: (c: CallRow) => c.callNo, shapeOf: callShape, estimate: (shape: string) => (shape === 'two' ? 50 : 33) };

export function CallsTable({ calls, asked, selected, scoped, forkAt, lostAt, ancestors, live, canFork, onSelect, onFork }: { calls: CallRow[]; asked: ReadonlyMap<number, string> | null; selected: number | null; scoped: boolean; forkAt: number | null; lostAt: number | null; ancestors: readonly CallIndex[]; live: boolean; canFork: boolean; onSelect: (n: number) => void; onFork: (n: number, el: HTMLElement) => void }) {
  const head = useRef<HTMLTableSectionElement>(null);
  const placed = useRef(false);
  const win = useWindow(calls, CALL_ROWS);
  const { show } = win;
  const latest = useRef(calls);
  latest.current = calls;
  // Keep the selected row in view, scrolling the views pane only: centred when the run opens, by as
  // little as it takes after that.
  useEffect(() => {
    const i = selected === null ? -1 : latest.current.findIndex((c) => c.callNo === selected);
    if (i < 0) return;
    show(i, { centre: !placed.current, head: head.current?.offsetHeight ?? 34 });
    placed.current = true;
  }, [selected, show]);
  if (!calls.length) return <div className="empty">No calls match.</div>;
  const cols = scoped ? 7 : 6;
  return (
    <table className="calls" aria-rowcount={calls.length + 1}>
      <thead ref={head}>
        <tr aria-rowindex={1}>
          <th className="n">#</th>
          <th>Call</th>
          {scoped ? <th className="hide-sm">Scope</th> : null}
          <th>Origin</th>
          <th className="num tok">Tokens</th>
          <th className="num">Time</th>
          <th className="rowact">
            <span className="sr">Fork</span>
          </th>
        </tr>
      </thead>
      <tbody ref={win.listRef}>
        {win.before ? <Spacer height={win.before} cols={cols} /> : null}
        {calls.slice(win.start, win.end).map((c, j) => (
          <Row key={c.callNo} at={win.start + j} c={c} asked={c.kind === 'api' && asked ? (asked.get(c.callNo) ?? null) : undefined} selected={c.callNo === selected} scoped={scoped} mark={c.callNo === forkAt ? 'fork' : c.callNo === lostAt ? 'lost' : null} ancestors={ancestors} live={live} canFork={canFork} onSelect={onSelect} onFork={onFork} />
        ))}
        {win.after ? <Spacer height={win.after} cols={cols} /> : null}
      </tbody>
    </table>
  );
}

/** The height of the rows not drawn, above or below those that are. */
function Spacer({ height, cols }: { height: number; cols: number }) {
  return (
    <tr className="wspace" aria-hidden="true" style={{ height }}>
      <td colSpan={cols} />
    </tr>
  );
}

const Row = memo(function Row({ at, c, asked, selected, scoped, mark, ancestors, live, canFork, onSelect, onFork }: { at: number; c: CallRow; asked: string | null | undefined; selected: boolean; scoped: boolean; mark: 'fork' | 'lost' | null; ancestors: readonly CallIndex[]; live: boolean; canFork: boolean; onSelect: (n: number) => void; onFork: (n: number, el: HTMLElement) => void }) {
  const d = callDetail(c, asked);
  const res = resultLine(c);
  const t = timeOf(c, ancestors, live);
  return (
    <tr data-wi={at} aria-rowindex={at + 2} aria-selected={selected} onClick={() => onSelect(c.callNo)}>
      <td className="n">
        {mark ? <span className={`fk${mark === 'lost' ? ' bl' : ''}`}>{mark === 'fork' ? 'FORK' : 'LOST'}</span> : null}
        {c.callNo}
      </td>
      <td className="name" title={c.name}>
        <small>{kindShort(c.kind)}</small>
        {callName(c.kind, c.name)}
        {c.input ? <span className="eff input">input</span> : c.effect ? <span className={`eff ${c.effect}`}>{c.effect}</span> : null}
        {c.attempts ? <span className="det" title={`${c.attempts} ${c.attempts === 1 ? 'retry' : 'retries'} before the final outcome`}>+{c.attempts}</span> : null}
        {d.text ? <span className={`det${d.err ? ' err' : ''}`}>{d.text}</span> : null}
        {res ? <span className={`res${res.err ? ' err' : ''}`}>→ {res.text}</span> : null}
      </td>
      {scoped ? (
        <td className="hide-sm scopecell">
          <code>{c.scope ?? ''}</code>
        </td>
      ) : null}
      <td>
        <Org origin={originOf(c)} />
      </td>
      <td className="num tok">{tokensText(c)}</td>
      <td className={`num${t.was ? ' was' : ''}`} title={t.was && t.text !== '—' ? 'recorded; not waited in this run' : undefined}>
        {t.text}
      </td>
      <td className="rowact">
        {canFork ? (
          <button
            type="button"
            aria-label={`Fork at #${c.callNo}`}
            title={`Fork at #${c.callNo}`}
            onClick={(e) => {
              e.stopPropagation();
              onFork(c.callNo, e.currentTarget);
            }}
          >
            <Icon name="fork" />
          </button>
        ) : null}
      </td>
    </tr>
  );
});
