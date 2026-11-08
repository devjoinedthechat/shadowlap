import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { runJob } from '../src/read-jobs.js';
import type { OutcomeWork, RunJudged } from '../src/run-outcome.js';
import { normalizeJudged, normalizeRunDetail, normalizeRuns } from '../ui/normalize.js';
import { outcomeTip } from '../ui/outcome-tip.js';
import { outcomeFact } from '../ui/run/metrics.js';
import { Metrics } from '../ui/run/parts.js';
import { RunsTable } from '../ui/runspage/RunsTable.js';
import { outcomeOf, runOutcome, runStatus, sideStatus, type RunLike } from '../ui/runs.js';
import type { RunDetail, RunListItem } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A run's outcome by checks as the pages say it (A13): Runs' Status and the run's first fact read the
 * server's `judged` alike: `check failed at #6`, `2 checks passed`, `inconclusive`, `not applicable`,
 * by today's checks after the word on the page and for a screen reader on Runs, `no checks` on a
 * run's page where no check judges it and a dash in Runs. Both have the same card on hover. The
 * sidebar says what needs a look in its own few words: where blame found a run lost, `check failed`.
 */

const BASE: RunLike = { runId: '01K8RG00000000000000000001', parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node agent.mjs', codeVersion: null, startedAt: 0, calls: 6, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], kind: 'recording', outcome: { kind: 'none' }, failed: false };

function judged(over: Partial<RunJudged> = {}): RunJudged {
  return { by: 'family', verdict: 'failed', counts: { passed: 1, failed: 1, inconclusive: 0, notApplicable: 0 }, callNo: 6, first: { label: 'send_email called 0 times', detail: 'called 1 time' }, today: true, since: 'packed', goldens: ['goldens/refund'], why: null, ...over };
}

const CHECKS: RunJudged['checks'] = [
  { label: 'send_email called 0 times', status: 'failed', detail: 'called 1 time', callNo: 6, golden: 'goldens/refund' },
  { label: 'when lookup_order has result.total > 200: escalate called 1 time', status: 'not-applicable', detail: 'the condition never held: lookup_order #2: result.total 150 > 200', callNo: null, golden: 'goldens/refund' },
];

describe('Status, judged by checks', () => {
  it('says the verdict of the checks that judged a run, at the call it turned on, by today’s checks', () => {
    const r = { ...BASE, judged: judged() };
    expect(runOutcome(r)).toEqual({ tone: 'err', text: 'check failed at #6', at: { words: 'check failed at', callNo: 6 }, today: true });
    expect(runOutcome({ ...BASE, judged: judged({ counts: { passed: 0, failed: 2, inconclusive: 0, notApplicable: 0 }, today: false }) })).toEqual({ tone: 'err', text: '2 checks failed at #6', at: { words: '2 checks failed at', callNo: 6 } });
    // One word for a check that could not be decided, in Runs as on the page.
    expect(runOutcome({ ...BASE, judged: judged({ verdict: 'inconclusive', callNo: null, today: false }) })).toEqual({ tone: 'warn', text: 'inconclusive' });
    expect(runOutcome({ ...BASE, judged: judged({ verdict: 'passed', counts: { passed: 2, failed: 0, inconclusive: 0, notApplicable: 1 }, callNo: null }) })).toEqual({ tone: 'ok', text: '2 checks passed, 1 not applicable', today: true });
    expect(runOutcome({ ...BASE, kind: 'capture', judged: judged({ by: 'import', verdict: 'not-applicable', callNo: null, today: false }) })).toEqual({ tone: 'mu', text: 'not applicable' });
    // The sidebar says what needs a look in its own words: the call is Runs'.
    expect(sideStatus(r)).toEqual({ text: 'check failed', tone: 'err' });
  });

  it('says a blamed run failed the check it names, at its call, where the sidebar says where it was lost', () => {
    // Blame lost it at model call #3; its own check failed at the refund, #4.
    const blamed = { ...BASE, status: 'completed' as const, outcome: { kind: 'lost', callNo: 3 }, failed: true, judged: judged({ by: 'own', callNo: 4, today: false, first: { label: 'every issue_refund call: amount <= 200', detail: 'issue_refund #4: amount 300 > 200' } }) };
    expect(runStatus(blamed)).toEqual({ tone: 'err', text: 'check failed at #4', at: { words: 'check failed at', callNo: 4 } });
    expect(sideStatus(blamed)).toEqual({ text: 'lost at #3', tone: 'err' });
    const fact = outcomeFact(blamed, { tools: 3 });
    expect(fact).toMatchObject({ tone: 'err', words: 'check failed at', callNo: 4 });
    expect(fact.tip).toMatchObject({ title: 'Check failed', sub: 'every issue_refund call: amount <= 200, but issue_refund #4: amount 300 > 200' });
    // Without the server's verdict, the check it failed, with no call to name.
    const { judged: _verdict, ...unjudged } = blamed;
    expect(runOutcome(unjudged)).toEqual({ tone: 'err', text: 'check failed' });
    // A family's verdict never stands for a run's own failure.
    expect(runOutcome({ ...blamed, judged: judged() }).text).toBe('check failed');
  });

  it('leaves a run still recording, a test that diverged, and an agent’s exit with no check failing, to their own words', () => {
    const j = judged();
    expect(runOutcome({ ...BASE, status: 'running', outcome: { kind: 'running' }, judged: j }).text).toBe('in progress');
    expect(runOutcome({ ...BASE, outcome: { kind: 'diverged', callNo: 1 }, judged: j })).toEqual({ tone: 'err', text: 'diverged at #1', at: { words: 'diverged at', callNo: 1 } });
    expect(runOutcome({ ...BASE, status: 'failed', outcome: { kind: 'check-failed', check: null }, failed: true, judged: judged({ by: 'own', verdict: 'passed' }) }).text).toBe('exited with an error');
    expect(runOutcome({ ...BASE, status: 'failed', outcome: { kind: 'check-failed', check: null }, failed: true, exitCode: 1 }).text).toBe('exited 1');
    // Its own check failed: the call it turned on, the check on its hover, in one line on a fork's row too.
    const own = { ...BASE, kind: 'fork', mode: 'replay' as const, divergence: { callNo: 3, type: 'request_changed' }, outcome: { kind: 'check-failed', check: 'send_email called 0 times' }, failed: true, judged: judged({ by: 'own', today: false }) };
    expect(runStatus(own)).toEqual({ tone: 'err', text: 'check failed at #6', at: { words: 'check failed at', callNo: 6 } });
  });

  it('says nothing for a clean replay no check judges: how faithful it was is no verdict', () => {
    expect(runOutcome({ ...BASE, kind: 'clean', mode: 'replay', parentRunId: '01K8RG00000000000000000002', outcome: { kind: 'clean' }, judged: null })).toEqual({ tone: 'n', text: '—' });
    expect(runOutcome({ ...BASE, kind: 'test', mode: 'replay', test: { golden: 'goldens/refund' }, outcome: { kind: 'clean' } })).toEqual({ tone: 'n', text: '—' });
  });

  it('takes the server’s judged outcome field by field, and drops one that is none', () => {
    const wire = JSON.parse(JSON.stringify({ ...judged(), checks: [{ label: 'a', status: 'failed', detail: 'b', callNo: 6, golden: 'goldens/refund' }, { label: 'c', status: 'nope' }] })) as unknown;
    expect(normalizeJudged(wire)).toEqual({ ...judged(), checks: [{ label: 'a', status: 'failed', detail: 'b', callNo: 6, golden: 'goldens/refund' }] });
    expect(normalizeJudged({ by: 'someone', verdict: 'failed', counts: {} })).toBeNull();
    const [row] = normalizeRuns([{ ...BASE, judged: { by: 'family' }, exitCode: 'one' } as unknown as RunListItem]);
    expect(row?.judged).toBeNull();
    expect(row && 'exitCode' in row).toBe(false);
  });
});

describe('the card on hover', () => {
  const tip = (r: RunLike, tools: number | null = 3) => outcomeTip(r, outcomeOf(r), tools);

  it('says what judged a run, by its goldens’ names, each check with its verdict and what decided it', () => {
    expect(tip({ ...BASE, judged: judged({ checks: CHECKS }) })).toEqual({
      title: 'Today’s checks, judged from the recording',
      sub: 'This run was recorded before them: refund’s checks, added with the golden.',
      rows: [
        ['send_email called 0 times', 'failed · called 1 time', 'var(--cq-red)'],
        // A check that did not apply, by the last clause of why.
        ['when lookup_order has result.total > 200: escalate called 1 time', 'not applicable · result.total 150 > 200', 'var(--cq-muted)'],
      ],
      said: 'send_email called 0 times, but called 1 time',
    });
    expect(tip({ ...BASE, judged: judged({ since: 'changed', goldens: ['goldens/refund', 'goldens/refund-twice'] }) }).sub).toBe('This run was recorded before them: refund’s and refund-twice’s checks, changed since the golden was packed.');
    expect(tip({ ...BASE, judged: judged({ today: false }) })).toMatchObject({ title: 'Its family’s checks', sub: 'refund’s checks, which it was made under.' });
    // What keeps a recording from settling them, where no check says it.
    expect(tip({ ...BASE, judged: judged({ verdict: 'inconclusive', first: null, callNo: null, why: "a check reads what the agent printed, which a recording doesn't keep" }) }).sub).toBe("This run was recorded before them: refund’s checks, added with the golden. A check reads what the agent printed, which a recording doesn't keep.");
  });

  it('says a capture was judged when it was imported, by the rules on calls, or why none applied', () => {
    const capture = { ...BASE, kind: 'capture' };
    expect(tip({ ...capture, judged: judged({ by: 'import', today: false, goldens: [] }) })).toMatchObject({ title: 'Judged when it was imported', sub: 'By the rules on calls in shadowlap.config.json.' });
    expect(tip({ ...capture, judged: judged({ by: 'import', verdict: 'not-applicable', callNo: null, first: null, today: false, why: 'it holds no tool calls, and every rule reads them' }) })).toMatchObject({ sub: 'Not applicable: it holds no tool calls, and every rule reads them.' });
    expect(tip({ ...capture, judged: judged({ by: 'import', today: true }) }).title).toBe('Judged again by today’s rules on calls');
  });

  it('titles a run’s own checks by their verdict', () => {
    expect(tip({ ...BASE, judged: judged({ by: 'own', today: false }) })).toMatchObject({ title: 'Check failed', sub: 'send_email called 0 times, but called 1 time', rows: [] });
    expect(tip({ ...BASE, judged: judged({ by: 'own', verdict: 'inconclusive', callNo: null, today: false, first: { label: 'judge "polite" answers yes', detail: 'not judged: no recorded verdict' } }) })).toMatchObject({ title: 'Inconclusive', sub: 'judge "polite" answers yes: inconclusive · not judged: no recorded verdict' });
    expect(tip({ ...BASE, judged: judged({ by: 'own', verdict: 'passed', first: null, callNo: null, today: false, checks: [{ label: 'a', status: 'passed', detail: null, callNo: null }] }) })).toMatchObject({ title: 'Checks', rows: [['a', 'passed', 'var(--cq-lime)']] });
  });

  it('says where a test diverged, how one comes to judge a run no check applies to, and a run still recording', () => {
    const diverged = { ...BASE, kind: 'test', mode: 'replay' as const, divergence: { callNo: 1, type: 'request_changed', diff: [{ path: '$.system' }] }, outcome: { kind: 'diverged', callNo: 1 }, failed: true };
    expect(tip(diverged)).toMatchObject({ title: 'Diverged at #1', sub: 'A request changed (~ $.system).' });
    expect(tip({ ...BASE, judged: null })).toMatchObject({ title: 'No check applies to this run', sub: 'Pick a tool call and use Add check… in the inspector, or pack the run as a golden with its checks.' });
    expect(tip({ ...BASE, judged: null }, 0).sub).toBe('It made no tool call, and a check is added from one.');
    // A capture offers no Add check…: it is told where a golden's checks go.
    expect(tip({ ...BASE, source: 'otel', judged: null }).sub).toBe('Pack it as a golden with checks, or give a golden of its family checks under "tests" in shadowlap.config.json.');
    expect(tip({ ...BASE, source: 'otel', judged: null }, 0).sub).toBe('It made no tool call, and a check on calls reads them.');
    expect(tip({ ...BASE, status: 'running', outcome: { kind: 'running' } })).toMatchObject({ title: 'Still recording', sub: 'It is judged once it finishes.' });
  });
});

describe("a run's first fact", () => {
  it('is its outcome, the call a link apart; no checks in grey with how one comes to judge it; nothing yet while it is judged', () => {
    expect(outcomeFact({ ...BASE, judged: { ...judged(), checks: CHECKS } }, { tools: 3 })).toMatchObject({ tone: 'err', words: 'check failed at', callNo: 6, today: true, tip: { title: 'Today’s checks, judged from the recording' } });
    // No check judges it: a clean replay and a fork say so too, by a grey dot.
    expect(outcomeFact({ ...BASE, judged: null }, { tools: 3 })).toMatchObject({ tone: 'mu', words: 'no checks', tip: { title: 'No check applies to this run' } });
    expect(outcomeFact({ ...BASE, kind: 'fork', mode: 'replay', divergence: { callNo: 2, type: 'request_changed' }, origins: 'rlb', judged: null }, { tools: 1 }).words).toBe('no checks');
    // Interrupted is no verdict: muted, as Status draws every such word.
    expect(outcomeFact({ ...BASE, status: 'crashed', judged: null }, { tools: 3 })).toMatchObject({ tone: 'mu', words: 'interrupted' });
    // A test that diverged: its call a link.
    expect(outcomeFact({ ...BASE, kind: 'test', outcome: { kind: 'diverged', callNo: 1 } }, { tools: 3 })).toMatchObject({ tone: 'err', words: 'diverged at', callNo: 1 });
    // A long run's first answer, before its analysis judged it: no verdict yet, never "no checks".
    expect(outcomeFact({ ...BASE, judged: null }, { tools: 3, pending: true })).toMatchObject({ tone: 'mu', words: '…', callNo: null });
  });

  it('leads the run page’s facts as the run payload says it, its check said to a screen reader', async () => {
    const store = Store.open(':memory:');
    // A model call, the email it asked for, and its answer.
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, startedAt: 1_760_000_000_000 });
    const runId = run.runId;
    const calls = [
      { kind: 'api' as const, name: 'POST /v1/messages', requestRef: null },
      { kind: 'tool' as const, name: 'send_email', requestRef: store.putJson({ args: { to: 'ada@example.com' } }) },
      { kind: 'api' as const, name: 'POST /v1/messages', requestRef: null },
    ];
    calls.forEach((c, i) => {
      const identity = { kind: c.kind, name: c.name, fingerprint: `f${i + 1}`, occurrence: 1 };
      store.appendCallStart({ runId, callNo: i + 1, ...identity, origin: 'live', effect: c.kind === 'tool' ? 'write' : null, requestRef: c.requestRef, meta: {}, at: run.startedAt + i * 10 });
      store.appendCallEnd(identity, { runId, callNo: i + 1, attempt: 0, responseRef: null, outcome: 'ok', meta: {}, at: run.startedAt + i * 10 + 5 });
    });
    store.endRun(runId, 'completed', run.startedAt + 100);
    const work: OutcomeWork = { version: 'v1', tests: { 'goldens/refund': { expect: { tools: { send_email: 0 } } } }, dir: '/work/project', goldens: [{ path: 'goldens/refund', runId, packedAt: 1_760_000_100_000 }] };
    const d = normalizeRunDetail(JSON.parse((await runJob(store, { kind: 'run', runId, read: {}, outcome: work })).body) as RunDetail);
    const html = renderToStaticMarkup(createElement(Metrics, { run: d, notWaitedMs: null, notWaitedUnknown: 0 }));
    // A status as Status draws it: its dot kept from a screen reader, which hears the words.
    expect(html).toContain(`<span class="metric rout"><span class="st err" data-tip=`);
    expect(html).toContain(`<i aria-hidden="true"></i>check failed at <a class="bn" href="#/run/${runId}/2">#2</a><span class="sr">: send_email called 0 times, but called 1 time</span></span><span class="rtoday">by today’s checks</span></span>`);
    // Its counts follow.
    expect(html.indexOf('rout')).toBeLessThan(html.indexOf('model calls'));
    // Before its analysis judged a long run: nothing said yet.
    const { judged: _verdict, ...first } = d;
    const pending = renderToStaticMarkup(createElement(Metrics, { run: first, notWaitedMs: null, notWaitedUnknown: 0, judged: null, pending: true }));
    expect(pending).toContain('<span class="metric rout"><span class="st mu" data-tip=');
    expect(pending).not.toContain('no checks');
    store.close();
  });
});

describe("Runs' Status", () => {
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
  });
  const row = (runId: string, o: Partial<RunListItem>): RunListItem => ({ ...(BASE as unknown as RunListItem), runId, depth: 0, label: 'recording', endedAt: 1, origins: 'l'.repeat(6), ...o });

  it('has the card the first fact has on hover, and says a run no check judges with a dash a screen reader hears as no checks', async () => {
    const judgedRow = row('01K8RG3000000000000000000A', { judged: { ...judged(), checks: CHECKS } });
    const none = row('01K8RG4000000000000000000B', { judged: null });
    r = await render(createElement(RunsTable, { rows: [judgedRow, none], picked: new Set<string>(), selectable: false, byColumn: false, sort: 'when', onSort: () => undefined, onPick: () => undefined, onPickAll: () => undefined, now: 60_000 }));
    const st = (id: string) => r!.all('table.runst tbody tr').find((tr) => tr.querySelector('.rid code')!.textContent === id.slice(0, 10))!.querySelector('.st')!;
    const card = JSON.parse(st(judgedRow.runId).getAttribute('data-tip')!) as { t: string; s: string; rows: string[][] };
    expect(card.t).toBe('Today’s checks, judged from the recording');
    expect(card.rows[0]).toEqual(['send_email called 0 times', 'failed · called 1 time', 'var(--cq-red)']);
    expect(st(judgedRow.runId).textContent).toContain('by today’s checks');
    expect(st(none.runId).getAttribute('aria-label')).toBe('no checks');
    expect((JSON.parse(st(none.runId).getAttribute('data-tip')!) as { t: string }).t).toBe('No check applies to this run');
  });
});
