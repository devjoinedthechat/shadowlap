import { Fragment, useMemo, useRef, type ReactNode } from 'react';
import type { Client, FixBundle, LineageNode } from '../api.js';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { Glyph, RunIcon } from '../components/RunIcon.js';
import { approx, shortId, stamp } from '../format.js';
import { familyRefresh } from '../connection.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { familyLineParts, repeatBundle } from '../runs.js';
import { useApp } from '../state.js';
import { FixBundleNode, useFixBundles } from '../fixes/Bundles.js';
import { lineageRunLike } from './model.js';
import { goldenName } from './offers.js';
import { useOfflineLink } from '../components/ActionButton.js';
import { byResult, testedRuns } from '../injection/fork-node.js';
import { TestNode } from '../injection/TestNode.js';
import { inPresets, presetSessions } from '../presets/fork-node.js';
import { PresetsNode } from '../presets/PresetsNode.js';
import type { InjectionRow } from '../types.js';

/**
 * Forks: the run's family as a tree, its recording and every replay and fork of it, each by its id and
 * its about line (decision 10), which under a parent is what it changed, then a line that says what
 * happened ("fork @17 · 13 live · 1 blocked"), leaving out the kind when the about line says it.
 * Attempts of one `--repeat` are bundled with how many passed, and so are a golden's attempts in one
 * test session, and blame's probes and verify's attempts, leading to their fix (fixes/Bundles.tsx).
 * Each injection test kept for a run, a gate's and a --clean answer's too, is one node under it, its
 * replays drawn in it (injection/TestNode.tsx); a test whose result is gone stays a `--repeat` bundle.
 * A session's error-path presets on a recording are one node under it, its attempts drawn in it
 * (presets/PresetsNode.tsx).
 */

/**
 * The bundle a golden's attempt in a test session goes in: a golden replayed more than once in one
 * session numbers its attempts (`test.attempt`), and they are one test. One replayed once is a test of its own.
 */
const sessionKey = (n: LineageNode): string | null => (n.test && n.test.attempt !== null ? `test:${n.test.session}\n${n.test.golden}` : null);

/** The injection tests kept for each of the runs `testedRuns` names. */
async function keptTests(client: Client, runs: readonly string[]): Promise<InjectionRow[]> {
  const kept = await Promise.all(runs.map((id) => client.injectionResults(id)));
  return kept.flatMap((k) => k.results);
}

const NO_TESTS: readonly InjectionRow[] = [];

export function ForksView({ runId }: { runId: string }) {
  const { client, runs, runsTick, live } = useApp();
  // Again when runs move, and while a run of the family records, as its calls do: not for another run's.
  const members = useRef<ReadonlySet<string>>(new Set());
  const lineage = useLoad(() => client.lineage(runId), runId, familyRefresh(runsTick, live, members.current));
  if (lineage.data) members.current = new Set(lineage.data.map((n) => n.runId));
  const byId = useMemo(() => new Map((runs ?? []).map((r) => [r.runId, r])), [runs]);
  // Blame's and verify's attempts, bundled by the fixes read model under the run they replayed.
  const fixes = useFixBundles(runId);
  // The tests the family's injection replays belong to, and the page's run's and the recording's, whose
  // replays may all be gone, read as runs move, as the family is.
  const tested = testedRuns(lineage.data, runId);
  const tests = useLoad(() => (tested.length ? keptTests(client, tested) : null), tested.join(' '), runsTick);
  const box = useRef<HTMLDivElement>(null);
  useFitAbouts(box);
  if (lineage.error) return <div className="empty">Could not load this run’s family: {lineage.error.message}</div>;
  if (!lineage.data || fixes.loading || tests.loading) return <div className="empty">Loading the family…</div>;
  const nodes = lineage.data;
  const rows = tests.data ?? NO_TESTS;
  const kept = new Set(rows.map((r) => r.resultId));
  const replays = byResult(nodes);
  // A kept test's replays are drawn in its node, never again as forks or a --repeat's bundle.
  const inTest = (n: LineageNode) => !!n.injection && kept.has(n.injection.result);
  const presets = presetSessions(nodes);
  const kids = new Map<string | null, LineageNode[]>();
  const ids = new Set(nodes.map((n) => n.runId));
  for (const n of nodes) {
    const p = n.parentRunId && ids.has(n.parentRunId) ? n.parentRunId : null;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  const node = (n: LineageNode) => {
    const r = lineageRunLike(n, byId.get(n.runId));
    const line = familyLineParts(r);
    const here = n.runId === runId || n.runId.startsWith(runId);
    // The kind, unless the about line says it already ("clean replay").
    const said = n.about && !line.err && line.text.startsWith(`${n.about.text} · `) ? n.about.text.length + 3 : 0;
    return (
      <a key={n.runId} className={`fnode${here ? ' here' : ''}`} href={href.run(n.runId, n.divergence?.callNo ?? null)}>
        <RunIcon run={r} className="" />
        <span className="fmain">
          <span className="f1">
            <code className="fid">{shortId(n.runId)}</code>
            <AboutLine about={n.about} />
            {here ? <span className="chip thisrun">this run</span> : null}
          </span>
          <span className="f2 block">
            {line.err ? <em>{line.err}</em> : null}
            {line.text.slice(said)}
          </span>
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
  // Each rule is stated once in the family, under the first bundle it decided (decision 9): a fix's
  // bundle, or a gated golden's attempts in one test session.
  const ruled = new Set<string>();
  const once = (rule: string | null | undefined): string | null => {
    if (!rule || ruled.has(rule)) return null;
    ruled.add(rule);
    return rule;
  };
  const ruleOf = (b: FixBundle): string | null => once(b.rule);
  const family = (parent: string | null): ReactNode => {
    const list = [...(kids.get(parent) ?? [])].filter((n) => !fixes.bundled.has(n.runId) && !inTest(n) && !inPresets(n)).sort((a, b) => a.startedAt - b.startedAt);
    // The fork blame rescued a run with is one of its attempts, but it shows as a fork of its own.
    const repeated = (n: LineageNode) => !!n.repeat && !fixes.rescued.has(n.runId);
    const groups = new Map<string, LineageNode[]>();
    for (const n of list) if (n.repeat && repeated(n)) groups.set(n.repeat.group, [...(groups.get(n.repeat.group) ?? []), n]);
    // A golden replayed several times in one test session: one test, bundled as --repeat's attempts are.
    const sessions = new Map<string, LineageNode[]>();
    for (const n of list) {
      const key = repeated(n) ? null : sessionKey(n);
      if (key) sessions.set(key, [...(sessions.get(key) ?? []), n]);
    }
    const tested = (n: LineageNode) => (sessions.get(sessionKey(n) ?? '')?.length ?? 0) > 1;
    const plain = list.filter((n) => !repeated(n) && !tested(n));
    const items: ReactNode[] = [];
    for (const n of plain) {
      items.push(node(n));
      const sub = family(n.runId);
      if (sub) items.push(<Fragment key={`${n.runId}:kids`}>{sub}</Fragment>);
    }
    for (const [group, attempts] of groups) items.push(<Bundle key={group} attempts={attempts} current={runId} />);
    for (const [key, attempts] of sessions) {
      if (attempts.length < 2) continue;
      const gate = attempts.find((n) => n.test?.gate)?.test?.gate ?? null;
      items.push(<Bundle key={key} attempts={attempts} current={runId} title={`test · ${goldenName(attempts[0]!.test!.golden)}`} gate={gate ? { ...gate, rule: once(gate.rule) } : null} />);
    }
    if (parent !== null) for (const b of fixes.bundles) if (b.parentRunId === parent) items.push(<FixBundleNode key={b.key} bundle={b} current={runId} rule={ruleOf(b)} />);
    // The run's kept injection tests, after its forks and bundles, oldest first as they are.
    const own = rows.filter((r) => r.runId === parent).sort((a, b) => a.at - b.at);
    for (const r of own) items.push(<TestNode key={r.resultId} row={r} runs={replays.get(r.resultId) ?? []} current={runId} rule={once(r.rule)} />);
    // Its error-path presets, a session's attempts a node, oldest first.
    for (const attempts of (parent && presets.get(parent)) || []) items.push(<PresetsNode key={`presets:${attempts[0]!.preset.session}`} attempts={attempts} current={runId} />);
    if (!items.length) return null;
    return parent === null ? <>{items}</> : <div className="fkids">{items}</div>;
  };
  return (
    <div className="fam" ref={box}>
      {family(null)}
    </div>
  );
}

/**
 * Attempts made together, as one node: a `--repeat`'s, or a golden's in one test session. A golden
 * with a gate says what the gate made of them, as Tests does: the verdict word, the tally and the
 * Wilson bound, then the rule, once, under it; without one, how many passed.
 */
function Bundle({ attempts, current, title, gate = null }: { attempts: LineageNode[]; current: string; title?: string; gate?: { verdict: string; rule: string | null } | null }) {
  // A test session's attempts are numbered by the golden's result, as --repeat's are by the replay.
  const numbered = (n: LineageNode) => n.repeat ?? (n.test?.attempt ? { attempt: n.test.attempt, of: attempts.length } : null);
  const b = repeatBundle(
    attempts.map((n) => ({ runId: n.runId, status: n.status, divergence: n.divergence, spent: n.spent, startedAt: n.startedAt, repeat: numbered(n), checks: n.checks })),
    title,
  );
  const first = attempts.find((n) => n.runId === b.attempts[0]?.runId) ?? attempts[0]!;
  const has = attempts.some((n) => n.runId === current);
  const attemptLink = useOfflineLink();
  const spent = attempts.reduce((sum, n) => sum + n.spent, 0);
  const word = gate ? /^(passed|failed|inconclusive)\b/.exec(gate.verdict)?.[1] : null;
  return (
    <a className={`fnode${has ? ' here' : ''}`} href={href.run(first.runId)} onClick={attemptLink}>
      {title ? <Glyph kind={word === 'failed' ? 'fail' : word === 'inconclusive' ? 'warn' : 'test'} label="Test attempts" /> : <Glyph kind="fork" label="Repeated attempts" />}
      <span>
        <span className="f1">
          <code>{b.title}</code>
        </span>
        <span className="f2 block">
          {gate ? `${gate.verdict}${spent ? ` · ${approx(spent)}` : ''}` : b.line}
          {gate?.rule ? <span className="frule">{gate.rule}</span> : null}
        </span>
        <span className="attempts">
          {b.attempts.map((a) => (
            <span key={a.runId}>
              {/* passed, failed, or interrupted (grey: it stopped, it did not fail) */}
              <i className={a.ok ? undefined : a.cut ? 'n' : 'no'} />
              {a.text}
            </span>
          ))}
        </span>
      </span>
      <span className="fr">{stamp(first.startedAt)}</span>
    </a>
  );
}
