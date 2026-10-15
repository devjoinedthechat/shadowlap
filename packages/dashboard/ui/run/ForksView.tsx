import { Fragment, useMemo, type ReactNode } from 'react';
import type { LineageNode, RunListItem } from '../api.js';
import { Glyph, RunIcon } from '../components/RunIcon.js';
import { shortId, stamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { familyLine, repeatBundle, type RunLike } from '../runs.js';
import { useApp } from '../state.js';
import { FixBundleNode, useFixBundles } from '../fixes/Bundles.js';

/**
 * Forks: the run's family, its recording and every replay and fork of it, each with a line that says
 * what happened ("fork @17 · 13 live · 1 blocked"). Attempts of one `--repeat` are bundled with how
 * many passed, and so are blame's probes and verify's attempts, leading to their fix (fixes/Bundles.tsx).
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

export function ForksView({ runId }: { runId: string }) {
  const { client, runs, tick } = useApp();
  const lineage = useLoad(() => client.lineage(runId), runId, tick);
  const byId = useMemo(() => new Map((runs ?? []).map((r) => [r.runId, r])), [runs]);
  // Blame's and verify's attempts, bundled by the fixes read model under the run they replayed.
  const fixes = useFixBundles(runId);
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
    const list = [...(kids.get(parent) ?? [])].filter((n) => !fixes.bundled.has(n.runId)).sort((a, b) => a.startedAt - b.startedAt);
    // The fork blame rescued a run with is one of its attempts, but it shows as a fork of its own.
    const repeated = (n: LineageNode) => !!n.repeat && !fixes.rescued.has(n.runId);
    const plain = list.filter((n) => !repeated(n));
    const groups = new Map<string, LineageNode[]>();
    for (const n of list) if (n.repeat && repeated(n)) groups.set(n.repeat.group, [...(groups.get(n.repeat.group) ?? []), n]);
    const items: ReactNode[] = [];
    for (const n of plain) {
      items.push(node(n));
      const sub = family(n.runId);
      if (sub) items.push(<Fragment key={`${n.runId}:kids`}>{sub}</Fragment>);
    }
    for (const [group, attempts] of groups) items.push(<Bundle key={group} attempts={attempts} current={runId} />);
    if (parent !== null) for (const b of fixes.bundles) if (b.parentRunId === parent) items.push(<FixBundleNode key={b.key} bundle={b} current={runId} />);
    if (!items.length) return null;
    return parent === null ? <>{items}</> : <div className="fkids">{items}</div>;
  };
  return <div className="fam">{family(null)}</div>;
}

function Bundle({ attempts, current }: { attempts: LineageNode[]; current: string }) {
  const b = repeatBundle(attempts.map((n) => ({ runId: n.runId, status: n.status, divergence: n.divergence, spent: n.spent, startedAt: n.startedAt, repeat: n.repeat, checks: n.checks })));
  const first = attempts.find((n) => n.runId === b.attempts[0]?.runId) ?? attempts[0]!;
  const has = attempts.some((n) => n.runId === current);
  return (
    <a className={`fnode${has ? ' here' : ''}`} href={href.run(first.runId)}>
      <Glyph kind="fork" label="Repeated attempts" />
      <span>
        <span className="f1">
          <code>{b.title}</code>
        </span>
        <span className="f2 block">{b.line}</span>
        <span className="attempts">
          {b.attempts.map((a) => (
            <span key={a.runId}>
              <i className={a.ok ? undefined : 'no'} />
              {a.text}
            </span>
          ))}
        </span>
      </span>
      <span className="fr">{stamp(first.startedAt)}</span>
    </a>
  );
}
