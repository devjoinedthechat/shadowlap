import { describe, expect, it } from 'vitest';
import { JUDGE_ASKED_IN_NONE, JUDGE_NOT_ASKED, Store, type JudgeSummary, type StoredCheck, type TestResultData } from '@shadowlap/engine';
import { checkMark } from '../ui/goldens.js';
import { printedLines } from '../src/golden-report.js';
import { testsView, type GoldenSource } from '../src/tests.js';

/**
 * A golden that may fork asks its judge only in the attempts that passed its other checks. Tests'
 * row reads such a judge as the attempts that asked it came out, though the attempt the result shows
 * (the first that failed) didn't ask it, and says why where no attempt asked it.
 */
const T0 = Date.UTC(2026, 10, 12, 10, 0);
const JUDGE = 'judge "explains-escalation" answers yes';
const WHEN_JUDGE = `when lookup_order has result.total > 200: ${JUDGE}`;
const REFUNDS = 'issue_refund called 0 times';

const outcome = (verdict: 'yes' | 'no' | null): NonNullable<StoredCheck['judge']> => ({ name: 'explains-escalation', model: 'claude-haiku-4-5', of: 'answer', verdict, source: verdict ? 'live' : null, cost: verdict ? 0.0004 : null, redactions: 0, cut: 0 });
const asked = (verdict: 'yes' | 'no', reason: string, label = JUDGE): StoredCheck => ({ ok: verdict === 'yes', status: verdict === 'yes' ? 'passed' : 'failed', label, detail: verdict === 'yes' ? null : 'the judge answered no', reason, source: 'live', judge: outcome(verdict) });
const notAsked = (detail: string = JUDGE_NOT_ASKED, label = JUDGE): StoredCheck => ({ ok: true, status: 'not-applicable', label, detail, judge: outcome(null) });
const exited: StoredCheck = { ok: false, status: 'inconclusive', label: JUDGE, detail: 'not judged: the agent exited with code 1', judge: outcome(null) };
const refunds = (ok: boolean): StoredCheck => (ok ? { ok, status: 'passed', label: REFUNDS, detail: null } : { ok, status: 'failed', label: REFUNDS, detail: 'called 1 time (1 blocked)' });

/** The judge summary of a session whose attempts asked the judge `n` times live. */
const judgeSummary = (n: number): JudgeSummary => ({ calls: n, replayed: 0, live: n, notAsked: 0, upstreamRequests: n, spent: (4 * n) / 10_000, saved: 0, unknownModels: [] });

/**
 * Tests' checks of a golden that may fork, whose last result ran these attempts, each run keeping its
 * checks, and its lines as printed: the result shows the first that failed, and keeps its checks
 * (`shown` in their place where given).
 */
function tested(attempts: StoredCheck[][], o: { shown?: StoredCheck[]; continued?: boolean; labels?: string[] } = {}) {
  const s = Store.open(':memory:');
  try {
    const runs = attempts.map((_, i) => `A${i + 1}`);
    attempts.forEach((checks, i) => s.createRun({ runId: runs[i], mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { checks } }));
    const first = attempts.findIndex((checks) => checks.some((c) => !c.ok));
    const passed = attempts.filter((checks) => checks.every((c) => c.ok)).length;
    const asks = attempts.flat().filter((c) => c.judge?.verdict).length;
    const data: TestResultData = { mode: 'fork', verdict: 'failed', checks: o.shown ?? attempts[first], attempts: { total: attempts.length, passed, required: attempts.length, runs }, ...(asks ? { judge: judgeSummary(asks) } : {}), ...(o.continued ? { continued: { sessions: ['S0'], attempts: 2 } } : {}) };
    const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', actor: 'ci', startedAt: T0 });
    s.addTestResult({ sessionId: session.sessionId, golden: 'goldens/pushy', ok: false, failure: 'check', reason: `${passed} of ${attempts.length} attempts passed`, runId: runs[first], revision: 'd2e8a1f', at: T0 + 1, data });
    s.finishTestSession(session.sessionId, { passed: 0, failed: 1, upstreamRequests: 0, endedAt: T0 + 100 });
    const golden: GoldenSource = { path: 'goldens/pushy', runId: null, packedAt: T0, mode: 'fork', repeat: attempts.length, passes: attempts.length, checks: o.labels ?? [REFUNDS, JUDGE] };
    const result = s.listTestResults({ golden: 'goldens/pushy', limit: 1 })[0];
    return { checks: testsView(s, [golden]).rows[0].checkResults, printed: printedLines('pushy', result).map((l) => l.text) };
  } finally {
    s.close();
  }
}

describe('a judge check on Tests that the attempt its result shows didn’t ask', () => {
  it('reads as the attempts that asked it came out, counting only their asks', () => {
    // Eight attempts: the odd ones passed their other check and asked the judge, the even ones didn't.
    const attempts = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => (n % 2 ? [refunds(true), asked('yes', `It says it escalated (${n}).`)] : [refunds(false), notAsked()]));
    const [refundsRow, judged] = tested(attempts).checks;
    expect(refundsRow).toMatchObject({ status: 'failed', attempts: { passed: 4, of: 8 } });
    expect(judged).toEqual({ label: JUDGE, status: 'passed', added: false, detail: null, reason: 'It says it escalated (7).', source: 'live', live: { cost: 0.0016, asked: 4 }, attempts: { passed: 4, of: 4 } });
    expect(checkMark(judged, true).sub).toBe('judged live in 4 attempts · ≈$0.0016');
  });

  it('reads as the first attempt whose judge said no, whatever came before it', () => {
    const [, judged] = tested([[refunds(true), asked('yes', 'It says it escalated.')], [refunds(false), notAsked()], [refunds(true), asked('no', 'It never says so.')]]).checks;
    expect(judged).toMatchObject({ status: 'failed', detail: 'the judge answered no', reason: 'It never says so.', attempts: { passed: 1, of: 2 } });
    expect(checkMark(judged, true).sub).toBe('1 of 2 attempts passed · the others: the judge answered no');
  });

  it('keeps main’s tally of an attempt that exited before it could ask, and never reads from it', () => {
    const passing = [3, 4, 5, 6].map((n) => [refunds(true), asked('yes', `It says it escalated (${n}).`)]);
    const [, judged] = tested([[refunds(false), notAsked()], [refunds(true), exited], ...passing]).checks;
    expect(judged).toMatchObject({ status: 'passed', reason: 'It says it escalated (6).', attempts: { passed: 4, of: 5 } });
    expect(checkMark(judged, true).sub).toBe('4 of 5 attempts passed');
  });

  it('reads a judge under a when rule whose condition held by the words its detail starts with', () => {
    const where = '; the condition held at lookup_order #2 (result.total 240 > 200)';
    const [, judged] = tested([[refunds(false), notAsked(JUDGE_NOT_ASKED + where, WHEN_JUDGE)], [refunds(true), asked('yes', 'It says it escalated.', WHEN_JUDGE)]], { labels: [REFUNDS, WHEN_JUDGE] }).checks;
    expect(judged).toMatchObject({ label: WHEN_JUDGE, status: 'passed', reason: 'It says it escalated.' });
  });

  it('keeps the shown check where the attempts can’t be read: a result that continued an earlier session’s', () => {
    const [, judged] = tested([[refunds(false), notAsked()], [refunds(true), asked('yes', 'It says it escalated.')]], { continued: true }).checks;
    expect(judged).toMatchObject({ status: 'not-applicable', detail: JUDGE_NOT_ASKED, source: null, live: null, attempts: null });
    expect(checkMark(judged, true)).toMatchObject({ mark: '–', sub: JUDGE_NOT_ASKED, tip: { title: `not applicable · ${JUDGE}`, label: 'not applicable', value: JUDGE_NOT_ASKED } });
  });

  it('says why under a judge no attempt asked, with no verdict, cost or update of its golden', () => {
    // Every attempt failed its other check: the CLI kept the golden's words for the shown attempt's judge.
    const attempts = [[refunds(false), notAsked()], [refunds(false), notAsked()]];
    const [, judged] = tested(attempts, { shown: [refunds(false), notAsked(JUDGE_ASKED_IN_NONE)] }).checks;
    expect(judged).toEqual({ label: JUDGE, status: 'not-applicable', added: false, detail: JUDGE_ASKED_IN_NONE, reason: null, source: null, live: null, attempts: null });
    const mark = checkMark(judged, true);
    expect(mark).toEqual({ mark: '–', status: 'not-applicable', word: 'not applicable', text: mark.text, sub: 'not asked: no attempt passed its other checks', tip: { title: `not applicable · ${JUDGE}`, label: 'not applicable', value: 'not asked: no attempt passed its other checks', color: 'var(--faint)' } });
    expect(JSON.stringify(mark)).not.toMatch(/update the golden|Answered|Model/);
  });

  it('prints the shown attempt’s judge as the CLI printed it, while its row reads as the attempts that asked it', () => {
    // Show as printed is the CLI's report: the shown attempt didn't ask the judge. The row reads the four that did.
    const some = tested([1, 2, 3, 4, 5, 6, 7, 8].map((n) => (n % 2 ? [refunds(true), asked('yes', 'It says it escalated.')] : [refunds(false), notAsked()])));
    expect(some.checks[1]).toMatchObject({ status: 'passed' });
    expect(some.printed).toContain(`    – ${JUDGE}: not applicable · not asked: another check failed`);
    // No attempt asked it: the line the CLI printed, in its golden's words.
    const none = tested([[refunds(false), notAsked()], [refunds(false), notAsked()]], { shown: [refunds(false), notAsked(JUDGE_ASKED_IN_NONE)] });
    expect(none.checks[1]).toMatchObject({ status: 'not-applicable', detail: JUDGE_ASKED_IN_NONE });
    expect(none.printed).toContain(`    – ${JUDGE}: not applicable · not asked: no attempt passed its other checks`);
  });
});
