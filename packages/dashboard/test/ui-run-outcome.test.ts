import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { runJob } from '../src/read-jobs.js';
import type { OutcomeWork, RunJudged } from '../src/run-outcome.js';
import { normalizeJudged, normalizeRunDetail, normalizeRuns } from '../ui/normalize.js';
import { outcomeFact } from '../ui/run/metrics.js';
import { Metrics } from '../ui/run/parts.js';
import { runOutcome, runStatus, sideStatus, type RunLike } from '../ui/runs.js';
import type { RunDetail, RunListItem } from '../ui/types.js';

/**
 * A run's outcome by checks as the pages say it (A13): Runs' Status, the sidebar and the run's first
 * fact read the server's `judged` alike: `check failed at #6`, `2 checks passed`, `check inconclusive`,
 * `not applicable`, by today's checks after the word on the page and for a screen reader on Runs, and
 * `no checks` on a run's page where no check judges it.
 */

const BASE: RunLike = { runId: '01K8RG00000000000000000001', parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node agent.mjs', codeVersion: null, startedAt: 0, calls: 6, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], kind: 'recording', outcome: { kind: 'none' }, failed: false };

function judged(over: Partial<RunJudged> = {}): RunJudged {
  return { by: 'family', verdict: 'failed', counts: { passed: 1, failed: 1, inconclusive: 0, notApplicable: 0 }, callNo: 6, first: { label: 'send_email called 0 times', detail: 'called 1 time' }, today: true, goldens: ['goldens/refund'], why: null, ...over };
}

describe('Status, judged by checks', () => {
  it('says the verdict of the checks that judged a run, at the call it turned on, by today’s checks', () => {
    const r = { ...BASE, judged: judged() };
    expect(runOutcome(r)).toEqual({ tone: 'err', text: 'check failed at #6', at: { words: 'check failed at', callNo: 6 }, today: true });
    expect(runOutcome({ ...BASE, judged: judged({ counts: { passed: 0, failed: 2, inconclusive: 0, notApplicable: 0 }, today: false }) })).toEqual({ tone: 'err', text: '2 checks failed at #6', at: { words: '2 checks failed at', callNo: 6 } });
    expect(runOutcome({ ...BASE, judged: judged({ verdict: 'inconclusive', callNo: null, today: false }) })).toEqual({ tone: 'warn', text: 'check inconclusive' });
    expect(runOutcome({ ...BASE, judged: judged({ verdict: 'passed', counts: { passed: 2, failed: 0, inconclusive: 0, notApplicable: 1 }, callNo: null }) })).toEqual({ tone: 'ok', text: '2 checks passed, 1 not applicable', today: true });
    expect(runOutcome({ ...BASE, kind: 'capture', judged: judged({ by: 'import', verdict: 'not-applicable', callNo: null, today: false }) })).toEqual({ tone: 'fk', text: 'not applicable' });
    // The sidebar says what needs a look in the same words.
    expect(sideStatus(r)).toEqual({ text: 'check failed at #6', tone: 'err' });
  });

  it('leaves a run still recording, one that diverged or was lost, and one that failed with no check named, to their own words', () => {
    const j = judged();
    expect(runOutcome({ ...BASE, status: 'running', outcome: { kind: 'running' }, judged: j }).text).toBe('in progress');
    expect(runOutcome({ ...BASE, outcome: { kind: 'diverged', callNo: 1 }, judged: j }).text).toBe('diverged at #1');
    expect(runOutcome({ ...BASE, outcome: { kind: 'lost', callNo: 5 }, judged: j }).text).toBe('lost at #5');
    expect(runOutcome({ ...BASE, status: 'failed', outcome: { kind: 'check-failed', check: null }, failed: true, judged: j }).text).toBe('failed');
    // Its own check failed: the check named under the words on a fork's row, and the call it turned on.
    const own = { ...BASE, kind: 'fork', mode: 'replay' as const, divergence: { callNo: 3, type: 'request_changed' }, outcome: { kind: 'check-failed', check: 'send_email called 0 times' }, failed: true, judged: judged({ by: 'own', today: false }) };
    expect(runStatus(own)).toEqual({ tone: 'err', text: 'check failed at #6', at: { words: 'check failed at', callNo: 6 }, check: 'send_email called 0 times' });
    // A family's verdict never stands for a run's own failure.
    expect(runOutcome({ ...own, judged: judged() }).text).toBe('check failed');
  });

  it('takes the server’s judged outcome field by field, and drops one that is none', () => {
    const wire = JSON.parse(JSON.stringify({ ...judged(), checks: [{ label: 'a', status: 'failed', detail: 'b', callNo: 6, golden: 'goldens/refund' }, { label: 'c', status: 'nope' }] })) as unknown;
    expect(normalizeJudged(wire)).toEqual({ ...judged(), checks: [{ label: 'a', status: 'failed', detail: 'b', callNo: 6, golden: 'goldens/refund' }] });
    expect(normalizeJudged({ by: 'someone', verdict: 'failed', counts: {} })).toBeNull();
    const [row] = normalizeRuns([{ ...BASE, judged: { by: 'family' } } as unknown as RunListItem]);
    expect(row?.judged).toBeNull();
  });
});

describe("a run's first fact", () => {
  it('is its outcome, the call a link, what judged it on hover; no checks says how one comes to judge it', () => {
    const checks = [{ label: 'send_email called 0 times', status: 'failed' as const, detail: 'called 1 time' }];
    const fact = outcomeFact({ ...BASE, judged: { ...judged(), checks } }, { tools: 3 });
    expect(fact).toEqual({ tone: 'err', words: 'check failed at', callNo: 6, today: true, tip: { title: 'Today’s checks, judged from the recording', sub: 'It was recorded before them: goldens/refund’s checks, added with the golden or since.', rows: [['send_email called 0 times', 'failed · called 1 time', 'var(--err)']] } });
    expect(outcomeFact({ ...BASE, judged: { ...judged({ today: false }), checks } }, { tools: 3 }).tip.title).toBe('Its family’s checks');
    expect(outcomeFact({ ...BASE, kind: 'capture', judged: { ...judged({ by: 'import', verdict: 'not-applicable', callNo: null, today: false, why: 'it holds no tool calls, and every rule reads them' }), checks: [] } }, { tools: 0 }).tip).toEqual({ title: 'Judged when it was imported', sub: 'Not applicable: it holds no tool calls, and every rule reads them.', rows: [] });
    // No check judges it: a clean replay and a fork say so too, and how one comes to.
    expect(outcomeFact({ ...BASE, judged: null }, { tools: 3 })).toMatchObject({ tone: 'n', words: 'no checks', tip: { title: 'No check judges this run', sub: 'Pack it as a golden with checks, or give a golden of its family checks under "tests" in shadowlap.config.json.' } });
    expect(outcomeFact({ ...BASE, kind: 'clean', mode: 'replay', outcome: { kind: 'clean' }, judged: null }, { tools: 0 }).tip.sub).toBe('It made no tool call, and a check on calls reads them.');
    expect(outcomeFact({ ...BASE, status: 'crashed', judged: null }, { tools: 3 }).words).toBe('interrupted');
    // A check that could not be decided reads inconclusive on the page, its one word for it.
    expect(outcomeFact({ ...BASE, judged: { ...judged({ verdict: 'inconclusive', callNo: null, today: false }), checks: [] } }, { tools: 3 })).toMatchObject({ tone: 'warn', words: 'inconclusive' });
  });

  it('leads the run page’s facts as the run payload says it', async () => {
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
    const work: OutcomeWork = { version: 'v1', tests: { 'goldens/refund': { expect: { tools: { send_email: 0 } } } }, dir: '/work/project', changedAt: 1_760_000_100_000, goldens: [{ path: 'goldens/refund', runId, packedAt: 1_760_000_100_000 }] };
    const d = normalizeRunDetail(JSON.parse((await runJob(store, { kind: 'run', runId, read: {}, outcome: work })).body) as RunDetail);
    const html = renderToStaticMarkup(createElement(Metrics, { run: d, notWaitedMs: null, notWaitedUnknown: 0 }));
    expect(html).toContain(`<span class="metric rout"><span class="st err" data-tip=`);
    expect(html).toContain(`check failed at <a href="#/run/${runId}/2">#2</a></span><span class="rtoday">by today’s checks</span></span>`);
    // Its counts follow.
    expect(html.indexOf('rout')).toBeLessThan(html.indexOf('model calls'));
    store.close();
  });
});
