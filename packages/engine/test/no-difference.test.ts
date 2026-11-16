import { describe, expect, it } from 'vitest';
import { JUDGE_SCOPE } from '../src/judge-scope.js';
import { noDifferenceOf, noDifferenceWarning, servedToolsOf, type NoDifference } from '../src/no-difference.js';
import { plain } from '../src/report.js';
import type { CallKind, CallMeta, CallRecord, Origin } from '../src/types.js';
import { decideVerify, formatVerify, type VerifiedRun, type VerifyAttempt, type VerifyReport, type VerifyRole } from '../src/verify.js';

function call(callNo: number, kind: CallKind, origin: Origin, name = kind === 'api' ? 'POST /v1/messages' : 'lookup_order', meta: CallMeta = {}): CallRecord {
  return { runId: '01M0', callNo, kind, name, fingerprint: `f${callNo}`, occurrence: 0, origin, effect: kind === 'tool' ? 'read' : null, requestRef: null, meta, at: callNo, end: null, attempts: [] };
}

const fp = { inputTokens: 1000, outputTokens: 10, cost: 0.001 };

/** An attempt: one that replayed clean with the tool calls it got from the recording, or one that forked at call 3. */
function attempt(served: Record<string, number> | 'forked'): VerifyAttempt {
  const forked = served === 'forked';
  return { runId: '01M1'.padEnd(26, '0'), passed: true, exitCode: 0, failures: [], forkedAt: forked ? 3 : null, spent: 0, upstreamRequests: 0, footprint: fp, ...(forked ? {} : { servedTools: served }) };
}

function run(role: VerifyRole, served: Record<string, number> | 'forked', id = `01K5${role.toUpperCase()}`): VerifiedRun {
  return { runId: id.padEnd(26, '0'), role, attempts: [attempt(served)], passes: 1, deterministic: served !== 'forked', verdict: 'pass', recorded: { passed: role === 'good', failures: [], footprint: fp } };
}

describe('servedToolsOf', () => {
  it("counts the agent's tool calls a clean replay got from the recording, by tool", () => {
    const calls = [
      call(1, 'api', 'replayed'),
      call(2, 'tool', 'replayed', 'lookup_order'),
      call(3, 'api', 'replayed'),
      call(4, 'tool', 'replayed', 'read_policy'),
      call(5, 'tool', 'replayed', 'lookup_order'),
      // A person's recorded answer is no tool's code; a read the recording held nothing for ran live.
      call(6, 'tool', 'replayed', 'user_input', { input: true }),
      call(7, 'tool', 'live', 'search'),
      call(8, 'clock', 'replayed', 'now'),
      // The judge's calls are none of the agent's.
      call(9, 'tool', 'replayed', 'judge_tool', { scope: JUDGE_SCOPE }),
    ];
    expect(servedToolsOf(calls, null)).toEqual({ lookup_order: 2, read_policy: 1 });
  });

  it('keeps a tool named after a property every object has as a name like any other', () => {
    const served = servedToolsOf([call(1, 'tool', 'replayed', '__proto__'), call(2, 'tool', 'replayed', 'constructor')], null)!;
    expect(Object.entries(served)).toEqual([
      ['__proto__', 1],
      ['constructor', 1],
    ]);
  });

  it('has nothing to say of an attempt that forked: what answered it after the fork is afterFork', () => {
    expect(servedToolsOf([call(1, 'tool', 'replayed')], 3)).toBeNull();
  });
});

describe('noDifferenceOf', () => {
  it('finds the change made no difference when every run replayed clean and a tool call came from the recording', () => {
    const runs = [run('target', { lookup_order: 1, read_policy: 1 }), run('good', { lookup_order: 2, escalate: 1, read_policy: 1 })];
    expect(noDifferenceOf(runs)).toEqual({
      runs: 2,
      toolCalls: 6,
      tools: [
        { name: 'lookup_order', calls: 3 },
        { name: 'read_policy', calls: 2 },
        { name: 'escalate', calls: 1 },
      ],
    });
  });

  it('finds nothing when any run forked: a request differed there', () => {
    expect(noDifferenceOf([run('target', { read_policy: 1 }), run('good', 'forked')])).toBeNull();
  });

  it('finds nothing when no tool call came from the recording: every one ran live, or none was made', () => {
    expect(noDifferenceOf([run('target', {}), run('good', {})])).toBeNull();
  });

  it('reads only the runs verify made an attempt of, and finds nothing in a report made before attempts counted them', () => {
    const unstarted: VerifiedRun = { ...run('good', 'forked'), attempts: [], deterministic: false, verdict: 'open' };
    expect(noDifferenceOf([run('target', { read_policy: 1 }), unstarted])).toMatchObject({ runs: 1, toolCalls: 1 });
    expect(noDifferenceOf([unstarted])).toBeNull();
    const { servedTools: _, ...uncounted } = attempt({ read_policy: 1 });
    const before: VerifiedRun = { ...run('target', {}), attempts: [uncounted] };
    expect(noDifferenceOf([before])).toBeNull();
  });
});

describe('noDifferenceWarning', () => {
  it('names the one tool, and the flag that runs it live', () => {
    const one: NoDifference = { runs: 2, toolCalls: 2, tools: [{ name: 'read_policy', calls: 2 }] };
    expect(noDifferenceWarning(one)).toBe(
      'the change made no difference to any request in 2 runs: 2 calls of read_policy were served from the recording, so its code never ran under the change; if the change is in read_policy or in what it reads, verify again with --live-tool read_policy',
    );
    expect(noDifferenceWarning({ runs: 1, toolCalls: 1, tools: [{ name: 'read_policy', calls: 1 }] })).toMatch(/^the change made no difference to any request in 1 run: 1 call of read_policy was served from the recording, /);
  });

  it('names five tools at most, the most called first, then how many more', () => {
    const tools = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) => ({ name, calls: 7 - i }));
    expect(noDifferenceWarning({ runs: 3, toolCalls: 28, tools })).toBe(
      'the change made no difference to any request in 3 runs: 28 tool calls (a, b, c, d, e and 2 more) were served from the recording, so the code they run never ran under the change; if the change is in a tool or in what one reads, verify again with --live-tool <name>',
    );
    expect(noDifferenceWarning({ runs: 1, toolCalls: 2, tools: tools.slice(0, 2) })).toContain('2 tool calls (a, b) were served');
  });
});

describe('verify, when the change made no difference', () => {
  const runs = [run('target', { read_policy: 1 }, '01K5TGT'), run('good', { read_policy: 1, lookup_order: 1 }, '01K5GOOD')];
  const warning =
    'the change made no difference to any request in 2 runs: 3 tool calls (read_policy, lookup_order) were served from the recording, so the code they run never ran under the change; if the change is in a tool or in what one reads, verify again with --live-tool <name>';

  it('warns, and gives what it found apart, the verdict as it would be without it', () => {
    const d = decideVerify(runs, null);
    expect(d.verdict).toBe('accepted');
    expect(d.reasons).toEqual([]);
    expect(d.warnings.at(-1)).toBe(warning);
    expect(d.noDifference).toEqual({ runs: 2, toolCalls: 3, tools: [{ name: 'read_policy', calls: 2 }, { name: 'lookup_order', calls: 1 }] });
    // A rejected change that made no difference says so too: it is why nothing was fixed.
    const failed = { ...runs[0], passes: 0, verdict: 'fail' as const, attempts: [{ ...runs[0].attempts[0], passed: false, failures: ['escalate called 0 times'] }] };
    expect(decideVerify([failed, runs[1]], null)).toMatchObject({ verdict: 'rejected', noDifference: { runs: 2 } });
  });

  it('says nothing, and has nothing apart, when a request differed', () => {
    const d = decideVerify([runs[0], run('good', 'forked')], null);
    expect(d.warnings.some((w) => w.includes('no difference'))).toBe(false);
    expect(d).not.toHaveProperty('noDifference');
  });

  it("prints it among the report's warnings", () => {
    const report: VerifyReport = { ...decideVerify(runs, null), runs, attemptsPerRun: 80, needed: 12, oracle: ['exit code 0'], fields: {}, codeVersion: null, attempts: 2, spent: 0, upstreamRequests: 0, unknownModels: [], stopReason: null, replayWarnings: [] };
    expect(formatVerify(report, plain).split('\n')).toContain(`  ! ${warning}`);
  });
});
