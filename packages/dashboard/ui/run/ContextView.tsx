import { useState } from 'react';
import type { CallRow, RunDetail } from '../api.js';
import { Seg } from '../components/bits.js';
import { tipCard } from '../components/HoverCard.js';
import { cacheMisses, cacheReadShare, wholeInput } from '../cache.js';
import { ktok, num } from '../format.js';

/**
 * Context: what each model call sent, split by what the cache did with it (read, written, uncached),
 * the output under it, and where the cache stopped hitting, judged within each scope and
 * conversation (a model call reading less from the cache than the previous call's whole input, by
 * 1,024 tokens or more).
 */

let asTable = false;

export function ContextView({ run, calls, selected, onSelect }: { run: RunDetail; calls: CallRow[]; selected: number | null; onSelect: (n: number) => void }) {
  const [table, setTableState] = useState(asTable);
  const setTable = (t: boolean) => {
    asTable = t;
    setTableState(t);
  };
  const ms = calls.filter((c) => c.kind === 'api' && c.usage && c.outcome !== 'error');
  if (!ms.length) return <div className="empty">{calls.some((c) => c.kind === 'api') ? 'No model call reported token usage, so there is no context to show.' : 'No model calls yet.'}</div>;
  // The server's misses when it judged them for the whole run; the same rule here otherwise.
  const misses = new Map((run.cache?.misses ?? cacheMisses(ms)).map((m) => [m.callNo, m.tokens]));
  const max = Math.max(1, ...ms.map((c) => wholeInput(c.usage!)));
  const outMax = Math.max(1, ...ms.map((c) => c.usage!.output));
  const big = ms.reduce((a, b) => (wholeInput(b.usage!) > wholeInput(a.usage!) ? b : a));
  const share = cacheReadShare(ms);
  const many = ms.length > 80;
  const every = Math.ceil(ms.length / 12);
  const h = (v: number) => `${((v / max) * 100).toFixed(2)}%`;
  const missList = [...misses.keys()].filter((n) => ms.some((c) => c.callNo === n));
  return (
    <>
      <div className="cstats">
        <div>
          <b>{ktok(wholeInput(big.usage!))}</b>
          <span>largest context · #{big.callNo}</span>
        </div>
        <div>
          <b>{Math.round(share * 100)}%</b>
          <span>of input read from the cache</span>
        </div>
        <div>
          <b className={missList.length ? 'warn' : undefined}>{missList.length ? missList.slice(0, 6).map((n) => `#${n}`).join(', ') + (missList.length > 6 ? ` +${missList.length - 6}` : '') : 'none'}</b>
          <span>where the cache stopped hitting</span>
        </div>
      </div>
      <div className="ctx">
        <div className="ctxtop">
          <div className="legend">
            <span>
              <i className="lc-read" />
              cache read
            </span>
            <span>
              <i className="lc-write" />
              cache write
            </span>
            <span>
              <i className="lc-unc" />
              uncached input
            </span>
            <span>
              <i className="lc-out" />
              output
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
                <th>Cache read</th>
                <th>Cache write</th>
                <th>Uncached</th>
                <th>Output</th>
                <th>Input total</th>
              </tr>
            </thead>
            <tbody>
              {ms.map((c) => (
                <tr key={c.callNo} className={misses.has(c.callNo) ? 'miss' : undefined} onClick={() => onSelect(c.callNo)}>
                  <td>#{c.callNo}</td>
                  <td>{num(c.usage!.cacheRead)}</td>
                  <td>{num(c.usage!.cacheWrite)}</td>
                  <td>{num(c.usage!.input)}</td>
                  <td>{num(c.usage!.output)}</td>
                  <td>{num(wholeInput(c.usage!))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <>
            <div className={`cbars${many ? ' many' : ''}`}>
              {ms.map((c) => {
                const u = c.usage!;
                const tip = tipCard(`#${c.callNo} · ${num(wholeInput(u))} input tokens`, [
                  { label: 'cache read', value: num(u.cacheRead), color: 'var(--c-read)' },
                  { label: 'cache write', value: num(u.cacheWrite), color: 'var(--c-write)' },
                  { label: 'uncached', value: num(u.input), color: 'var(--c-unc)' },
                  { label: 'output', value: num(u.output), color: 'var(--c-out)' },
                  ...(misses.has(c.callNo) ? [{ label: 'sent again', value: num(misses.get(c.callNo)!), color: 'var(--warn)' }] : []),
                ]);
                return (
                  <div key={c.callNo} className={`cbar${c.callNo === selected ? ' sel' : ''}`} data-tip={tip} onClick={() => onSelect(c.callNo)}>
                    {u.cacheRead ? <i className="seg-read" style={{ height: h(u.cacheRead) }} /> : null}
                    <i className="seg-write" style={{ height: h(u.cacheWrite) }} />
                    <i className="seg-unc" style={{ height: `max(2px, ${h(u.input)})` }} />
                    {misses.has(c.callNo) ? (
                      <span className="miss" style={{ bottom: `calc(${h(wholeInput(u))} + 8px)` }}>
                        cache miss
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className={`couts${many ? ' many' : ''}`}>
              {ms.map((c) => (
                <i key={c.callNo} style={{ height: `${((c.usage!.output / outMax) * 100).toFixed(2)}%` }} />
              ))}
            </div>
            <div className={`clabels${many ? ' many' : ''}`}>
              {ms.map((c, i) => (
                <span key={c.callNo} className={c.callNo === selected ? 'sel' : undefined}>
                  {!many || i % every === 0 ? `#${num(c.callNo)}` : ''}
                </span>
              ))}
            </div>
          </>
        )}
        {missList.length ? (
          <p className="cnote">
            <b>The cache stopped hitting at {missList.slice(0, 8).map((n) => `#${n}`).join(', ')}.</b> {num([...misses.values()].reduce((s, n) => s + n, 0))} tokens were sent again. A change early in the prompt does this to every call after it.
          </p>
        ) : (
          <p className="cnote">{ms.some((c) => c.conversation) ? 'Each conversation starts its own context; within each, every model call read the previous prompt from the cache.' : 'Every model call read the previous prompt from the cache.'}</p>
        )}
      </div>
    </>
  );
}
