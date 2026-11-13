import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKey, gateResult, Store, type DiffEntry } from '@shadowlap/engine';
import { goldenSteps, pricedNextStep, type NextStepWork } from '../src/next-step.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * What each golden that didn't pass leads Tests with (next-step.ts `goldenSteps`, which GET /api/tests
 * asks beside the server): its replay's own step, as the run's page leads with it, Run more
 * attempts for a gate that ran out of them, which only Tests runs, and Re-run test for an injection
 * gate that showed too little to say. A failed injection gate's Open proof is in injection-routes.
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
function tested(parent: string, at: number, result: { ok: boolean; failure?: 'diverged' | 'inconclusive' | 'injection'; data?: Record<string, unknown> }, diff?: DiffEntry[]): void {
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

  it('leads a replay that failed a check with the open fix of that check, which no fix holds yet, and with none once that fix is applied', async () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    const check = { tools: { send_email: { max: 0 } } };
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + MIN, revision: 'bbbbbbb' }).sessionId;
    const run = addRun(store, { parent: rec, startedAt: T0 + MIN, calls: 'r', status: 'failed', meta: { test: { golden: GOLDEN, session }, checks: [{ label: 'send_email called 0 times', ok: false, status: 'failed', detail: 'called 1 time' }] } });
    store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'check', runId: run, goldenRunId: rec, revision: 'bbbbbbb', at: T0 + MIN });
    const w = { ...work([source(rec)]), tests: { [GOLDEN]: { expect: check } } };
    expect(goldenSteps(store, [GOLDEN], w)[GOLDEN]?.key).not.toBe('fix');
    const fixId = 'fx-01K8RG00000000000000000009';
    store.insertFix({ fixId, title: 'Emails sent on refunds', labels: [], check: { expect: check, key: checkKey(check), oracle: [], text: 'send_email called 0 times' }, status: 'open', openedAt: T0, verifiedAt: null, appliedAt: null, data: {} });
    expect(goldenSteps(store, [GOLDEN], w)[GOLDEN]).toMatchObject({ key: 'fix', label: 'Open fix', fixId, href: `#/fixes/${fixId}` });
    // Its own page leads the replay with that fix too, as the run page's step table says.
    await expect(pricedNextStep(store, run, w, { kept: () => true })).resolves.toMatchObject({ key: 'fix', label: 'Open fix', fixId });
    store.updateFix(fixId, { status: 'applied', appliedAt: T0 + 2 * MIN });
    expect(goldenSteps(store, [GOLDEN], w)[GOLDEN]?.key).not.toBe('fix');
  });

  it('runs a golden and its injection gate again where the gate showed too little to say, though its replay passed', () => {
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    const gate = { resultId: 'inj-01PLANT', attempts: 2, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 2, allowed: { obeyed: 0, influenced: null }, verdict: 'inconclusive', reason: 'no model read it', skipped: null };
    tested(rec, T0 + MIN, { ok: false, failure: 'injection', data: { mode: 'replay', injection: gate } });
    expect(goldenSteps(store, [GOLDEN], work([source(rec)]))).toEqual({ [GOLDEN]: { key: 'gate-again', label: 'Re-run test', golden: GOLDEN, command: `shadowlap test ${GOLDEN}`, sub: 'Its injection gate showed too little to say: no model read it' } });
    // One with no reason says that no attempt decided.
    tested(rec, T0 + 2 * MIN, { ok: false, failure: 'injection', data: { mode: 'replay', injection: { ...gate, attempts: 0, inconclusive: 0, reason: null } } });
    expect(goldenSteps(store, [GOLDEN], work([source(rec)]))[GOLDEN]).toMatchObject({ key: 'gate-again', sub: 'Its injection gate showed too little to say: no attempt decided' });
  });
});
