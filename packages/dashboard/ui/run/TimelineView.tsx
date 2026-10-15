import type { CallRow } from '../api.js';
import { tipCard } from '../components/HoverCard.js';
import { callName, dur } from '../format.js';
import { ORIGIN_COLOR, ORIGIN_NAME } from '../origins.js';
import { scopeDepth, scopeLeaf, scopesOf } from '../scopes.js';
import { originOf, ticksFor, timelineOf, type TimelineRow } from './model.js';

/**
 * Timeline: every call on one clock, coloured by origin, with a notch where a streamed answer's first
 * token arrived. With scopes, each scope gets a header showing the span it was busy. The summary
 * line says where the time went and what ran at once.
 */
export function TimelineView({ calls, selected, scoped, onSelect }: { calls: CallRow[]; selected: number | null; scoped: boolean; onSelect: (n: number) => void }) {
  const { rows, end, parallel } = timelineOf(calls);
  if (!rows.length) return <div className="empty">No calls yet.</div>;
  const pct = (ms: number) => `${(ms / end) * 100}%`;
  const row = (r: TimelineRow) => {
    const c = r.call;
    const o = originOf(c);
    const ms = r.end - r.start;
    const tip = tipCard(`#${c.callNo} ${callName(c.kind, c.name)}`, [{ label: ORIGIN_NAME[o], value: dur(ms), color: ORIGIN_COLOR[o] }, ...(r.firstToken !== null ? [{ label: 'first token', value: dur(r.firstToken), color: 'var(--dim)' }] : [])]);
    const lane = parallel.some(([, b]) => b === c.callNo);
    return (
      <div key={c.callNo} className={`tl-row${c.callNo === selected ? ' sel' : ''}`} onClick={() => onSelect(c.callNo)}>
        <span className="lab">
          #{c.callNo} {callName(c.kind, c.name)}
          {lane ? ' ∥' : ''}
        </span>
        <span className="lane">
          <i className={`bar ${o}`} style={{ left: pct(r.start), width: `max(3px, ${(Math.max(ms, 0) / end) * 100}%)` }} data-tip={tip}>
            {r.firstToken !== null && ms > 0 ? <i className="ft" style={{ left: `${Math.min(100, (r.firstToken / ms) * 100)}%` }} /> : null}
          </i>
        </span>
      </div>
    );
  };
  const byNo = new Map(rows.map((r) => [r.call.callNo, r]));
  let modelMs = 0;
  let toolMs = 0;
  for (const r of rows) {
    if (r.call.kind === 'api') modelMs += r.end - r.start;
    else toolMs += r.end - r.start;
  }
  const longest = rows.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const groups = scoped
    ? scopesOf(calls).map((sc) => {
        const rs = calls.filter((c) => c.scope === sc).map((c) => byNo.get(c.callNo)).filter((r): r is TimelineRow => !!r);
        return { sc, rs };
      })
    : [];
  const unscoped = scoped ? calls.filter((c) => !c.scope).map((c) => byNo.get(c.callNo)).filter((r): r is TimelineRow => !!r) : rows;
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
        <div className="tl-rows">
          {groups.map(({ sc, rs }) => {
            if (!rs.length) return null;
            const a = Math.min(...rs.map((r) => r.start));
            const b = Math.max(...rs.map((r) => r.end));
            return (
              <div key={sc}>
                <div className="tl-row tl-head">
                  <span className="lab" title={sc}>
                    <code>{scopeDepth(sc) ? `↳ ${scopeLeaf(sc)}` : sc}</code>
                  </span>
                  <span className="lane">
                    <i className="span" style={{ left: pct(a), width: `max(3px, ${((b - a) / end) * 100}%)` }} data-tip={tipCard(sc, [{ label: 'busy', value: dur(b - a) }])} />
                  </span>
                </div>
                {rs.map(row)}
              </div>
            );
          })}
          {unscoped.map(row)}
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
