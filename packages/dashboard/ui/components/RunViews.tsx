import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CallRow, Client, LineageNode, RunDetail } from '../api.js';
import { ago, callName, formatDuration, formatTokens, formatUsd, shortId, isFailure } from '../format.js';
import { usePolling } from '../hooks.js';
import { href, navigate } from '../router.js';
import { RunLabel } from './common.js';

/**
 * The other ways to look at a run, beside the call table: what each model call cost in context,
 * when each call ran, how calls group into the agent's turns, and where the run sits among its forks.
 * Every mark selects its call, so the inspector follows.
 */

export type RunPane = 'calls' | 'turns' | 'context' | 'timeline' | 'forks';

export const RUN_PANES: Array<[RunPane, string]> = [
  ['calls', 'Calls'],
  ['turns', 'Turns'],
  ['context', 'Context'],
  ['timeline', 'Timeline'],
  ['forks', 'Forks'],
];

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="note pad">{children}</div>;
}

function Facts({ items }: { items: Array<[string, ReactNode] | null> }) {
  return (
    <dl className="facts">
      {items.filter((x): x is [string, ReactNode] => x !== null).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A round number at or above `n`, for an axis. */
function niceMax(n: number): number {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

const inputOf = (c: CallRow) => (c.usage ? c.usage.input + c.usage.cacheRead + c.usage.cacheWrite : 0);
const go = (runId: string, callNo: number) => navigate(href.run(runId, callNo), true);

// ---- Context --------------------------------------------------------------------------------

/**
 * Tokens per model call: the context sent, split by what it cost (uncached, written to the cache,
 * read from it), and the output below. A call where the cache stopped hitting is marked; that is
 * usually a prompt change early in the context, and the most expensive bug an agent has.
 */
export function ContextView({ run, selected }: { run: RunDetail; selected: number | null }) {
  const calls = useMemo(() => run.calls.filter((c) => c.kind === 'api' && c.usage), [run.calls]);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const stats = useMemo(() => {
    let peak: CallRow | null = null;
    let input = 0;
    let read = 0;
    let output = 0;
    const misses = new Set<number>();
    calls.forEach((c, i) => {
      if (!peak || inputOf(c) > inputOf(peak)) peak = c;
      input += inputOf(c);
      read += c.usage!.cacheRead;
      output += c.usage!.output;
      const prev = calls[i - 1];
      if (prev && prev.usage!.cacheRead > 0 && c.usage!.cacheRead === 0 && inputOf(c) >= 2048) misses.add(c.callNo);
    });
    return { peak: peak as CallRow | null, hit: input ? read / input : 0, output, misses, cost: calls.reduce((s, c) => s + (c.cost ?? 0), 0) };
  }, [calls]);

  if (calls.length === 0) return <Empty>No model call in this run reported token usage.</Empty>;

  const L = 44;
  const R = 12;
  const plot = Math.max(80, width - L - R);
  const perBar = Math.max(1, Math.ceil(calls.length / Math.floor(plot / 3)));
  // One bar per call, or per range of calls when there are more calls than pixels: the largest context in the range.
  const bars: Array<{ call: CallRow; count: number }> = [];
  for (let i = 0; i < calls.length; i += perBar) {
    const range = calls.slice(i, i + perBar);
    bars.push({ call: range.reduce((a, b) => (inputOf(b) > inputOf(a) ? b : a)), count: range.length });
  }
  const band = plot / bars.length;
  const barW = Math.max(1, Math.min(28, band * 0.72));
  const TOP = 14;
  const IN_H = 180;
  const GAP = 26;
  const OUT_H = 44;
  const height = TOP + IN_H + GAP + OUT_H + 20;
  const inMax = niceMax(Math.max(...calls.map(inputOf)));
  const outMax = niceMax(Math.max(...calls.map((c) => c.usage!.output)));
  const yIn = (v: number) => TOP + IN_H - (v / inMax) * IN_H;
  const outTop = TOP + IN_H + GAP;
  const labelEvery = Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(plot / 38))));
  const shown = hover !== null ? bars[hover] : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left - L;
    const i = Math.floor(x / band);
    setHover(i >= 0 && i < bars.length ? i : null);
  };

  return (
    <div className="pane-scroll">
      <Facts
        items={[
          ['Largest context', stats.peak ? <a href={href.run(run.run.runId, stats.peak.callNo)}>{`${formatTokens(inputOf(stats.peak))} at #${stats.peak.callNo}`}</a> : '—'],
          ['Read from cache', `${Math.round(stats.hit * 100)}% of input`],
          stats.misses.size ? ['Cache misses', <span className="err">{stats.misses.size}</span>] : null,
          ['Output', formatTokens(stats.output)],
          stats.cost ? ['Model cost', `≈${formatUsd(stats.cost)}`] : null,
        ]}
      />
      <div className="chart">
        <div className="chart-box" ref={ref}>
        {width > 0 ? (
          <svg width={width} height={height} role="img" aria-label={`Input and output tokens for ${calls.length} model calls`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line className="grid" x1={L} x2={L + plot} y1={yIn(inMax * f)} y2={yIn(inMax * f)} />
                <text className="axis" x={L - 6} y={yIn(inMax * f) + 3} textAnchor="end">
                  {formatTokens(inMax * f)}
                </text>
              </g>
            ))}
            <text className="axis" x={L - 6} y={outTop + 8} textAnchor="end">
              out
            </text>
            <text className="axis" x={L - 6} y={outTop + OUT_H} textAnchor="end">
              {formatTokens(outMax)}
            </text>
            <line className="grid" x1={L} x2={L + plot} y1={outTop} y2={outTop} />
            {bars.map(({ call: c }, i) => {
              const u = c.usage!;
              const x = L + i * band + (band - barW) / 2;
              const read = yIn(u.cacheRead);
              const write = yIn(u.cacheRead + u.cacheWrite);
              const all = yIn(inputOf(c));
              const isSel = bars[i]!.count === 1 ? c.callNo === selected : false;
              return (
                <g key={c.callNo} className={`cx-bar${isSel ? ' sel' : ''}${hover === i ? ' hover' : ''}`} onClick={() => go(run.run.runId, c.callNo)}>
                  <rect className="cx-hit" x={L + i * band} y={TOP} width={band} height={height - TOP} />
                  <rect className="cx-read" x={x} y={read} width={barW} height={TOP + IN_H - read} />
                  <rect className="cx-write" x={x} y={write} width={barW} height={read - write} />
                  <rect className="cx-fresh" x={x} y={all} width={barW} height={write - all} />
                  <rect className="cx-out" x={x} y={outTop} width={barW} height={Math.max(u.output ? 1 : 0, (u.output / outMax) * OUT_H)} />
                  {stats.misses.has(c.callNo) ? <path className="cx-miss" d={`M${x + barW / 2 - 4},${all - 9} h8 l-4,6 z`} /> : null}
                  {isSel ? <rect className="cx-selbox" x={x - 2} y={all - 2} width={barW + 4} height={TOP + IN_H - all + 4} /> : null}
                  {i % labelEvery === 0 ? (
                    <text className="axis" x={x + barW / 2} y={height - 4} textAnchor="middle">
                      #{c.callNo}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : null}
        {shown ? (
          <div className="tip" style={{ left: Math.min(Math.max(8, L + (hover ?? 0) * band + band / 2 - 120), Math.max(8, width - 250)), top: 6 }}>
            <b>
              #{shown.call.callNo}
              {shown.count > 1 ? ` (largest of ${shown.count} calls)` : ''}
            </b>
            {shown.call.model ? <span> · {shown.call.model}</span> : null}
            <div>
              {formatTokens(inputOf(shown.call))} in: {formatTokens(shown.call.usage!.input)} uncached, {formatTokens(shown.call.usage!.cacheWrite)} written, {formatTokens(shown.call.usage!.cacheRead)} read
            </div>
            <div>
              {formatTokens(shown.call.usage!.output)} out{shown.call.cost !== null ? ` · ≈${formatUsd(shown.call.cost)}` : ''}
              {shown.call.stopReason ? ` · ${shown.call.stopReason}` : ''}
            </div>
            {stats.misses.has(shown.call.callNo) ? <div className="err">The cache stopped hitting here.</div> : null}
          </div>
        ) : null}
        </div>
      </div>
      <div className="chart-legend">
        <span>
          <i className="cx-fresh" /> uncached input
        </span>
        <span>
          <i className="cx-write" /> written to cache
        </span>
        <span>
          <i className="cx-read" /> read from cache
        </span>
        <span>
          <i className="cx-out" /> output
        </span>
        {stats.misses.size ? (
          <span>
            <i className="cx-miss" /> cache stopped hitting
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---- Timeline -------------------------------------------------------------------------------

/** Every call on a clock, in as many lanes as ran at once: where the time goes, and what ran in parallel. */
export function TimelineView({ run, selected }: { run: RunDetail; selected: number | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const model = useMemo(() => {
    const calls = run.calls.filter((c) => c.startedAt > 0).slice().sort((a, b) => a.startedAt - b.startedAt || a.callNo - b.callNo);
    if (!calls.length) return null;
    // The span of the calls themselves: an agent that idles before its first call or after its last
    // would otherwise squeeze every bar into a corner.
    const t0 = calls[0]!.startedAt;
    const endOf = (c: CallRow) => c.endedAt ?? (c.outcome === null ? Date.now() : c.startedAt);
    const t1 = Math.max(...calls.map(endOf));
    // With scopes, each scope gets its own band of lanes, in the order scopes first appear.
    const scopes = [...new Set(calls.map((c) => c.scope ?? ''))];
    const scoped = scopes.some((x) => x !== '');
    const MAX_LANES = 24;
    const placed: Array<{ c: CallRow; lane: number; start: number; end: number }> = [];
    const groups: Array<{ scope: string; first: number; lanes: number }> = [];
    let offset = 0;
    for (const sc of scoped ? scopes : ['']) {
      const laneEnds: number[] = [];
      for (const c of calls) {
        if (scoped && (c.scope ?? '') !== sc) continue;
        let lane = laneEnds.findIndex((end) => end <= c.startedAt);
        if (lane < 0) {
          lane = laneEnds.length < MAX_LANES ? laneEnds.length : MAX_LANES - 1;
          if (lane === laneEnds.length) laneEnds.push(0);
        }
        laneEnds[lane] = Math.max(laneEnds[lane]!, endOf(c));
        placed.push({ c, lane: offset + lane, start: c.startedAt - t0, end: endOf(c) - t0 });
      }
      groups.push({ scope: sc, first: offset, lanes: laneEnds.length });
      offset += laneEnds.length;
    }
    const sum = (kind: CallRow['kind']) => calls.filter((c) => c.kind === kind).reduce((s, c) => s + (c.latencyMs ?? 0), 0);
    const widest = Math.max(0, ...groups.map((g) => g.lanes));
    return { placed, groups: scoped ? groups : [], lanes: offset, widest, span: Math.max(1, t1 - t0), model: sum('api'), tools: sum('tool'), longest: calls.reduce((a, b) => ((b.latencyMs ?? 0) > (a.latencyMs ?? 0) ? b : a)) };
  }, [run]);

  if (!model) return <Empty>No calls to place on a timeline.</Empty>;
  const L = model.groups.length ? Math.min(150, Math.max(70, width * 0.2)) : 12;
  const R = 12;
  const plot = Math.max(80, width - L - R);
  const LANE = 16;
  const TOP = 8;
  const height = TOP + model.lanes * LANE + 26;
  const x = (ms: number) => L + (ms / model.span) * plot;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="pane-scroll">
      <Facts
        items={[
          ['First to last call', formatDuration(model.span)],
          ['In model calls', model.model ? `${formatDuration(model.model)}${model.model <= model.span ? ` (${Math.round((model.model / model.span) * 100)}%)` : ', some at once'}` : '0 s'],
          ['In tools', formatDuration(model.tools)],
          model.groups.length ? ['Scopes', String(model.groups.length)] : null,
          [model.groups.length ? 'Most at once in a scope' : 'Most at once', String(model.widest)],
          model.longest.latencyMs ? ['Longest call', <a href={href.run(run.run.runId, model.longest.callNo)}>{`#${model.longest.callNo} · ${formatDuration(model.longest.latencyMs)}`}</a>] : null,
        ]}
      />
      <div className="chart">
        <div className="chart-box" ref={ref}>
        {width > 0 ? (
          <svg width={width} height={height} role="img" aria-label={`${model.placed.length} calls over ${formatDuration(model.span)}`}>
            {ticks.map((f) => (
              <g key={f}>
                <line className="grid" x1={x(model.span * f)} x2={x(model.span * f)} y1={TOP - 4} y2={TOP + model.lanes * LANE} />
                <text className="axis" x={x(model.span * f)} y={height - 8} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>
                  {formatDuration(model.span * f)}
                </text>
              </g>
            ))}
            {model.groups.map((g, i) => (
              <g key={g.scope || '(none)'}>
                {i > 0 ? <line className="grid" x1={0} x2={L + plot} y1={TOP + g.first * LANE - 2.5} y2={TOP + g.first * LANE - 2.5} /> : null}
                {(() => {
                  // The last part of the path, indented by how deep it is nested; the full path on hover.
                  const parts = g.scope ? g.scope.split('/') : ['(no scope)'];
                  const indent = Math.min(3, parts.length - 1) * 10;
                  const room = Math.max(4, Math.floor((L - indent - 8) / 6.4));
                  const last = parts.at(-1)!;
                  return (
                    <text className="axis tl-scope" x={indent} y={TOP + g.first * LANE + 9}>
                      <title>{g.scope || 'outside any scope'}</title>
                      {last.length > room ? `${last.slice(0, room - 1)}…` : last}
                    </text>
                  );
                })()}
              </g>
            ))}
            {model.placed.map(({ c, lane, start, end }) => {
              const h = c.kind === 'api' ? 11 : 7;
              const y = TOP + lane * LANE + (11 - h) / 2;
              const left = x(start);
              const w = Math.max(2, x(end) - left);
              const title = `#${c.callNo} ${callName(c.kind, c.name)}${c.scope ? ` · ${c.scope}` : ''} · ${c.origin}${c.latencyMs !== null ? ` · ${formatDuration(c.latencyMs)}` : ''} · at ${formatDuration(start)}${c.ttftMs !== null ? ` · first token ${formatDuration(c.ttftMs)}` : ''}`;
              return (
                <g key={c.callNo} className={`tl-bar o-${c.origin}${isFailure(c) ? ' is-error' : ''}${c.callNo === selected ? ' sel' : ''}`} onClick={() => go(run.run.runId, c.callNo)}>
                  <title>{title}</title>
                  <rect x={left} y={y} width={w} height={h} />
                  {c.ttftMs !== null && c.ttftMs < (c.latencyMs ?? 0) ? <line className="tl-ttft" x1={x(start + c.ttftMs)} x2={x(start + c.ttftMs)} y1={y - 2} y2={y + h + 2} /> : null}
                </g>
              );
            })}
          </svg>
        ) : null}
        </div>
      </div>
      <div className="chart-legend">
        <span>
          <i className="tl-key-api" /> model call
        </span>
        <span>
          <i className="tl-key-tool" /> tool, clock or random
        </span>
        <span>
          <i className="tl-key-ttft" /> first token
        </span>
        <span className="muted">colored by origin, as in the strip above</span>
      </div>
    </div>
  );
}

// ---- Turns ----------------------------------------------------------------------------------

interface Turn {
  model: CallRow | null;
  calls: CallRow[];
}

/** Calls grouped the way an agent loop makes them: a model call, then the calls it led to before the next one. */
export function TurnsView({ run, selected }: { run: RunDetail; selected: number | null }) {
  // With scopes, turns are built per scope: branches that run at once interleave their calls.
  const sections = useMemo(() => {
    const scopes = [...new Set(run.calls.map((c) => c.scope ?? ''))];
    const scoped = scopes.some((x) => x !== '');
    return (scoped ? scopes : ['']).map((sc) => {
      const out: Turn[] = [];
      let current: Turn = { model: null, calls: [] };
      for (const c of run.calls) {
        if (scoped && (c.scope ?? '') !== sc) continue;
        if (c.kind === 'api') {
          if (current.model || current.calls.length) out.push(current);
          current = { model: c, calls: [] };
        } else current.calls.push(c);
      }
      if (current.model || current.calls.length) out.push(current);
      return { scope: scoped ? sc || '(no scope)' : null, turns: out };
    });
  }, [run.calls]);
  const turns = sections.flatMap((x) => x.turns);
  if (!turns.length) return <Empty>No calls yet.</Empty>;
  const modelTurns = turns.filter((t) => t.model).length;
  const toolCalls = run.calls.filter((c) => c.kind === 'tool').length;
  const widest = Math.max(0, ...turns.map((t) => t.calls.filter((c) => c.kind === 'tool').length));
  return (
    <div className="pane-scroll">
      <Facts items={[['Model turns', String(modelTurns)], ['Tool calls', String(toolCalls)], ['Most tools in a turn', String(widest)], sections.length > 1 ? ['Scopes', String(sections.length)] : null]} />
      {sections.map((section) => (
        <TurnList key={section.scope ?? ''} run={run} selected={selected} scope={section.scope} turns={section.turns} />
      ))}
    </div>
  );
}

function TurnList({ run, selected, scope, turns }: { run: RunDetail; selected: number | null; scope: string | null; turns: Turn[] }) {
  let n = 0;
  return (
    <>
      {scope !== null ? (
        <div className="turn-scope">
          <span className="label">scope</span> <code>{scope}</code> <span className="muted">{turns.filter((t) => t.model).length} turns</span>
        </div>
      ) : null}
      <ol className="turns">
        {turns.map((t) => {
          const m = t.model;
          const label = m ? `Turn ${++n}` : 'Before the first model call';
          const isFork = run.run.divergence && [m, ...t.calls].some((c) => c?.callNo === run.run.divergence!.callNo);
          return (
            <li key={m?.callNo ?? `pre-${t.calls[0]?.callNo}`} className={`turn${isFork ? ' is-fork' : ''}`}>
              <div className="turn-label">{label}</div>
              <div className="turn-body">
                {m ? (
                  <a className={`turn-model o-${m.origin}${m.callNo === selected ? ' sel' : ''}${isFailure(m) ? ' is-error' : ''}`} href={href.run(run.run.runId, m.callNo)} onClick={(e) => (e.preventDefault(), go(run.run.runId, m.callNo))}>
                    <span className="num">#{m.callNo}</span>
                    <i aria-hidden="true" />
                    <span className="tm-model">{m.model ?? callName(m.kind, m.name)}</span>
                    {m.usage ? <span className="tm-dim">{`${formatTokens(inputOf(m))} → ${formatTokens(m.usage.output)}`}</span> : null}
                    {m.stopReason ? <span className="tm-dim">{m.stopReason}</span> : null}
                    {m.latencyMs !== null && m.origin === 'live' ? <span className="tm-dim">{formatDuration(m.latencyMs)}</span> : null}
                  </a>
                ) : null}
                {t.calls.length ? (
                  <div className="turn-calls">
                    {t.calls.map((c) => (
                      <a
                        key={c.callNo}
                        className={`chip o-${c.origin}${c.callNo === selected ? ' sel' : ''}${isFailure(c) ? ' is-error' : ''}${c.kind !== 'tool' ? ' minor' : ''}`}
                        href={href.run(run.run.runId, c.callNo)}
                        onClick={(e) => (e.preventDefault(), go(run.run.runId, c.callNo))}
                        title={`#${c.callNo} ${c.name} · ${c.origin}${c.error ? ` · ${c.error}` : ''}${c.detail ? `\n${c.detail}` : ''}`}
                      >
                        <i aria-hidden="true" />
                        {c.kind === 'tool' ? callName(c.kind, c.name) : c.kind}
                        {c.origin === 'blocked' || c.origin === 'stubbed' ? <span className="chip-note">{c.origin}</span> : c.outcome === 'error' ? <span className="chip-note">error</span> : null}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// ---- Forks ----------------------------------------------------------------------------------

type ForkRow = { node: LineageNode } | { group: string; parentDepth: number; nodes: LineageNode[] };

/** The run's family: its recording, every replay and fork of it, repeated attempts bundled, with what each came to. */
export function ForksView({ client, runId }: { client: Client; runId: string }) {
  const { data, error } = usePolling(() => client.lineage(runId), runId, client.exported ? null : 4000);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rows = useMemo(() => {
    const out: ForkRow[] = [];
    for (const node of data ?? []) {
      const last = out[out.length - 1];
      if (node.repeat && last && 'group' in last && last.group === node.repeat.group) last.nodes.push(node);
      else if (node.repeat) out.push({ group: node.repeat.group, parentDepth: node.depth, nodes: [node] });
      else out.push({ node });
    }
    return out;
  }, [data]);
  if (error) return <Empty>Could not load this run's forks: {error.message}</Empty>;
  if (!data) return <Empty>Loading forks…</Empty>;
  const forks = data.filter((n) => n.divergence).length;
  return (
    <div className="pane-scroll">
      <Facts items={[['Runs in this family', String(data.length)], ['Forks', String(forks)], ['Clean replays', String(data.filter((n) => n.mode === 'replay' && !n.divergence && n.status === 'completed').length)]]} />
      <ul className="lineage">
        {rows.map((row) => {
          if ('node' in row) return <LineageRow key={row.node.runId} node={row.node} current={row.node.runId === runId} />;
          const { nodes } = row;
          const expanded = open.has(row.group) || nodes.some((n) => n.runId === runId);
          const forkPoints = new Map<string, number>();
          for (const n of nodes) {
            const k = n.divergence ? `forked at #${n.divergence.callNo}` : 'clean';
            forkPoints.set(k, (forkPoints.get(k) ?? 0) + 1);
          }
          const checked = nodes.filter((n) => n.checks);
          return (
            <li key={row.group} className="lin-group" style={{ '--depth': row.parentDepth } as React.CSSProperties}>
              <button type="button" className="lin-grouphead" aria-expanded={expanded} onClick={() => setOpen((s) => new Set(s.has(row.group) ? [...s].filter((g) => g !== row.group) : [...s, row.group]))}>
                <span className="lin-glyph">⑂</span>
                <b>
                  {nodes.length} attempts of one fork
                </b>
                <span className="muted">
                  {[...forkPoints].map(([k, v]) => `${v} ${k}`).join(' · ')}
                  {checked.length ? ` · checks passed in ${checked.filter((n) => n.checks!.passed === n.checks!.total).length} of ${checked.length}` : ''}
                </span>
                <span className="caret-down" />
              </button>
              {expanded ? (
                <ul>
                  {nodes.map((n) => (
                    <LineageRow key={n.runId} node={n} current={n.runId === runId} attempt />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LineageRow({ node: n, current, attempt = false }: { node: LineageNode; current: boolean; attempt?: boolean }) {
  return (
    <li className={`lin-row${current ? ' current' : ''}`} style={{ '--depth': n.depth } as React.CSSProperties}>
      <a href={n.divergence ? href.run(n.runId, n.divergence.callNo) : href.run(n.runId)} className="lin-link">
        <span className={`lin-glyph${n.depth === 0 ? ' root' : ''}`}>{n.depth === 0 ? '●' : n.divergence ? '⑂' : '↻'}</span>
        <code>{shortId(n.runId)}</code>
        {attempt && n.repeat ? <span className="muted nowrap">attempt {n.repeat.attempt}</span> : null}
        <RunLabel label={n.label} status={n.status} />
        {n.checks ? <span className={`badge ${n.checks.passed === n.checks.total ? 'ok' : 'bad'}`}>{`checks ${n.checks.passed}/${n.checks.total}`}</span> : null}
        <span className="spacer" />
        <span className="lin-meta">
          {n.calls} calls{n.spent ? ` · ≈${formatUsd(n.spent)}` : ''} · {ago(n.startedAt)}
        </span>
      </a>
    </li>
  );
}
