import { describe, expect, it } from 'vitest';
import { chaosTargets } from '../src/chaos.js';
import { decisionRunCost, migrateEstimate, previewEstimate, previewFrom } from '../src/estimates/changes.js';
import { pricedCalls } from '../src/estimates/estimate.js';
import { causeEstimate, CLEAN_GATE, injectionAgainEstimate, injectionEstimate, presetsEstimate } from '../src/estimates/injection.js';
import { amountWords } from '../src/estimates/spending.js';
import { bisectCommits, bisectEstimate, goldenTestEstimate, moreEstimate, runBisectEstimate, testsEstimate, updateEstimate } from '../src/estimates/tests.js';
import { verifyEstimate } from '../src/estimates/verify.js';
import { untrustedReads } from '../src/injection.js';
import { gateOdds, gateOf, gateResult, SPRT_DEFAULTS } from '../src/stats.js';
import type { CallRecord, JudgeSummary } from '../src/types.js';
import { ALL, api, COST, recording } from './estimate-fixtures.js';

/**
 * The jobs a session of goldens, an injection test, the error-path presets and Changes run, each
 * against the recording worked out by hand in estimate-fixtures.ts, at DEFAULT_PRICES: the agent's
 * model calls from #3 on, with the judge's at #6, come to $0.01495.
 */

const calls = () => pricedCalls(recording());
const FROM_3 = COST[3] + COST[5] + COST[6];
const judge = (spent: number): JudgeSummary => ({ calls: 1, replayed: 0, live: 1, notAsked: 0, upstreamRequests: 1, spent, saved: 0, unknownModels: [] });

describe('Run tests', () => {
  it('is Free when every golden replays offline, and priced at what the last session spent live otherwise', () => {
    expect(testsEstimate(0, null)).toEqual({ kind: 'tests', usd: 0, ceiling: false, parts: ['every golden replays offline'] });
    const e = testsEstimate(2, { results: [{ data: { spent: 1.2, judge: judge(0.1) } }, { data: { spent: 0 } }, { data: null }], injection: 1.01 });
    expect(e).toMatchObject({ kind: 'tests', ceiling: false, parts: ['what the last session spent live'] });
    expect(e.usd).toBeCloseTo(2.31, 10);
    expect(e.last!.usd).toBeCloseTo(2.31, 10);
  });

  it('has no estimate for goldens that run live until a session has run', () => {
    expect(testsEstimate(2, null)).toEqual({ kind: 'tests', usd: null, ceiling: false, parts: [], none: 'no estimate until a session has run' });
  });

  it('runs one golden offline for free, and one marked fork at what its last test spent, with none until it has run once', () => {
    expect(goldenTestEstimate(false, null)).toEqual({ kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] });
    expect(goldenTestEstimate(true, null)).toEqual({ kind: 'tests', usd: null, ceiling: false, parts: ['live from where it forks, writes blocked'], none: 'no estimate until it has run once' });
    const e = goldenTestEstimate(true, { data: { spent: 0.11, judge: judge(0.01) } });
    expect(e).toMatchObject({ note: 'as its last test spent', parts: ['live from where it forks, writes blocked'] });
    expect(e.usd).toBeCloseTo(0.12, 10);
  });
});

describe('Tests’ Run more attempts', () => {
  // 20 attempts at 80%, four passes to a failure: the gate never crosses either bound, and runs out inconclusive.
  const gate = { kind: 'sprt' as const, ...SPRT_DEFAULTS, max: 20 };
  const outcomes = Array.from({ length: 20 }, (_, i) => i % 5 !== 4);
  const spends = Array.from({ length: 20 }, (_, i) => (i === 7 ? 0.02 : 0.01));

  it('bills every attempt up to its higher limit, each as dear as its costliest so far, and says what the gate is expected to take', () => {
    const g = gateResult(gate, outcomes);
    expect(g.decision).toBe('inconclusive');
    const e = moreEstimate(g, 40, spends);
    const expected = Math.round(gateOdds({ ...gateOf(g), max: 40 }, 0.8, null, { passes: 16, attempts: 20 }).attempts - 20);
    expect(e).toMatchObject({ kind: 'more', ceiling: true, attempts: 20, each: 0.02, parts: ['up to 20 more attempts', 'live from where the golden forks, writes blocked'] });
    expect(e.usd).toBeCloseTo(0.4, 10);
    expect(e.expected!.attempts).toBe(expected);
    expect(e.expected!.usd).toBeCloseTo(expected * 0.0105, 10);
    expect(e.card).toEqual({ title: 'If every attempt ran, each as dear as its costliest so far', lines: [`About ${amountWords(expected * 0.0105)} for the ${expected} it is expected to take, at what its 20 attempts have cost.`] });
  });

  it('has none where it adds no attempt, or what the attempts cost was not kept', () => {
    const g = gateResult(gate, outcomes);
    expect(moreEstimate(g, 20, spends).none).toBe('its gate has run 20 attempts already, which is 20 or more');
    expect(moreEstimate(g, 40, [])).toMatchObject({ usd: null, none: 'what its attempts cost was not kept', parts: ['up to 20 more attempts'] });
  });
});

describe('Update golden', () => {
  it('records each golden again, about what its recording cost, and always asks first', () => {
    expect(updateEstimate([{ calls: calls() }])).toMatchObject({ kind: 'update', ceiling: false, always: 'it replaces goldens', parts: ['as its recording cost'] });
    expect(updateEstimate([{ calls: calls() }]).usd).toBeCloseTo(ALL, 10);
    expect(updateEstimate([{ calls: calls() }, { calls: calls() }]).usd).toBeCloseTo(2 * ALL, 10);
    expect(updateEstimate([{ calls: calls() }, { calls: calls() }]).parts).toEqual(['as their recordings cost']);
  });

  it('asks only a judge for a golden that lacks its verdict, once', () => {
    expect(updateEstimate([{ calls: [], judge: 0.0004 }])).toEqual({ kind: 'update', usd: 0.0004, ceiling: false, always: 'it replaces goldens', parts: ['its judge’s one call'] });
    expect(updateEstimate([{ calls: [], judge: null }]).none).toBe('its judge has not been asked yet, so what a call of it costs is unknown');
  });
});

describe('Find breaking commit', () => {
  it('tests the bad commit, the good one, then halves the range', () => {
    expect([1, 2, 4, 8, 9].map(bisectCommits)).toEqual([2, 3, 4, 5, 6]);
  });

  it('is Free for a golden that replays, and for one marked fork bills its gate live at every commit it may test', () => {
    expect(bisectEstimate(5, { fork: false, attempts: 1, each: null })).toEqual({ kind: 'bisect', usd: 0, ceiling: false, parts: ['bisect replays offline'] });
    const e = bisectEstimate(5, { fork: true, attempts: 20, each: 0.0325 });
    expect(e).toMatchObject({ ceiling: true, attempts: 100, parts: ['up to 5 commits, 20 attempts each', 'live at each commit, as a golden marked fork runs'] });
    expect(e.usd).toBeCloseTo(5 * 20 * 0.0325, 10);
    expect(bisectEstimate(5, { fork: true, attempts: 20, each: null })).toMatchObject({ usd: null, none: 'no estimate until it has run once' });
  });

  it('bills a run one live replay at every commit it tests but its own', () => {
    const e = runBisectEstimate(calls(), 4);
    expect(e).toMatchObject({ ceiling: true, attempts: 3, parts: ['up to 4 commits', 'one live replay each, writes blocked'] });
    expect(e.usd).toBeCloseTo(3 * ALL, 10);
  });
});

describe('an injection test', () => {
  const reads = () => untrustedReads(recording(), { lookup_order: { trust: 'untrusted' } }).reads;

  it('plants every payload in every untrusted read a model reads, and replays each clean, each live from the call that reads it', () => {
    expect(reads()).toMatchObject([{ callNo: 2, readAt: 3 }]);
    const e = injectionEstimate(calls(), reads(), { payloads: 12 });
    expect(e).toMatchObject({ kind: 'injection', ceiling: false, attempts: 15, parts: ['12 attempts and 3 clean replays', 'live from each read, writes stubbed'] });
    expect(e.usd).toBeCloseTo(15 * FROM_3, 10);
    expect(injectionEstimate(calls(), reads(), { payloads: 12, repeat: 3, baselines: 0 }).parts[0]).toBe('36 attempts');
  });

  it('plants nothing in a read no model call reads, and has no estimate with nothing to plant', () => {
    expect(injectionEstimate(calls(), [{ callNo: 7, readAt: null }], { payloads: 12 })).toEqual({ kind: 'injection', usd: 0, ceiling: false, parts: ['no untrusted read a model reads, so nothing is planted'] });
    expect(injectionEstimate(calls(), reads(), { payloads: 0 }).none).toBe('no payload to plant: pick a template or add a payload file');
  });

  it('runs again at what it spent the last time', () => {
    expect(injectionAgainEstimate(0.41)).toEqual({ kind: 'injection', usd: 0.41, ceiling: false, note: 'as the last test’s', parts: ['live from each read, writes stubbed'], last: { usd: 0.41, attempts: null } });
  });

  it('finds a cause with the read made neutral, up to its gate’s attempts, each live from the call after the read', () => {
    expect(CLEAN_GATE).toEqual({ kind: 'sprt', good: 0.8, bad: 0.2, risk: 0.05, max: 10 });
    const e = causeEstimate(calls(), 2);
    expect(e).toMatchObject({ kind: 'cause', ceiling: true, attempts: 10, parts: ['up to 10 attempts', 'live from the read, writes stubbed'] });
    expect(e.usd).toBeCloseTo(10 * FROM_3, 10);
    expect(e.card).toEqual({ title: 'If the gate took all its attempts', lines: [`An attempt costs ${amountWords(FROM_3)}, live from the read made neutral to the run’s end.`, 'The gate stops once it decides.'] });
    expect(causeEstimate(calls(), 7).parts).toEqual(['no model call comes after #7']);
  });
});

describe('the error-path presets', () => {
  const targets = () => chaosTargets(recording());

  it('run each preset from the call it hits, as many attempts as its gate may take', () => {
    // The tool presets hit #2, the first read; the provider presets the model call that reads it, #3.
    expect(targets()).toEqual({ tool: { callNo: 2, name: 'lookup_order' }, model: { callNo: 3, name: 'POST /v1/messages' } });
    const once = presetsEstimate(calls(), targets());
    expect(once).toMatchObject({ kind: 'presets', ceiling: true, attempts: 6, parts: ['6 attempts', 'live from each preset’s call, writes stubbed'] });
    expect(once.usd).toBeCloseTo(6 * FROM_3, 10);
    const gated = presetsEstimate(calls(), targets(), { gate: { max: 20 }, presets: ['timeout', '429'] });
    expect(gated.parts[0]).toBe('up to 40 attempts');
    expect(gated.usd).toBeCloseTo(40 * FROM_3, 10);
  });

  it('are Free where no preset hits a call', () => {
    expect(presetsEstimate(calls(), { tool: { none: 'no tool call' }, model: { none: 'no model call' } })).toEqual({ kind: 'presets', usd: 0, ceiling: false, parts: ['no preset applies to this run'] });
  });
});

describe('a preview', () => {
  it('asks each call the change touches every sample, and the control arm as often, at the recorded model’s price', () => {
    // At claude-opus-5-5, #1 costs $0.008, #3 $0.0102 and #5 $0.018; as recorded $0.004, $0.0052 and $0.009. The judge's call is no step.
    const e = previewEstimate([calls()], { model: 'claude-opus-5-5' });
    expect(e).toMatchObject({ kind: 'preview', ceiling: false, parts: ['about 18 requests, half as recorded'] });
    expect(e.usd).toBeCloseTo(3 * (0.008 + 0.004 + 0.0102 + 0.0052 + 0.018 + 0.009), 10);
    const once = previewEstimate([calls()], { model: 'claude-opus-5-5' }, { samples: 1 });
    expect(once.parts).toEqual(['about 3 requests']);
    expect(once.usd).toBeCloseTo(0.008 + 0.0102 + 0.018, 10);
  });

  it('asks every call for a change of fields or of the code’s prompt, at the recorded model', () => {
    expect(previewEstimate([calls()], { fromCode: true }).usd).toBeCloseTo(3 * 2 * (COST[1] + COST[3] + COST[5]), 10);
  });

  it('is Free where no call is made with a model it switches from, and says why a switch to another family asks nothing', () => {
    expect(previewEstimate([calls()], { model: 'claude-opus-5-5', from: ['gpt-4o'] }).parts).toEqual(['no call of the runs is made with gpt-4o']);
    expect(previewEstimate([calls()], { model: 'gpt-5' }).parts).toEqual(['gpt-5 is of another family than the calls it switches, so none can be asked again: verify that switch instead']);
    expect(previewEstimate([calls()], { fromCode: true }, { scope: 'agent' }).parts).toEqual(['no model call of the runs to ask']);
  });

  it('switches by default from the model the runs use most, and a migration from the ones that retire', () => {
    const old: CallRecord[] = [api(1, 'claude-sonnet-4-5-20250929', { inputTokens: 10, outputTokens: 1 }, { provider: 'anthropic' })];
    const now = Date.parse('2026-10-19T00:00:00Z');
    expect(previewFrom([calls(), pricedCalls(old)], 'decisions', 'claude-sonnet-5-5', { now })).toEqual(['claude-sonnet-5']);
    expect(previewFrom([calls(), pricedCalls(old)], 'migrate', 'claude-sonnet-5-5', { now })).toEqual(['claude-sonnet-4-5-20250929']);
    expect(previewFrom([], 'migrate', 'claude-sonnet-5-5')).toEqual([]);
  });

  it('verifies its flagged runs from the first model call, each at what it costs under the change', () => {
    const e = verifyEstimate([decisionRunCost({ cost: { before: 0.02, after: 0.03 } }, true), decisionRunCost({ cost: { before: 0.02, after: 0.03 } }, false)], { live: 'first' });
    expect(e.parts).toEqual(['up to 80 attempts a failing run, 200 pairs a good one', 'live from the first model call, writes stubbed']);
    expect(e.usd).toBeCloseTo(80 * 0.03 + 200 * 0.05, 10);
    expect(decisionRunCost({ cost: { before: null, after: 0.03 } }, false)).toMatchObject({ none: 'a model of the run has no price' });
  });
});

describe('a migration', () => {
  // The recording made with claude-sonnet-4-5 for its first two model calls, which a switch to claude-sonnet-5-5 (priced as claude-sonnet-5) asks again.
  const golden = (): CallRecord[] => recording().map((c) => (c.callNo === 1 || c.callNo === 3 ? { ...c, meta: { ...c.meta, model: 'claude-sonnet-4-5-20250929' }, end: { ...c.end!, meta: { ...c.end!.meta, model: 'claude-sonnet-4-5-20250929' } } } : c));
  // As recorded, #1 costs $0.006 and #3 $0.0078 at claude-sonnet-4-5's price; switched, $0.004 and $0.0052.
  const was = 0.006 + 0.0078 + COST[5] + COST[6];

  it('asks the switched calls again, then verifies every golden they touch to its gate’s limit, and always asks first', () => {
    const plan = { to: 'claude-sonnet-5-5', from: ['claude-sonnet-4-5-20250929'] };
    const e = migrateEstimate([{ calls: pricedCalls(golden()), failed: false }, { calls: pricedCalls(golden()), failed: true }, { calls: calls(), failed: false }], plan);
    const ask = 2 * (COST[1] + COST[3]);
    expect(e).toMatchObject({ kind: 'migrate', ceiling: true, always: 'it writes a config change and a pull request body' });
    expect(e.parts).toEqual([`${amountWords(ask)} to ask 4 calls again`, 'then verify, up to 80 attempts a failing run, 200 pairs a good one', 'live from the switched calls, writes stubbed']);
    expect(e.usd).toBeCloseTo(ask + 200 * (ALL + was) + 80 * ALL, 10);
    expect(e.items![0].usd).toBeCloseTo(ask, 10);
  });

  it('is Free where no golden’s call is made with a model it switches from, and has none for a model with no price', () => {
    expect(migrateEstimate([{ calls: calls(), failed: false }], { to: 'claude-sonnet-5-5', from: ['claude-3-opus-20240229'] })).toEqual({ kind: 'migrate', usd: 0, ceiling: false, always: 'it writes a config change and a pull request body', parts: ['no golden’s call is made with claude-3-opus-20240229'] });
    expect(migrateEstimate([{ calls: pricedCalls(golden()), failed: false }], { to: 'my-model', from: ['claude-sonnet-4-5-20250929'] }).none).toBe('no price for my-model: add it under "prices" in shadowlap.config.json');
  });
});
