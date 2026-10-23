import { describe, expect, it } from 'vitest';
import type { CallRecord } from '../src/types.js';
import { gateResult, type SprtGate } from '../src/stats.js';
import { decideVerify, eachRun, footprintDelta, footprintOf, formatVerify, gateVerdict, outcomeOf, runVerdict, unsettledReason, verifyRule, type VerifiedRun, type VerifyReport, type VerifyRole } from '../src/verify.js';

const fp = (inputTokens: number, cost: number | null = inputTokens / 1e6) => ({ inputTokens, outputTokens: 10, cost });

function run(role: VerifyRole, outcomes: boolean[], o: { deterministic?: boolean; recorded?: boolean | null; tokens?: number; id?: string } = {}): VerifiedRun {
  const passes = outcomes.filter(Boolean).length;
  const deterministic = o.deterministic ?? false;
  return {
    runId: (o.id ?? `01K5${role.toUpperCase()}`).padEnd(26, '0'),
    role,
    attempts: outcomes.map((passed, i) => ({ runId: `01M${i}`.padEnd(26, '0'), passed, exitCode: passed ? 0 : 1, failures: passed ? [] : ['issue_refund called 0 times, but called 1 time'], forkedAt: deterministic ? null : 3, spent: 0.01, upstreamRequests: 2, footprint: fp(o.tokens ?? 1000) })),
    passes,
    deterministic,
    verdict: runVerdict(passes, outcomes.length, 5, 4, deterministic),
    recorded: { passed: o.recorded === undefined ? (role === 'good') : o.recorded, failures: role === 'good' ? [] : ['issue_refund called 0 times, but called 1 time'], footprint: fp(1000) },
  };
}

describe('runVerdict', () => {
  it('settles a run whose first attempt replayed clean on that attempt', () => {
    expect(runVerdict(1, 1, 5, 4, true)).toBe('pass');
    expect(runVerdict(0, 1, 5, 4, true)).toBe('fail');
    expect(runVerdict(0, 0, 5, 4, true)).toBe('open');
  });

  it('needs its bar of passing attempts otherwise, and stops once it can\'t be met', () => {
    expect(runVerdict(4, 4, 5, 4, false)).toBe('pass');
    expect(runVerdict(3, 4, 5, 4, false)).toBe('open');
    // Two failures of five: four passes are out of reach.
    expect(runVerdict(1, 3, 5, 4, false)).toBe('fail');
  });
});

describe('decideVerify', () => {
  it('accepts only when every failing run is fixed and every good run kept', () => {
    const ok = decideVerify([run('target', [true, true, true, true]), run('holdout', [true, true, true, true]), run('good', [true], { deterministic: true })], null);
    expect(ok).toEqual({ verdict: 'accepted', reasons: [], warnings: [] });

    const broken = decideVerify([run('target', [true, true, true, true]), run('holdout', [true, false, false], { id: '01K5HELD' }), run('good', [false], { deterministic: true, id: '01K5GOOD' })], null);
    expect(broken.verdict).toBe('rejected');
    expect(broken.reasons).toEqual([
      'held-out run 01K5HELD00 not fixed: 1 of 3 passed (issue_refund called 0 times, but called 1 time)',
      'good run 01K5GOOD00 broken: clean replay (issue_refund called 0 times, but called 1 time)',
    ]);
  });

  it('is incomplete, not accepted, while a run is unsettled, and rejected once any run fails', () => {
    const open = { ...run('target', [true, true]), verdict: 'open' as const };
    expect(decideVerify([open, run('good', [true], { deterministic: true })], 'the budget of $0.50 is spent')).toMatchObject({ verdict: 'incomplete', reasons: ['1 run not settled: the budget of $0.50 is spent'] });
    expect(decideVerify([open, run('good', [false], { deterministic: true })], 'interrupted').verdict).toBe('rejected');
  });

  it('says what the evidence lacks', () => {
    const d = decideVerify([run('target', [true, true, true, true], { recorded: true, id: '01K5TGT' })], null);
    expect(d.verdict).toBe('accepted');
    expect(d.warnings).toEqual([
      'target run 01K5TGT000 already passes as recorded, so fixing it proves nothing',
      'no good runs: nothing was checked for regressions (--keeps label:good)',
      'no held-out runs: the change was only tried on the runs it was written for (--holdout)',
    ]);
    const bad = decideVerify([run('good', [true], { deterministic: true, recorded: false, id: '01K5BAD' })], null);
    expect(bad.warnings).toEqual([expect.stringContaining('good run 01K5BAD000 fails as recorded')]);
  });
});

describe('a run an attempt of which could not be judged', () => {
  const why = 'judge "issued" answers yes, but it is inconclusive: not judged: the judge\'s call failed: HTTP 400';
  /** A run whose attempts came out as `outcomes`, then one all that kept from passing was a check that could not be decided. */
  const undecided = (role: VerifyRole, outcomes: boolean[], id: string): VerifiedRun => {
    const r = run(role, outcomes, { id });
    const last = { runId: `01M${outcomes.length}`.padEnd(26, '0'), passed: false, verdict: 'inconclusive' as const, exitCode: 0, failures: [why], forkedAt: 3, spent: 0.01, upstreamRequests: 2, footprint: fp(1000) };
    return { ...r, attempts: [...r.attempts.map((a) => ({ ...a, verdict: a.passed ? ('passed' as const) : ('failed' as const) })), last], verdict: 'open', undecided: why };
  };

  it('is inconclusive, never a failure: the change is incomplete, not rejected, and the report says why', () => {
    const good = undecided('good', [true, true], '01K5GOOD');
    expect(outcomeOf(good)).toBe('inconclusive');
    const d = decideVerify([run('target', [true, true, true, true]), good], null);
    expect(d).toMatchObject({ verdict: 'incomplete', reasons: [`good run 01K5GOOD00 inconclusive: attempt 3 could not be judged: ${why}`] });
    // A run that failed still rejects the change.
    expect(decideVerify([run('target', [false, false]), good], null).verdict).toBe('rejected');
  });

  it('is counted apart in the first line, its tally left without the attempt that was not judged', () => {
    const runs = [run('target', [true, true, true, true]), undecided('holdout', [], '01K5HELD'), undecided('good', [true, true], '01K5GOOD')];
    const text = formatVerify({ ...decideVerify(runs, null), runs, attemptsPerRun: 5, needed: 4, oracle: ['the agent exits 0', 'judge "issued" answers yes'], fields: {}, codeVersion: null, attempts: 8, spent: 0, upstreamRequests: 16, unknownModels: [], stopReason: null, replayWarnings: [] });
    expect(text).toContain('! Incomplete: the change fixes 1 of 1 target run, 0 of 1 held-out run (1 inconclusive) and keeps 0 of 1 good run (1 inconclusive)');
    expect(text).toMatch(/held-out +01K5HELD00 +inconclusive +attempt 1 not judged +judge "issued" answers yes, but it is inconclusive/);
    expect(text).toMatch(/good +01K5GOOD00 +inconclusive +2 of 2 passed, attempt 3 not judged +judge "issued" answers yes/);
    expect(text).not.toMatch(/not fixed|broken|Rejected/);
  });

  it('is marked in amber among the reasons, where what the change failed is red', () => {
    const tag = (name: string) => (s: string) => `<${name}>${s}</${name}>`;
    const palette = { green: tag('green'), red: tag('red'), yellow: tag('yellow'), dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };
    // A target run the change did not fix, a good run it could not judge, and a held-out run the budget left open.
    const runs = [run('target', [false, false]), undecided('good', [true, true], '01K5GOOD'), { ...run('holdout', [true], { id: '01K5HELD' }), verdict: 'open' as const }];
    const d = decideVerify(runs, 'the budget ran out');
    const text = formatVerify({ ...d, runs, attemptsPerRun: 5, needed: 4, oracle: ['the agent exits 0'], fields: {}, codeVersion: null, attempts: 5, spent: 0, upstreamRequests: 10, unknownModels: [], stopReason: 'the budget ran out', replayWarnings: [] }, palette);
    expect(text).toContain('<red>·</red> target run 01K5TARGET not fixed: 0 of 2 passed');
    expect(text).toContain(`<yellow>·</yellow> good run 01K5GOOD00 inconclusive: attempt 3 could not be judged: ${why}`);
    expect(text).toContain('<yellow>·</yellow> 1 run not settled: the budget ran out');
    expect(d.reasons.filter(unsettledReason)).toEqual([`good run 01K5GOOD00 inconclusive: attempt 3 could not be judged: ${why}`, '1 run not settled: the budget ran out']);
    expect(unsettledReason('1 run not settled: the budget ran out')).toBe(true);
    expect(unsettledReason('held-out run 01K5HELD00 inconclusive: 7 of 12 passed · rate 0.32 to 0.81 (95%), between the gate\'s bounds when its attempts ran out')).toBe(true);
    expect(unsettledReason('good run 01K5GOOD00 broken: 0 of 1 passed')).toBe(false);
  });
});

describe('footprints', () => {
  it('adds up what a run would cost live, whatever each call\'s origin', () => {
    const call = (usage: object | undefined, kind = 'api'): CallRecord => ({ kind, end: usage ? { meta: { usage } } : null, meta: {} }) as unknown as CallRecord;
    const calls = [call({ inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 900 }), call({ inputTokens: 50, outputTokens: 5 }), call(undefined), call({ inputTokens: 1, outputTokens: 1 }, 'tool')];
    expect(footprintOf(calls, () => 0.5)).toEqual({ inputTokens: 1050, outputTokens: 10, cost: 1 });
    expect(footprintOf(calls, () => null).cost).toBeNull();
  });

  it('compares the mean of each run\'s attempts with its recording', () => {
    const d = footprintDelta([run('target', [true, true], { tokens: 1200 }), run('good', [true], { deterministic: true, tokens: 1000 })]);
    expect(d).toMatchObject({ runs: 2, recorded: fp(1000), now: { inputTokens: 1100, outputTokens: 10 } });
    expect(d!.now.cost).toBeCloseTo(0.0011, 10);
    expect(footprintDelta([])).toBeNull();
  });
});

describe('formatVerify', () => {
  const report = (runs: VerifiedRun[], over: Partial<VerifyReport> = {}): VerifyReport => ({
    ...decideVerify(runs, null),
    runs,
    attemptsPerRun: 5,
    needed: 4,
    oracle: ['the agent exits 0', 'issue_refund called 0 times'],
    fields: {},
    codeVersion: '3a4f5e1+dirty',
    attempts: 9,
    spent: 0.42,
    upstreamRequests: 40,
    unknownModels: [],
    stopReason: null,
    replayWarnings: [],
    ...over,
  });

  it('leads with the verdict and lists every run under its role', () => {
    const text = formatVerify(report([run('target', [true, true, true, true], { tokens: 1100 }), run('holdout', [true, false, false], { id: '01K5HELD' }), run('good', [true], { deterministic: true })]));
    expect(text).toContain('✗ Rejected: the change fixes 1 of 1 target run, 0 of 1 held-out run and keeps 1 of 1 good run');
    expect(text).toContain('· held-out run 01K5HELD00 not fixed: 1 of 3 passed');
    expect(text).toContain('A run passes when 4 of 5 attempts meet the oracle: the agent exits 0; issue_refund called 0 times.');
    expect(text).toMatch(/target +01K5TARGET +fixed +4 of 4 passed +forked at #3/);
    expect(text).toMatch(/held-out +01K5HELD00 +not fixed +1 of 3 passed +issue_refund called 0 times, but called 1 time/);
    expect(text).toMatch(/good +01K5GOOD00 +kept +clean replay/);
    // The mean over the three runs: 1,100, 1,000 and 1,000 tokens against 1,000 each as recorded.
    expect(text).toContain('per run, as it would run live: 1,000 → 1,033 input tokens (+3.3%) · ≈$0.0010 → ≈$0.0010 (+3.3%)');
    expect(text).toContain('verifying: 9 attempts · 40 upstream requests · ≈$0.420 spent · code 3a4f5e1+dirty');
  });

  it('names a change made through request fields', () => {
    const text = formatVerify(report([run('good', [true], { deterministic: true })], { fields: { model: 'big-model' } }));
    expect(text).toContain('✓ Accepted: the change keeps 1 of 1 good run');
    expect(text).toContain("with model=big-model from each run's first model call");
  });
});

describe('runs decided by a gate', () => {
  const GATE: SprtGate = { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 40 };
  /** A run whose attempts came out as `outcomes`, decided by GATE after each one, as verify decides it. */
  function gated(role: VerifyRole, outcomes: boolean[], o: { deterministic?: boolean; id?: string } = {}): VerifiedRun {
    const base = run(role, outcomes, o);
    const { verdict, decision } = gateVerdict(base.passes, outcomes.length, GATE, base.deterministic);
    return { ...base, verdict, decision, gate: gateResult(GATE, outcomes, { clean: base.deterministic, decision }) };
  }

  it('passes a run at 90% or more, fails it at 70% or less, and settles a clean replay with its one attempt', () => {
    expect(gateVerdict(12, 12, GATE, false)).toEqual({ verdict: 'pass', decision: 'pass' });
    expect(gateVerdict(11, 11, GATE, false)).toEqual({ verdict: 'open', decision: 'continue' });
    expect(gateVerdict(0, 3, GATE, false)).toEqual({ verdict: 'fail', decision: 'fail' });
    expect(gateVerdict(1, 1, GATE, true)).toEqual({ verdict: 'pass', decision: 'pass' });
    expect(gateVerdict(0, 1, GATE, true)).toEqual({ verdict: 'fail', decision: 'fail' });
    // 33 of 40 scores 33·0.2513 − 7·1.0986 ≈ 0.60: still between the bounds at the most attempts it runs.
    expect(gateVerdict(33, 40, GATE, false)).toEqual({ verdict: 'open', decision: 'inconclusive' });
  });

  it('calls a run its gate couldn\'t settle inconclusive, and keeps the change from being accepted', () => {
    const unsure = gated('good', [...Array(33).fill(true), ...Array(7).fill(false)], { id: '01K5GOOD' });
    expect(outcomeOf(unsure)).toBe('inconclusive');
    const d = decideVerify([gated('target', Array(12).fill(true)), unsure], null);
    expect(d.verdict).toBe('incomplete');
    expect(d.reasons).toEqual(["good run 01K5GOOD00 inconclusive: 33 of 40 passed · rate 0.59 to 0.96 (95%), between the gate's bounds when its attempts ran out"]);
    // A failure still rejects it, inconclusive runs or not.
    expect(decideVerify([gated('target', [false, false, false]), unsure], null).verdict).toBe('rejected');
  });

  it('reports each run with its rate, and the gate it was decided by', () => {
    const runs = [gated('target', Array(12).fill(true)), gated('holdout', [false, false, false], { id: '01K5HELD' }), gated('good', [true], { deterministic: true })];
    const text = formatVerify({ ...decideVerify(runs, null), runs, attemptsPerRun: 40, needed: 12, gate: GATE, oracle: ['the agent exits 0', 'issue_refund called 0 times'], fields: {}, codeVersion: null, attempts: 16, spent: 0, upstreamRequests: 60, unknownModels: [], stopReason: null, replayWarnings: [] });
    // The rule stated once; each run's outcome, tally and bound under it.
    expect(text).toContain("A run's attempts must meet the oracle: the agent exits 0; issue_refund called 0 times. Its gate decides after each attempt (gate: tells 90%+ from 70%- at <= 5% risk, up to 40 attempts); a clean replay settles it in one.");
    expect(text).toMatch(/target +01K5TARGET +fixed +12 of 12 passed · rate >= 0\.73 \(95%\) +forked at #3/);
    expect(text).toMatch(/held-out +01K5HELD00 +not fixed +0 of 3 passed · rate <= 0\.71 \(95%\) +issue_refund called 0 times/);
    expect(text).not.toMatch(/at least|at most|of the time|confidence/);
    expect(text).toMatch(/good +01K5GOOD00 +kept +clean replay/);
    expect(eachRun({ gate: GATE, needed: 12, attemptsPerRun: 40 })).toBe('each by its gate, which tells 90%+ from 70%- at <= 5% risk');
    expect(eachRun({ gate: null, needed: 4, attemptsPerRun: 5 })).toBe('each at 4 of 5 attempts');
    expect(verifyRule({ gate: null, needed: 4, attemptsPerRun: 5, fields: {}, oracle: ['the agent exits 0'] })).toBe('A run passes when 4 of 5 attempts meet the oracle: the agent exits 0.');
  });
});
