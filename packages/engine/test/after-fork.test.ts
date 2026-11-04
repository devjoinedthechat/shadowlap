import { describe, expect, it } from 'vitest';
import { afterForkLines, afterForkOf, afterForkWarnings, type AfterFork } from '../src/after-fork.js';
import { JUDGE_SCOPE } from '../src/judge-scope.js';
import { plain } from '../src/report.js';
import type { CallKind, CallMeta, CallRecord, Origin } from '../src/types.js';
import { decideVerify, formatVerify, type VerifiedRun, type VerifyAttempt, type VerifyReport, type VerifyRole } from '../src/verify.js';

function call(callNo: number, kind: CallKind, origin: Origin, meta: CallMeta = {}): CallRecord {
  return { runId: '01M0', callNo, kind, name: kind === 'api' ? 'POST /v1/messages' : 'lookup_order', fingerprint: `f${callNo}`, occurrence: 0, origin, effect: kind === 'tool' ? 'read' : null, requestRef: null, meta, at: callNo, end: null, attempts: [] };
}

const counts = (o: Partial<AfterFork>): AfterFork => ({ recorded: 0, inOrder: 0, live: 0, stubbed: 0, blocked: 0, ...o });

function attempt(afterFork?: AfterFork): VerifyAttempt {
  return { runId: '01M1'.padEnd(26, '0'), passed: true, exitCode: 0, failures: [], forkedAt: afterFork ? 3 : null, spent: 0.01, upstreamRequests: 2, footprint: { inputTokens: 1000, outputTokens: 10, cost: 0.001 }, ...(afterFork ? { afterFork } : {}) };
}

function run(role: VerifyRole, change: Array<AfterFork | undefined>, baseline?: Array<AfterFork | undefined>): VerifiedRun {
  return {
    runId: `01K5${role.toUpperCase()}`.padEnd(26, '0'),
    role,
    attempts: change.map(attempt),
    passes: change.length,
    deterministic: false,
    verdict: 'pass',
    recorded: { passed: role === 'good', failures: [], footprint: { inputTokens: 1000, outputTokens: 10, cost: 0.001 } },
    ...(baseline ? { baselineRuns: baseline.map(attempt), baseline: { passes: baseline.length, attempts: baseline.length, source: 'paired' as const } } : {}),
  };
}

describe('afterForkOf', () => {
  it("counts the agent's tool calls from the fork on by where each was answered from", () => {
    const calls = [
      call(1, 'api', 'replayed'),
      call(2, 'tool', 'replayed'),
      call(3, 'api', 'live'),
      call(4, 'tool', 'replayed'),
      call(5, 'tool', 'replayed', { input: true }),
      call(6, 'tool', 'live'),
      call(7, 'tool', 'stubbed'),
      call(8, 'tool', 'blocked'),
      call(9, 'clock', 'live'),
      call(10, 'api', 'live', { scope: JUDGE_SCOPE }),
      call(11, 'tool', 'live', { scope: JUDGE_SCOPE }),
    ];
    // Call 2 came before the fork; model calls, a clock and the judge's calls are none of what is counted.
    expect(afterForkOf(calls, 3)).toEqual(counts({ recorded: 1, inOrder: 1, live: 1, stubbed: 1, blocked: 1 }));
  });

  it('counts a tool call the fork itself is', () => {
    expect(afterForkOf([call(1, 'api', 'replayed'), call(2, 'tool', 'live')], 2)).toEqual(counts({ live: 1 }));
  });

  it('has nothing to count for an attempt that replayed clean', () => {
    expect(afterForkOf([call(1, 'tool', 'replayed')], null)).toBeNull();
  });
});

describe('afterForkLines', () => {
  it("names what answered the change's tool calls, and its baselines' apart", () => {
    const runs = [run('target', [counts({ recorded: 3, stubbed: 1 }), counts({ recorded: 3, inOrder: 2 })]), run('good', [counts({ live: 1 })], [counts({ recorded: 1 })])];
    expect(afterForkLines(runs, plain)).toEqual([
      "  after the fork, the change's 3 attempts made 10 tool calls: 6 answered as recorded, 2 given a person's recorded answers in order, 1 ran live, 1 stubbed; the baselines' 1 attempt made 1 tool call: 1 answered as recorded",
    ]);
  });

  it('says nothing when no attempt made a tool call after its fork, or none counted them', () => {
    expect(afterForkLines([run('target', [counts({}), counts({})])], plain)).toEqual([]);
    expect(afterForkLines([run('target', [undefined])], plain)).toEqual([]);
  });

  it('wraps to a terminal at whole words', () => {
    const lines = afterForkLines([run('target', [counts({ recorded: 3, stubbed: 1, blocked: 2 })])], plain, 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= 60)).toBe(true);
  });
});

describe('afterForkWarnings', () => {
  it("warns when a good run's change arm went unanswered 10 points or more past its baseline's", () => {
    const apart = run('good', [counts({ recorded: 3, stubbed: 1 })], [counts({ recorded: 4 })]);
    expect(afterForkWarnings([apart])).toEqual([
      "good run 01K5GOOD00: the change's attempts got stubbed or blocked answers for 1 of 4 tool calls after the fork, its baseline's for 0 of 4, so the two arms didn't run against the same answers",
    ]);
  });

  it('keeps quiet when the arms are within 10 points, and for runs with no baseline arm', () => {
    const close = run('good', [counts({ recorded: 18, stubbed: 2 })], [counts({ recorded: 19, blocked: 1 })]);
    const target = run('target', [counts({ stubbed: 4 })]);
    const noBaselineCalls = run('good', [counts({ stubbed: 1 })], [counts({})]);
    expect(afterForkWarnings([close, target, noBaselineCalls])).toEqual([]);
  });

  it("counts the change's attempts a person's recorded answers reached after the fork", () => {
    const runs = [run('target', [counts({ inOrder: 2 }), counts({ recorded: 1 })]), run('good', [counts({ inOrder: 1 })], [counts({ inOrder: 3 })])];
    expect(afterForkWarnings(runs)).toEqual([
      "2 attempts of the change got a person's recorded answers after the fork, in the order they were given, whatever the agent then asked: where the change alters the conversation, they may not fit it",
    ]);
  });
});

describe('verify report', () => {
  it('carries the after-fork warnings and prints the line', () => {
    const runs = [run('target', [counts({ recorded: 2, inOrder: 1 })]), run('holdout', [counts({ recorded: 2 })]), run('good', [counts({ recorded: 1, blocked: 1 })], [counts({ recorded: 2 })])];
    const decision = decideVerify(runs, null);
    expect(decision.warnings).toContain("good run 01K5GOOD00: the change's attempts got stubbed or blocked answers for 1 of 2 tool calls after the fork, its baseline's for 0 of 2, so the two arms didn't run against the same answers");
    expect(decision.warnings).toContain("1 attempt of the change got a person's recorded answers after the fork, in the order they were given, whatever the agent then asked: where the change alters the conversation, they may not fit it");
    const report: VerifyReport = { ...decision, runs, attemptsPerRun: 5, needed: 4, oracle: ['the agent exits 0'], fields: {}, codeVersion: null, attempts: 4, spent: 0.04, upstreamRequests: 8, unknownModels: [], stopReason: null, replayWarnings: [] };
    expect(formatVerify(report, plain)).toContain("after the fork, the change's 3 attempts made 7 tool calls: 5 answered as recorded, 1 given a person's recorded answers in order, 1 blocked; the baselines' 1 attempt made 2 tool calls: 2 answered as recorded");
  });

  it('prints no line for a report whose attempts never counted them', () => {
    const runs = [run('target', [undefined])];
    const report: VerifyReport = { ...decideVerify(runs, null), runs, attemptsPerRun: 5, needed: 4, oracle: ['the agent exits 0'], fields: {}, codeVersion: null, attempts: 1, spent: 0, upstreamRequests: 0, unknownModels: [], stopReason: null, replayWarnings: [] };
    expect(formatVerify(report, plain)).not.toContain('after the fork');
  });
});
