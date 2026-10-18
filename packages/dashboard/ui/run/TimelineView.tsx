import { useMemo } from 'react';
import type { CallRow } from '../api.js';
import { tipCard } from '../components/HoverCard.js';
import { callName, dur } from '../format.js';
import { ORIGIN_COLOR, ORIGIN_NAME } from '../origins.js';
import { scopeDepth, scopeLeaf, scopesOf } from '../scopes.js';
import { originOf, ticksFor, timelineOf, type TimelineRow } from './model.js';
import { useWindow } from './window-hook.js';

/**
 * Timeline: every call on one clock, coloured by origin, with a notch where a streamed answer's first
 * token arrived. With scopes, each scope gets a header showing the span it was busy. The summary
 * line says where the time went and what ran at once. Only the rows in view and a screenful either
 * side are drawn (window-hook.ts).
 */

/** A line of the clock: a scope's header with the span it was busy, or a call. */
type ClockLine = { kind: 'head'; scope: string; a: number; b: number } | { kind: 'row'; row: TimelineRow<CallRow> };

const CLOCK_LINES = {
  keyOf: (l: ClockLine) => (l.kind === 'head' ? `s:${l.scope}` : l.row.call.callNo),
  shapeOf: (l: ClockLine) => l.kind,
  estimate: () => 22,
};
export function TimelineView({ calls, selected, scoped, onSelect }: { calls: CallRow[]; selected: number | null; scoped: boolean; onSelect: (n: number) => void }) {
  const clock = useMemo(() => timelineOf(calls), [calls]);
  const { rows, end, parallel } = clock;
  // The calls that started while another ran: marked ∥ on their line.
  const lanes = useMemo(() => new Set(parallel.map(([, b]) => b)), [parallel]);
  const lines = useMemo<ClockLine[]>(() => {
    if (!scoped) return rows.map((row) => ({ kind: 'row', row }));
    const byNo = new Map(rows.map((r) => [r.call.callNo, r]));
    const out: ClockLine[] = [];
    for (const sc of scopesOf(calls)) {
      const rs = calls.filter((c) => c.scope === sc).map((c) => byNo.get(c.callNo)).filter((r): r is TimelineRow<CallRow> => !!r);
      if (!rs.length) continue;
      let a = Infinity;
      let b = -Infinity;
      for (const r of rs) {
        a = Math.min(a, r.start);
        b = Math.max(b, r.end);
      }
      out.push({ kind: 'head', scope: sc, a, b });
      for (const row of rs) out.push({ kind: 'row', row });
    }
    for (const c of calls) {
      const r = c.scope ? undefined : byNo.get(c.callNo);
      if (r) out.push({ kind: 'row', row: r });
    }
    return out;
  }, [rows, calls, scoped]);
  const win = useWindow(lines, CLOCK_LINES);
  if (!rows.length) return <div className="empty">{calls.length ? 'These calls carry no timing, so they have no place on a clock.' : 'No calls yet.'}</div>;
  const pct = (ms: number) => `${(ms / end) * 100}%`;
  const row = (r: TimelineRow<CallRow>, at: number) => {
    const c = r.call;
    const o = originOf(c);
    const ms = r.end - r.start;
    const tip = tipCard(`#${c.callNo} ${callName(c.kind, c.name)}`, [{ label: ORIGIN_NAME[o], value: dur(ms), color: ORIGIN_COLOR[o] }, ...(r.firstToken !== null ? [{ label: 'first token', value: dur(r.firstToken), color: 'var(--dim)' }] : [])]);
    return (
      <div key={c.callNo} data-wi={at} className={`tl-row${c.callNo === selected ? ' sel' : ''}`} onClick={() => onSelect(c.callNo)}>
        <span className="lab">
          #{c.callNo} {callName(c.kind, c.name)}
          {lanes.has(c.callNo) ? ' ∥' : ''}
        </span>
        <span className="lane">
          <i className={`bar ${o}`} style={{ left: pct(r.start), width: `max(3px, ${(Math.max(ms, 0) / end) * 100}%)` }} data-tip={tip}>
            {r.firstToken !== null && ms > 0 ? <i className="ft" style={{ left: `${Math.min(100, (r.firstToken / ms) * 100)}%` }} /> : null}
          </i>
        </span>
      </div>
    );
  };
  let modelMs = 0;
  let toolMs = 0;
  for (const r of rows) {
    if (r.call.kind === 'api') modelMs += r.end - r.start;
    else toolMs += r.end - r.start;
  }
  const longest = rows.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  return (
    <>
      <div className="tl">
        <div className="tl-axis">
          {ticksFor(end).map((t) => (
            <span key={t.at} style={{ left: pct(t.at) }}>
              {t.label}
            </span>
          ))}
        </div>
        <div className="tl-rows" ref={win.listRef}>
          {win.before ? <div aria-hidden="true" style={{ height: win.before }} /> : null}
          {lines.slice(win.start, win.end).map((l, j) =>
            l.kind === 'row' ? (
              row(l.row, win.start + j)
            ) : (
              <div key={`s:${l.scope}`} data-wi={win.start + j} className="tl-row tl-head">
                <span className="lab" title={l.scope}>
                  <code>{scopeDepth(l.scope) ? `↳ ${scopeLeaf(l.scope)}` : l.scope}</code>
                </span>
                <span className="lane">
                  <i className="span" style={{ left: pct(l.a), width: `max(3px, ${((l.b - l.a) / end) * 100}%)` }} data-tip={tipCard(l.scope, [{ label: 'busy', value: dur(l.b - l.a) }])} />
                </span>
              </div>
            ),
          )}
          {win.after ? <div aria-hidden="true" style={{ height: win.after }} /> : null}
        </div>
      </div>
      <div className="tl-sum">
        <span>
          wall clock <b>{dur(end)}</b>
        </span>
        <span>
          model <b>{dur(modelMs)}</b>
        </span>
        <span>
          tools <b>{dur(toolMs)}</b>
        </span>
        <span>
          longest{' '}
          <b>
            #{longest.call.callNo} {callName(longest.call.kind, longest.call.name)} · {dur(longest.end - longest.start)}
          </b>
        </span>
        <span>
          ran at once <b>{parallel.length ? parallel.slice(0, 4).map(([x, y]) => `#${x} + #${y}`).join(', ') + (parallel.length > 4 ? ` +${parallel.length - 4}` : '') : 'none'}</b>
        </span>
        {rows.some((r) => r.firstToken !== null) ? (
          <span>
            <i className="ftkey" />
            first token
          </span>
        ) : null}
      </div>
    </>
  );
}
