import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateResult, Store, type DiffEntry } from '@shadowlap/engine';
import { goldenSteps, type NextStepWork } from '../src/next-step.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * What each golden that didn't pass leads Tests with (next-step.ts `goldenSteps`, which GET /api/tests
 * asks beside the server): its replay's own step, as the run's page leads with it, and Run more
 * attempts for a gate that ran out of them, which only Tests runs.
 */

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const GOLDEN = 'goldens/refund-in-limit';
const UUID_CHANGE: DiffEntry = { path: '$.metadata.user_id', op: 'changed', before: '3f1c9a2e-5b7d-4e21-9c0a-8d6f2b1e7a43', after: 'b84e07d1-2c9f-4a63-8e15-6f0d3a9c2b78' };

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const source = (runId: string): GoldenSource => ({ path: GOLDEN, runId, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] });
const work = (goldens: GoldenSource[]): NextStepWork => ({ goldens, tests: undefined, normalize: undefined, dir: '/work/project' });

/** A session of the golden at `at`, with its replay of `parent` and its result. */
function tested(parent: string, at: number, result: { ok: boolean; failure?: 'diverged' | 'inconclusive'; data?: Record<string, unknown> }, diff?: DiffEntry[]): void {
  const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision: 'bbbbbbb' }).sessionId;
  const run = addRun(store, { parent, startedAt: at, calls: 'r', ...(result.ok ? {} : { status: 'failed' as const }), meta: { test: { golden: GOLDEN, session } } });
  if (diff) store.setDivergence(run, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff });
  store.addTestResult({ sessionId: session, golden: GOLDEN, ok: result.ok, ...(result.failure ? { failure: result.failure } : {}), runId: run, goldenRunId: parent, revision: 'bbbbbbb', at, ...(result.data ? { data: result.data } : {}) });
}

describe('a golden’s step on Tests', () => {
  it('leads a golden that didn’t pass as its replay’s page does, and one that passed or never ran with none', () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    tested(rec, T0 + MIN, { ok: false, failure: 'diverged' }, [UUID_CHANGE]);
    expect(goldenSteps(store, [GOLDEN, 'goldens/never-run'], work([source(rec)]))).toEqual({ [GOLDEN]: expect.objectContaining({ key: 'normalizer', label: 'Add normalizer and re-run', golden: GOLDEN }) });
    tested(rec, T0 + 2 * MIN, { ok: true });
    expect(goldenSteps(store, [GOLDEN], work([source(rec)]))).toEqual({});
  });

  it('runs more attempts of a gate that ran out of them between its bounds', () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    const gate = gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 3 }, [true, false, true], { decision: 'inconclusive' });
    tested(rec, T0 + MIN, { ok: false, failure: 'inconclusive', data: { verdict: 'inconclusive', gate } });
    expect(goldenSteps(store, [GOLDEN], work([source(rec)]))).toEqual({ [GOLDEN]: { key: 'more-attempts', label: 'Run more attempts', golden: GOLDEN, command: `shadowlap test ${GOLDEN} --max-attempts 6 --continue` } });
  });
});
