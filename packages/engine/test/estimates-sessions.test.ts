import { describe, expect, it } from 'vitest';
import { chaosTargets } from '../src/chaos.js';
import { decisionRunCost, migrateEstimate, previewEstimate } from '../src/estimates/changes.js';
import { pricedCalls } from '../src/estimates/estimate.js';
import { causeEstimate, CLEAN_GATE, injectionAgainEstimate, injectionEstimate, presetsEstimate } from '../src/estimates/injection.js';
import { amountWords, asksFirst, costLine, costWords, type Spending } from '../src/estimates/spending.js';
import { bisectCommits, bisectEstimate, goldenTestEstimate, moreEstimate, runBisectEstimate, testsEstimate, updateEstimate } from '../src/estimates/tests.js';
import { verifyEstimate } from '../src/estimates/verify.js';
import { untrustedReads } from '../src/injection.js';
import { defaultFrom, modelUse } from '../src/switch-from.js';
import type { CallRecord, JudgeSummary } from '../src/types.js';
import { ALL, api, COST, recording, tool } from './estimate-fixtures.js';

/**
 * The jobs a session of goldens, an injection test, the error-path presets and Changes run, each
 * against the recording worked out by hand in estimate-fixtures.ts, at DEFAULT_PRICES: the agent's
 * model calls from #3 on, with the judge's at #6, come to $0.01495.
 */

const calls = () => pricedCalls(recording());
const FROM_3 = COST[3] + COST[5] + COST[6];
const judge = (spent: number, unknownModels: string[] = []): JudgeSummary => ({ calls: 1, replayed: 0, live: 1, notAsked: 0, upstreamRequests: 1, spent, saved: 0, unknownModels });
/** Spending's every setting: Always ask, the default, $2 and Never ask. */
const SETTINGS: Spending[] = [0, 0.5, 2, null];

describe('Run tests', () => {
  it('is Free when every golden replays offline, and priced at what the last session spent live otherwise', () => {
    expect(testsEstimate(0, null)).toEqual({ kind: 'tests', usd: 0, ceiling: false, parts: ['every golden replays offline'] });
    const e = testsEstimate(2, { results: [{ data: { spent: 1.2, judge: judge(0.1) } }, { data: { spent: 0 } }, { data: null }], injection: [{ spent: 1.01, unknownModels: [] }] });
    expect(e).toMatchObject({ kind: 'tests', ceiling: false, parts: ['what the last session spent live'] });
    expect(e.usd).toBeCloseTo(2.31, 10);
    expect(e.last!.usd).toBeCloseTo(2.31, 10);
  });

  it('has no estimate for goldens that run live until a session has run', () => {
    expect(testsEstimate(2, null)).toEqual({ kind: 'tests', usd: null, ceiling: false, parts: ['no estimate until a session has run'], none: 'no estimate until a session has run' });
  });

  it('has none, and asks on every setting, where the last session spent nothing live or met a model with no price', () => {
    // Its fork goldens replayed clean last time, so spent nothing: this session may fork, and bill.
    const clean = testsEstimate(2, { results: [{ data: { spent: 0 } }, { data: { spent: 0 } }] });
    expect(clean).toMatchObject({ usd: null, none: 'the last session spent nothing live, so what this one bills is unknown' });
    for (const s of SETTINGS) expect(asksFirst(clean, s), String(s)).toBe(true);
    expect(testsEstimate(1, { results: [{ data: { spent: 0.5, judge: judge(0, ['my-judge']) } }] }).none).toBe('no price for my-judge: add it under "prices" in shadowlap.config.json');
    expect(testsEstimate(1, { results: [{ data: { spent: 0.5 } }], injection: [{ spent: 0, unknownModels: ['my-model'] }] }).none).toBe('no price for my-model: add it under "prices" in shadowlap.config.json');
  });

  it('runs one golden offline for free, and one marked fork at what its last test spent, with none until it has run once', () => {
    expect(goldenTestEstimate(false, null)).toEqual({ kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] });
    // Not covered's Run test on the golden a pack just made, as the ask says it.
    const first = goldenTestEstimate(true, null);
    expect(first).toEqual({ kind: 'tests', usd: null, ceiling: false, parts: ['live from there, writes blocked', 'no estimate until it has run once'], none: 'no estimate until it has run once' });
    expect(costLine(first)).toEqual(['Billed by your provider', 'live from there, writes blocked', 'no estimate until it has run once']);
    const e = goldenTestEstimate(true, { data: { spent: 0.11, judge: judge(0.01) } });
    expect(e).toMatchObject({ note: 'as its last test spent', parts: ['live from there, writes blocked'] });
    expect(e.usd).toBeCloseTo(0.12, 10);
  });

  it('has none for a golden marked fork whose last test spent nothing live, which says nothing of what the next bills', () => {
    const e = goldenTestEstimate(true, { data: { spent: 0 } });
    expect(e).toMatchObject({ usd: null, none: 'its last test spent nothing live, so what this one bills is unknown' });
    for (const s of SETTINGS) expect(costWords(e, s), String(s)).toBe('no estimate · asks first');
  });
});

describe('Tests’ Run more attempts', () => {
  // The gate's own figure, as Tests works it out: from 80 attempts to 160, about 27 more expected, at what its 80 cost ($1.032).
  const more = { attempts: 160, most: 80, expected: 26.9, cost: (1.032 / 80) * 26.9 };
  const spends = Array.from({ length: 80 }, (_, i) => (i === 7 ? 0.019 : 0.0128));

  it('bills every attempt it may add, each as dear as its costliest so far, and gives the gate’s own figure to the cent', () => {
    const e = moreEstimate(more, spends);
    expect(e).toMatchObject({ kind: 'more', ceiling: true, attempts: 80, each: 0.019, parts: ['up to 80 more attempts', 'live from where the golden forks, writes blocked'] });
    expect(e.usd).toBeCloseTo(80 * 0.019, 10);
    expect(costLine(e)).toEqual(['At most ≈$1.52', 'up to 80 more attempts', 'live from where the golden forks, writes blocked']);
    expect(e.expected).toEqual({ usd: more.cost, attempts: 27 });
    expect(e.card).toEqual({ title: 'If every attempt ran, each as dear as its costliest so far', lines: ['About ≈$0.35 for the 27 it is expected to take, at what its 80 have cost.'] });
  });

  it('has none where it adds no attempt, what the attempts cost was not kept, or they spent nothing live', () => {
    expect(moreEstimate({ ...more, most: 0 }, spends).none).toBe('its gate has taken its 160 attempts already');
    expect(moreEstimate(more, [])).toMatchObject({ usd: null, none: 'what its attempts cost was not kept', parts: ['up to 80 more attempts', 'live from where the golden forks, writes blocked', 'what its attempts cost was not kept'] });
    const free = moreEstimate({ ...more, cost: null }, Array<number>(80).fill(0));
    expect(free).toMatchObject({ usd: null, none: 'its attempts so far spent nothing live, so what more cost is unknown' });
    expect(asksFirst(free, 0)).toBe(true);
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

  it('has none for a golden marked fork whose last session’s attempts spent nothing live', () => {
    const e = bisectEstimate(5, { fork: true, attempts: 20, each: 0 });
    expect(e).toMatchObject({ usd: null, none: 'its last session’s attempts spent nothing live, so what one costs is unknown' });
    expect(costLine(e)).toEqual(['Billed by your provider', 'live at each commit, as a golden marked fork runs', 'its last session’s attempts spent nothing live, so what one costs is unknown']);
  });

  it('bills a run one live replay at every commit it tests but its own', () => {
    const e = runBisectEstimate(calls(), 4);
    expect(e).toMatchObject({ ceiling: true, attempts: 3, parts: ['up to 4 commits', 'one live replay each, writes blocked'] });
    expect(e.usd).toBeCloseTo(3 * ALL, 10);
  });
});

describe('an injection test', () => {
  const reads = () => untrustedReads(recording(), { lookup_order: { trust: 'untrusted' } }).reads;
  /** A kept test of the recording, as `shadowlap injection` keeps it: its attempts, its clean replays, what it spent. */
  const kept = (spent: number, unknownModels: string[] = []) => ({
    totals: { attempts: 72, obeyed: 0, influenced: 0, ignored: 72, inconclusive: 0 },
    baselines: [
      { read: 2, runs: ['b1', 'b2', 'b3'], writes: 1, failed: [] },
      { read: 7, runs: ['b4', 'b5', 'b6'], writes: 0, failed: [] },
    ],
    cost: { spent, upstreamRequests: 90, unknownModels },
  });

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

  it('prices a run of many reads from sums worked out once, its counts as the line says a number', () => {
    const n = 100_000;
    const big: CallRecord[] = Array.from({ length: n }, (_, i) => (i % 2 ? tool(i + 1, 'fetch', 'read') : api(i + 1, 'claude-sonnet-5', { inputTokens: 1000, outputTokens: 100 })));
    // 25,000 reads, each at #4k + 2 and read at the model call after it; a model call costs $0.003, every other call one.
    const many = Array.from({ length: 25_000 }, (_, i) => ({ callNo: 4 * i + 2, readAt: 4 * i + 3 }));
    const e = injectionEstimate(pricedCalls(big), many, { payloads: 12 });
    expect(e.parts[0]).toBe('300,000 attempts and 75,000 clean replays');
    const fromRead = (at: number) => ((n - at + 1) / 2) * 0.003;
    expect(e.usd).toBeCloseTo(15 * many.reduce((s, r) => s + fromRead(r.readAt), 0), 4);
  });

  it('runs again at what it spent the last time, saying whose attempts that counts', () => {
    const e = injectionAgainEstimate(kept(3.11));
    expect(e).toEqual({ kind: 'injection', usd: 3.11, ceiling: false, note: 'as the last test’s 72 attempts and 6 clean replays', parts: ['live from each read, writes stubbed'], last: { usd: 3.11, attempts: 78 } });
    expect(costLine(e)).toEqual(['≈$3.11, as the last test’s 72 attempts and 6 clean replays', 'live from each read, writes stubbed']);
    expect(injectionAgainEstimate({ ...kept(0.41), baselines: [] }).note).toBe('as the last test’s 72 attempts');
  });

  it('has none to run again from a test that spent nothing live, or met a model with no price', () => {
    for (const e of [injectionAgainEstimate(kept(0)), injectionAgainEstimate(kept(0.2, ['my-model']))]) {
      expect(e.usd).toBeNull();
      for (const s of SETTINGS) expect(asksFirst(e, s), String(s)).toBe(true);
    }
    expect(injectionAgainEstimate(kept(0)).none).toBe('the last test spent nothing live, so what this one bills is unknown');
    expect(costLine(injectionAgainEstimate(kept(0.2, ['my-model'])))).toEqual(['Billed by your provider', 'live from each read, writes stubbed', 'no price for my-model: add it under "prices" in shadowlap.config.json']);
  });

  it('finds a cause with the read made neutral, up to its gate’s attempts, each live from the model call that reads it', () => {
    expect(CLEAN_GATE).toEqual({ kind: 'sprt', good: 0.8, bad: 0.2, risk: 0.05, max: 10 });
    const e = causeEstimate(calls(), reads()[0]!);
    expect(e).toMatchObject({ kind: 'cause', ceiling: true, attempts: 10, parts: ['up to 10 attempts', 'live from the read, writes stubbed'] });
    expect(e.usd).toBeCloseTo(10 * FROM_3, 10);
    expect(e.card).toEqual({ title: 'If the gate took all its attempts', lines: [`An attempt costs ${amountWords(FROM_3)}, live from the read made neutral to the run’s end.`, 'The gate stops once it decides.'] });
    expect(causeEstimate(calls(), { callNo: 7, readAt: null }).parts).toEqual(['no model call comes after #7']);
  });

  it('prices a cause from the call in the read’s scope that reads it, not another scope’s that only replays', () => {
    // #2 a read in the agent's scope; #3 a planner's call, which the neutral read leaves as it was; #4 the agent's, which reads it.
    const scoped: CallRecord[] = [
      api(1, 'claude-sonnet-5', { inputTokens: 1000, outputTokens: 100 }, { scope: 'agent' }),
      tool(2, 'fetch', 'read', 'live', 'agent'),
      api(3, 'claude-sonnet-5', { inputTokens: 5000, outputTokens: 500 }, { scope: 'planner' }),
      api(4, 'claude-sonnet-5', { inputTokens: 1000, outputTokens: 100 }, { scope: 'agent' }),
    ];
    const read = untrustedReads(scoped, { fetch: { trust: 'untrusted' } }).reads[0]!;
    expect(read).toMatchObject({ callNo: 2, readAt: 4 });
    expect(causeEstimate(pricedCalls(scoped), read).each).toBeCloseTo(0.003, 10);
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
  /** The recorded models a switch changes, as the commands pick them when --from names none. */
  const picked = (runs: CallRecord[][], kind: 'decisions' | 'migrate', to: string) => defaultFrom(modelUse(runs, null), kind, to, Date.parse('2026-10-19T00:00:00Z'))?.models ?? null;

  it('asks each call the change touches every sample, and the control arm as often, at the recorded model’s price', () => {
    // At claude-opus-5-5, #1 costs $0.008, #3 $0.0102 and #5 $0.018; as recorded $0.004, $0.0052 and $0.009. The judge's call is no step.
    const from = picked([recording()], 'decisions', 'claude-opus-5-5');
    expect(from).toEqual(['claude-sonnet-5']);
    const e = previewEstimate([calls()], { model: 'claude-opus-5-5', from });
    expect(e).toMatchObject({ kind: 'preview', ceiling: false, parts: ['about 18 requests, half as recorded'] });
    expect(e.usd).toBeCloseTo(3 * (0.008 + 0.004 + 0.0102 + 0.0052 + 0.018 + 0.009), 10);
    const once = previewEstimate([calls()], { model: 'claude-opus-5-5', from }, { samples: 1 });
    expect(once.parts).toEqual(['about 3 requests']);
    expect(once.usd).toBeCloseTo(0.008 + 0.0102 + 0.018, 10);
  });

  it('counts its requests as the line says a number, and asks no call whose request or answer was not kept', () => {
    const runs = Array.from({ length: 68 }, () => calls());
    expect(previewEstimate(runs, { model: 'claude-opus-5-5', from: ['claude-sonnet-5'] }).parts).toEqual(['about 1,224 requests, half as recorded']);
    const kept = pricedCalls([api(1, 'claude-sonnet-5', { inputTokens: 10, outputTokens: 1 }), api(2, 'claude-sonnet-5', { inputTokens: 10, outputTokens: 1 }, { request: false }), api(3, 'claude-sonnet-5', null, { ended: 'error' })]);
    expect(previewEstimate([kept], { from: null }, { samples: 1 }).parts).toEqual(['about 1 request']);
  });

  it('asks every call for a change of fields, at the recorded model', () => {
    expect(previewEstimate([calls()], { from: null }).usd).toBeCloseTo(3 * 2 * (COST[1] + COST[3] + COST[5]), 10);
  });

  it('has no estimate for a change of the working tree’s prompt until its offline replay names the calls it changes', () => {
    const e = previewEstimate([calls()], { from: null, fromCode: true });
    expect(e).toMatchObject({ usd: null, none: 'which calls the working tree changes is known once the preview has replayed it offline' });
    expect(costLine(e)).toEqual(['Billed by your provider', 'which calls the working tree changes is known once the preview has replayed it offline']);
  });

  it('is Free where no call is made with a model it switches from, and says why a switch to another family asks nothing', () => {
    expect(previewEstimate([calls()], { model: 'claude-opus-5-5', from: ['gpt-4o'] }).parts).toEqual(['no call of the runs is made with gpt-4o']);
    expect(previewEstimate([calls()], { model: 'gpt-5', from: ['claude-sonnet-5'] }).parts).toEqual(['gpt-5 is of another family than the calls it switches, so none can be asked again: verify that switch instead']);
    expect(previewEstimate([calls()], { from: null }, { scope: 'agent' }).parts).toEqual(['no model call of the runs to ask']);
  });

  it('switches by default from the model the runs use most, and a migration from the ones that retire, as the commands pick them', () => {
    const old: CallRecord[] = [api(1, 'claude-sonnet-4-5-20250929', { inputTokens: 10, outputTokens: 1 }, { provider: 'anthropic' })];
    expect(picked([recording(), old], 'decisions', 'claude-sonnet-5-5')).toEqual(['claude-sonnet-5']);
    expect(picked([recording(), old], 'migrate', 'claude-sonnet-5-5')).toEqual(['claude-sonnet-4-5-20250929']);
    expect(picked([], 'migrate', 'claude-sonnet-5-5')).toBeNull();
    // As the commands count them: by the model recorded, every call whose request was kept, one that failed too.
    const failing: CallRecord[] = [api(1, 'gpt-5', null, { ended: 'error' }), api(2, 'gpt-5', null, { ended: 'error' }), api(3, 'claude-sonnet-5', { inputTokens: 1, outputTokens: 1 }), api(4, 'claude-sonnet-5', null, { request: false })];
    expect(modelUse([failing], null)).toEqual([
      { model: 'gpt-5', provider: null, calls: 2 },
      { model: 'claude-sonnet-5', provider: null, calls: 1 },
    ]);
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

  it('says which switched call kept no token counts, rather than a price the new model has', () => {
    const uncounted = pricedCalls([api(1, 'claude-sonnet-4-5', { inputTokens: 1000, outputTokens: 100 }), api(2, 'claude-sonnet-4-5', null)]);
    const e = migrateEstimate([{ calls: uncounted, failed: true }], { to: 'claude-sonnet-5', from: ['claude-sonnet-4-5'] });
    expect(e).toMatchObject({ usd: null, none: '#2 kept no token counts', always: 'it writes a config change and a pull request body' });
    expect(previewEstimate([uncounted], { model: 'claude-sonnet-5', from: ['claude-sonnet-4-5'] }).none).toBe('#2 kept no token counts');
  });
});
