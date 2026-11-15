import { describe, expect, it } from 'vitest';
import { Store, type ChaosResultData } from '@shadowlap/engine';
import { chaosMatrices, chaosOfGolden } from '../src/chaos.js';

/**
 * Each attempt of an error-path preset, as the dashboard's presets matrix gives it, carries its own
 * verdict: an attempt that said nothing of the agent's error path (its replay never reached the
 * call, or only a check no attempt can decide kept it from passing) is inconclusive, never failed,
 * as the preset it ended is. A result kept before attempts had a verdict reads as it was decided.
 */

const UNDECIDED = 'check inconclusive: judge "ok" answers yes, but not judged: no recorded verdict and no key for openai (OPENAI_API_KEY)';
const NEVER = 'the replay never reached #3, so the preset was never played in';

describe("an error-path preset's attempts on the dashboard", () => {
  it('carry their own verdict, inconclusive apart from failed, whether kept with one or before', () => {
    const store = Store.open(':memory:');
    try {
      store.startChaosSession({ sessionId: 'S1', startedAt: 1, command: ['shadowlap', 'test', 'goldens/a', '--chaos'], presets: ['timeout', 'empty', 'malformed', 'oversized', '429', '500'] });
      const add = (preset: string, verdict: 'passed' | 'failed' | 'inconclusive', passes: number, data: ChaosResultData) =>
        store.addChaosResult({ sessionId: 'S1', runId: 'G', golden: 'goldens/a', preset, verdict, callNo: 3, passes, attempts: data.runs?.length ?? 0, at: 2, data });
      // Kept with a verdict: a judge no attempt can ask held its one attempt back.
      add('timeout', 'inconclusive', 0, { reason: UNDECIDED, runs: [{ runId: 'A1', verdict: 'inconclusive', passed: false, exitCode: 0, reason: UNDECIDED }] });
      // Kept with verdicts: the second attempt's replay left the recording before the call.
      add('empty', 'inconclusive', 1, { reason: NEVER, runs: [{ runId: 'A2', verdict: 'passed', passed: true, exitCode: 0 }, { runId: 'A3', verdict: 'inconclusive', passed: false, exitCode: 1, reason: NEVER }] });
      // Kept before attempts had a verdict: the last attempt of a preset inconclusive for a reason of its own.
      add('malformed', 'inconclusive', 0, { reason: NEVER, runs: [{ runId: 'A4', passed: false, exitCode: 0, reason: NEVER }] });
      // Kept before, by a gate that ran out of attempts between its bounds (no reason kept): each attempt passed or failed.
      add('oversized', 'inconclusive', 1, { reason: null, runs: [{ runId: 'A5', passed: true, exitCode: 0 }, { runId: 'A6', passed: false, exitCode: 1, reason: 'the agent exited with code 1' }] });
      // Kept before: a failed preset's attempt failed.
      add('429', 'failed', 0, { reason: 'the agent exited with code 1', runs: [{ runId: 'A7', passed: false, exitCode: 1, reason: 'the agent exited with code 1' }] });
      add('500', 'passed', 1, { runs: [{ runId: 'A8', verdict: 'passed', passed: true, exitCode: 0 }] });

      const m = chaosOfGolden(store, 'goldens/a')!;
      expect(m.cells.map((c) => [c.preset, c.verdict, c.runs.map((r) => `${r.runId} ${r.verdict}`)])).toEqual([
        ['timeout', 'inconclusive', ['A1 inconclusive']],
        ['empty', 'inconclusive', ['A2 passed', 'A3 inconclusive']],
        ['malformed', 'inconclusive', ['A4 inconclusive']],
        ['oversized', 'inconclusive', ['A5 passed', 'A6 failed']],
        ['429', 'failed', ['A7 failed']],
        ['500', 'passed', ['A8 passed']],
      ]);
      expect(m.counts).toEqual({ passed: 1, failed: 1, inconclusive: 4, notApplicable: 0 });
      // Every read of the matrices, Tests' and Needs a look's, has the same cells.
      expect(chaosMatrices(store)).toEqual([m]);
    } finally {
      store.close();
    }
  });
});
