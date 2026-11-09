import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type StoredCheck, type TestFailure, type TestResult } from '@shadowlap/engine';
import { checksStep } from '../src/check-steps.js';
import { goldenSteps, nextStepOf, type NextStepWork } from '../src/next-step.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * The steps a golden's checks lead with (check-steps.ts): Run tests once its checks changed since its
 * last test, and Edit check for a check added since that its own recording fails, the same on Tests
 * and on its last test replay's page.
 */
const T0 = 1_790_000_000_000;
const MIN = 60_000;
const GOLDEN = 'goldens/refund-flow';
const failed = (label: string): StoredCheck => ({ status: 'failed', ok: false, label, detail: 'called 1 time' });
const passed = (label: string): StoredCheck => ({ status: 'passed', ok: true, label, detail: null });
const golden = (checks: string[], mode: 'replay' | 'fork' = 'replay') => ({ path: GOLDEN, mode, checks });
const result = (checks: StoredCheck[], o: { failure?: TestFailure; mode?: 'replay' | 'fork'; diverged?: boolean } = {}) =>
  ({ ok: !o.failure, ...(o.failure ? { failure: o.failure } : {}), runId: 'R', data: { mode: o.mode ?? 'replay', checks, ...(o.diverged ? { divergence: { type: 'request_changed', callNo: 1 } } : {}) } }) as unknown as TestResult;

describe('the step a golden’s checks lead with', () => {
  it('is Run tests once a check its last result failed or couldn’t decide left the config', () => {
    const latest = result([failed('issue_refund called 0 times'), passed('escalate called 1 time')], { failure: 'check' });
    expect(checksStep(golden(['escalate called 1 time']), [latest])).toEqual({ key: 'run-tests', golden: GOLDEN, gone: ['issue_refund called 0 times'] });
    // A check it passed that left changes nothing.
    expect(checksStep(golden(['issue_refund called 0 times']), [latest])).toBeNull();
  });

  it('is Edit check for a check added since its previous test that its own recording fails', () => {
    const before = result([passed('escalate called 1 time')]);
    const latest = result([passed('escalate called 1 time'), failed('send_email called 0 times')], { failure: 'check' });
    const now = golden(['escalate called 1 time', 'send_email called 0 times']);
    expect(checksStep(now, [latest, before])).toEqual({ key: 'edit-check', golden: GOLDEN, check: 'send_email called 0 times' });
    // Its previous test judged the check: the agent changed, and the failed check's steps lead.
    expect(checksStep(now, [latest, result([passed('escalate called 1 time'), passed('send_email called 0 times')])])).toBeNull();
    // No previous test, a golden marked fork, a replay that diverged or forked: what fails may not be the recording.
    expect(checksStep(now, [latest])).toBeNull();
    expect(checksStep(golden(now.checks, 'fork'), [latest, before])).toBeNull();
    expect(checksStep(now, [result(latest.data!.checks!, { failure: 'check', diverged: true }), before])).toBeNull();
    expect(checksStep(now, [result(latest.data!.checks!, { failure: 'check', mode: 'fork' }), before])).toBeNull();
    // Failed by its exit, not the check.
    expect(checksStep(now, [result(latest.data!.checks!, { failure: 'exit' }), before])).toBeNull();
  });

  it('leads with Run tests before Edit check, a session judging every check again', () => {
    const before = result([failed('issue_refund called 0 times')], { failure: 'check' });
    const latest = result([failed('issue_refund called 0 times'), failed('send_email called 0 times')], { failure: 'check' });
    expect(checksStep(golden(['send_email called 0 times']), [latest, before])).toMatchObject({ key: 'run-tests', gone: ['issue_refund called 0 times'] });
  });
});

describe('the step on Tests and on the test replay’s page', () => {
  let store: Store;
  beforeEach(() => {
    store = Store.open(':memory:');
  });
  afterEach(() => store.close());

  const source = (checks: string[]): GoldenSource => ({ path: GOLDEN, runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks });
  const work = (checks: string[]): NextStepWork => ({ goldens: [source(checks)], tests: undefined, normalize: undefined, dir: '/work/project' });
  function tested(at: number, checks: StoredCheck[]): string {
    const failure = checks.some((c) => c.status === 'failed') ? ('check' as const) : undefined;
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: at, revision: 'bbbbbbb' }).sessionId;
    const run = addRun(store, { startedAt: at, ...(failure ? { status: 'failed' as const } : {}), calls: 'r', meta: { test: { golden: GOLDEN, session } } });
    store.addTestResult({ sessionId: session, golden: GOLDEN, ok: !failure, ...(failure ? { failure } : {}), reason: failure ? 'check failed' : null, runId: run, revision: 'bbbbbbb', at, data: { mode: 'replay', checks } });
    return run;
  }

  it('is Run tests for a golden whose checks changed since, on Tests and on its last test replay alone', () => {
    const older = tested(T0, [failed('issue_refund called 0 times')]);
    const last = tested(T0 + MIN, [failed('issue_refund called 0 times')]);
    const steps = goldenSteps(store, [GOLDEN], work(['escalate called 1 time']));
    expect(steps[GOLDEN]).toMatchObject({ key: 'run-tests', label: 'Run tests', gone: ['issue_refund called 0 times'], sub: 'Its checks changed since its last test: the session judges them as they are now', command: "shadowlap test 'goldens/*'" });
    expect(nextStepOf(store, last, work(['escalate called 1 time']))).toMatchObject({ key: 'run-tests', sub: 'Its checks changed since this test: the session judges them as they are now' });
    expect(nextStepOf(store, older, work(['escalate called 1 time']))!.key).not.toBe('run-tests');
  });

  it('is Edit check for a check added since that the recording fails, and nothing once a session judged it passing', () => {
    tested(T0, [passed('escalate called 1 time')]);
    const last = tested(T0 + MIN, [passed('escalate called 1 time'), failed('send_email called 0 times')]);
    const now = work(['escalate called 1 time', 'send_email called 0 times']);
    expect(goldenSteps(store, [GOLDEN], now)[GOLDEN]).toMatchObject({ key: 'edit-check', label: 'Edit check…', check: 'send_email called 0 times', sub: 'It fails refund-flow’s own recording: edit the check, or update the golden if the agent should now do this' });
    expect(nextStepOf(store, last, now)).toMatchObject({ key: 'edit-check', check: 'send_email called 0 times' });
    // The check edited to one the recording meets, and a session judged it: nothing leads.
    tested(T0 + 2 * MIN, [passed('escalate called 1 time'), passed('send_email called at most 1 time')]);
    expect(goldenSteps(store, [GOLDEN], work(['escalate called 1 time', 'send_email called at most 1 time']))[GOLDEN]).toBeUndefined();
  });
});
