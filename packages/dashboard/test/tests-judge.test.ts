import { describe, expect, it } from 'vitest';
import { Store, type StoredCheck, type TestResult } from '@shadowlap/engine';
import { goldenChecks, withJudgeAsks, type GoldenCheck } from '../src/tests-checks.js';
import type { TestsView } from '../src/tests.js';
import { goldenExpect } from '../src/run-offers.js';
import { checkMark } from '../ui/goldens.js';

/**
 * A judge check on Tests: where its verdict came from and what it cost in the engine's words, joined
 * as a page joins them, and its card: what it asks, what it answered and why, and its model.
 */
const LABEL = 'judge "limit" answers yes';
const QUESTION = 'Does the reply name the refund limit?';
const judged = (o: { source: 'recording' | 'live'; cost: number | null; redactions?: number; verdict?: 'yes' | 'no' }): StoredCheck => ({
  ok: (o.verdict ?? 'yes') === 'yes',
  status: (o.verdict ?? 'yes') === 'yes' ? 'passed' : 'failed',
  label: LABEL,
  detail: (o.verdict ?? 'yes') === 'yes' ? null : 'the judge answered no',
  reason: 'It names the $100 limit.',
  source: o.source,
  judge: { name: 'limit', model: 'claude-haiku-4-5', of: 'answer', verdict: o.verdict ?? 'yes', source: o.source, cost: o.cost, redactions: o.redactions ?? 0, cut: 0 },
});
const result = (checks: StoredCheck[], more: Record<string, unknown> = {}) => ({ ok: true, at: 1, data: { mode: 'fork', checks, ...more } }) as unknown as TestResult;
const summary = (live: number, spent: number) => ({ calls: live, replayed: 0, live, notAsked: 0, upstreamRequests: live, spent, saved: 0, unknownModels: [] });

describe("a judge check's source and card on Tests", () => {
  const store = Store.open(':memory:');
  const judgeOf = (r: TestResult, labels = [LABEL]) => goldenChecks(store, labels, r)[0].judge;

  it('says where each verdict came from and what it cost in the engine’s words, at the cost Tests gives', () => {
    expect(judgeOf(result([judged({ source: 'recording', cost: 0 })]))).toEqual({ question: null, model: 'claude-haiku-4-5', verdict: 'yes', judged: { how: 'judged from the recording', cost: 'free', read: [] } });
    // Five attempts and one judge: the result's summary is what asking it cost.
    expect(judgeOf(result([judged({ source: 'live', cost: 0.0004 })], { judge: summary(5, 0.0021), attempts: { total: 5, passed: 5, required: null, runs: [] } }))?.judged).toEqual({ how: 'judged live', cost: '≈$0.0021', read: [] });
    // Over several attempts beside another judge, the result doesn't say: no figure, never one attempt's.
    const two = result([judged({ source: 'live', cost: 0.0004 }), { ...judged({ source: 'live', cost: 0.0004 }), label: 'judge "calm" answers yes' }], { judge: summary(10, 0.008), attempts: { total: 5, passed: 5, required: null, runs: [] } });
    expect(judgeOf(two)?.judged).toEqual({ how: 'judged live', cost: null, read: [] });
    expect(judgeOf(result([judged({ source: 'live', cost: null, redactions: 1 })]))?.judged).toEqual({ how: 'judged live', cost: 'no price for claude-haiku-4-5', read: ['read with 1 redaction rule applied'] });
    // Any other check has no judge.
    expect(goldenChecks(store, ['escalate called 1 time'], result([{ ok: true, status: 'passed', label: 'escalate called 1 time', detail: null }]))[0].judge).toBeNull();
  });

  it('reads what each judge asks and its model from the golden’s entry, for a check not judged yet too, and keeps the model that answered', () => {
    const tests = { 'goldens/refund-flow': { expect: { judge: [{ name: 'limit', question: QUESTION, model: 'gpt-5-mini' }] } }, 'goldens/broken': { expect: { judge: 'yes' } } };
    const row = (path: string, checkResults: GoldenCheck[]) => ({ path, checkResults }) as TestsView['rows'][number];
    const view = { rows: [row('goldens/refund-flow', goldenChecks(store, [LABEL], result([judged({ source: 'recording', cost: 0 })]))), row('goldens/new', goldenChecks(store, [LABEL], null)), row('goldens/broken', goldenChecks(store, [LABEL], null))] } as TestsView;
    const asked = withJudgeAsks(view, (g) => goldenExpect({ ...tests, 'goldens/new': tests['goldens/refund-flow'] }, g));
    expect(asked.rows[0].checkResults[0].judge).toMatchObject({ question: QUESTION, model: 'claude-haiku-4-5', verdict: 'yes' });
    expect(asked.rows[1].checkResults[0].judge).toEqual({ question: QUESTION, model: 'gpt-5-mini', verdict: null, judged: null });
    // An entry that can't be read asks nothing here.
    expect(asked.rows[2].checkResults[0].judge).toBeNull();
  });

  it('draws its card as the mock does: Asks, then Answered and Model where it was asked, and in Tests’ cell a passed verdict’s source on its hover', () => {
    const [c] = withJudgeAsks({ rows: [{ path: 'goldens/x', checkResults: goldenChecks(store, [LABEL], result([judged({ source: 'recording', cost: 0 })])) }] } as unknown as TestsView, () => ({ judge: [{ name: 'limit', question: QUESTION, model: 'claude-haiku-4-5' }] })).rows[0].checkResults;
    const rows = [
      { label: 'Asks', value: QUESTION },
      { label: 'Answered', value: 'yes: It names the $100 limit.' },
      { label: 'Model', value: 'claude-haiku-4-5' },
    ];
    expect(checkMark(c, true)).toMatchObject({ sub: 'judged from the recording · free', tip: { title: `passed · ${LABEL}`, rows } });
    expect(checkMark(c, true).tip.note).toBeUndefined();
    expect(checkMark(c, true, true)).toMatchObject({ sub: null, tip: { rows, note: 'judged from the recording · free' } });
    // No verdict: what it asks, and why under it.
    const unjudged: GoldenCheck = { ...c, status: 'inconclusive', detail: 'not judged: no recorded verdict and the test runs offline', judge: { ...c.judge!, verdict: null, judged: null } };
    expect(checkMark(unjudged, true, true).tip).toMatchObject({ rows: [rows[0]], note: 'not judged: no recorded verdict and the test runs offline' });
    // A failed verdict: its answer and why on the card, what it found under the check.
    const failed = goldenChecks(store, [LABEL], result([judged({ source: 'recording', cost: 0, verdict: 'no' })]))[0];
    expect(checkMark({ ...failed, judge: { ...failed.judge!, question: QUESTION } }, true, true)).toMatchObject({ sub: 'the judge answered no', tip: { rows: [rows[0], { label: 'Answered', value: 'no: It names the $100 limit.' }, rows[2]] } });
  });
});
