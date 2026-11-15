import { describe, expect, it } from 'vitest';
import { decisionsHeadline, emptyCounts, JUDGED_IN_RECORDED_STATE, type DecisionStep } from '../src/decisions.js';
import { commentDecisions, commentHead, commentInjection, commentMarkdown, commentRows, costPerRunLine, injectionGateLine, JUDGED_IN_RECORDED_STATE_SHORT, type CommentDecisionsSource, type CommentResult } from '../src/pr-comment.js';
import type { InjectionGateData } from '../src/store/tests.js';
import { injectionTally } from '../src/trust-words.js';
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
      '### shadowlap: 1 of 2 goldens passed · 1 failed',
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
    expect(bare).toBe('### shadowlap: 1 of 1 golden passed\n\n| | Golden | Verdict |\n|---|---|---|\n| ✅ | `goldens/x` | passed · replayed clean |\n');
  });

  it("stays within GitHub's limit, dropping rows from the end, which are never failures", () => {
    const many = Array.from({ length: 400 }, (_, i) => result({ golden: `goldens/golden-number-${i}`, ...(i === 399 ? { ok: false, verdict: 'failed', message: 'diverged at call 3' } : {}) }));
    const cut = commentMarkdown({ results: many, costPerRun: { before: 0.041, after: 0.043 }, longest: 5_000 });
    expect(cut.length).toBeLessThanOrEqual(5_000);
    expect(cut).toMatch(/\| \| … \| \d+ more in the job summary \|/);
    expect(cut.split('\n')[4]).toContain('golden-number-399');
    expect(cut).toContain('Cost per run: ≈$0.041 → ≈$0.043 (+5%)');
  });

  /** `n` flagged goldens, each deciding two steps differently, where it now sends an email of 1,500 characters. */
  const emailing = (n: number): CommentDecisionsSource => {
    const email = (callNo: number) => step({ callNo, now: { stop: 'tools', stopReason: 'tool_use', tools: [{ name: 'send_email', args: { to: 'pat@example.test', body: 'x'.repeat(1_500) }, effect: 'write' }], text: '' } });
    const runs = Array.from({ length: n }, (_, i) => ({ runId: `run-${i}`, golden: `goldens/flagged-${i}`, refused: null, decisions: [email(11), email(12)] }));
    return { counts: { ...emptyCounts(), 1: 2 * n, same: 10 }, flagged: runs.map((r) => r.runId), runs };
  };
  const failing = result({ golden: 'goldens/refund-flow', ok: false, verdict: 'failed', message: 'check failed: issue_refund called 0 times, but called 1 time' });
  const passing = Array.from({ length: 30 }, (_, i) => result({ golden: `goldens/passing-${i}` }));

  it('keeps each call whole, as the design has it, while the comment fits', () => {
    const body = `{"to":"pat@example.test","body":"${'x'.repeat(1_500)}"}`;
    expect(commentDecisions(emailing(1)).rows[0].now).toBe(`send_email(${body})`);
    expect(commentMarkdown({ results: [failing, ...passing], decisions: emailing(2) })).toContain(`  - now \`send_email(${body})\``);
    // A width cuts each call, as the terminal's line does.
    expect(commentDecisions(emailing(1), 72).rows[0].now).toBe(`send_email(${body.slice(0, 71)}…)`);
  });

  it("keeps the decisions within GitHub's limit too: each call cut first, then what passed, then later steps, and a failure's row last", () => {
    // Twenty flagged goldens with two steps each outgrow the comment with their calls whole: each call is cut to 200 characters, every step and row kept.
    const results = [failing, ...passing];
    const cut = commentMarkdown({ results, decisions: emailing(20) });
    expect(cut.length).toBeLessThanOrEqual(60_000);
    expect(cut.match(/^- rank 1 · /gm)).toHaveLength(40);
    const json = '{"to":"pat@example.test","body":"';
    expect(cut).toContain(`  - now \`send_email(${json}${'x'.repeat(199 - json.length)}…)\``);
    expect(cut.match(/^\| ✅ \| /gm)).toHaveLength(30);
    // Tighter, it leaves out the rows that passed, then the later steps, saying how many and where; the failed row stays.
    const tight = commentMarkdown({ results, decisions: emailing(20), longest: 6_000 });
    expect(tight.length).toBeLessThanOrEqual(6_000);
    const lines = tight.split('\n');
    expect(lines.slice(4, 6)).toEqual(['| ❌ | `goldens/refund-flow` | failed · check failed: issue_refund called 0 times, but called 1 time |', '| | … | 30 more in the job summary |']);
    const steps = tight.match(/^- rank 1 · /gm)!.length;
    expect(steps).toBeGreaterThan(0);
    expect(lines).toContain(`- … ${40 - steps} more steps: \`shadowlap decisions --from-code\` on this branch lists every one`);
    expect(tight).toContain("Later steps are judged in the recorded run's state");
    // However tight, the failed row is the last to go.
    const tighter = commentMarkdown({ results, decisions: emailing(20), longest: 700 });
    expect(tighter.length).toBeLessThanOrEqual(700);
    expect(tighter.split('\n')[4]).toContain('goldens/refund-flow');
    expect(tighter).toContain('- … 40 more steps');
  });

  it('leaves out the injection gates that passed before any that failed, saying how many more the job log has', () => {
    const failed = Array.from({ length: 3 }, (_, i) => result({ golden: `goldens/obeys-${i}`, ok: false, verdict: 'failed', message: 'failed · injection: 2 of 6 attempts obeyed', injection: gate({ obeyed: 2, ignored: 4, verdict: 'failed' }) }));
    const passed = Array.from({ length: 100 }, (_, i) => result({ golden: `goldens/ignores-${i}`, injection: gate({ resultId: `inj-${i}` }) }));
    // The gates come worst first by their own verdict, whatever their golden's row says.
    expect(commentInjection([result({ golden: 'goldens/a', injection: gate() }), result({ golden: 'goldens/b', injection: gate({ verdict: 'inconclusive' }) })]).map((g) => g.golden)).toEqual(['goldens/b', 'goldens/a']);
    const cut = commentMarkdown({ results: [...passed, ...failed], longest: 4_000 });
    expect(cut.length).toBeLessThanOrEqual(4_000);
    const lines = cut.split('\n');
    expect(lines.slice(4, 8)).toEqual([...failed.map((r) => `| ❌ | \`${String(r.golden)}\` | failed · injection: 2 of 6 attempts obeyed |`), '| | … | 100 more in the job summary |']);
    const at = lines.indexOf('#### Injection');
    expect(lines.slice(at + 2, at + 5)).toEqual(failed.map((r) => `❌ \`${String(r.golden)}\` · failed · 6 attempts · 2 obeyed (at most 0 allowed) · 0 influenced · 4 ignored`));
    const kept = lines.filter((l) => l.startsWith('✅ `goldens/ignores-')).length;
    expect(lines).toContain(`… ${100 - kept} more gates in the job's log`);
  });
});
