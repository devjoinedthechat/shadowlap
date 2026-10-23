import { describe, expect, it } from 'vitest';
import { attemptKindOf, countAttempts, isAttempt, rescuedForks, type ClassifiableRun, type RunMeta } from '../src/index.js';

// Which runs are attempts: one rule, read from a run's record, for the dashboard's counts, its lists
// and a run's page alike.

const REC = '01K5CQ4N7G0000000000000000';
let n = 0;
const run = (meta: RunMeta | undefined, over: Partial<ClassifiableRun> = {}): ClassifiableRun => ({
  runId: `01K5CQ4N7H${String(++n).padStart(16, '0')}`,
  parentRunId: REC,
  mode: 'replay',
  status: 'completed',
  divergence: null,
  meta,
  ...over,
});

describe('an attempt, by what made it', () => {
  it('is a blame probe, a verify attempt, a --repeat, a preset’s attempt, or a golden replayed again in one session', () => {
    expect(attemptKindOf(run({ probe: { of: REC, callNo: 5, passed: false }, repeat: { group: 'g', attempt: 1, of: 3 } }))).toBe('probe');
    expect(attemptKindOf(run({ verify: { role: 'good', passed: true }, repeat: { group: 'v', attempt: 1, of: 1 } }))).toBe('verify');
    expect(attemptKindOf(run({ repeat: { group: 'r', attempt: 2, of: 5 } }))).toBe('repeat');
    expect(attemptKindOf(run({ chaos: { preset: 'timeout', callNo: 2, session: 's', attempt: 1 } }))).toBe('chaos');
    const head = run({ test: { golden: 'goldens/refund', session: 's1' } });
    expect(attemptKindOf(run({ test: { golden: 'goldens/refund', session: 's1', attempt: 2, of: head.runId } }))).toBe('test');
    // The result a golden's session shows is the run its attempts are filed under: a run of its own.
    expect(isAttempt(head)).toBe(false);
  });

  it('counts an injection test’s replays and a model’s scoring as the --repeat batches they are', () => {
    const injection = { result: 'inj-1', role: 'attempt' as const, read: 3, attempt: 1, of: 3 };
    expect(isAttempt(run({ repeat: { group: 'inj-1', attempt: 1, of: 3 }, injection }))).toBe(true);
    const task = { golden: 'goldens/refund', model: 'qwen3', takeover: 5, attempt: 1, of: 5, score: 1, session: 'ts-1' };
    expect(isAttempt(run({ repeat: { group: 'ts-1-refund', attempt: 1, of: 5 }, task }))).toBe(true);
  });

  it('leaves a recording, a fork and a clean replay runs of their own', () => {
    expect(isAttempt(run(undefined, { parentRunId: null, mode: 'record' }))).toBe(false);
    expect(isAttempt(run({ labels: ['what-if'] }, { divergence: { callNo: 3, type: 'request_changed' } }))).toBe(false);
    expect(isAttempt(run({}))).toBe(false);
  });

  it('makes the fork blame rescued a run with a run of its own, though blame made it as a probe', () => {
    const fork = run({ probe: { of: REC, callNo: 5, passed: true }, repeat: { group: 'g', attempt: 1, of: 3 } }, { divergence: { callNo: 5, type: 'forced' } });
    expect(isAttempt(fork)).toBe(true);
    expect(isAttempt(fork, { rescued: true })).toBe(false);
    const blamed = run({ blame: { at: 1, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: fork.runId, fields: {}, oracle: [], probes: [], spent: 0 } }, { parentRunId: null, mode: 'record' });
    expect([...rescuedForks([blamed, fork])]).toEqual([fork.runId]);
  });

  it('never hides a run under another one a pack’s probe names', () => {
    expect(isAttempt(run({ probe: { of: '01OTHER0000000000000000000', callNo: 5, passed: false } }))).toBe(false);
  });

  it('takes a list row’s classification, made against the whole store, over its own reading', () => {
    expect(isAttempt({ runId: 'x', attemptKind: 'verify' })).toBe(true);
    expect(isAttempt({ runId: 'x', attemptKind: null, meta: { repeat: { group: 'r', attempt: 1, of: 2 } } })).toBe(false);
    expect(isAttempt({ runId: 'x', attemptKind: 'nonsense' })).toBe(false);
    // A row that carries neither says nothing makes it an attempt.
    expect(isAttempt({ runId: 'x' })).toBe(false);
  });
});

describe('counting runs and attempts', () => {
  it('bundles an attempt only under a run that is there, a test’s only under the result it names', () => {
    const rec = run(undefined, { runId: REC, parentRunId: null, mode: 'record' });
    const probe = run({ probe: { of: REC, callNo: 5, passed: false }, repeat: { group: 'g', attempt: 1, of: 2 } });
    const orphan = run({ repeat: { group: 'r', attempt: 1, of: 2 } }, { parentRunId: '01GONE0000000000000000000' });
    const head = run({ test: { golden: 'goldens/refund', session: 's1' } }, { parentRunId: REC });
    const filed = run({ test: { golden: 'goldens/refund', session: 's1', attempt: 2, of: head.runId } }, { parentRunId: REC });
    // Names a test run of another golden: listed as a run of its own, never hidden under it.
    const misfiled = run({ test: { golden: 'goldens/other', session: 's1', attempt: 2, of: head.runId } }, { parentRunId: REC });
    expect(countAttempts([rec, probe, orphan, head, filed, misfiled])).toEqual({ runs: 4, attempts: 2 });
  });

  it('counts the fork blame rescued a run with as a run', () => {
    const fork = run({ probe: { of: REC, callNo: 5, passed: true }, repeat: { group: 'g', attempt: 1, of: 1 } }, { divergence: { callNo: 5, type: 'forced' } });
    const rec = run({ blame: { at: 1, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: fork.runId, fields: {}, oracle: [], probes: [], spent: 0 } }, { runId: REC, parentRunId: null, mode: 'record' });
    expect(countAttempts([rec, fork])).toEqual({ runs: 2, attempts: 0 });
  });
});
