import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type StoredCheck } from '@shadowlap/engine';
import { nextStepOf, pageSteps, type NextStepWork } from '../src/next-step.js';
import { listRunsPage } from '../src/runs-list.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * A failed test replay a later replay of its golden passed, whatever way it failed: Runs' Status names
 * the run that passed (`fixed by <run>`), and the run's page leads with Open passing run to that same
 * run, as both read one rule (runs-filter.ts `fixedBy`).
 */

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const GOLDEN = 'goldens/refund-in-limit';
const CHECK: StoredCheck = { status: 'failed', ok: false, label: 'every issue_refund call: amount <= 100', detail: 'issue_refund #1: amount 240' };

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const work = (goldens: GoldenSource[]): NextStepWork => ({ goldens, tests: undefined, normalize: undefined, dir: '/work/project' });

/** A replay of the golden in a session of its own, with its result: passed, or ran to its end and failed a check. */
function tested(parent: string, at: number, ok: boolean): string {
  const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision: 'bbbbbbb' }).sessionId;
  const run = addRun(store, { parent, startedAt: at, calls: 'rr', meta: { test: { golden: GOLDEN, session }, ...(ok ? {} : { checks: [CHECK] }) } });
  store.addTestResult({ sessionId: session, golden: GOLDEN, ok, ...(ok ? {} : { failure: 'check' as const, reason: `check failed: ${CHECK.label}` }), runId: run, goldenRunId: parent, revision: 'bbbbbbb', at });
  return run;
}

describe('a failed test replay its golden passed since', () => {
  it('leads its page with the run Runs says fixed it, one that failed a check as one that diverged or crashed', async () => {
    const rec = addRun(store, { startedAt: T0, calls: 'll' });
    const failed = tested(rec, T0 + MIN, false);
    const passed = tested(rec, T0 + 2 * MIN, true);
    expect(listRunsPage(store, { limit: 50 }).runs.find((r) => r.runId === failed)).toMatchObject({ outcome: { kind: 'check-failed' }, failed: false, fixedBy: passed });
    const source: GoldenSource = { path: GOLDEN, runId: rec, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] };
    const { next } = await pageSteps(store, failed, work([source]), { judged: undefined, kept: () => true });
    expect(next).toMatchObject({ key: 'passing', label: 'Open passing run', runId: passed, href: `#/run/${passed}` });
    // Runs reads no golden on disk, and neither does the step.
    expect(nextStepOf(store, failed, work([]))).toMatchObject({ key: 'passing', runId: passed });
  });
});
