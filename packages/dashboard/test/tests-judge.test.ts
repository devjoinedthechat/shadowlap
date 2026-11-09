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
    expect(judgeOf(result([judged({ source: 'recording', cost: 0 })]))).toEqual({ question: null, model: 'claude-haiku-4-5', verdict: 'yes', judged: { how: 'judged from the recording', cost: 'free', read: [] }, held: null });
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
    expect(asked.rows[1].checkResults[0].judge).toEqual({ question: QUESTION, model: 'gpt-5-mini', verdict: null, judged: null, held: null });
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
    // A failed verdict: what it answered on the card, and under the check where it came from, as a passed one's line says it.
    const failed = goldenChecks(store, [LABEL], result([judged({ source: 'recording', cost: 0, verdict: 'no' })]))[0];
    const no = { ...failed, judge: { ...failed.judge!, question: QUESTION } };
    for (const cell of [false, true]) expect(checkMark(no, true, cell)).toMatchObject({ sub: 'judged from the recording · free', tip: { rows: [rows[0], { label: 'Answered', value: 'no: It names the $100 limit.' }, rows[2]] } });
    expect(checkMark(no, true, true).tip.note).toBeUndefined();
    // Over several attempts the line counts them, and the card says where the verdict came from.
    expect(checkMark({ ...no, attempts: { passed: 2, of: 5 } }, true, true)).toMatchObject({ sub: '2 of 5 attempts passed · the others: the judge answered no', tip: { note: 'judged from the recording · free' } });
  });

  it('says on an undecided judge’s card how to judge it once where a replay found no verdict in its pack, else why it has none', () => {
    const undecided = (detail: string): StoredCheck => ({ ok: false, status: 'inconclusive', label: LABEL, detail, judge: { name: 'limit', model: 'claude-haiku-4-5', of: 'answer', verdict: null, source: null, cost: null, redactions: 0, cut: 0 } });
    const offline = 'not judged: no recorded verdict and the test runs offline';
    // What the pack holds, by the CLI's words for why, for a replay alone: a golden that forks asks its judges live.
    expect(judgeOf({ ...result([undecided(offline)]), data: { mode: 'replay', checks: [undecided(offline)] } })?.held).toBe('none');
    expect(judgeOf({ ...result([]), data: { mode: 'replay', checks: [undecided("not judged: the recording's verdict was given to an older form of the judge's request, and the test runs offline: record it again with shadowlap test --update")] } })?.held).toBe('older');
    expect(judgeOf(result([undecided('not judged: no recorded verdict and no key for anthropic')]))?.held).toBeNull();
    const card = (detail: string, held: 'none' | null) => {
      const [c] = goldenChecks(store, [LABEL], result([undecided(detail)]));
      return checkMark({ ...c, judge: { ...c.judge!, question: QUESTION, held } }, true, true);
    };
    // The line says why; the card, as the design's does, how to settle it: an update asks the judge once and keeps its verdict.
    expect(card(offline, 'none')).toMatchObject({ mark: '?', sub: offline, tip: { rows: [{ label: 'Asks', value: QUESTION }], note: 'Not judged offline · update the golden to ask it once' } });
    expect(card('not judged: no recorded verdict and no key for anthropic', null).tip.note).toBe('not judged: no recorded verdict and no key for anthropic');
  });

  it('gives a judge check not tested yet what it asks on its card, with why it has no mark, as Ask a judge… on Tests adds one', () => {
    const view = { rows: [{ path: 'goldens/x', checkResults: goldenChecks(store, [LABEL], result([])) }] } as unknown as TestsView;
    const [c] = withJudgeAsks(view, () => ({ judge: [{ name: 'limit', question: QUESTION, model: 'claude-haiku-4-5' }] })).rows[0].checkResults;
    expect(c).toMatchObject({ status: null, added: true });
    for (const cell of [false, true])
      expect(checkMark(c, true, cell)).toMatchObject({
        mark: null,
        sub: 'added since its last test · not tested yet',
        tip: { title: `not tested yet · ${LABEL}`, rows: [{ label: 'Asks', value: QUESTION }], note: 'Added to shadowlap.config.json since its last test: its next test judges it' },
      });

  });
});
