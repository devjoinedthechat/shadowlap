import { describe, expect, it } from 'vitest';
import { blameBound, blameEstimate } from '../src/estimates/blame.js';
import { pricedCalls } from '../src/estimates/estimate.js';
import { REPAIR_CANDIDATES, repairerBound, repairEstimate, type RepairRun } from '../src/estimates/repair.js';
import { amountWords } from '../src/estimates/spending.js';
import { verifyCeiling, verifyEstimate, verifyLimits, verifyMoreEstimate, verifyParts, verifyRunCosts, type VerifyRunCost } from '../src/estimates/verify.js';
import { SPRT_DEFAULTS, gateOdds } from '../src/stats.js';
import type { VerifiedRun, VerifyAttempt, VerifyReport } from '../src/verify.js';
import { ALL, api, recording } from './estimate-fixtures.js';

/**
 * The jobs that run attempts until a gate decides, each priced at its ceiling as the CLI bounds it:
 * blame's probes and the check of a call they pin, verify's runs by role, and repair's blame, its
 * repairer and its candidates. Against the recording worked out by hand in estimate-fixtures.ts, at
 * DEFAULT_PRICES: its agent's three model calls are what blame probes, $0.01895 a run with its judge.
 */

const calls = () => pricedCalls(recording());

describe('blame’s bound', () => {
  it('is the most probes, each at its gate’s max at its share of the risk, and the check of a pinned call, as the CLI prints it', () => {
    // 3 model calls: 1 + ⌈log₂ 3⌉ + 2 scanned = 5 probes; 20 attempts at 5% become 31 at 1% each; the check, 2 × 62 pairs.
    expect(blameBound(3)).toEqual({ steps: 3, probes: 5, each: 31, pin: 124, attempts: 279 });
    // 31 to 36 attempts a probe over 5 to 10 probes (blame.md#cost).
    expect(blameBound(30)).toEqual({ steps: 30, probes: 8, each: 34, pin: 136, attempts: 408 });
    expect(blameBound(100)).toMatchObject({ probes: 10, each: 36 });
    // One model call: no next call to check a pin against.
    expect(blameBound(1)).toEqual({ steps: 1, probes: 1, each: 20, pin: 0, attempts: 20 });
  });

  it('follows a lower bar or a higher max (`--gate`), a fixed count, and the scan', () => {
    expect(blameBound(3, { gate: { kind: 'sprt', good: 0.6, bad: 0.1, risk: 0.05, max: 40 } })).toMatchObject({ each: 62, pin: 248, attempts: 558 });
    // A fixed count runs its attempts a probe; its check runs at the default gate's share.
    expect(blameBound(3, { attempts: 5 })).toMatchObject({ each: 5, pin: 124, attempts: 149 });
    expect(blameBound(3, { scan: 0 }).probes).toBe(3);
  });
});

describe('Run blame', () => {
  it('bills at most every attempt its search may make, each at most what the recording cost from its first probed call', () => {
    const e = blameEstimate(calls());
    expect(e).toMatchObject({ kind: 'blame', ceiling: true, attempts: 279, parts: ['up to 5 probes of 31 attempts and a check of the call found', 'live from each probe, writes stubbed'] });
    expect(e.usd).toBeCloseTo(279 * ALL, 10);
    expect(e.card).toEqual({ title: 'If every probe and the check ran to their limit', lines: [`An attempt costs at most what the recording did, ${amountWords(ALL)}.`, 'A probe stops once it settles, and a later one costs less.'] });
    expect(blameEstimate(calls(), { writes: 'block' }).parts[1]).toBe('live from each probe, writes blocked');
  });

  it('probes only the calls in its scope, from the first of them', () => {
    const scoped = pricedCalls([api(1, 'claude-sonnet-5', { inputTokens: 1000, outputTokens: 200 }, { scope: 'user' }), api(2, 'claude-sonnet-5', { inputTokens: 1000, outputTokens: 200 }, { scope: 'agent' })]);
    const e = blameEstimate(scoped, { scope: 'agent' });
    // One call in scope: one probe of 20 attempts, no check, each from #2 alone ($0.004).
    expect(e).toMatchObject({ attempts: 20, parts: ['up to 1 probe of 20 attempts', 'live from each probe, writes stubbed'] });
    expect(e.usd).toBeCloseTo(20 * 0.004, 10);
    expect(e.card!.title).toBe('If every probe ran to its limit');
    expect(blameEstimate(scoped, { scope: 'planner' })).toMatchObject({ usd: null, none: 'the run made no model calls in scope planner, so blame has nothing to probe' });
  });

  it('prices Run blame again about as one of the last blame’s attempts, and says what it cost', () => {
    const last = { attempts: 33, spent: 1, judge: { spent: 0.089, upstreamRequests: 33 } };
    const e = blameEstimate(calls(), { last });
    expect(e.usd).toBeCloseTo(279 * (1.089 / 33), 10);
    expect(e.card!.lines[0]).toBe(`An attempt costs about what the last blame’s 33 attempts did, ${amountWords(1.089 / 33)} each.`);
    expect(e.last).toEqual({ usd: 1.089, attempts: 33 });
    // Under another check the search starts over: an attempt at most what the recording cost.
    expect(blameEstimate(calls(), { last, fresh: true }).usd).toBeCloseTo(279 * ALL, 10);
  });

  it('prices a stronger model at its price on the run’s own tokens: about twice claude-sonnet-5’s for claude-opus-5-5', () => {
    const last = { attempts: 33, spent: 1, judge: { spent: 0.089, upstreamRequests: 33 } };
    const k = 0.0362 / 0.0182;
    const e = blameEstimate(calls(), { model: 'claude-opus-5-5', last });
    expect(e.usd).toBeCloseTo(279 * (1.089 / 33) * k, 10);
    expect(e.card!.lines[0]).toBe(`An attempt costs about twice what the last blame’s 33 attempts did, at claude-opus-5-5’s prices: ${amountWords((1.089 / 33) * k)} each.`);
    // With no blame before it, from the recording at that model's price, its judge's calls at theirs.
    const fresh = blameEstimate(calls(), { model: 'claude-opus-5-5' });
    expect(fresh.usd).toBeCloseTo(279 * (0.008 + 0.0102 + 0.018 + 0.00075), 10);
    expect(fresh.card!.lines[0]).toBe(`An attempt costs at most what the recording did at claude-opus-5-5’s prices, ${amountWords(0.03695)}.`);
  });

  it('has none for a run with no model call, or one with no price', () => {
    expect(blameEstimate([])).toEqual({ kind: 'blame', usd: null, ceiling: false, parts: [], none: 'the run made no model calls, so blame has nothing to probe' });
    expect(blameEstimate(pricedCalls([api(1, 'my-model', { inputTokens: 10, outputTokens: 10 })])).none).toBe('no price for my-model: add it under "prices" in shadowlap.config.json');
  });
});

describe('verify’s ceiling', () => {
  it('reads the limits as verify does: 80 attempts a failing run, 200 pairs a good one, a gate’s other max capping both', () => {
    expect(verifyLimits()).toEqual({ failing: 80, good: 200, unit: 'pairs' });
    expect(verifyLimits({ gate: { kind: 'sprt', ...SPRT_DEFAULTS, max: 160 } })).toEqual({ failing: 160, good: 160, unit: 'pairs' });
    expect(verifyLimits({ gate: { kind: 'sprt', ...SPRT_DEFAULTS, max: 160 }, keptMax: 50 })).toEqual({ failing: 160, good: 50, unit: 'pairs' });
    expect(verifyLimits({ baseline: 'history' })).toEqual({ failing: 80, good: 200, unit: 'attempts' });
    expect(verifyLimits({ baseline: 'none' })).toEqual({ failing: 80, good: 80, unit: 'attempts' });
    expect(verifyLimits({ attempts: 5 })).toEqual({ failing: 5, good: 5, unit: 'attempts' });
  });

  const runs: VerifyRunCost[] = [
    { role: 'target', usd: 0.02 },
    { role: 'holdout', usd: 0.03 },
    { role: 'good', usd: 0.01, baseline: 0.012 },
  ];

  it('bills a failing run to its gate’s max, and a good one in pairs against its baseline, or by its gate when that costs more', () => {
    expect(verifyCeiling(runs)).toMatchObject({ attempts: 80 + 80 + 400 });
    expect(verifyCeiling(runs).usd).toBeCloseTo(80 * 0.02 + 80 * 0.03 + 200 * 0.022, 10);
    expect(verifyCeiling(runs, { baseline: 'history' }).usd).toBeCloseTo(1.6 + 2.4 + 200 * 0.01, 10);
    expect(verifyCeiling(runs, { baseline: 'none' }).usd).toBeCloseTo(1.6 + 2.4 + 0.8, 10);
    expect(verifyCeiling(runs, { attempts: 5 })).toMatchObject({ attempts: 15 });
    // 20 pairs cost less than the gate on its own, which runs when no baseline can be had.
    expect(verifyCeiling(runs, { keptMax: 20 }).usd).toBeCloseTo(1.6 + 2.4 + 80 * 0.01, 10);
    expect(verifyCeiling([...runs, { role: 'good', usd: null, none: 'no price for my-model' }]).usd).toBeNull();
  });

  it('says its attempts as the ask does', () => {
    expect(verifyParts(2, 1, verifyLimits())).toBe('up to 80 attempts a failing run, 200 pairs a good one');
    expect(verifyParts(0, 2, verifyLimits())).toBe('up to 200 pairs a run against its baseline');
    expect(verifyParts(1, 0, verifyLimits())).toBe('up to 80 attempts a run');
    expect(verifyParts(1, 1, verifyLimits({ attempts: 5 }))).toBe('up to 5 attempts a run');
    expect(verifyParts(1, 1, verifyLimits({ baseline: 'history' }))).toBe('up to 80 attempts a failing run, 200 attempts a good one');
  });
});

/** An attempt as a verify report keeps it. */
const attempt = (spent: number): VerifyAttempt => ({ runId: `a${spent}`, passed: true, exitCode: 0, failures: [], forkedAt: 3, spent, upstreamRequests: 1, footprint: { inputTokens: 0, outputTokens: 0, cost: spent } });
const run = (role: VerifiedRun['role'], spends: number[], o: Partial<VerifiedRun> = {}): VerifiedRun => ({ runId: `${role}-${spends.length}`, role, attempts: spends.map(attempt), passes: spends.length, deterministic: false, verdict: 'open', recorded: { passed: null, failures: [], footprint: { inputTokens: 0, outputTokens: 0, cost: 0 } }, ...o });

describe('a verify', () => {
  const last = { attempts: 12, spent: 0.24, judge: { spent: 0.03, upstreamRequests: 12 } };

  it('is priced at its ceiling, with the last verify of the runs and what it spent on the price’s card', () => {
    const e = verifyEstimate([{ role: 'target', usd: 0.02 }, { role: 'good', usd: 0.01, baseline: 0.012 }], { last });
    expect(e).toMatchObject({ kind: 'verify', ceiling: true, parts: ['up to 80 attempts a failing run, 200 pairs a good one', 'live where a replay forks, writes stubbed'], last: { usd: 0.27, attempts: 12 } });
    expect(e.usd).toBeCloseTo(1.6 + 4.4, 10);
    expect(e.card).toEqual({ title: 'If every run’s gate ran to its limit', lines: [`An attempt costs about ${amountWords(0.27 / 12)}, as one of the last verify’s 12 attempts did.`, `A gate stops once it decides: the last verify spent ${amountWords(0.27)}.`] });
    expect(verifyEstimate([{ role: 'good', usd: 0.01 }], { live: 'first' }).parts).toEqual(['up to 200 pairs a run against its baseline', 'live from the first model call, writes stubbed']);
    expect(verifyEstimate([])).toMatchObject({ usd: null, none: 'there is no run to verify' });
    expect(verifyEstimate([{ role: 'target', usd: null, none: 'no price for my-model' }])).toMatchObject({ usd: null, none: 'no price for my-model' });
  });

  it('runs more attempts at the higher limit, and what they are expected to take at the rate each run passed at so far', () => {
    const gate = { kind: 'sprt' as const, ...SPRT_DEFAULTS, max: 160 };
    const runs: VerifyRunCost[] = [
      { role: 'target', usd: 0.02, tally: { passes: 9, attempts: 12 } },
      { role: 'good', usd: 0, tally: { passes: 1, attempts: 1, deterministic: true } },
    ];
    const e = verifyMoreEstimate(runs, { rule: { gate } });
    const n = gateOdds(gate, 0.75).attempts;
    expect(e.usd).toBeCloseTo(160 * 0.02, 10);
    expect(e.expected).toEqual({ usd: n * 0.02, attempts: Math.round(n + 1) });
    expect(e.parts).toEqual(['up to 160 attempts a failing run, 160 pairs a good one', `about ${Math.round(n + 1)} attempts expected`, 'live where a replay forks, writes stubbed']);
    // A fixed count states no rate it tells apart: nothing says what it takes.
    expect(verifyMoreEstimate(runs, { rule: { attempts: 10 } }).expected).toBeUndefined();
  });

  it('prices a kept verify’s runs at what an attempt of each cost, its judge’s share with it; a clean replay stays free', () => {
    const report: Pick<VerifyReport, 'runs' | 'attempts' | 'spent' | 'judge'> = {
      runs: [run('target', [0.02, 0.04]), run('good', [0.01], { baselineRuns: [attempt(0.012), attempt(0.014)] }), run('good', [0], { deterministic: true }), run('holdout', [])],
      attempts: 6,
      spent: 0.096,
      judge: { spent: 0.012, upstreamRequests: 6 },
    };
    const costs = verifyRunCosts(report);
    expect(costs.map((c) => c.role)).toEqual(['target', 'good', 'good', 'holdout']);
    expect(costs[0].usd).toBeCloseTo(0.032, 10);
    expect(costs[1].usd).toBeCloseTo(0.012, 10);
    expect(costs[1].baseline).toBeCloseTo(0.015, 10);
    expect(costs[2]).toEqual({ role: 'good', usd: 0, tally: { passes: 1, attempts: 1, deterministic: true } });
    // One that never started: the verify's own average, $0.016, and the judge's share.
    expect(costs[3].usd).toBeCloseTo(0.018, 10);
  });
});

describe('Run repair', () => {
  const failing = (o: Partial<RepairRun> = {}): RepairRun[] => [
    { runId: 'b', startedAt: 2, calls: calls(), ...o },
    { runId: 'a', startedAt: 1, calls: calls(), ...o },
  ];
  const good = [{ calls: calls() }];
  // A verify of a candidate: the run shown and the one held out up to 80 attempts, the good one up to 200 pairs, each the whole run live.
  const verify = 80 * ALL + 80 * ALL + 200 * 2 * ALL;
  // Claude Code's answer: its prompt, the shown run's longest request (3,000 tokens, about 4 characters each) counted at 3 characters a token, read in each of 2 turns, and 16,000 tokens out a turn, at claude-opus-5-5's price.
  const repairer = (2 * 4000 + 16_000) * 4e-6 + 2 * 16_000 * 20e-6;

  it('bills a blame of the run it shows the repairer, its answer, and up to twice the candidates it asks for, each verified up to twice', () => {
    const e = repairEstimate({ failing: failing(), good });
    expect(e).toMatchObject({ kind: 'repair', ceiling: true, always: 'it makes its candidates from your working tree', parts: ['a new blame, then up to 6 candidates', 'each verified up to twice', 'live from each run’s first model call, writes stubbed'] });
    expect(e.usd).toBeCloseTo(279 * ALL + repairer + 2 * 6 * verify, 8);
    expect(e.items!.map((x) => x.what)).toEqual(['Blame', 'Repairer', 'A verify']);
    expect(e.items![1].usd).toBeCloseTo(0.736, 10);
    expect(e.items![2].usd).toBeCloseTo(verify, 10);
    expect(e.attempts).toBe(2 * 6 * (80 + 80 + 400));
    expect(REPAIR_CANDIDATES).toBe(3);
    expect(e.card!.lines.at(-1)).toBe('A run that replays clean settles in one free attempt.');
    // With a verify of the fix before it, what that one took.
    expect(repairEstimate({ failing: failing(), good, last: { attempts: 12, spent: 0.24, judge: { spent: 0.03, upstreamRequests: 12 } } }).card!.lines.at(-1)).toBe(`The last verify of this fix took 12 attempts, ${amountWords(0.27)}.`);
  });

  it('reuses a kept blame that searched to the end, and blames a stopped one again', () => {
    expect(repairEstimate({ failing: failing({ blame: { outcome: 'blamed' } }), good }).parts[0]).toBe('up to 6 candidates');
    expect(repairEstimate({ failing: failing({ blame: { outcome: 'blamed' } }), good }).usd).toBeCloseTo(repairer + 12 * verify, 8);
    expect(repairEstimate({ failing: failing({ blame: { outcome: 'stopped' } }), good }).usd).toBeCloseTo(279 * ALL + repairer + 12 * verify, 8);
  });

  it('decides no more candidates than ⌊1/risk⌋, and asks for as many as told', () => {
    const at = (o: Parameters<typeof repairEstimate>[0]) => (repairEstimate(o).usd! - 279 * ALL - repairer) / verify;
    expect(at({ failing: failing(), good, candidates: 1 })).toBeCloseTo(4, 8);
    expect(at({ failing: failing(), good, rule: { gate: { kind: 'sprt', ...SPRT_DEFAULTS, risk: 0.2 } } })).toBeCloseTo(10, 8);
    expect(repairEstimate({ failing: failing(), good, candidates: 1 }).parts[0]).toBe('a new blame, then up to 2 candidates');
  });

  it('is Free, and still asks first, where it would end No fix to try', () => {
    expect(repairEstimate({ failing: failing(), noFix: 'unsettled' })).toEqual({ kind: 'repair', usd: 0, ceiling: false, always: 'it makes its candidates from your working tree', parts: ['nothing runs: the blame it reuses didn’t settle'] });
    expect(repairEstimate({ failing: failing(), noFix: 'unrescued' }).parts).toEqual(['nothing runs: the blame it reuses rescued no call']);
    // Every run it would show the repairer keeps a blame that rescued no call: there is nothing to learn from.
    expect(repairEstimate({ failing: failing({ blame: { outcome: 'unrescuable' } }), good })).toMatchObject({ usd: 0, parts: ['nothing runs: the blame it reuses rescued no call'] });
  });

  it('prices the repairer as repair bounds it before it asks: Claude Code twice over, another once, none with no model or price', () => {
    expect(repairerBound('claude-code', 12_000)).toEqual({ usd: repairer, model: 'claude-opus-5-5' });
    expect(repairerBound('anthropic', 12_000).usd).toBeCloseTo(4000 * 4e-6 + 16_000 * 20e-6, 10);
    expect(repairerBound('openai:gpt-5', 12_000).usd).toBeCloseTo(4000 * 1.25e-6 + 16_000 * 10e-6, 10);
    expect(repairEstimate({ failing: failing(), repairer: 'openai' })).toMatchObject({ usd: null, none: 'the repairer names no model to price its answer at' });
    expect(repairEstimate({ failing: failing(), repairer: 'anthropic:my-model' }).none).toBe('no price for my-model, the repairer\'s model: add it under "prices" in shadowlap.config.json');
  });
});
