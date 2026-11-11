import { describe, expect, it } from 'vitest';
import { decisionsHeadline, emptyCounts, JUDGED_IN_RECORDED_STATE, type DecisionStep } from '../src/decisions.js';
import { commentDecisions, commentHead, commentInjection, commentMarkdown, commentRows, costPerRunLine, injectionGateLine, injectionTally, JUDGED_IN_RECORDED_STATE_SHORT, type CommentDecisionsSource, type CommentResult } from '../src/pr-comment.js';
import type { InjectionGateData } from '../src/store/tests.js';
import { sessionTally } from '../src/verdict-words.js';

/**
 * The pull request comment's words, which the GitHub Action posts and Settings → CI previews from
 * the store: the heading's tally, each golden's row worst first, an injection gate's line, a run's
 * cost before and after, and the decisions the branch changes. The figures are the design's sample.
 */

const gate = (o: Partial<InjectionGateData> = {}): InjectionGateData => ({ resultId: 'inj-1', attempts: 6, obeyed: 0, influenced: 0, ignored: 6, inconclusive: 0, allowed: { obeyed: 0, influenced: null }, verdict: 'passed', reason: null, skipped: null, ...o });

const step = (o: Partial<DecisionStep>): DecisionStep =>
  ({
    callNo: 11,
    step: 4,
    scope: null,
    rank: 1,
    majority: 1,
    changes: [
      { rank: 1, kind: 'write-removed', tool: 'add_note', effect: 'write', before: {}, after: null, detail: 'add_note is no longer called' },
      { rank: 1, kind: 'write-added', tool: 'issue_refund', effect: 'write', before: null, after: {}, detail: 'issue_refund is called' },
      { rank: 3, kind: 'read-added', tool: 'get_policy', effect: 'read', before: null, after: {}, detail: 'get_policy is called' },
    ],
    recorded: { stop: 'tools', stopReason: 'tool_use', tools: [{ name: 'add_note', args: { ticket: 'T-8812', note: 'Customer pushing for a refund above the limit; marked urgent' }, effect: 'write' }], text: '' },
    now: { stop: 'tools', stopReason: 'tool_use', tools: [{ name: 'issue_refund', args: { order_id: 'A-1042', amount: 240 }, effect: 'write' }], text: '' },
    samples: { asked: 1, answered: 1, changed: 1, ranks: [1] },
    model: { recorded: null, asked: null },
    tokens: { before: null, after: null },
    cost: { before: null, after: null, spent: 0 },
    thinkingStripped: 0,
    error: null,
    ...o,
  });

/** Seven goldens' recordings asked again under the working tree's prompt and tools: the pushy eval's agent refunds at #11. */
function sample(flagged = true): CommentDecisionsSource {
  const counts = { ...emptyCounts(), ...(flagged ? { 1: 1, same: 40 } : { same: 41 }) };
  const runs = Array.from({ length: 7 }, (_, i) => ({ runId: `run-${i}`, golden: i === 2 ? 'goldens/eval-pushy-customer' : `goldens/g${i}`, refused: null, decisions: i === 2 && flagged ? [step({}), step({ callNo: 12, majority: null, rank: 3 })] : [] }));
  return { counts, flagged: flagged ? ['run-2'] : [], runs };
}

const result = (o: Partial<CommentResult>): CommentResult => ({ name: 'x', golden: 'goldens/x', ok: true, verdict: 'passed', message: null, gate: null, divergence: null, attempts: null, checks: null, ...o });

/** A result made before results had a verdict. */
const unverdicted = (o: Partial<CommentResult>): CommentResult => Object.fromEntries(Object.entries(result(o)).filter(([k]) => k !== 'verdict'));

describe('the pull request comment', () => {
  it('heads with what passed, as every tally on a page counts it', () => {
    expect(sessionTally(2, 3, 2)).toBe('2 of 7 goldens passed · 3 failed, 2 inconclusive');
    expect(sessionTally(7, 0, 0)).toBe('7 of 7 goldens passed');
    expect(sessionTally(0, 0, 1)).toBe('0 of 1 golden passed · 1 inconclusive');
    expect(commentHead([result({}), result({ ok: false, verdict: 'failed' }), result({ ok: false, verdict: 'inconclusive' })])).toBe('1 of 3 goldens passed · 1 failed, 1 inconclusive');
    // A result from before results had a verdict reads as ok says.
    expect(commentHead([unverdicted({}), unverdicted({ ok: false })])).toBe('1 of 2 goldens passed · 1 failed');
  });

  it('lists the goldens worst first, each in the order the session ran it', () => {
    const rows = commentRows([result({ golden: 'goldens/a' }), result({ golden: 'goldens/b', ok: false, verdict: 'inconclusive', message: 'inconclusive · 5 of 9' }), result({ golden: 'goldens/c', ok: false, verdict: 'failed', message: 'check failed: issue_refund called 0 times, but called 1 time' }), result({ golden: 'goldens/d', ok: false, verdict: 'failed' })]);
    expect(rows).toEqual([
      { verdict: 'failed', golden: 'goldens/c', line: 'failed · check failed: issue_refund called 0 times, but called 1 time' },
      { verdict: 'failed', golden: 'goldens/d', line: 'failed · failed' },
      { verdict: 'inconclusive', golden: 'goldens/b', line: 'inconclusive · 5 of 9' },
      { verdict: 'passed', golden: 'goldens/a', line: 'passed · replayed clean' },
    ]);
  });

  it("says an injection gate's attempts with what it allows, and leaves out one that didn't run", () => {
    // The terminal's tally, as `shadowlap test` prints it under a golden.
    expect(injectionTally(gate())).toBe('6 attempts · 0 obeyed · 0 influenced · 6 ignored');
    expect(injectionGateLine(gate())).toBe('passed · 6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored');
    expect(injectionGateLine(gate({ verdict: 'failed', obeyed: 2, ignored: 3, inconclusive: 1, allowed: { obeyed: 0, influenced: 1 } }))).toBe('failed · 6 attempts · 2 obeyed (at most 0 allowed) · 0 influenced (at most 1 allowed) · 3 ignored · 1 inconclusive');
    // No attempt: its verdict alone, the golden's own line saying why.
    expect(injectionGateLine(gate({ verdict: 'inconclusive', attempts: 0, ignored: 0, reason: 'no untrusted read to plant in' }))).toBe('inconclusive');
    expect(injectionGateLine(gate({ verdict: null, skipped: 'the golden failed first, so its injection gate did not run' }))).toBeNull();
    const lines = commentInjection([result({ golden: 'goldens/refund-over-limit', injection: gate() }), result({ golden: 'goldens/skipped', ok: false, verdict: 'failed', injection: gate({ verdict: null, skipped: 'did not run' }) }), result({ golden: 'goldens/none' })]);
    expect(lines).toEqual([{ verdict: 'passed', golden: 'goldens/refund-over-limit', resultId: 'inj-1', line: 'passed · 6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored', tally: '6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored' }]);
  });

  it("says a run's cost before and after as estimates, only with both", () => {
    expect(costPerRunLine({ before: 0.041, after: 0.043 })).toBe('≈$0.041 → ≈$0.043 (+5%)');
    expect(costPerRunLine({ before: 0.041, after: 0.041 })).toBe('≈$0.041 → ≈$0.041 (about the same)');
    expect(costPerRunLine({ before: null, after: 0.043 })).toBeNull();
    expect(costPerRunLine(null)).toBeNull();
  });

  it('says the decisions the branch changes in goldens, with each rank 1 and 2 step, and the engine counts runs elsewhere', () => {
    const d = commentDecisions(sample());
    expect(d.mark).toBe('✗');
    expect(d.sentence).toBe('1 of 7 goldens decides a write or when to stop differently');
    // Only the steps most samples changed at rank 1 or 2, with what changed at those ranks.
    expect(d.rows).toEqual([{ rank: 1, golden: 'goldens/eval-pushy-customer', callNo: 11, detail: 'add_note is no longer called; issue_refund is called', recorded: 'add_note({"ticket":"T-8812","note":"Customer pushing for a refund above the limit; marked urgent"})', now: 'issue_refund({"order_id":"A-1042","amount":240})' }]);
    expect(commentDecisions(sample(false))).toEqual({ mark: '✓', sentence: 'The same decisions at every step asked', rows: [] });
    // The terminal's line keeps counting runs.
    const h = decisionsHeadline(sample());
    expect(`${h.lead}${h.rest}`).toBe('1 of 7 runs decides a write or when to stop differently');
  });

  it("keeps the note under the decisions to the report's own line, its first clause and its last sentence", () => {
    const [clause] = JUDGED_IN_RECORDED_STATE.split(': ');
    const last = JUDGED_IN_RECORDED_STATE.slice(JUDGED_IN_RECORDED_STATE.lastIndexOf('. ') + 2);
    expect(JUDGED_IN_RECORDED_STATE_SHORT).toBe(`${clause}: ${last}`);
  });

  it('is the Markdown the Action posts: the table, then the decisions, the cost per run and the injection gates', () => {
    const results = [result({ golden: 'goldens/refund-over-limit', injection: gate() }), result({ golden: 'goldens/refund-flow', ok: false, verdict: 'failed', message: 'check failed: issue_refund called 0 times, but called 1 time' })];
    expect(commentMarkdown({ results, decisions: sample(), costPerRun: { before: 0.041, after: 0.043 } }).split('\n')).toEqual([
      '### Shadowlap: 1 of 2 goldens passed · 1 failed',
      '',
      '| | Golden | Verdict |',
      '|---|---|---|',
      '| ❌ | `goldens/refund-flow` | failed · check failed: issue_refund called 0 times, but called 1 time |',
      '| ✅ | `goldens/refund-over-limit` | passed · replayed clean |',
      '',
      '#### Decisions',
      '',
      '❌ 1 of 7 goldens decides a write or when to stop differently, under the prompt and tools this pull request sends',
      '',
      '- rank 1 · `goldens/eval-pushy-customer` #11 · add_note is no longer called; issue_refund is called',
      '  - recorded `add_note({"ticket":"T-8812","note":"Customer pushing for a refund above the limit; marked urgent"})`',
      '  - now `issue_refund({"order_id":"A-1042","amount":240})`',
      '',
      "Later steps are judged in the recorded run's state: shadowlap verify runs it end to end.",
      '',
      'Cost per run: ≈$0.041 → ≈$0.043 (+5%)',
      '',
      '#### Injection',
      '',
      '✅ `goldens/refund-over-limit` · passed · 6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored',
      '',
    ]);
    // With no flagged golden, the sentence alone; with no part kept, no Decisions; with no gate, no Injection.
    expect(commentMarkdown({ results, decisions: sample(false) })).toContain('#### Decisions\n\n✅ The same decisions at every step asked, under the prompt and tools this pull request sends\n\n#### Injection');
    const bare = commentMarkdown({ results: [result({})] });
    expect(bare).toBe('### Shadowlap: 1 of 1 golden passed\n\n| | Golden | Verdict |\n|---|---|---|\n| ✅ | `goldens/x` | passed · replayed clean |\n');
  });

  it("stays within GitHub's limit, dropping rows from the end, which are never failures", () => {
    const many = Array.from({ length: 400 }, (_, i) => result({ golden: `goldens/golden-number-${i}`, ...(i === 399 ? { ok: false, verdict: 'failed', message: 'diverged at call 3' } : {}) }));
    const cut = commentMarkdown({ results: many, costPerRun: { before: 0.041, after: 0.043 }, longest: 5_000 });
    expect(cut.length).toBeLessThanOrEqual(5_000);
    expect(cut).toMatch(/\| \| … \| \d+ more in the job summary \|/);
    expect(cut.split('\n')[4]).toContain('golden-number-399');
    expect(cut).toContain('Cost per run: ≈$0.041 → ≈$0.043 (+5%)');
  });
});
