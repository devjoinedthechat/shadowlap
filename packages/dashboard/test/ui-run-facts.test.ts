import { describe, expect, it } from 'vitest';
import { attemptOutcome } from '../ui/run/banner.js';
import { outcomeFact } from '../ui/run/metrics.js';
import type { PresetAttempt } from '../ui/run/preset.js';
import type { RunLike } from '../ui/runs.js';

/**
 * A run's first fact says how it came out, the words the chip beside its id said before it went: an
 * attempt's verdict, a preset's, a rescued fork's. An attempt with no checks of its own would read `no
 * checks` otherwise.
 */

const FORK: RunLike = { runId: '01K8RG00000000000000000002', parentRunId: '01K8RG00000000000000000001', mode: 'replay', status: 'completed', divergence: { type: 'request_changed', callNo: 5, kind: 'api', name: 'POST /v1/messages', replayedBefore: 4 } as never, command: 'node agent.mjs', codeVersion: null, startedAt: 0, calls: 6, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], kind: 'fork', outcome: { kind: 'none' }, failed: false };
const PRESET: PresetAttempt = { label: 'tool timeout', golden: 'goldens/list-inbox', callNo: 2, target: 'list_inbox', verdict: 'failed', attempt: 1, of: 1, played: 'list_inbox (#2) timed out', outcome: 'the agent exited with code 1 (TimeoutError)', exitCode: 1 };
const fact = (o: Parameters<typeof outcomeFact>[1]) => {
  const f = outcomeFact(FORK, o);
  return [f.tone, f.words, f.tip?.title ?? null, f.tip?.sub ?? null];
};

describe('a run’s first fact', () => {
  it('says passed for a rescued fork and an attempt that passed, with no card', () => {
    expect(fact({ tools: 1, rescued: true })).toEqual(['ok', 'passed', null, null]);
    expect(fact({ tools: 1, attempt: attemptOutcome({ status: 'completed', checks: [] }, { verdict: 'passed' }) })).toEqual(['ok', 'passed', null, null]);
  });

  it('says a preset’s verdict: its exit, or check failed, with why under it, and inconclusive', () => {
    expect(fact({ tools: 1, preset: PRESET })).toEqual(['err', 'exited 1', 'Exited 1', PRESET.outcome]);
    expect(fact({ tools: 1, preset: { ...PRESET, exitCode: 0 } })).toEqual(['err', 'check failed', 'Check failed', PRESET.outcome]);
    expect(fact({ tools: 1, preset: { ...PRESET, verdict: 'inconclusive' } })).toEqual(['warn', 'inconclusive', 'Inconclusive', PRESET.outcome]);
    expect(fact({ tools: 1, preset: { ...PRESET, verdict: 'passed' } })).toEqual(['ok', 'passed', null, null]);
  });

  it('says an attempt that stopped is interrupted, muted, one that failed failed, and one blame couldn’t decide inconclusive', () => {
    expect(fact({ tools: 1, attempt: { tone: 'n', text: 'interrupted' } })).toEqual(['mu', 'interrupted', 'Stopped before it ended', null]);
    expect(fact({ tools: 1, attempt: { tone: 'no', text: 'failed' } })).toEqual(['err', 'failed', 'Failed', null]);
    expect(fact({ tools: 1, attempt: { tone: 'inc', text: 'inconclusive', why: 'send_email called 1 time' } })).toEqual(['warn', 'inconclusive', 'Inconclusive', 'send_email called 1 time']);
    // A run that is no attempt keeps its own words.
    expect(fact({ tools: 1 })[1]).toBe('no checks');
  });
});
