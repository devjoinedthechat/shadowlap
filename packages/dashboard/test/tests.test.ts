import { describe, expect, it } from 'vitest';
import { NO_COMMAND, recordEvent, Store, type TestResultData } from '@shadowlap/engine';
import { bisectChoices, bisectJob, checkedRevision, failingTests, normalizeAndTestJob, overviewTests, runTestsJob, testRunBanner, testsSummary, testsView, updateGoldensJob, type GoldenSource } from '../src/tests.js';

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
  it('leads with the verdict, naming the first failure', () => {
    const store = sampleStore();
    const view = testsView(store, goldens);
    expect(view.empty).toBe(false);
    expect(view.verdict).toMatchObject({
      state: 'failing',
      failing: 1,
      passing: 2,
      untested: 0,
      title: 'refund-in-limit diverged at call 1',
      first: { golden: 'goldens/refund-in-limit', name: 'refund-in-limit', reason: 'diverged at call 1 (api POST /v1/messages)', runId: 'R_C_LIMIT' },
      session: { command: 'shadowlap test goldens/*', revision: 'd2e8a1f', startedAt: T0, passed: 2, failed: 1, upstreamRequests: 0, actor: 'ci' },
    });
    store.close();
  });

  it('counts every golden by its last result after a session that ran only one of them', () => {
    const store = sampleStore();
    // Run tests on one golden, as Add normalizer and re-run or a per-golden Run tests does.
    session(store, 'e3f9b20', T0 + DAY, [{ golden: 'goldens/refund-flow', ok: true, runId: 'R_D_FLOW' }]);
    const view = testsView(store, goldens);
    // refund-in-limit still fails: its last result is the one from the full session.
    expect(view.verdict).toMatchObject({ state: 'failing', failing: 1, passing: 2, untested: 0, title: 'refund-in-limit diverged at call 1', first: { golden: 'goldens/refund-in-limit' } });
    // The line under it is the newest session's: its command, revision and time.
    expect(view.verdict!.session).toMatchObject({ revision: 'e3f9b20', passed: 1, failed: 0 });
    expect(view.rows.map((r) => r.last.result)).toEqual(['pass', 'fail', 'pass']);
    // Once it passes too, all of them do.
    session(store, 'e3f9b20', T0 + 2 * DAY, [{ golden: 'goldens/refund-in-limit', ok: true, runId: 'R_E_LIMIT' }]);
    expect(testsView(store, goldens).verdict).toMatchObject({ state: 'passing', failing: 0, passing: 3, title: 'All 3 goldens pass', first: null });
    // A golden added since has not run yet, and the verdict says so rather than "all pass".
    const more = [...goldens, { path: 'goldens/new-one', runId: null, packedAt: T0, mode: 'replay' as const, repeat: 1, passes: 1, checks: [] }];
    expect(testsView(store, more).verdict).toMatchObject({ state: 'passing', passing: 3, untested: 1, title: '3 of 4 goldens pass, 1 not run yet' });
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
    // Add normalizer and re-run: the rule, then the golden again.
    expect(d!.normalizeAndTest).toEqual([d!.volatile!.args, ['test', 'goldens/refund-in-limit']]);
    expect(d!.bisect).toEqual({ good: 'c91d0f4', bad: 'd2e8a1f', args: ['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4', '--bad', 'd2e8a1f'], live: false });
    expect(d!.found).toBeNull();
    expect(view.failures).toEqual([]);
    // Once Find the commit has run, its answer shows above the buttons.
    recordEvent(store, { kind: 'bisect.found', ref: 'goldens/refund-in-limit', at: T0 + 60_000, data: { good: 'c91d0f4', bad: 'd2e8a1f', first: { rev: '4e7b2d1', subject: 'Send the user id with every request', author: 'Ravi', date: '2026-09-30T10:00:00+02:00' }, why: 'diverged at call 1 (api POST /v1/messages) · $.metadata.user_id', replays: 4, tokens: 0, upstreamRequests: 0 } });
    expect(testsView(store, goldens).divergences[0]!.found).toEqual({ rev: '4e7b2d1', subject: 'Send the user id with every request', author: 'Ravi', date: '2026-09-30T10:00:00+02:00', why: 'diverged at call 1 (api POST /v1/messages) · $.metadata.user_id', untested: [], replays: 4, tokens: 0, at: T0 + 60_000 });
    expect(view.commands).toEqual({ ci: 'shadowlap test goldens/* --junit report.xml', inCi: 'shadowlap test goldens/* --junit report.xml --markdown "$GITHUB_STEP_SUMMARY"', pack: 'shadowlap pack <run> goldens/<name>', run: ['test', 'goldens/*'], updateAll: ['test', 'goldens/refund-in-limit', '--update'] });
    store.close();
  });

  it('trusts what was judged on the whole divergence over the cut-down diff it kept', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    // 13 changes: 12 request ids kept, the 13th (a prompt change) cut off.
    const ids = Array.from({ length: 12 }, (_, i) => ({ path: `$.messages[${i}].metadata.request_id`, op: 'changed', before: `req_${i}a1b2`, after: `req_${i}c3d4` }));
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', data: { divergence: { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: ids, entries: 13, volatile: { values: [{ path: ids[0]!.path, looks: 'an id', op: 'changed', normalizer: { kind: 'api', path: ids[0]!.path, replace: '<ID>' } }], explainsAll: false }, text: '✗ Diverged at call 1' } } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const [d] = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }]).divergences;
    expect(d!.normalizerFixes).toBe(false);
    expect(d!.volatile).toMatchObject({ looks: 'an id', args: ['normalize', 'add', '--kind', 'api', '--path', '$.messages[0].metadata.request_id', '--replace', '<ID>'] });
    // The rule alone can't make it match (the prompt changed too): the golden is updated after it.
    expect(d!.normalizeAndTest).toEqual([d!.volatile!.args, ['test', 'goldens/x', '--update']]);
    store.close();
  });

  it('adds a rule for each value that changes every run before re-running, and bisects from a revision tested as committed', () => {
    const store = Store.open(':memory:');
    const day = (n: number, revision: string, ok: boolean, data?: TestResultData) => {
      const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision, startedAt: T0 + n * DAY });
      store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok, ...(ok ? {} : { failure: 'diverged' as const, reason: 'diverged at call 1 (api POST /v1/messages)' }), revision, at: T0 + n * DAY + 1, ...(data ? { data } : {}) });
      store.finishTestSession(s.sessionId, { passed: ok ? 1 : 0, failed: ok ? 0 : 1, upstreamRequests: 0, endedAt: T0 + n * DAY + 2 });
    };
    day(0, 'aaa1111', true);
    day(1, 'bbb2222+dirty', true);
    const diff = [
      { path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B },
      { path: '$.metadata.sent_at', op: 'changed', before: '2026-09-20T10:00:00Z', after: '2026-09-21T11:30:00Z' },
    ];
    day(2, 'ccc3333', false, { divergence: { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff, text: '✗ Diverged at call 1' } });
    const [d] = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }]).divergences;
    expect(d!.normalizerFixes).toBe(true);
    expect(d!.normalizeAndTest!.map((step) => step.slice(0, 6))).toEqual([
      ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id'],
      ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.sent_at'],
      ['test', 'goldens/x'],
    ]);
    // The passing session at bbb2222 had uncommitted changes; aaa1111 passed as committed.
    expect(d!.bisect).toEqual({ good: 'aaa1111', bad: 'ccc3333', args: ['bisect', 'goldens/x', '--good', 'aaa1111', '--bad', 'ccc3333'], live: false });
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

  it('runs the goldens the config names outside the goldens folder too', () => {
    const store = Store.open(':memory:');
    const pack = (path: string): GoldenSource => ({ path, runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] });
    const both = testsView(store, [pack('goldens/a'), pack('goldens/b'), pack('packs/budget'), pack('goldens/team/c')]).commands;
    expect(both.run).toEqual(['test', 'goldens/*', 'packs/budget', 'goldens/team/c']);
    expect(both.ci).toBe('shadowlap test goldens/* packs/budget goldens/team/c --junit report.xml');
    const elsewhere = testsView(store, [pack('my packs/budget')], { folder: 'recordings' }).commands;
    expect(elsewhere.run).toEqual(['test', 'my packs/budget']);
    expect(elsewhere.inCi).toBe(`shadowlap test 'my packs/budget' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY"`);
    expect(elsewhere.pack).toBe('shadowlap pack <run> recordings/<name>');
    expect(testsView(store, []).commands.run).toEqual(['test', 'goldens/*']);
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
    const pack = (path: string): GoldenSource => ({ path, runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] });
    const view = testsView(store, [pack('goldens/a'), pack('goldens/b')]);
    expect(view.verdict).toMatchObject({ state: 'passing', failing: 0, passing: 2, untested: 0, title: 'All 2 goldens pass', first: null });
    expect(view.commands.updateAll).toBeNull();
    expect(testsView(store, [pack('goldens/a')]).verdict!.title).toBe('The golden passes');
    // Results of goldens that are gone say nothing about the ones on disk, which have not run.
    const other = testsView(store, goldens.slice(0, 1));
    expect(other.verdict).toBeNull();
    expect(other.rows[0]!.last).toEqual({ result: null, failure: null, line: 'not run yet', at: null, updated: false });
    store.close();
  });

  it('adds the rule and then updates the golden when the request gained a field with a per-run value', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', data: { divergence: { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.metadata', op: 'added', after: { user_id: UUID_B } }], text: '✗ Diverged at call 1' } } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const [d] = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }]).divergences;
    // The recording never had the field: masking can't make the replay match, so the golden is re-recorded after the rule.
    expect(d!.volatile).toMatchObject({ path: '$.metadata.user_id', op: 'added' });
    expect(d!.normalizerFixes).toBe(false);
    expect(d!.normalizeAndTest).toEqual([['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/x', '--update']]);
    store.close();
  });

  it('bisects from where the recording that fails now passed, and says when the search costs tokens', () => {
    const store = Store.open(':memory:');
    const day = (n: number, revision: string, ok: boolean, goldenRunId: string) => {
      const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision, startedAt: T0 + n * DAY });
      store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok, ...(ok ? {} : { failure: 'check' as const, reason: 'check failed: escalate called 1 time, but called 0 times' }), revision, goldenRunId, at: T0 + n * DAY + 1 });
      store.finishTestSession(s.sessionId, { passed: ok ? 1 : 0, failed: ok ? 0 : 1, upstreamRequests: 0, endedAt: T0 + n * DAY + 2 });
    };
    day(0, 'aaa1111', true, 'REC_1');
    // Updated at bbb2222: the new recording passes there, and the old one passed later still, at ccc3333.
    day(1, 'bbb2222', true, 'REC_2');
    day(2, 'ccc3333', true, 'REC_1');
    day(3, 'ddd4444', false, 'REC_2');
    const fork: GoldenSource = { path: 'goldens/x', runId: null, packedAt: null, mode: 'fork', repeat: 1, passes: 1, checks: ['escalate called 1 time'] };
    const [f] = testsView(store, [fork]).failures;
    expect(f!.bisect).toEqual({ good: 'bbb2222', bad: 'ddd4444', args: ['bisect', 'goldens/x', '--good', 'bbb2222', '--bad', 'ddd4444'], live: true });
    store.close();
  });
});

describe('tests on the Overview and in Needs a look', () => {
  it('counts goldens passing, the regressions caught, when they last ran, and the same a week before', () => {
    const store = sampleStore();
    expect(testsSummary(store, { goldens, now: T0 + DAY })).toEqual({ empty: false, total: 3, passing: 2, failing: 1, untested: 0, line: '1 regression caught', lastRunAt: T0 + 100, lastWeek: { passing: 1, total: 1 } });
    expect(testsSummary(store, { goldens: ['goldens/refund-flow', 'goldens/new'], now: T0 + DAY })).toMatchObject({ total: 2, passing: 1, failing: 0, untested: 1, line: 'no regressions' });
    expect(testsSummary(Store.open(':memory:'), { goldens: [] })).toMatchObject({ empty: true, total: 0, line: 'no goldens yet', lastRunAt: null, lastWeek: null });
    // The Overview's outcome strip compares with when its week started.
    expect(overviewTests(store, { now: T0 + DAY, weekStart: T0 - DAY }, { goldens })).toEqual({ goldens: 3, passing: 2, lastWeek: 2, regressions: 1, lastRunAt: T0 + 100 });
    expect(overviewTests(store, { now: T0 + DAY, weekStart: T0 - 3 * DAY }, { goldens })).toMatchObject({ lastWeek: 1 });
    expect(overviewTests(Store.open(':memory:'), { now: T0, weekStart: T0 - DAY }, { goldens: [] })).toBeNull();
    store.close();
  });

  it('stops counting a golden once it is deleted or renamed', () => {
    const store = sampleStore();
    // refund-in-limit, whose last result failed, is gone from disk: it is no regression any more.
    const left = goldens.filter((g) => g.path !== 'goldens/refund-in-limit');
    expect(testsSummary(store, { goldens: left, now: T0 + DAY })).toMatchObject({ total: 2, passing: 2, failing: 0, line: 'no regressions' });
    expect(failingTests(store, { goldens: left })).toEqual([]);
    expect(overviewTests(store, { now: T0 + DAY, weekStart: T0 - DAY }, { goldens: left })).toMatchObject({ goldens: 2, regressions: 0 });
    store.close();
  });

  it('lists failing tests with why, linking to the failing run', () => {
    const store = sampleStore();
    expect(failingTests(store, { goldens })).toEqual([{ golden: 'goldens/refund-in-limit', title: 'A test failed: refund-in-limit', line: 'diverged at call 1 · $.metadata.user_id looks like a UUID', failure: 'diverged', runId: 'R_C_LIMIT', href: '#/run/R_C_LIMIT', at: T0 + 2 }]);
    store.deleteRun('R_C_LIMIT');
    expect(failingTests(store, { goldens: goldens.map((g) => g.path) })[0]).toMatchObject({ runId: null, href: '#/tests' });
    store.close();
  });
});

describe('the diverged-test banner on a run', () => {
  it('names the golden a test replay came from, and the normalizer that fixes its divergence', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'] });
    const replay = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { test: { golden: 'goldens/refund-in-limit', session: s.sessionId } } });
    store.setDivergence(replay.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B }] });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-in-limit', ok: false, failure: 'diverged', runId: replay.runId });
    // A golden that may fork diverges by design; its replay gets no banner.
    const fork = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { test: { golden: 'goldens/refund-over-limit', session: s.sessionId } } });
    store.setDivergence(fork.runId, { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2 });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-over-limit', ok: true, runId: fork.runId });
    expect(testRunBanner(store, fork.runId)).toBeNull();
    expect(testRunBanner(store, replay.runId)).toEqual({
      golden: 'goldens/refund-in-limit',
      session: s.sessionId,
      volatile: { path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', normalizer: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }, args: ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], command: "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'" },
      normalizerFixes: true,
      values: { values: [{ path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', normalizer: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' } }], explainsAll: true },
      rerun: ['test', 'goldens/refund-in-limit'],
      update: ['test', 'goldens/refund-in-limit', '--update'],
      normalizeAndTest: [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-in-limit']],
    });
    const recording = store.createRun({ mode: 'record', command: { argv: ['node'], cwd: '/p' } });
    expect(testRunBanner(store, recording.runId)).toBeNull();
    expect(testRunBanner(store, 'nope')).toBeNull();
    store.close();
  });
});

describe('Find the commit from a run', () => {
  const agent = ['node', 'agent.mjs'];
  function history(store: Store) {
    const make = (codeVersion: string, startedAt: number, status: 'completed' | 'failed', meta?: Parameters<Store['createRun']>[0]['meta']) => {
      const r = store.createRun({ mode: 'record', command: { argv: agent, cwd: '/p' }, codeVersion, startedAt, ...(meta ? { meta } : {}) });
      store.endRun(r.runId, status, startedAt + 1);
      return r.runId;
    };
    make('aaa1111', T0, 'completed');
    make('bbb2222', T0 + DAY, 'completed');
    make('bbb2222', T0 + DAY + 1, 'failed');
    make('ccc3333+dirty', T0 + 2 * DAY, 'completed');
    make('ddd4444', T0 + 3 * DAY, 'failed');
    return { failed: make('eee5555', T0 + 4 * DAY, 'failed'), passed: make('eee5555', T0 + 4 * DAY + 5, 'completed'), make };
  }

  it('offers the newest earlier commit where the command still worked, and forks a run that failed on its own', () => {
    const store = Store.open(':memory:');
    const { failed, passed } = history(store);
    const c = bisectChoices(store, failed, { goldens: [] })!;
    expect(c).toMatchObject({ target: { kind: 'run', runId: failed }, failed: true, good: 'bbb2222', bad: 'eee5555', fork: true, live: true, unavailable: null, args: ['bisect', failed, '--good', 'bbb2222', '--bad', 'eee5555', '--fork'] });
    // Uncommitted revisions can't be checked out; each revision says how its runs went.
    expect(c.revisions).toEqual([
      { rev: 'ddd4444', at: T0 + 3 * DAY, runs: 1, failed: 1 },
      { rev: 'bbb2222', at: T0 + DAY + 1, runs: 2, failed: 1 },
      { rev: 'aaa1111', at: T0, runs: 1, failed: 0 },
    ]);
    // The calendar's days: only commits from before the first day picked.
    expect(bisectChoices(store, failed, { goldens: [], before: T0 + DAY })!.good).toBe('aaa1111');
    // A run that passed is the good end; bisect looks up to HEAD for what changed it.
    expect(bisectChoices(store, passed, { goldens: [] })).toMatchObject({ failed: false, good: 'eee5555', bad: null, fork: false, live: false, args: ['bisect', passed, '--good', 'eee5555'] });
    expect(bisectChoices(store, 'NOPE', { goldens: [] })).toBeNull();
    store.close();
  });

  it('says why it can\'t start from a run still recording, a capture, or a failed check it doesn\'t know', () => {
    const store = Store.open(':memory:');
    history(store);
    const recording = store.createRun({ mode: 'record', command: { argv: agent, cwd: '/p' }, codeVersion: 'fff6666', startedAt: T0 + 5 * DAY });
    expect(bisectChoices(store, recording.runId, { goldens: [] })).toMatchObject({ unavailable: 'this run is still recording', args: null });
    expect(bisectJob(store, [], { runId: recording.runId, good: 'aaa1111' })).toEqual({ error: 'this run is still recording' });
    // A capture records what was sent, not what sent it.
    const capture = store.createRun({ mode: 'record', command: { argv: [NO_COMMAND], cwd: '/p' }, codeVersion: 'fff6666', startedAt: T0 + 5 * DAY });
    store.endRun(capture.runId, 'failed', T0 + 5 * DAY + 1);
    expect(bisectChoices(store, capture.runId, { goldens: [] })!.unavailable).toMatch(/^this run was imported from a capture, so there is no command to run at each commit: replay it once with your agent \(shadowlap replay \w+ -- <command>\)/);
    // A replay that exited 0 but failed a check, of a golden no longer on disk or in the config: no check to judge each commit by.
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/gone'] });
    const checked = store.createRun({ mode: 'replay', command: { argv: agent, cwd: '/p' }, codeVersion: 'fff6666', startedAt: T0 + 5 * DAY, meta: { test: { golden: 'goldens/gone', session: s.sessionId }, checks: [{ ok: false, label: 'escalate called 1 time', detail: 'called 0 times' }] } });
    store.endRun(checked.runId, 'completed', T0 + 5 * DAY + 1);
    const unknown = bisectChoices(store, checked.runId, { goldens: [] })!;
    expect(unknown).toMatchObject({ target: { kind: 'run' }, failed: true, fork: true, args: null });
    expect(unknown.unavailable).toBe(`this run failed a check that bisect can't know: give it on the command line, shadowlap bisect ${checked.runId} --good <commit> --expect '<checks>' --fork`);
    expect(bisectJob(store, [], { runId: checked.runId, good: 'aaa1111' })).toEqual({ error: unknown.unavailable });
    // With the config still naming its golden and checks (its pack gone), bisect takes them from there.
    const named: GoldenSource = { path: 'goldens/gone', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: ['escalate called 1 time'], error: 'no run.json: not a pack' };
    expect(bisectChoices(store, checked.runId, { goldens: [named] })).toMatchObject({ target: { kind: 'run', runId: checked.runId }, unavailable: null, args: ['bisect', checked.runId, '--good', 'eee5555', '--bad', 'fff6666', '--fork'] });
    expect(bisectJob(store, [named], { golden: 'goldens/gone', good: 'aaa1111' })).toEqual({ error: "goldens/gone can't be read: no run.json: not a pack" });
    store.close();
  });

  it('bisects the golden a test replay came from, while that golden is on disk', () => {
    const store = sampleStore();
    const s = store.listTestSessions()[0]!;
    const replay = store.createRun({ mode: 'replay', command: { argv: agent, cwd: '/p' }, codeVersion: 'd2e8a1f', meta: { test: { golden: 'goldens/refund-in-limit', session: s.sessionId } } });
    store.endRun(replay.runId, 'completed');
    store.setDivergence(replay.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0 });
    expect(bisectChoices(store, replay.runId, { goldens })).toMatchObject({ target: { kind: 'golden', golden: 'goldens/refund-in-limit' }, failed: true, good: 'c91d0f4', bad: 'd2e8a1f', fork: false, live: false, revisions: [{ rev: 'c91d0f4', runs: 1, failed: 0 }], args: ['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4', '--bad', 'd2e8a1f'] });
    // Once the golden is gone, the replay is bisected as the run it is.
    expect(bisectChoices(store, replay.runId, { goldens: [] })!.target).toEqual({ kind: 'run', runId: replay.runId });
    store.close();
  });

  it('offers where the recording that failed last passed, and says a golden that may fork costs tokens', () => {
    const store = Store.open(':memory:');
    const at = (n: number, revision: string, ok: boolean, goldenRunId: string, golden = 'goldens/f') => {
      const s = store.startTestSession({ command: ['shadowlap', 'test', golden], revision, startedAt: T0 + n * DAY });
      const replay = store.createRun({ mode: 'replay', command: { argv: agent, cwd: '/p' }, codeVersion: revision, startedAt: T0 + n * DAY, meta: { test: { golden, session: s.sessionId } } });
      store.endRun(replay.runId, 'completed', T0 + n * DAY + 1);
      store.addTestResult({ sessionId: s.sessionId, golden, ok, ...(ok ? {} : { failure: 'check' as const }), revision, goldenRunId, runId: replay.runId, at: T0 + n * DAY + 1 });
      store.finishTestSession(s.sessionId, { passed: ok ? 1 : 0, failed: ok ? 0 : 1, upstreamRequests: 0, endedAt: T0 + n * DAY + 2 });
      return replay.runId;
    };
    at(0, 'aaa1111', true, 'REC_1');
    at(1, 'bbb2222', true, 'REC_2');
    at(2, 'ccc3333', true, 'REC_1');
    const failing = at(3, 'ddd4444', false, 'REC_2');
    const fork: GoldenSource = { path: 'goldens/f', runId: 'REC_2', packedAt: null, mode: 'fork', repeat: 3, passes: 3, checks: ['escalate called 1 time'] };
    expect(bisectChoices(store, failing, { goldens: [fork] })).toMatchObject({ target: { kind: 'golden', golden: 'goldens/f' }, good: 'bbb2222', bad: 'ddd4444', fork: false, live: true, args: ['bisect', 'goldens/f', '--good', 'bbb2222', '--bad', 'ddd4444'] });
    store.close();
  });
});

describe('jobs for the Tests actions', () => {
  it('runs every golden, or the one named, and nothing the browser makes up', () => {
    expect(runTestsJob(goldens, {})).toEqual({ title: 'Running the tests', args: ['test', 'goldens/*'] });
    expect(runTestsJob(goldens, { golden: 'goldens/refund-flow' })).toEqual({ title: 'Running the tests', args: ['test', 'goldens/refund-flow'] });
    for (const golden of ['goldens/../../etc', '--update', 'goldens/*', 42]) expect(runTestsJob(goldens, { golden })).toHaveProperty('error');
    expect(runTestsJob([], {})).toEqual({ error: 'no goldens yet: pack a run you consider correct into goldens/ first' });
  });

  it('updates the goldens named, each once', () => {
    expect(updateGoldensJob(goldens, { goldens: ['goldens/refund-in-limit', 'goldens/refund-flow', 'goldens/refund-in-limit'] })).toEqual({ title: 'Updating goldens', args: ['test', 'goldens/refund-in-limit', 'goldens/refund-flow', '--update'] });
    expect(updateGoldensJob(goldens, { golden: 'goldens/refund-in-limit' })).toEqual({ title: 'Updating a golden', args: ['test', 'goldens/refund-in-limit', '--update'] });
    expect(updateGoldensJob(goldens, { goldens: ['goldens/refund-flow', '--online'] })).toEqual({ error: 'no such golden: --online' });
    expect(updateGoldensJob(goldens, { goldens: [] })).toHaveProperty('error');
  });

  it('adds the normalizer the stored divergence names, then re-runs the golden', () => {
    const store = sampleStore();
    const job = normalizeAndTestJob(store, goldens, { golden: 'goldens/refund-in-limit' });
    expect(job).toEqual({ title: 'Adding a normalizer', steps: [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-in-limit']], runId: 'R_C_LIMIT' });
    expect(normalizeAndTestJob(store, goldens, { golden: 'goldens/refund-in-limit', path: '$.metadata.other' })).toEqual({ error: 'no value that changes every run diverged at that path' });
    expect(normalizeAndTestJob(store, goldens, { golden: 'goldens/refund-flow' })).toEqual({ error: 'goldens/refund-flow did not diverge the last time it ran' });
    expect(normalizeAndTestJob(store, goldens, { golden: 'goldens/nope' })).toHaveProperty('error');
    expect(normalizeAndTestJob(store, goldens, { runId: 'R_C_FLOW' })).toEqual({ error: 'that run is not a replay of a golden that diverged' });
    store.close();
  });

  it('starts the diverged-test banner\'s Add normalizer from the replay on its page', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'] });
    const replay = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { test: { golden: 'goldens/refund-in-limit', session: s.sessionId } } });
    store.setDivergence(replay.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.system', op: 'changed', before: 'a', after: 'b' }] });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-in-limit', ok: false, failure: 'diverged', runId: replay.runId });
    expect(normalizeAndTestJob(store, goldens, { runId: replay.runId })).toEqual({ error: 'goldens/refund-in-limit diverged on more than values that change every run: if the change was intended, update the golden' });
    store.setDivergence(replay.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B }] });
    expect(normalizeAndTestJob(store, goldens, { runId: replay.runId })).toMatchObject({ title: 'Adding a normalizer', steps: [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-in-limit']], runId: replay.runId });
    expect(normalizeAndTestJob(store, [], { runId: replay.runId })).toEqual({ error: 'goldens/refund-in-limit is no longer a golden on disk' });
    // Two values that change every run: one rule alone leaves the other diverging, so the golden is updated after it.
    store.setDivergence(replay.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B }, { path: '$.metadata.trace_id', op: 'changed', before: UUID_B, after: UUID_A }] });
    expect(normalizeAndTestJob(store, goldens, { runId: replay.runId })).toMatchObject({ title: 'Adding a normalizer', steps: [expect.arrayContaining(['$.metadata.user_id']), expect.arrayContaining(['$.metadata.trace_id']), ['test', 'goldens/refund-in-limit']] });
    expect(normalizeAndTestJob(store, goldens, { runId: replay.runId, path: '$.metadata.trace_id' })).toMatchObject({ title: 'Adding a normalizer and updating the golden', steps: [expect.arrayContaining(['$.metadata.trace_id']), ['test', 'goldens/refund-in-limit', '--update']] });
    store.close();
  });

  it('finds the commit for a golden or a run, from revisions that look like ones', () => {
    const store = sampleStore();
    expect(bisectJob(store, goldens, { golden: 'goldens/refund-in-limit', good: 'c91d0f4', bad: 'd2e8a1f' })).toEqual({ title: 'Finding the commit', args: ['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4', '--bad', 'd2e8a1f'] });
    expect(bisectJob(store, goldens, { golden: 'goldens/refund-in-limit', good: 'v1.2.0' })).toEqual({ title: 'Finding the commit', args: ['bisect', 'goldens/refund-in-limit', '--good', 'v1.2.0'] });
    for (const good of ['--output=x', '-x', 'a..b', 'a b', '', null, 7]) expect(bisectJob(store, goldens, { golden: 'goldens/refund-in-limit', good }), String(good)).toEqual({ error: 'name a commit where it still worked' });
    expect(bisectJob(store, goldens, { golden: 'goldens/refund-in-limit', good: 'c91d0f4', bad: '--exec=x' })).toEqual({ error: 'that is not a commit' });
    expect(bisectJob(store, goldens, { golden: 'elsewhere/x', good: 'c91d0f4' })).toHaveProperty('error');
    expect(checkedRevision('abc1234+dirty')).toBe('abc1234');
    expect(checkedRevision('HEAD~3')).toBe('HEAD~3');
    const failed = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, codeVersion: 'fff6666' });
    store.endRun(failed.runId, 'failed');
    expect(bisectJob(store, goldens, { runId: failed.runId, good: 'c91d0f4' })).toEqual({ title: 'Finding the commit', args: ['bisect', failed.runId, '--good', 'c91d0f4', '--bad', 'fff6666', '--fork'], runId: failed.runId });
    expect(bisectJob(store, goldens, { runId: failed.runId, good: 'fff6666' })).toEqual({ error: 'fff6666 is where it fails: choose an earlier commit where it still worked' });
    expect(bisectJob(store, goldens, { runId: 'not-a-run', good: 'c91d0f4' })).toEqual({ error: 'no such run' });
    store.close();
  });
});
