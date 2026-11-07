import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, NO_TOKENS, Store, type DecisionRun, type DecisionStep, type DecisionsVerify } from '@shadowlap/engine';
import { DONE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { previewSession, withinLine } from '../src/decision-view.js';

/**
 * A kept session as Changes' Preview shows it, worded on the server: its verdict in each state
 * Verdicts gives one, verify's verdict and the runs it ran end to end, the next step's facts, a
 * migration, a session kept before `toVerify`, and a run gone from the store.
 */

let store: Store;
let a = '';
let b = '';
const GONE = '01M5GONE000000000000000000';

const write = { rank: 1 as const, kind: 'write-removed', tool: 'issue_refund', effect: 'write', before: { amount: 240 }, after: null, detail: 'issue_refund is no longer called' };
const step = (callNo: number, rank: DecisionStep['rank'], o: Partial<DecisionStep> = {}): DecisionStep => ({
  callNo,
  step: callNo,
  scope: null,
  rank,
  majority: rank,
  changes: rank === 1 ? [write] : [],
  recorded: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  now: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  samples: { asked: 2, answered: 2, changed: rank === null || rank === 0 ? 0 : 2, ranks: [rank ?? 0, rank ?? 0] },
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
    expect(s.view.next).toEqual({ verify: { runs: [a], every: true, gone: 0 }, more: [], migrate: null });
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
    expect(s.view.next).toEqual({ verify: null, more: [], migrate: { to: 'claude-haiku-4-5', from: ['claude-sonnet-4-5-20250929'], goldens: ['goldens/refund'], runs: [] } });
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
    expect(s.view.next).toMatchObject({ verify: null, more: [] });
  });

  it('is rejected where verify broke a run, and counts what verify left open for Run more attempts', () => {
    const v = verified('rejected', [{ runId: a, role: 'good', outcome: 'broken', passes: 1, attempts: 4 }, { runId: b, role: 'good', outcome: 'inconclusive', passes: 2, attempts: 4 }]);
    const id = keep('dc-01M5000000000000000000000E', [runOf(a, null, [step(3, 1)]), runOf(b, null, [step(3, 1)])], { flagged: [a, b], toVerify: [a, b], verify: v, counts: counts({ 1: 2 }) });
    const s = previewSession(store, id)!;
    expect(s.view.verdict.word).toBe('rejected');
    expect(s.view.verify!.word).toBe('rejected');
    expect(s.view.next).toEqual({ verify: null, more: [b], migrate: null });
  });

  it('words a migration as its preview, and offers no migration of its own', () => {
    const id = keep('mg-01M5000000000000000000000F', [runOf(a, null, [step(3, 1)])], { flagged: [a], counts: counts({ 1: 1 }) }, 'migrate');
    const s = previewSession(store, id)!;
    expect(s.kind).toBe('migrate');
    expect(s.view.next.migrate).toBeNull();
    expect(s.matrix.map((r) => r.title)).toEqual([a.slice(0, 10)]);
  });

  it('takes the flagged runs to verify from a session kept before toVerify, and marks a run gone from the store', () => {
    const id = keep('dc-01M5000000000000000000000G', [runOf(a, null, [step(3, 1)]), runOf(GONE, null, [step(3, 1)])], { flagged: [a, GONE], counts: counts({ 1: 2 }) });
    const s = previewSession(store, id)!;
    expect(s.matrix.map((r) => [r.runId, r.inStore, r.toVerify, r.about === null])).toEqual([[a, true, true, false], [GONE, false, true, true]]);
    expect(s.view.next.verify).toEqual({ runs: [a, GONE], every: true, gone: 1 });
    expect(previewSession(store, 'dc-01M5NOTKEPT0000000000000')).toBeNull();
  });
});

describe('the within-variation line', () => {
  it('counts the runs whose cells show a write within the model’s own variation, and says nothing asked once', () => {
    const noise = step(3, null, { changes: [write], samples: { asked: 2, answered: 2, changed: 1, ranks: [1, 0] }, majority: null, sampled: 1, control: { asked: 2, answered: 2, changed: 1, ranks: [1, 0] } });
    const runs = [runOf(a, null, [noise]), runOf(b, null, [step(3, 1)])];
    expect(withinLine({ samples: 2, flagged: [b], runs })).toBe("1 more run changes a write within the model's own variation");
    expect(withinLine({ samples: 1, flagged: [b], runs })).toBeNull();
    expect(withinLine({ samples: 2, flagged: [], runs: [runOf(a, null, [step(3, null)])] })).toBeNull();
  });
});
