import { describe, expect, it } from 'vitest';
import { askedInNone, checkLine, evaluateChecks, JUDGE_ASKED_IN_NONE, JUDGE_NOT_ASKED, JUDGE_SKIP_UNDONE, judgedOptions, judgeOverAttempts, notAskedWords, parseExpect, Store, storedCheckInput, type StoredCheck } from '../src/index.js';
import { RunBuilder, text, toolUse, usage, user } from './run-fixtures.js';

// A golden that may fork asks its judges only in an attempt that passed its other checks. Elsewhere a
// judge is not applicable, with why, and costs nothing; the CLI decides when (judge-edges.test.ts),
// and the engine says how such a judge reads.

/** A refund run: the order looked up (total 240), then refunded for 300, and the answer says so. */
function refundRun(store: Store): string {
  const b = RunBuilder.start(store);
  const ask = [user('Order A-1042 arrived damaged. Refund it, please.')];
  b.model({ messages: ask }, [toolUse('lookup_order', { order_id: 'A-1042' }, 'toolu_1')], { usage: usage(120) });
  b.tool('lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', total: 240 });
  b.model({ messages: ask }, [toolUse('issue_refund', { order_id: 'A-1042', amount: 300 }, 'toolu_2')], { usage: usage(160) });
  b.tool('issue_refund', { order_id: 'A-1042', amount: 300 }, { refund_id: 'R-5401', status: 'issued' }, { effect: 'write' });
  b.model({ messages: ask }, [text('Refund issued for order A-1042.')], { usage: usage(200) });
  return b.end();
}

const JUDGE = { name: 'explains-refund', question: 'Does the answer say what was refunded?', model: 'claude-haiku-4-5' };
const WHEN_JUDGE = { name: 'says-escalated', question: 'Does the answer say it was escalated?', model: 'claude-haiku-4-5' };
/** Every judge of the run, not asked. */
const notAsked = { verdicts: new Map(), notJudged: new Map(), notAsked: new Map([JUDGE.name, WHEN_JUDGE.name].map((n) => [n, JUDGE_NOT_ASKED])) };

function judge(expect: Record<string, unknown>): ReturnType<typeof evaluateChecks> {
  const store = Store.open(':memory:');
  try {
    const runId = refundRun(store);
    return evaluateChecks(parseExpect(expect, '--expect'), storedCheckInput(store, store.getCalls(runId), ''), judgedOptions(notAsked));
  } finally {
    store.close();
  }
}

describe('a judge check that was not asked', () => {
  it('is not applicable beside a check that failed, with why, no verdict and no cost: never inconclusive', () => {
    const [refunds, judged] = judge({ tools: { issue_refund: 0 }, judge: [JUDGE] });
    expect(refunds).toMatchObject({ status: 'failed', ok: false });
    expect(judged).toMatchObject({ status: 'not-applicable', ok: true, detail: JUDGE_NOT_ASKED, judge: { name: 'explains-refund', verdict: null, source: null, cost: null } });
    expect(checkLine(judged)).toBe('– judge "explains-refund" answers yes: not applicable · not asked: another check failed');
  });

  it('keeps where a when rule’s condition held after why, and its words are read from the start', () => {
    const results = judge({ tools: { issue_refund: 0 }, when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { judge: [WHEN_JUDGE] } }] });
    const held = results.at(-1)!;
    expect(held).toMatchObject({ status: 'not-applicable', ok: true, detail: `${JUDGE_NOT_ASKED}; the condition held at lookup_order #2 (result.total 240 > 200)` });
    expect(notAskedWords(held.detail)).toBe(JUDGE_NOT_ASKED);
    expect(askedInNone(held).detail).toBe(`${JUDGE_ASKED_IN_NONE}; the condition held at lookup_order #2 (result.total 240 > 200)`);
    expect(notAskedWords(askedInNone(held).detail)).toBe(JUDGE_ASKED_IN_NONE);
  });

  it('is inconclusive where no other check failed after all, so the run never passes without its judge', () => {
    const results = judge({ tools: { issue_refund: 1 }, judge: [JUDGE] });
    expect(results.map((r) => r.status)).toEqual(['passed', 'inconclusive']);
    expect(results[1]).toMatchObject({ ok: false, detail: JUDGE_SKIP_UNDONE, judge: { verdict: null, source: null } });
    expect(checkLine(results[1])).toBe("? judge \"explains-refund\" answers yes: inconclusive · not judged: skipped when another check failed, and that check didn't fail in the end");
    // A judge not asked under a when rule whose condition held reads so too, its condition after why.
    const when = judge({ tools: { issue_refund: 1 }, when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { judge: [WHEN_JUDGE] } }] });
    expect(when.at(-1)).toMatchObject({ status: 'inconclusive', ok: false, detail: `${JUDGE_SKIP_UNDONE}; the condition held at lookup_order #2 (result.total 240 > 200)` });
  });

  it('reads as main reads it without a reason: inconclusive, not judged', () => {
    const store = Store.open(':memory:');
    try {
      const runId = refundRun(store);
      const [, judged] = evaluateChecks(parseExpect({ tools: { issue_refund: 0 }, judge: [JUDGE] }, '--expect'), storedCheckInput(store, store.getCalls(runId), ''), judgedOptions({ verdicts: new Map(), notJudged: new Map([[JUDGE.name, 'the agent exited with code 1']]) }));
      expect(judged).toMatchObject({ status: 'inconclusive', ok: false, detail: 'not judged: the agent exited with code 1' });
      expect(notAskedWords(judged.detail)).toBeNull();
      expect(askedInNone(judged)).toBe(judged);
    } finally {
      store.close();
    }
  });
});

describe('a judge over a golden’s attempts', () => {
  const outcome = (verdict: 'yes' | 'no' | null) => ({ name: 'j', model: 'm', of: 'answer' as const, verdict, source: verdict ? ('live' as const) : null, cost: verdict ? 0.0004 : null, redactions: 0, cut: 0 });
  const shown: StoredCheck = { status: 'not-applicable', ok: true, label: 'judge "j" answers yes', detail: JUDGE_NOT_ASKED, judge: outcome(null) };
  const passed = (reason: string): StoredCheck => ({ status: 'passed', ok: true, label: shown.label, detail: null, reason, source: 'live', judge: outcome('yes') });
  const failed: StoredCheck = { status: 'failed', ok: false, label: shown.label, detail: 'the judge answered no', reason: 'it declined', source: 'live', judge: outcome('no') };
  const exited: StoredCheck = { status: 'inconclusive', ok: false, label: shown.label, detail: 'not judged: the agent exited with code 1', judge: outcome(null) };

  it('reads as the last attempt that asked it passed, or as the first whose judge said no, whatever their order', () => {
    expect(judgeOverAttempts(shown, [shown, passed('first'), exited, passed('last')])).toMatchObject({ status: 'passed', reason: 'last' });
    expect(judgeOverAttempts(shown, [passed('first'), failed, passed('last')])).toBe(failed);
  });

  it('keeps the shown check where no attempt asked it, and any check its attempt asked or skipped for another reason', () => {
    expect(judgeOverAttempts(shown, [shown, exited])).toBe(shown);
    expect(judgeOverAttempts(shown, [])).toBe(shown);
    expect(judgeOverAttempts(exited, [passed('first')])).toBe(exited);
    const none = askedInNone(shown);
    expect(none.detail).toBe(JUDGE_ASKED_IN_NONE);
    expect(judgeOverAttempts(none, [passed('first')])).toBe(none);
  });
});
