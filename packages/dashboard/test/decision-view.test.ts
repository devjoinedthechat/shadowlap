import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, NO_TOKENS, recordVerdict, retirementOf, retirementsOf, Store, type DecisionChange, type DecisionRun, type DecisionStep, type DecisionsVerify } from '@shadowlap/engine';
import { verifyReport } from '../../engine/test/fix-fixtures.js';
import { DONE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { moreOf } from '../src/decision-more.js';
import { previewSession } from '../src/decision-view.js';
import { runDecisions } from '../src/decisions.js';
import { quoteLine } from '../src/decision-cells.js';

/**
 * A kept session as Changes' Preview shows it, worded on the server: its verdict in each state
 * Verdicts gives one, verify's verdict and the runs it ran end to end, the next step's facts, a
 * migration, a session kept before `toVerify`, and a run gone from the store.
 */

let store: Store;
let a = '';
let b = '';
const GONE = '01M5GONE000000000000000000';

const write: DecisionChange = { rank: 1, kind: 'write-removed', tool: 'issue_refund', effect: 'write', before: { amount: 240 }, after: null, detail: 'issue_refund is no longer called' };
const step = (callNo: number, rank: DecisionStep['rank'], o: Partial<DecisionStep> = {}): DecisionStep => ({
  callNo,
  step: callNo,
  scope: null,
  rank,
  majority: rank,
  changes: rank === 1 ? [write] : [],
  recorded: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  now: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  samples: { asked: 2, answered: 2, changed: rank === null ? 0 : 2, ranks: [rank ?? 0, rank ?? 0] },
  model: { recorded: 'claude-sonnet-4-5-20250929', asked: 'claude-haiku-4-5' },
  tokens: { before: null, after: null },
  cost: { before: null, after: null, spent: 0 },
  thinkingStripped: 0,
  error: null,
  ...o,
});
const runOf = (runId: string, golden: string | null, decisions: DecisionStep[]): DecisionRun => {
  const ranks = decisions.map((d) => d.rank).filter((r): r is NonNullable<typeof r> => r !== null);
  const rank = ranks.length ? (Math.min(...ranks) as DecisionRun['rank']) : null;
  return { runId, golden, steps: decisions.length, asked: decisions.length, rank, majority: rank, counts: emptyCounts(), cost: { before: 0.04, after: 0.02, spent: 0.02 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions, warnings: [] };
};
const change = { model: 'claude-haiku-4-5', fields: {}, from: ['claude-sonnet-4-5-20250929'], fromCode: null, text: 'the model claude-haiku-4-5' };
const counts = (o: Partial<ReturnType<typeof emptyCounts>>) => ({ ...emptyCounts(), ...o });
const verified = (verdict: DecisionsVerify['verdict'], runs: DecisionsVerify['runs'], o: Partial<DecisionsVerify> = {}): DecisionsVerify => ({ verdict, verifyIds: [], runs, rule: '4 of 4 attempts must pass', commands: [], warnings: [], spent: 0.01, upstreamRequests: 4, reasons: [], ...o });

/** Keeps a preview of `runs` with `data` over its report. */
function keep(sessionId: string, runs: DecisionRun[], data: Record<string, unknown>, kind: 'decisions' | 'migrate' = 'decisions'): string {
  const report = { decisionsId: sessionId, kind, at: 1_000, change, command: 'shadowlap decisions goldens/* --model claude-haiku-4-5', samples: 2, counts: emptyCounts(), flagged: [], remedies: [], notes: [], warnings: [], verify: null, stopReason: null, cost: { before: 0.04, after: 0.02, spent: 0.004, upstreamRequests: 6, unknownModels: [] }, ...data };
  const body = kind === 'migrate' ? { migrateId: sessionId, kind, at: 1_000, from: change.from, to: change.model, decisions: report, passes: { verdict: 'accepted', runs: [] } } : report;
  store.putDecisionSession({ sessionId, kind, at: 1_000, change: change.text, actor: null, revision: null, data: body, runs: runs.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: 1, data: r as unknown as Record<string, unknown> })) });
  return sessionId;
}

beforeAll(() => {
  store = Store.open(':memory:');
  a = recordRun(store, [LOOKUP, POLICY, REFUND, DONE], { model: 'claude-sonnet-4-5-20250929' }).run.runId;
  b = recordRun(store, [LOOKUP, POLICY, DONE], { model: 'claude-sonnet-4-5-20250929' }).run.runId;
});
afterAll(() => store.close());

describe('a preview worded for Changes', () => {
  it('leaves a flagged run to verify, its row red and named by its run, and asks Verify for every one left', () => {
    const id = keep('dc-01M5000000000000000000000A', [runOf(a, 'goldens/refund', [step(1, null), step(3, 1)]), runOf(b, null, [step(1, null), step(3, null)])], { flagged: [a], toVerify: [a], counts: counts({ 1: 1, same: 3 }) });
    const s = previewSession(store, id)!;
    expect(s.view).toMatchObject({ name: 'Model switch to claude-haiku-4-5', samples: 2, unit: 'run', verdict: { word: 'not verified', line: '1 of 2 runs to verify', toVerify: 1, flaggedRank: 1 }, verify: null, redacted: false });
    expect(s.view.next).toEqual({ verify: { runs: [a], every: true, gone: 0 }, more: null, migrate: null });
    expect(s.view.headline.asked).toBe(true);
    expect(s.view.later).toMatchObject({ text: expect.any(String), card: expect.stringContaining(s.view.later!.title) });
    expect(s.matrix.map((r) => [r.title, r.golden, r.flagged, r.inStore, r.toVerify, r.verified, r.cleared])).toEqual([
      [a.slice(0, 10), 'goldens/refund', true, true, true, null, false],
      [b.slice(0, 10), null, false, true, false, null, false],
    ]);
    expect(s.matrix[0].ending).toMatchObject({ tone: 'w', callNo: 3 });
    expect(s.view.counts).toMatchObject({ writes: 1, same: 3, split: 0 });
    expect(s.view.receipt).toMatchObject({ perRun: { before: 0.04, after: 0.02 }, spent: 0.004, requests: 6, judge: null, stopReason: null });
    expect(previewSession(store, id, { redacted: true })!.view.redacted).toBe(true);
  });

  it('has nothing to verify where no run is flagged, and offers the model it switches to', () => {
    const id = keep('dc-01M5000000000000000000000B', [runOf(a, 'goldens/refund', [step(1, null), step(3, null)])], { counts: counts({ same: 2 }) });
    const s = previewSession(store, id)!;
    expect(s.view.verdict).toMatchObject({ word: 'nothing to verify', toVerify: 0 });
    expect(s.view.unit).toBe('golden');
    expect(s.view.next).toEqual({ verify: null, more: null, migrate: { to: 'claude-haiku-4-5', from: ['claude-sonnet-4-5-20250929'], goldens: ['goldens/refund'], runs: [] } });
    expect(s.view.within).toBeNull();
  });

  it('is inconclusive where asking stopped short, and offers no migration', () => {
    const id = keep('dc-01M5000000000000000000000C', [runOf(a, null, [step(1, null), step(3, null, { error: 'rate limited', samples: { asked: 2, answered: 0, changed: 0, ranks: [] } })])], { stopReason: 'the spend limit of $0.50 was reached', counts: counts({ same: 1, notAsked: 1 }) });
    const s = previewSession(store, id)!;
    expect(s.view.verdict.word).toBe('inconclusive');
    expect(s.view.verdict.line).toContain('spend limit');
    expect(s.view.receipt.stopReason).toBe('the spend limit of $0.50 was reached');
    expect(s.view.next.migrate).toBeNull();
  });

  it('says what verify found once it ran: accepted, the runs verified end to end and their cost, a cleared run not run end to end', () => {
    const v = verified('accepted', [{ runId: a, role: 'good', outcome: 'kept', passes: 4, attempts: 4, bound: null, rule: '4 of 4 attempts must pass' }], { footprint: { recorded: { inputTokens: 4000, outputTokens: 100, cost: 0.014 }, now: { inputTokens: 5000, outputTokens: 120, cost: 0.018 } }, warnings: ['a good run judged by its gate alone'] });
    const id = keep('dc-01M5000000000000000000000D', [runOf(a, null, [step(3, 1)]), runOf(b, null, [step(3, null)])], { flagged: [a], toVerify: [a], verify: v, counts: counts({ 1: 1, same: 1 }) });
    const s = previewSession(store, id)!;
    expect(s.view.verdict.word).toBe('accepted');
    expect(s.view.verify).toMatchObject({ word: 'accepted', count: '1 of 2 runs verified end to end', warnings: ['a good run judged by its gate alone'], rules: [{ rule: '4 of 4 attempts must pass', runs: [a] }] });
    expect(s.view.verify!.endToEnd).toMatch(/^4,000 → 5,000 input tokens \(\+25%\) · .*\$0\.014 → .*\$0\.018 \(\+29%\)$/);
    expect(s.matrix.map((r) => [r.verified?.outcome ?? null, r.cleared])).toEqual([['kept', false], [null, true]]);
    expect(s.matrix[0].verified!.tally).toContain('4 of 4');
    expect(s.view.cleared).toContain('not run end to end');
    expect(s.view.next).toMatchObject({ verify: null, more: null });
  });

  it('leaves the runs no verify took to verify, by name, once verify took some of them', () => {
    const v = verified('accepted', [{ runId: a, role: 'good', outcome: 'kept', passes: 4, attempts: 4, bound: null, rule: '4 of 4 attempts must pass' }]);
    const id = keep('dc-01M5000000000000000000000I', [runOf(a, null, [step(3, 1)]), runOf(b, null, [step(3, 1)])], { flagged: [a, b], toVerify: [a, b], verify: v, counts: counts({ 1: 2 }) });
    const s = previewSession(store, id)!;
    // Verify offers and prices the one left, and its job names it (ui/decisions.ts nextStep, test/decisions-routes.test.ts).
    expect(s.view.next).toEqual({ verify: { runs: [b], every: false, gone: 0 }, more: null, migrate: null });
    expect(s.matrix.map((r) => [r.toVerify, r.verified?.outcome ?? null, r.cleared])).toEqual([
      [true, 'kept', false],
      [true, null, false],
    ]);
  });

  it('is rejected where verify broke a run, and offers no Run more attempts, which a run it left open cannot turn', () => {
    const v = verified('rejected', [{ runId: a, role: 'good', outcome: 'broken', passes: 1, attempts: 4 }, { runId: b, role: 'good', outcome: 'inconclusive', passes: 2, attempts: 4 }]);
    const id = keep('dc-01M5000000000000000000000E', [runOf(a, null, [step(3, 1)]), runOf(b, null, [step(3, 1)])], { flagged: [a, b], toVerify: [a, b], verify: v, counts: counts({ 1: 2 }) });
    const s = previewSession(store, id)!;
    expect(s.view.verdict.word).toBe('rejected');
    expect(s.view.verify!.word).toBe('rejected');
    expect(s.view.next).toEqual({ verify: null, more: null, migrate: null });
  });

  it('runs more attempts by role on the runs verify left open, a limit doubled only where a run of its role ran out, and verifies again where an attempt could not be judged', () => {
    const v = verified('incomplete', [{ runId: a, role: 'target', outcome: 'inconclusive', passes: 50, attempts: 80 }, { runId: b, role: 'good', outcome: 'unsettled', passes: 3, attempts: 3 }]);
    const id = keep('dc-01M5000000000000000000000F', [runOf(a, null, [step(3, 1)]), runOf(b, null, [step(3, 1)])], { flagged: [a, b], toVerify: [a, b], verify: v, counts: counts({ 1: 2 }) });
    // The failing run's gate ran out: 2 x 80. The good run stopped first: its 200 pairs again, as they were.
    expect(previewSession(store, id)!.view.next.more).toEqual({ kind: 'more', runs: [a, b], max: 160, keptMax: 200, flags: ['--gate', '{"max":160}', '--kept-max', '200'], attempts: 83, limit: 'up to 160 attempts a failing run, 200 pairs a good one' });
    // The config's verify.max is what a good run ran under.
    expect(previewSession(store, id, { keptMax: 300 })!.view.next.more).toMatchObject({ max: 160, keptMax: 300 });
    // Each run's Decisions view offers it for that run alone, in its role.
    const mine = (runId: string) => runDecisions(store, runId, 50).sessions.find((x) => x.sessionId === id)!.more;
    expect(mine(a)).toEqual({ kind: 'more', runs: [a], max: 160, keptMax: null, flags: ['--gate', '{"max":160}'], attempts: 80, limit: 'up to 160 attempts a run' });
    expect(mine(b)).toEqual({ kind: 'more', runs: [b], max: null, keptMax: 200, flags: ['--kept-max', '200'], attempts: 3, limit: 'up to 200 pairs a run against its baseline' });
    expect(moreOf({ ...v, runs: [{ ...v.runs[1], outcome: 'inconclusive' }] }, { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 }, null)).toEqual({ kind: 'more', runs: [b], max: null, keptMax: 400, flags: ['--kept-max', '400'], attempts: 3, limit: 'up to 400 pairs a run against its baseline' });
    expect(moreOf({ ...v, runs: [{ ...v.runs[0], attempts: 1000 }] }, { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 1000 }, null)).toBeNull();
    expect(moreOf({ ...v, runs: [{ ...v.runs[0], undecided: 'the judge gave no answer' }] }, null, null)).toEqual({ kind: 'again', runs: [a], max: null, keptMax: null, flags: [], attempts: 80, limit: '' });
    // A fixed count that ran out decides nothing more with more of the same.
    expect(moreOf(v, null, null)).toBeNull();
  });

  it('starts a good run’s limit on a second Run more attempts from the pairs it ran under, never cut to the raised gate’s max', () => {
    // The first round ran under --gate {"max":160} --kept-max 200: its verdict keeps both.
    const report = verifyReport([{ runId: a, role: 'target', pass: true }, { runId: b, role: 'good', pass: true }]);
    Object.assign(report, { gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 160 }, kept: { margin: 0.1, risk: 0.05, max: 200, source: 'paired' } });
    const { verdict } = recordVerdict(store, { report, expect: null, command: 'v', rerun: { flags: [], command: null } });
    const v = verified('incomplete', [{ runId: b, role: 'good', outcome: 'unsettled', passes: 3, attempts: 3 }], { verifyIds: [verdict.verifyId] });
    const id = keep('dc-01M5000000000000000000000G', [runOf(a, null, [step(3, 1)]), runOf(b, null, [step(3, 1)])], { flagged: [b], toVerify: [b], verify: v, counts: counts({ 1: 1 }) });
    // A good run that stopped again takes its 200 pairs again, where keptMaxOf on the raised gate alone gives 160.
    expect(previewSession(store, id, { keptMax: null })!.view.next.more).toMatchObject({ kind: 'more', runs: [b], keptMax: 200 });
    expect(previewSession(store, id)!.view.next.more!.flags.slice(-2)).toEqual(['--kept-max', '200']);
    expect(runDecisions(store, b, 50).sessions.find((x) => x.sessionId === id)!.more).toMatchObject({ keptMax: 200 });
  });

  it('words a migration as its preview, and offers no migration of its own', () => {
    const id = keep('mg-01M5000000000000000000000F', [runOf(a, null, [step(3, 1)])], { flagged: [a], counts: counts({ 1: 1 }) }, 'migrate');
    const s = previewSession(store, id)!;
    expect(s.kind).toBe('migrate');
    expect(s.view.next.migrate).toBeNull();
    expect(s.matrix.map((r) => r.title)).toEqual([a.slice(0, 10)]);
    expect(runDecisions(store, a, 50).sessions.find((x) => x.sessionId === id)!.more).toBeNull();
  });

  it('takes the flagged runs to verify from a session kept before toVerify, and marks a run gone from the store', () => {
    const id = keep('dc-01M5000000000000000000000G', [runOf(a, null, [step(3, 1)]), runOf(GONE, null, [step(3, 1)])], { flagged: [a, GONE], counts: counts({ 1: 2 }) });
    const s = previewSession(store, id)!;
    expect(s.matrix.map((r) => [r.runId, r.inStore, r.toVerify, r.about === null])).toEqual([[a, true, true, false], [GONE, false, true, true]]);
    expect(s.view.next.verify).toEqual({ runs: [a, GONE], every: true, gone: 1 });
    expect(previewSession(store, 'dc-01M5NOTKEPT0000000000000')).toBeNull();
  });
});

describe('a preview’s retirement notices', () => {
  it('says the notices of the models its runs use and the one it switches to, in today’s words, before what it couldn’t ask', () => {
    // As `decisions` keeps them: the models the runs use and the one the change switches to that retire.
    const retirements = retirementsOf([{ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }], { now: Date.now() });
    expect(retirements.length).toBeGreaterThan(0);
    const id = keep('dc-01M5000000000000000000000R', [runOf(a, null, [step(2, null)])], { retirements, warnings: ['1 step got no answer: rate limited'] });
    const today = retirements.map((n) => retirementOf(n.provider, n.model)!.text);
    expect(previewSession(store, id)!.view.warnings).toEqual([...today, '1 step got no answer: rate limited']);
  });
});

describe('the key and the receipt, worded on the server', () => {
  const samples = (ranks: number[], unjudged = 0) => ({ asked: ranks.length, answered: ranks.length, changed: ranks.filter((r) => r).length, ranks, unjudged });
  const entry = (s: NonNullable<ReturnType<typeof previewSession>>, words: string) => [...s.view.key.main, ...s.view.key.quiet].find((e) => e.words === words)!;

  it('rings only words a judge couldn’t read, and says on each card the rule it stands on: the judge’s own reasons, a run it couldn’t ask, a split’s rule from the notes', () => {
    // Words only, its samples unjudged: it waits on a judge. A read change whose samples' words went unjudged keeps its colour, and its rank's count.
    const words = step(4, 5, { samples: samples([5, 5], 2), majority: 5 });
    const read = step(5, 3, { samples: samples([3, 3], 1), majority: 3 });
    const refused = { ...runOf(b, null, [step(1, null, { now: null, samples: samples([]) })]), asked: 0, refused: 'its first request differs in more than its prompt and tools' };
    const tokens = { before: { ...NO_TOKENS, input: 4000 }, after: { ...NO_TOKENS, input: 5000, cacheRead: 1000 } };
    const id = keep('dc-01M5000000000000000000000J', [{ ...runOf(a, null, [words, read]), tokens }, refused], {
      counts: counts({ 3: 1, 5: 1, notAsked: 1 }),
      notes: ["1 step had a write, stop or judged change in fewer than half its samples: listed, not flagged, as a model's own variation."],
      warnings: ['2 text-only steps a judge check reads could not be judged: no key for the judge’s provider: HTTP 401: unauthorized'],
    });
    const s = previewSession(store, id)!;
    expect([entry(s, 'waits on a judge').n, s.view.counts.waits, entry(s, 'the same').n]).toEqual([1, 1, 0]);
    expect(entry(s, 'waits on a judge').card.text).toBe('No key for the judge’s provider (HTTP 401): its run waits, unless another change flags it.');
    expect(entry(s, 'not asked')).toMatchObject({ n: 1, card: { text: 'A run the change can’t ask is asked nothing: the notes under the matrix say why.' } });
    expect(entry(s, 'split').card.text).toBe("Its 2 samples decided differently, a band each. 1 step had a write, stop or judged change in fewer than half its samples: listed, not flagged, as a model's own variation.");
    expect(s.view.key.main[1].card.text).toBe('When the agent stops or hands over differently, or a judge check reads its new words otherwise; verify settles it end to end.');
    // The receipt's tokens: a run's input tokens either way, the mean over the runs asked.
    expect(s.view.receipt.tokens).toEqual({ before: 4000, after: 6000 });
    // The project's clock, for an opened cell's cost line: auto unless the config says exact.
    expect([s.view.clock, previewSession(store, id, { clock: 'exact' })!.view.clock, previewSession(store, id, { clock: null })!.view.clock]).toEqual(['auto', 'exact', null]);
  });

  it('says a run --from-code can’t ask, a split’s rule with the control, a judge with no reason kept, and no tokens where a session kept none', () => {
    const control = 'Each step was asked 3 times under the change and 3 times as recorded: a change is ranked only when its decisions run more consequential than the recorded request’s own, by an exact permutation test at 5% a step.';
    const noise = "1 step decided otherwise no more often than it did as recorded: listed with both counts, not ranked, as the model's own variation.";
    const refused = { ...runOf(b, null, [step(1, null, { now: null, samples: samples([]) })]), asked: 0, refused: 'its first request differs in more than its prompt and tools' };
    const id = keep('dc-01M5000000000000000000000K', [runOf(a, null, [step(4, 5, { samples: samples([5, 5, 5], 1), majority: 5 })]), refused], {
      samples: 3,
      change: { ...change, model: null, fromCode: { calls: 1, instructions: null, tools: { added: [], removed: [], changed: [] }, codeVersion: null } },
      counts: counts({ 5: 1, notAsked: 1 }),
      notes: [control, noise],
    });
    const s = previewSession(store, id)!;
    expect(entry(s, 'not asked').card.text).toBe('A run --from-code can’t ask is asked nothing: the notes under the matrix say why.');
    expect(entry(s, 'split').card.text).toBe(`Its 3 samples decided differently, a band each. ${control} ${noise}`);
    expect(entry(s, 'waits on a judge').card.text).toBe('Its judge couldn’t answer: its run waits, unless another change flags it.');
    expect(s.view.receipt.tokens).toBeNull();
  });
});

describe('an opened cell, worded on the server', () => {
  it('says both stops, each changed argument field by field, the judges in their colours, the cost either way and the short samples', () => {
    const args: DecisionChange = { rank: 1, kind: 'write-arguments', tool: 'issue_refund', effect: 'write', before: { amount: 240, reason: 'late' }, after: { amount: 120, reason: 'late' }, detail: 'issue_refund is called with other arguments' };
    const side = (status: 'passed' | 'failed', reason: string, source: 'recording' | 'live', cost: number) => ({ status, verdict: status === 'passed' ? ('yes' as const) : ('no' as const), reason, source, cost, request: null });
    const judged = step(3, 1, {
      majority: null,
      changes: [args, { ...write, rank: 2, kind: 'stops', detail: 'it answers and stops' }],
      now: { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'Done.' },
      samples: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0] },
      tokens: { before: { ...NO_TOKENS, input: 100, output: 10 }, after: { ...NO_TOKENS, input: 100, output: 130 } },
      cost: { before: 0.001, after: 0.003, spent: 0.003 },
      judge: [{ name: 'polite', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes', recorded: side('passed', 'kind', 'recording', 0), now: side('failed', 'curt', 'live', 0.0004), changed: true }],
    });
    const id = keep('dc-01M5000000000000000000000H', [runOf(a, null, [step(1, null, { now: null, samples: { asked: 3, answered: 0, changed: 0, ranks: [] }, error: 'overloaded' }), judged])], { samples: 3, counts: counts({ 1: 1, notAsked: 1 }) });
    const s = previewSession(store, id)!;
    expect(s.view.side).toBe('claude-haiku-4-5');
    const [unasked, cell] = s.matrix[0].cells;
    expect(unasked.open).toBeNull();
    expect(cell.open).toEqual({
      short: 'in 1 of 3, not flagged',
      stops: { recorded: 'calls tools', now: 'answers and stops' },
      args: ['issue_refund.amount: 240 → 120'],
      judges: [{ name: 'polite', words: [{ text: 'passed', tone: 'ok' }, { text: ' → ', tone: null }, { text: 'failed', tone: 'no' }, { text: ' · curt (judged live, <$0.001)', tone: 'dim' }] }],
      delta: '+120 tokens · +$0.0020',
    });
  });

  it('words a step its control couldn’t settle inconclusive, as decisions prints it, drawn as not asked', () => {
    const open = step(3, null, { changes: [write], majority: null, sampled: 1, samples: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0] }, control: { asked: 3, answered: 0, changed: 0, ranks: [], error: 'overloaded' } });
    const id = keep('dc-01M5000000000000000000000Y', [runOf(a, null, [step(1, null), open])], { samples: 3, counts: counts({ same: 1, notAsked: 1 }) });
    expect(previewSession(store, id)!.matrix[0].cells[1]).toMatchObject({ state: 'unsettled', words: "issue_refund is no longer called · inconclusive: in 1 of 3 samples; as recorded, no answer (overloaded): too few to tell from the model's own variation" });
  });
});

describe('the within-variation line', () => {
  it('puts the engine’s line under the verdict for the runs a change shows in that doesn’t flag them, and none asked once', () => {
    // Changed in 1 of 3 samples, as often as in 1 of 3 asked as recorded: within the model's own variation.
    const noise = step(3, null, { changes: [write], samples: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0] }, majority: null, sampled: 1, control: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0] } });
    const runs = [runOf(a, null, [noise]), runOf(b, null, [step(3, 1)])];
    const data = { flagged: [b], toVerify: [b], counts: counts({ 1: 1, noise: 1 }) };
    expect(previewSession(store, keep('dc-01M5000000000000000000000W', runs, { ...data, samples: 3 }))!.view.within).toBe("1 more run changes a write within the model's own variation");
    expect(previewSession(store, keep('dc-01M5000000000000000000000X', runs, { ...data, samples: 1 }))!.view.within).toBeNull();
  });
});

describe('a quote in the Decisions view', () => {
  const said = (text: string) => ({ stop: 'answer' as const, stopReason: null, tools: [], text });
  it('cuts an answer longer than its line where a sentence ends, else after a whole word, and keeps tool calls and short answers', () => {
    expect(quoteLine(said('This needs tier-2 approval. I have asked a manager to sign off on the refund for order A-1042.'))).toBe('answers and stops: "This needs tier-2 approval. …"');
    expect(quoteLine(said('I have asked a manager to sign off on the refund for order A-1042 before I send anything'))).toBe('answers and stops: "I have asked a manager to sign off on the refund for order …"');
    expect(quoteLine(said('Refunded.'))).toBe('answers and stops: "Refunded."');
    // a cut after a comma drops it
    expect(quoteLine(said('I have asked a manager to sign off on the refund for order 42, and then I will write back'))).toBe('answers and stops: "I have asked a manager to sign off on the refund for order 42 …"');
    expect(quoteLine({ stop: 'tools', stopReason: null, tools: [{ name: 'issue_refund', args: { order: 'A-1042' }, effect: 'write' }], text: '' })).toBe('issue_refund({"order":"A-1042"})');
    expect(quoteLine(null)).toBe('no answer');
  });
});
