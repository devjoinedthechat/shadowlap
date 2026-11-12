import { Fragment, useMemo, useState } from 'react';
import type { CallRow, RunDetail } from '../api.js';
import { Seg } from '../components/bits.js';
import { tipCard } from '../components/HoverCard.js';
import { cacheMisses, cacheNote, cacheReadShare, missStat, usedCache, wholeInput } from '../cache.js';
import { ktok, num } from '../format.js';
import { INPUT_PARTS } from '../../../engine/src/tokens.js';
import { inputTicks, outputTop, tickLabel } from './context-axis.js';
import { useWindow } from './window-hook.js';

/**
 * Context: what each model call sent, split by what the cache did with it (cache read, cache creation, uncached),
 * the output under it, and where the cache stopped hitting, judged within each scope and
 * conversation (a model call reading less from the cache than the previous call's whole input, by
 * 1,024 tokens or more). Past 360 model calls a bar stands for a range of them and shows its largest
 * context, as the origin strip does; the table draws only the rows in view (window-hook.ts).
 */

let asTable = false;

/** The chart's bars past this many model calls stand for ranges of them. */
export const MAX_BARS = 360;

export interface ContextBar {
  first: number;
  last: number;
  /** How many model calls it stands for. */
  size: number;
  /** The call with the largest context in the range: its bar is drawn. */
  call: CallRow;
  /** The range's largest output. */
  out: number;
  /** The tokens the range's misses sent again, and the first of them; null without a miss. */
  miss: { tokens: number; callNo: number } | null;
}

/** The chart's bars: one per model call, or past `max` one per range of them, each drawn as its largest context. */
export function contextBars(ms: readonly CallRow[], misses: ReadonlyMap<number, number>, max = MAX_BARS): ContextBar[] {
  const size = ms.length > max ? Math.ceil(ms.length / max) : 1;
  const out: ContextBar[] = [];
  for (let i = 0; i < ms.length; i += size) {
    let call = ms[i]!;
    let most = 0;
    let miss = null as ContextBar['miss'];
    const end = Math.min(ms.length, i + size);
    for (let j = i; j < end; j++) {
      const c = ms[j]!;
      if (wholeInput(c.usage!) > wholeInput(call.usage!)) call = c;
      most = Math.max(most, c.usage!.output);
      const sent = misses.get(c.callNo);
      if (sent !== undefined) miss = { tokens: (miss?.tokens ?? 0) + sent, callNo: miss?.callNo ?? c.callNo };
    }
    out.push({ first: ms[i]!.callNo, last: ms[end - 1]!.callNo, size: end - i, call, out: most, miss });
  }
  return out;
}

const TABLE_ROWS = { keyOf: (c: CallRow) => c.callNo, shapeOf: () => 'row', estimate: () => 28 };

/** The table's heads for the parts of a call's input: Cache read, Cache creation, Uncached. */
const HEADS = Object.fromEntries(Object.entries(INPUT_PARTS).map(([k, part]) => [k, `${part.charAt(0).toUpperCase()}${part.slice(1)}`])) as Record<keyof typeof INPUT_PARTS, string>;

export function ContextView({ run, calls, selected, onSelect }: { run: RunDetail; calls: CallRow[]; selected: number | null; onSelect: (n: number) => void }) {
  const [table, setTableState] = useState(asTable);
  const setTable = (t: boolean) => {
    asTable = t;
    setTableState(t);
  };
  const ms = useMemo(() => calls.filter((c) => c.kind === 'api' && c.usage && c.outcome !== 'error'), [calls]);
  const win = useWindow(table ? ms : [], TABLE_ROWS);
  if (!ms.length) return <div className="empty">{calls.some((c) => c.kind === 'api') ? 'No model call reported token usage, so there is no context to show.' : 'No model calls yet.'}</div>;
  // The server's misses when it judged them (for the whole run, or on each call); the same rule here
  // otherwise. Only those among the calls shown (the scope picked) count.
  const judged = run.cache?.misses ?? (ms.some((c) => c.cacheMiss !== undefined) ? ms.flatMap((c) => (c.cacheMiss ? [{ callNo: c.callNo, tokens: c.cacheMiss.sentAgain }] : [])) : null);
  const shownNos = new Set(ms.map((c) => c.callNo));
  const shownMisses = (judged ?? cacheMisses(ms)).filter((m) => shownNos.has(m.callNo));
  const misses = new Map(shownMisses.map((m) => [m.callNo, m.tokens]));
  // A fork whose change made a miss: the request path that changed.
  const d = run.run.divergence;
  const note = cacheNote(ms, shownMisses, d ? { callNo: d.callNo, path: d.diff?.[0]?.path ?? null } : null);
  const stat = missStat(ms, shownMisses);
  // Calls that never used the cache miss on every turn: the note says so once, not a label per bar.
  const labelMisses = usedCache(ms);
  const big = ms.reduce((a, b) => (wholeInput(b.usage!) > wholeInput(a.usage!) ? b : a));
  const share = cacheReadShare(ms);
  return (
    <>
      <div className="cstats">
        <div>
          <b>{ktok(wholeInput(big.usage!))}</b>
          <span>{`largest context\u00a0· #${big.callNo}`}</span>
        </div>
        <div>
          <b>{Math.round(share * 100)}%</b>
          <span>of input read from the cache</span>
        </div>
        <div>
          <b className={stat.warn ? 'warn' : undefined}>{stat.value}</b>
          <span>{stat.label}</span>
        </div>
      </div>
      <div className="ctx">
        <div className="ctxtop">
          <div className="legend">
            <span>
              <i className="lc-read" />
              {INPUT_PARTS.cacheRead}
            </span>
            <span>
              <i className="lc-write" />
              {INPUT_PARTS.cacheCreation}
            </span>
            <span>
              <i className="lc-unc" />
              {INPUT_PARTS.uncached}
            </span>
            <span>
              <i className="lc-out" />
              output, on its own axis
            </span>
          </div>
          <Seg
            label="Show as"
            items={[
              { key: 'chart', label: 'Chart' },
              { key: 'table', label: 'Table' },
            ]}
            value={table ? 'table' : 'chart'}
            onChange={(k) => setTable(k === 'table')}
          />
        </div>
        {table ? (
          <table className="ctab">
            <thead>
              <tr>
                <th>Call</th>
                <th>{HEADS.cacheRead}</th>
                <th>{HEADS.cacheCreation}</th>
                <th>{HEADS.uncached}</th>
                <th>Output</th>
                <th>Input total</th>
              </tr>
            </thead>
            <tbody ref={win.listRef}>
              {win.before ? (
                <tr className="wspace" aria-hidden="true" style={{ height: win.before }}>
                  <td colSpan={6} />
                </tr>
              ) : null}
              {ms.slice(win.start, win.end).map((c, j) => (
                <tr key={c.callNo} data-wi={win.start + j} data-acts="" className={misses.has(c.callNo) ? 'miss' : undefined} onClick={() => onSelect(c.callNo)}>
                  <td>#{c.callNo}</td>
                  <td>{num(c.usage!.cacheRead)}</td>
                  <td>{num(c.usage!.cacheWrite)}</td>
                  <td>{num(c.usage!.input)}</td>
                  <td>{num(c.usage!.output)}</td>
                  <td>{num(wholeInput(c.usage!))}</td>
                </tr>
              ))}
              {win.after ? (
                <tr className="wspace" aria-hidden="true" style={{ height: win.after }}>
                  <td colSpan={6} />
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : (
          <ContextChart ms={ms} misses={misses} max={Math.max(1, wholeInput(big.usage!))} labelMisses={labelMisses} selected={selected} onSelect={onSelect} />
        )}
        <p className="cnote">
          {note.lead ? (
            <>
              <b>{note.lead}</b>{' '}
            </>
          ) : null}
          {note.parts.map((p, i) => (typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : <code key={i}>{p.code}</code>))}
        </p>
      </div>
    </>
  );
}

/**
 * The chart: the input's axis and gridlines beside the bars, the output's own axis running down from
 * the baseline beside its bars (context-axis.ts), and the call numbers under both. The axes are drawn
 * for the eye alone: each bar's card and the table say the numbers.
 */
function ContextChart({ ms, misses, max, labelMisses, selected, onSelect }: { ms: CallRow[]; misses: ReadonlyMap<number, number>; max: number; labelMisses: boolean; selected: number | null; onSelect: (n: number) => void }) {
  const bars = contextBars(ms, misses);
  let outMax = 0;
  for (const b of bars) outMax = Math.max(outMax, b.out);
  const top = outputTop(outMax);
  const ticks = inputTicks(max);
  const many = bars.length > 80;
  // A label per bar while they fit (the design's thirty-call run); past that, every few, so they never run together.
  const every = Math.max(1, Math.ceil(bars.length / (many ? 12 : 22)));
  const modelNos = new Set(ms.map((c) => c.callNo));
  const holds = (b: ContextBar) => selected !== null && selected >= b.first && selected <= b.last && modelNos.has(selected);
  const h = (v: number) => `${((v / max) * 100).toFixed(2)}%`;
  return (
    <div className="cplot">
      <div className="yaxis" aria-hidden="true">
        {ticks.map((v) => (
          <span key={v} style={{ bottom: h(v) }}>
            {tickLabel(v)}
          </span>
        ))}
      </div>
      <div className={`cbars${many ? ' many' : ''}`}>
        {ticks.slice(1).map((v) => (
          <span key={`gl${v}`} className="gl" style={{ bottom: h(v) }} />
        ))}
        {bars.map((b) => {
          const c = b.call;
          const u = c.usage!;
          const range = b.size > 1;
          const tip = tipCard(range ? `#${num(b.first)}–#${num(b.last)} · largest #${num(c.callNo)}, ${num(wholeInput(u))} input tokens` : `#${c.callNo} · ${num(wholeInput(u))} input tokens`, [
            { label: INPUT_PARTS.cacheRead, value: num(u.cacheRead), color: 'var(--c-read)' },
            { label: INPUT_PARTS.cacheCreation, value: num(u.cacheWrite), color: 'var(--c-write)' },
            { label: INPUT_PARTS.uncached, value: num(u.input), color: 'var(--c-unc)' },
            { label: 'output', value: num(u.output), color: 'var(--c-out)' },
            ...(b.miss ? [{ label: range ? 'sent again in the range' : 'sent again', value: num(b.miss.tokens), color: 'var(--warn)' }] : []),
          ]);
          // A range opens its miss, else the call picked in it, else its largest context.
          const opens = b.miss?.callNo ?? (holds(b) ? selected! : c.callNo);
          return (
            <div key={b.first} className={`cbar${holds(b) ? ' sel' : ''}`} data-tip={tip} data-acts="" onClick={() => onSelect(opens)}>
              {u.cacheRead ? <i className="seg-read" style={{ height: h(u.cacheRead) }} /> : null}
              <i className="seg-write" style={{ height: h(u.cacheWrite) }} />
              <i className="seg-unc" style={{ height: `max(2px, ${h(u.input)})` }} />
              {labelMisses && b.miss ? (
                <span className="miss" style={{ bottom: `calc(${h(wholeInput(u))} + 8px)` }}>
                  cache miss
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="yaxis yout" aria-hidden="true">
        <span style={{ bottom: '50%' }}>{top / 2}</span>
        <span style={{ bottom: 0 }}>{top}</span>
      </div>
      <div className={`couts${many ? ' many' : ''}`}>
        {bars.map((b) => (
          <i key={b.first} style={{ height: `${((b.out / top) * 100).toFixed(2)}%` }} />
        ))}
      </div>
      <span />
      <div className={`clabels${many ? ' many' : ''}`}>
        {bars.map((b, i) => (
          <span key={b.first} className={holds(b) ? 'sel' : undefined}>
            {i % every === 0 ? `#${num(b.first)}` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
