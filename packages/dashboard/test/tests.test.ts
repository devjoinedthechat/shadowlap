import { describe, expect, it } from 'vitest';
import { recordEvent, Store, type TestResultData } from '@shadowlap/engine';
import { failingTests, testRunBanner, testsSummary, testsView, type GoldenSource } from '../src/tests.js';

/**
 * The Tests screen's read model over a store with three sessions at three revisions: one golden that
 * always passes, one that diverges at the last revision on a per-run UUID, and one that forks and
 * failed a check once.
 */
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 20, 10, 0);
const UUID_A = '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f';
const UUID_B = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const goldens: GoldenSource[] = [
  { path: 'goldens/refund-flow', runId: 'GOLDEN_FLOW', packedAt: T0 - DAY, mode: 'replay', repeat: 1, passes: 1, checks: ['issue_refund called 1 time'] },
  { path: 'goldens/refund-in-limit', runId: 'GOLDEN_LIMIT', packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] },
  { path: 'goldens/refund-over-limit', runId: 'GOLDEN_OVER', packedAt: T0, mode: 'fork', repeat: 5, passes: 5, checks: ['issue_refund called 0 times', 'escalate called 1 time'] },
];

function run(store: Store, runId: string, imported = false) {
  store.createRun({ runId, mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, ...(imported ? { meta: { imported: { at: T0, from: 'x' } } } : {}) });
}

function session(store: Store, revision: string, at: number, results: Array<{ golden: string; ok: boolean; failure?: 'diverged' | 'check'; reason?: string; runId: string; data?: TestResultData }>) {
  const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision, actor: 'ci', startedAt: at });
  results.forEach((r, i) => store.addTestResult({ sessionId: s.sessionId, golden: r.golden, ok: r.ok, ...(r.failure ? { failure: r.failure } : {}), reason: r.reason ?? null, runId: r.runId, revision, at: at + i + 1, data: r.data ?? { mode: 'replay', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 } } }));
  store.finishTestSession(s.sessionId, { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, upstreamRequests: 0, endedAt: at + 100 });
  return s;
}

function sampleStore(): Store {
  const store = Store.open(':memory:');
  run(store, 'GOLDEN_FLOW'); // recorded here, then packed
  run(store, 'GOLDEN_LIMIT', true); // only known from its pack
  for (const id of ['R_C_FLOW', 'R_C_LIMIT', 'R_C_OVER']) run(store, id);
  const forkData = (passed: number): TestResultData => ({ mode: 'fork', checks: [{ ok: passed === 5, label: 'issue_refund called 0 times', detail: passed === 5 ? null : 'called 1 time' }, { ok: true, label: 'escalate called 1 time', detail: null }], attempts: { total: 5, passed, required: 5, runs: [] } });
  session(store, '5e1a9d3', T0 - 9 * DAY, [{ golden: 'goldens/refund-flow', ok: true, runId: 'R_A_FLOW' }]);
  session(store, 'c91d0f4', T0 - 2 * DAY, [
    { golden: 'goldens/refund-flow', ok: true, runId: 'R_B_FLOW' },
    { golden: 'goldens/refund-in-limit', ok: true, runId: 'R_B_LIMIT' },
    { golden: 'goldens/refund-over-limit', ok: false, failure: 'check', reason: '4 of 5 attempts passed, 5 needed. Attempt 2: check failed: issue_refund called 0 times, but called 1 time', runId: 'R_B_OVER', data: forkData(4) },
  ]);
  session(store, 'd2e8a1f', T0, [
    { golden: 'goldens/refund-flow', ok: true, runId: 'R_C_FLOW', data: { mode: 'replay', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 }, checks: [{ ok: true, label: 'issue_refund called 1 time', detail: null }], updated: { from: 'OLD', to: 'GOLDEN_FLOW', calls: 8 } } },
    {
      golden: 'goldens/refund-in-limit',
      ok: false,
      failure: 'diverged',
      reason: 'diverged at call 1 (api POST /v1/messages)',
      runId: 'R_C_LIMIT',
      data: {
        mode: 'replay',
        divergence: {
          type: 'request_changed',
          callNo: 1,
          kind: 'api',
          name: 'POST /v1/messages',
          replayedBefore: 0,
          diff: [{ path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B }],
          text: `✗ Diverged at call 1 (api POST /v1/messages): 0 calls replayed before divergence\n  ~ $.metadata.user_id\n      - "${UUID_A}"\n      + "${UUID_B}"`,
        },
      },
    },
    { golden: 'goldens/refund-over-limit', ok: true, runId: 'R_C_OVER', data: forkData(5) },
  ]);
  return store;
}

describe('the Tests screen', () => {
  it('leads with the last session\'s verdict, naming the first failure', () => {
    const store = sampleStore();
    const view = testsView(store, goldens);
    expect(view.empty).toBe(false);
    expect(view.verdict).toMatchObject({
      state: 'failing',
      failing: 1,
      title: 'refund-in-limit diverged at call 1',
      first: { golden: 'goldens/refund-in-limit', name: 'refund-in-limit', reason: 'diverged at call 1 (api POST /v1/messages)', runId: 'R_C_LIMIT' },
      session: { command: 'shadowlap test goldens/*', revision: 'd2e8a1f', startedAt: T0, passed: 2, failed: 1, upstreamRequests: 0, actor: 'ci' },
    });
    store.close();
  });

  it('lists each golden with where it came from, its mode, its checks and its result at each revision', () => {
    const store = sampleStore();
    const view = testsView(store, goldens);
    expect(view.revisions).toEqual(['5e1a9d3', 'c91d0f4', 'd2e8a1f']);
    const [flow, limit, over] = view.rows;
    expect(flow).toMatchObject({ name: 'refund-flow', source: { kind: 'run', runId: 'GOLDEN_FLOW' }, modeLabel: 'replay', modeHint: 'must send exactly the requests it recorded', last: { result: 'pass', line: 'updated · 8/8 replayed · check passed', updated: true }, runId: 'R_C_FLOW' });
    expect(flow!.history.map((h) => h.result)).toEqual(['pass', 'pass', 'pass']);
    expect(flow!.history.map((h) => h.updated)).toEqual([false, false, true]);
    // A pack made elsewhere, never tested at the first revision; its failing run is the one to open.
    expect(limit).toMatchObject({ source: { kind: 'pack', packedAt: T0 }, last: { result: 'fail', failure: 'diverged', line: 'diverged at call 1 · $.metadata.user_id looks like a UUID' }, runId: 'R_C_LIMIT' });
    expect(limit!.history.map((h) => h.result)).toEqual([null, 'pass', 'fail']);
    expect(limit!.history[2]!.note).toBe('diverged at call 1 · $.metadata.user_id looks like a UUID');
    expect(over).toMatchObject({ modeLabel: 'fork ×5', modeHint: 'allowed to fork; passes on its checks, 5 of 5 attempts', checks: ['issue_refund called 0 times', 'escalate called 1 time'], last: { line: '5 of 5 attempts passed both checks' } });
    expect(over!.history[1]).toMatchObject({ result: 'fail', note: '4 of 5 attempts passed, 5 needed. Attempt 2: check failed: issue_refund called 0 times, but called 1 time', runId: null });
    store.close();
  });

  it('prints each divergence as the CLI does, with the normalizer that fixes it and the commit range to bisect', () => {
    const store = sampleStore();
    const view = testsView(store, goldens);
    expect(view.diverged).toEqual(['goldens/refund-in-limit']);
    const [d] = view.divergences;
    expect(d!.text).toBe(`✗ refund-in-limit: diverged at call 1 (api POST /v1/messages)\n    ✗ Diverged at call 1 (api POST /v1/messages): 0 calls replayed before divergence\n      ~ $.metadata.user_id\n          - "${UUID_A}"\n          + "${UUID_B}"`);
    expect(d!.volatile).toMatchObject({ path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', command: "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'", args: ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'] });
    expect(d!.normalizerFixes).toBe(true);
    expect(d!.rerun).toEqual(['test', 'goldens/refund-in-limit']);
    expect(d!.update).toEqual(['test', 'goldens/refund-in-limit', '--update']);
    expect(d!.bisect).toEqual({ good: 'c91d0f4', bad: 'd2e8a1f', args: ['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4', '--bad', 'd2e8a1f'] });
    expect(d!.found).toBeNull();
    expect(view.failures).toEqual([]);
    // Once Find the commit has run, its answer shows above the buttons.
    recordEvent(store, { kind: 'bisect.found', ref: 'goldens/refund-in-limit', at: T0 + 60_000, data: { good: 'c91d0f4', bad: 'd2e8a1f', first: { rev: '4e7b2d1', subject: 'Send the user id with every request', author: 'Ravi', date: '2026-09-30T10:00:00+02:00' }, why: 'diverged at call 1 (api POST /v1/messages) · $.metadata.user_id', replays: 4, tokens: 0, upstreamRequests: 0 } });
    expect(testsView(store, goldens).divergences[0]!.found).toEqual({ rev: '4e7b2d1', subject: 'Send the user id with every request', author: 'Ravi', date: '2026-09-30T10:00:00+02:00', why: 'diverged at call 1 (api POST /v1/messages) · $.metadata.user_id', replays: 4, tokens: 0, at: T0 + 60_000 });
    expect(view.commands).toEqual({ ci: 'shadowlap test goldens/* --junit report.xml', inCi: 'shadowlap test goldens/* --junit report.xml --markdown "$GITHUB_STEP_SUMMARY"', pack: 'shadowlap pack <run> goldens/<name>', run: ['test', 'goldens/*'], updateAll: ['test', 'goldens/refund-in-limit', '--update'] });
    store.close();
  });

  it('shows a failed check as test --markdown prints it, without the normalizer', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234+dirty' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'check', reason: 'check failed: send_email called 0 times, but called 1 time', revision: 'abc1234+dirty', data: { checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }], details: '✗ send_email called 0 times: called 1 time' } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const view = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: ['send_email called 0 times'] }]);
    expect(view.verdict!.title).toBe('x check failed: send_email called 0 times');
    expect(view.divergences).toEqual([]);
    expect(view.failures).toEqual([{ golden: 'goldens/x', name: 'x', runId: null, failure: 'check', reason: 'check failed: send_email called 0 times, but called 1 time', checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }], details: '✗ send_email called 0 times: called 1 time', bisect: null, found: null }]);
    expect(view.revisions).toEqual(['abc1234+dirty']);
    store.close();
  });

  it('has an empty state, and says all goldens pass when they do', () => {
    const store = Store.open(':memory:');
    const empty = testsView(store, []);
    expect(empty).toMatchObject({ empty: true, goldens: 0, verdict: null, rows: [], revisions: [] });
    expect(empty.note).toContain('__recordings__/');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'abc1234' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/a', ok: true });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/b', ok: true });
    store.finishTestSession(s.sessionId, { passed: 2, failed: 0, upstreamRequests: 0 });
    const view = testsView(store, goldens.slice(0, 1));
    expect(view.verdict).toMatchObject({ state: 'passing', failing: 0, title: 'All 2 goldens pass', first: null });
    expect(view.rows[0]!.last).toEqual({ result: null, failure: null, line: 'not run yet', at: null, updated: false });
    expect(view.commands.updateAll).toBeNull();
    store.close();
  });
});

describe('tests on the Overview and in Needs a look', () => {
  it('counts goldens passing, the regressions caught, when they last ran, and the same a week before', () => {
    const store = sampleStore();
    expect(testsSummary(store, { now: T0 + DAY })).toEqual({ empty: false, total: 3, passing: 2, failing: 1, untested: 0, line: '1 regression caught', lastRunAt: T0 + 100, lastWeek: { passing: 1, total: 1 } });
    expect(testsSummary(store, { goldens: ['goldens/refund-flow', 'goldens/new'], now: T0 + DAY })).toMatchObject({ total: 2, passing: 1, failing: 0, untested: 1, line: 'no regressions' });
    expect(testsSummary(Store.open(':memory:'))).toMatchObject({ empty: true, total: 0, line: 'no goldens yet', lastRunAt: null, lastWeek: null });
    store.close();
  });

  it('lists failing tests with why, linking to the failing run', () => {
    const store = sampleStore();
    expect(failingTests(store)).toEqual([{ golden: 'goldens/refund-in-limit', title: 'A test failed: refund-in-limit', line: 'diverged at call 1 · $.metadata.user_id looks like a UUID', failure: 'diverged', runId: 'R_C_LIMIT', href: '#/run/R_C_LIMIT', at: T0 + 2 }]);
    store.deleteRun('R_C_LIMIT');
    expect(failingTests(store)[0]).toMatchObject({ runId: null, href: '#/tests' });
    store.close();
  });
});

describe('the diverged-test banner on a run', () => {
  it('names the golden a test replay came from, and the normalizer that fixes its divergence', () => {
    const store = Store.open(':memory:');
    const replay = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { test: { golden: 'goldens/refund-in-limit', session: 'S1' } } });
    store.setDivergence(replay.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B }] });
    expect(testRunBanner(store, replay.runId)).toEqual({
      golden: 'goldens/refund-in-limit',
      session: 'S1',
      volatile: { path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', normalizer: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }, args: ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], command: "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'" },
      normalizerFixes: true,
      rerun: ['test', 'goldens/refund-in-limit'],
      update: ['test', 'goldens/refund-in-limit', '--update'],
    });
    const recording = store.createRun({ mode: 'record', command: { argv: ['node'], cwd: '/p' } });
    expect(testRunBanner(store, recording.runId)).toBeNull();
    expect(testRunBanner(store, 'nope')).toBeNull();
    store.close();
  });
});
