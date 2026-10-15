import { useMemo, type ReactNode } from 'react';
import type { LineageNode, RunListItem } from '../api.js';
import { Glyph, RunIcon } from '../components/RunIcon.js';
import { approx, num, plural, shortId, stamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { countOrigins, parseOrigins } from '../origins.js';
import { href } from '../route.js';
import { runType, type RunLike } from '../runs.js';
import { useApp } from '../state.js';

/**
 * Forks: the run's family, its recording and every replay and fork of it, each with a line that says
 * what happened ("fork @17 · 13 live · 1 blocked"). Attempts of one `--repeat` are bundled with how
 * many passed.
 */

function asRun(n: LineageNode, listed: RunListItem | undefined): RunLike {
  return {
    runId: n.runId,
    parentRunId: n.parentRunId,
    mode: n.mode,
    status: n.status,
    divergence: n.divergence,
    command: listed?.command ?? '',
    codeVersion: listed?.codeVersion ?? null,
    startedAt: n.startedAt,
    calls: n.calls,
    spent: n.spent,
    saved: n.saved,
    captured: listed?.captured ?? 0,
    imported: listed?.imported ?? false,
    covers: listed?.covers ?? null,
    source: listed?.source ?? null,
    labels: listed?.labels ?? [],
    origins: n.origins ?? listed?.origins ?? null,
    test: listed?.test ?? null,
    checks: n.checks,
  };
}

/** What happened in a run, in one line. */
export function familyLine(r: RunLike): string {
  const o = parseOrigins(r.origins);
  const n = o ? countOrigins(o) : null;
  const t = runType(r);
  if (r.status === 'running') return `recording · ${plural(r.calls, 'call')} so far`;
  if (t === 'fork') {
    const went = n ? `${num(n.rep)} replayed · ${num(n.live + n.fail)} live${n.block ? ` · ${num(n.block)} blocked` : ''}${n.stub ? ` · ${num(n.stub)} stubbed` : ''}` : plural(r.calls, 'call');
    return `fork @${r.divergence!.callNo} · ${went} · ${approx(r.spent)}`;
  }
  if (t === 'clean') return n && n.rep === r.calls ? `clean replay · ${num(r.calls)}/${num(r.calls)} · 0 upstream` : `clean replay · ${plural(r.calls, 'call')}`;
  if (t === 'test') return `test · replayed offline · ${plural(r.calls, 'call')}`;
  if (t === 'capture') return `capture · ${plural(r.calls, 'call')} · ${approx(r.captured)} as captured`;
  if (t === 'replay') return `replay · ${plural(r.calls, 'call')} · ${r.status === 'completed' ? 'finished' : r.status}`;
  return `recording · ${plural(r.calls, 'call')} · ${approx(r.spent)}`;
}

export function ForksView({ runId }: { runId: string }) {
  const { client, runs, tick } = useApp();
  const lineage = useLoad(() => client.lineage(runId), runId, tick);
  const byId = useMemo(() => new Map((runs ?? []).map((r) => [r.runId, r])), [runs]);
  if (lineage.error) return <div className="empty">Could not load this run’s family: {lineage.error.message}</div>;
  if (!lineage.data) return <div className="empty">Loading the family…</div>;
  const nodes = lineage.data;
  const kids = new Map<string | null, LineageNode[]>();
  const ids = new Set(nodes.map((n) => n.runId));
  for (const n of nodes) {
    const p = n.parentRunId && ids.has(n.parentRunId) ? n.parentRunId : null;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const node = (n: LineageNode) => {
    const r = asRun(n, byId.get(n.runId));
    const here = n.runId === runId || n.runId.startsWith(runId);
    return (
      <a key={n.runId} className={`fnode${here ? ' here' : ''}`} href={href.run(n.runId, n.divergence?.callNo ?? null)}>
        <RunIcon run={r} className="" />
        <span>
          <span className="f1">
            <code>{shortId(n.runId)}</code>
            {here ? <span className="chip">this run</span> : null}
          </span>
          <span className="f2 block">{familyLine(r)}</span>
          {n.checks ? (
            <span className="checks">
              <span className={n.checks.passed === n.checks.total ? undefined : 'bad'}>
                {n.checks.passed === n.checks.total ? '✓' : '✗'} checks {n.checks.passed} of {n.checks.total}
              </span>
            </span>
          ) : null}
        </span>
        <span className="fr">{stamp(n.startedAt)}</span>
      </a>
    );
  };
  const family = (parent: string | null): ReactNode => {
    const list = [...(kids.get(parent) ?? [])].sort((a, b) => a.startedAt - b.startedAt);
    const plain = list.filter((n) => !n.repeat);
    const groups = new Map<string, LineageNode[]>();
    for (const n of list) if (n.repeat) groups.set(n.repeat.group, [...(groups.get(n.repeat.group) ?? []), n]);
    const items: ReactNode[] = [];
    for (const n of plain) {
      items.push(node(n));
      const sub = family(n.runId);
      if (sub) items.push(sub);
    }
    for (const [group, attempts] of groups) items.push(<Bundle key={group} attempts={attempts} current={runId} />);
    if (!items.length) return null;
    return parent === null ? <>{items}</> : <div className="fkids">{items}</div>;
  };
  return <div className="fam">{family(null)}</div>;
}

function Bundle({ attempts, current }: { attempts: LineageNode[]; current: string }) {
  const sorted = [...attempts].sort((a, b) => (a.repeat?.attempt ?? 0) - (b.repeat?.attempt ?? 0));
  const checked = sorted.filter((n) => n.checks);
  const passed = checked.filter((n) => n.checks!.passed === n.checks!.total).length;
  const first = sorted[0]!;
  const forkAt = first.divergence?.callNo;
  const spent = sorted.reduce((s, n) => s + n.spent, 0);
  const has = sorted.some((n) => n.runId === current);
  return (
    <a className={`fnode${has ? ' here' : ''}`} href={href.run(first.runId)}>
      <Glyph kind="fork" label="Repeated attempts" />
      <span>
        <span className="f1">
          <code>
            --repeat {first.repeat?.of ?? sorted.length}
            {forkAt ? ` · #${forkAt}` : ''}
          </code>
        </span>
        <span className="f2 block">
          {forkAt ? 'forked ' : ''}
          {plural(sorted.length, 'attempt')}
          {checked.length ? `, ${passed} passed` : ''}
          {spent ? ` · ${approx(spent)}` : ''}
        </span>
        <span className="attempts">
          {sorted.map((n) => {
            const ok = n.checks ? n.checks.passed === n.checks.total : n.status === 'completed';
            return (
              <span key={n.runId}>
                <i className={ok ? undefined : 'no'} />
                {n.repeat?.attempt ?? '?'} · {n.divergence ? `forked at #${n.divergence.callNo}` : 'same path'}
                {n.checks ? ` · checks ${n.checks.passed}/${n.checks.total}` : ''}
              </span>
            );
          })}
        </span>
      </span>
      <span className="fr">{stamp(first.startedAt)}</span>
    </a>
  );
}
