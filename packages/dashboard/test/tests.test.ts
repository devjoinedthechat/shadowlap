import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_COMMAND, gateResult, NO_COMMAND, recordBlame, recordEvent, Store, TEST_COMMAND, type TestResultData } from '@shadowlap/engine';
import { blameReport, EXPECT } from '../../engine/test/fix-fixtures.js';
import { asksForAll, bisectChoices, bisectJob, checkedRevision, failingTests, normalizeAndTestJob, overviewTests, resultLine, runTestsJob, testPatterns, testRunBanner, testsSummary, testsView, underChecks, updateGoldensJob, type GoldenSource } from '../src/tests.js';

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

function session(store: Store, revision: string, at: number, results: Array<{ golden: string; ok: boolean; failure?: 'diverged' | 'check'; reason?: string; runId: string; data?: TestResultData }>, command = ['shadowlap', 'test', 'goldens/*']) {
  const s = store.startTestSession({ command, revision, actor: 'ci', startedAt: at });
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
      title: '2 of 3 goldens passed · refund-in-limit diverged at call 1',
      first: { golden: 'goldens/refund-in-limit', name: 'refund-in-limit', reason: 'diverged at call 1 (api POST /v1/messages)', runId: 'R_C_LIMIT' },
      session: { command: 'shadowlap test goldens/*', revision: 'd2e8a1f', startedAt: T0, passed: 2, failed: 1, upstreamRequests: 0, actor: 'ci' },
    });
    store.close();
  });

  it('counts every golden by its last result after a session that ran only one of them', () => {
    const store = sampleStore();
    // Run tests on one golden, as Add normalizer and re-run or a per-golden Run tests does.
    session(store, 'e3f9b20', T0 + DAY, [{ golden: 'goldens/refund-flow', ok: true, runId: 'R_D_FLOW' }], ['shadowlap', 'test', 'goldens/refund-flow']);
    const view = testsView(store, goldens);
    // refund-in-limit still fails: its last result is the one from the full session.
    expect(view.verdict).toMatchObject({ state: 'failing', failing: 1, passing: 2, untested: 0, title: '2 of 3 goldens passed · refund-in-limit diverged at call 1', first: { golden: 'goldens/refund-in-limit' } });
    // The line under it is the newest session that ran them all, with its own counts; what ran since on its own is said apart.
    expect(view.verdict!.session).toMatchObject({ revision: 'd2e8a1f', command: 'shadowlap test goldens/*', passed: 2, failed: 1 });
    expect(view.verdict!.since).toEqual([{ golden: 'goldens/refund-flow', name: 'refund-flow', ok: true, verdict: 'passed', revision: 'e3f9b20', at: T0 + DAY + 1 }]);
    expect(view.rows.map((r) => r.last.result)).toEqual(['pass', 'fail', 'pass']);
    // It adds no column of dashes for the others: the history is the full sessions'.
    expect(view.revisions).toEqual(['5e1a9d3', 'c91d0f4', 'd2e8a1f']);
    // Once it passes too, all of them do.
    session(store, 'e3f9b20', T0 + 2 * DAY, [{ golden: 'goldens/refund-in-limit', ok: true, runId: 'R_E_LIMIT' }], ['shadowlap', 'test', 'goldens/refund-in-limit']);
    expect(testsView(store, goldens).verdict).toMatchObject({ state: 'passing', failing: 0, passing: 3, title: 'All 3 goldens pass', first: null, session: { revision: 'd2e8a1f' } });
    expect(testsView(store, goldens).verdict!.since.map((x) => [x.name, x.ok])).toEqual([
      ['refund-flow', true],
      ['refund-in-limit', true],
    ]);
    // A golden added since has not run yet, and the verdict says so rather than "all pass".
    const more = [...goldens, { path: 'goldens/new-one', runId: null, packedAt: T0, mode: 'replay' as const, repeat: 1, passes: 1, checks: [] }];
    expect(testsView(store, more).verdict).toMatchObject({ state: 'passing', passing: 3, untested: 1, title: '3 of 4 goldens passed · 1 golden not tested yet' });
    store.close();
  });

  it('counts a session that has not ended by the results it has, everywhere alike', () => {
    const store = sampleStore();
    // A session still running (or whose process was killed): one golden has finished, at a new revision.
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'f00ba47', startedAt: T0 + DAY });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-in-limit', ok: true, runId: 'R_F_LIMIT', revision: 'f00ba47', at: T0 + DAY + 10 });
    const view = testsView(store, goldens);
    // Its result counts in the verdict, the table and its history, and its own line counts what it has.
    // Its process is still there (this one), so it is running, wherever it was started.
    expect(view.verdict).toMatchObject({ state: 'passing', passing: 3, session: { id: s.sessionId, revision: 'f00ba47', endedAt: null, passed: 1, failed: 0, interrupted: false, live: true } });
    expect(view.revisions.at(-1)).toBe('f00ba47');
    expect(view.rows[1].history.at(-1)).toMatchObject({ revision: 'f00ba47', result: 'pass' });
    expect(view.rows[1].last.result).toBe('pass');
    expect(testsSummary(store, { goldens, now: T0 + DAY + 20 })).toMatchObject({ passing: 3, failing: 0, lastRunAt: T0 + DAY + 10 });
    expect(failingTests(store, { goldens })).toEqual([]);
    // Stopped by a signal, it ends with what finished, and says so.
    store.finishTestSession(s.sessionId, { passed: 1, failed: 0, upstreamRequests: 0, endedAt: T0 + DAY + 30, interrupted: true });
    expect(testsView(store, goldens).verdict!.session).toMatchObject({ endedAt: T0 + DAY + 30, passed: 1, interrupted: true });
    expect(testsSummary(store, { goldens }).lastRunAt).toBe(T0 + DAY + 30);
    // One that started and has no result yet, whose process is gone, changes nothing.
    const gone = { pid: 2_147_483_646, host: hostname() };
    store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'aaa0000', startedAt: T0 + 2 * DAY, owner: gone });
    expect(testsView(store, goldens).verdict!.session.id).toBe(s.sessionId);
    // One whose process runs, started in a terminal or from another dashboard, reads as running before its first result.
    const now = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'bbb0000', startedAt: T0 + 3 * DAY });
    expect(testsView(store, goldens).verdict!.session).toMatchObject({ id: now.sessionId, endedAt: null, passed: 0, failed: 0, live: true });
    store.close();
  });

  it('tells a session whose process was killed from one still running', () => {
    const store = sampleStore();
    const gone = { pid: 2_147_483_646, host: hostname() };
    const killed = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'f00ba47', startedAt: T0 + DAY, owner: gone });
    store.addTestResult({ sessionId: killed.sessionId, golden: 'goldens/refund-flow', ok: true, revision: 'f00ba47', at: T0 + DAY + 10 });
    expect(testsView(store, goldens).verdict!.session).toMatchObject({ id: killed.sessionId, endedAt: null, live: false });
    // A session from elsewhere names no process: it is not running here.
    const elsewhere = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'f00ba48', startedAt: T0 + 2 * DAY, owner: null });
    store.addTestResult({ sessionId: elsewhere.sessionId, golden: 'goldens/refund-flow', ok: true, revision: 'f00ba48', at: T0 + 2 * DAY + 10 });
    expect(store.testSessionOwner(elsewhere.sessionId)).toBeNull();
    expect(testsView(store, goldens).verdict!.session).toMatchObject({ id: elsewhere.sessionId, live: false });
    // Ended, a session names no process any more.
    const ran = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'f00ba49', startedAt: T0 + 3 * DAY });
    expect(store.testSessionOwner(ran.sessionId)).toMatchObject({ pid: process.pid });
    store.finishTestSession(ran.sessionId, { passed: 0, failed: 0, upstreamRequests: 0 });
    expect(store.testSessionOwner(ran.sessionId)).toBeNull();
    store.close();
  });

  it('shows a golden run again on its own in the column of the commit under it, and a full session stopped early as the one it was', () => {
    const store = sampleStore();
    // Add normalizer and re-run at d2e8a1f, with the rule in the working tree: its revision is d2e8a1f+dirty.
    session(store, 'd2e8a1f+dirty', T0 + DAY, [{ golden: 'goldens/refund-in-limit', ok: true, runId: 'R_D_LIMIT' }], ['shadowlap', 'test', 'goldens/refund-in-limit']);
    const view = testsView(store, goldens);
    expect(view.revisions).toEqual(['5e1a9d3', 'c91d0f4', 'd2e8a1f']);
    expect(view.rows[1].history.at(-1)).toMatchObject({ revision: 'd2e8a1f', tested: 'd2e8a1f+dirty', result: 'pass', runId: null });
    // The other goldens keep their own results there.
    expect(view.rows[0].history.at(-1)).toMatchObject({ revision: 'd2e8a1f', tested: 'd2e8a1f', result: 'pass' });
    // A session asked to run them all, stopped after one: still the line's, interrupted, with a column of its own.
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*', '--junit', 'report.xml'], revision: 'e3f9b20', startedAt: T0 + 2 * DAY });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-flow', ok: true, revision: 'e3f9b20', at: T0 + 2 * DAY + 1 });
    store.finishTestSession(s.sessionId, { passed: 1, failed: 0, upstreamRequests: 0, endedAt: T0 + 2 * DAY + 2, interrupted: true });
    const after = testsView(store, goldens);
    expect(after.verdict!.session).toMatchObject({ id: s.sessionId, interrupted: true, passed: 1, failed: 0 });
    expect(after.verdict!.since).toEqual([]);
    expect(after.revisions).toEqual(['5e1a9d3', 'c91d0f4', 'd2e8a1f', 'e3f9b20']);
    expect(after.rows[1].history.at(-1)).toMatchObject({ revision: 'e3f9b20', result: null });
    store.close();
  });

  it('lists each golden with where it came from, its mode, its checks and its result at each revision', () => {
    const store = sampleStore();
    const view = testsView(store, goldens);
    expect(view.revisions).toEqual(['5e1a9d3', 'c91d0f4', 'd2e8a1f']);
    const [flow, limit, over] = view.rows;
    expect(flow).toMatchObject({ name: 'refund-flow', source: { kind: 'run', runId: 'GOLDEN_FLOW' }, modeLabel: 'replay', modeHint: 'must send exactly the requests it recorded', last: { result: 'pass', line: 'updated at d2e8a1f · check passed', updated: true }, runId: 'R_C_FLOW' });
    expect(flow.history.map((h) => h.result)).toEqual(['pass', 'pass', 'pass']);
    expect(flow.history.map((h) => h.updated)).toEqual([false, false, true]);
    // A pack made elsewhere, never tested at the first revision; its failing run is the one to open.
    expect(limit).toMatchObject({ source: { kind: 'pack', packedAt: T0 }, last: { result: 'fail', failure: 'diverged', line: 'diverged at call 1 · $.metadata.user_id looks like a UUID' }, runId: 'R_C_LIMIT' });
    expect(limit.history.map((h) => h.result)).toEqual([null, 'pass', 'fail']);
    expect(limit.history[2].note).toBe('diverged at call 1 · $.metadata.user_id looks like a UUID');
    expect(over).toMatchObject({ modeLabel: 'fork ×5', modeHint: 'allowed to fork; passes on its checks, 5 of 5 attempts', checks: ['issue_refund called 0 times', 'escalate called 1 time'], last: { line: '5 of 5 attempts passed both checks' } });
    const attempts = (n: number) => resultLine({ sessionId: 's', golden: 'g', at: T0, revision: null, ok: true, failure: null, reason: null, runId: null, goldenRunId: null, data: { attempts: { total: 3, passed: 3, required: 3, runs: [] }, checks: Array.from({ length: n }, (_, i) => ({ ok: true, label: `check ${i}`, detail: null })) } }, []);
    expect([attempts(0), attempts(1), attempts(3)]).toEqual(['3 of 3 attempts passed', '3 of 3 attempts passed the check', '3 of 3 attempts passed all 3 checks']);
    // A count met before an attempt a check could not decide: that attempt is counted apart, never as one that failed.
    const met = resultLine({ sessionId: 's', golden: 'g', at: T0, revision: null, ok: true, failure: null, reason: null, runId: null, goldenRunId: null, data: { verdict: 'passed', attempts: { total: 2, passed: 1, required: 1, runs: [], inconclusive: 1 }, checks: [{ ok: true, label: 'check 0', detail: null }] } }, []);
    expect(met).toBe('1 of 2 attempts passed the check · 1 inconclusive');
    expect(over.history[1]).toMatchObject({ result: 'fail', note: '4 of 5 attempts passed, 5 needed. Attempt 2: check failed: issue_refund called 0 times, but called 1 time', runId: null });
    store.close();
  });

  it('prints each divergence as the CLI does, with the normalizer that fixes it and the commit range to bisect', () => {
    const store = sampleStore();
    const view = testsView(store, goldens);
    expect(view.diverged).toEqual(['goldens/refund-in-limit']);
    const [d] = view.divergences;
    expect(d.text).toBe(`✗ refund-in-limit: diverged at call 1 (api POST /v1/messages)\n    ✗ Diverged at call 1 (api POST /v1/messages): 0 calls replayed before divergence\n      ~ $.metadata.user_id\n          - "${UUID_A}"\n          + "${UUID_B}"`);
    expect(d.volatile).toMatchObject({ path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', command: "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'", args: ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'] });
    expect(d.normalizerFixes).toBe(true);
    expect(d.rerun).toEqual(['test', 'goldens/refund-in-limit']);
    expect(d.update).toEqual(['test', 'goldens/refund-in-limit', '--update']);
    // Add normalizer and re-run: the rule, then the golden again.
    expect(d.normalizeAndTest).toEqual([d.volatile!.args, ['test', 'goldens/refund-in-limit']]);
    expect(d.bisect).toEqual({ good: 'c91d0f4', bad: 'd2e8a1f', args: ['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4', '--bad', 'd2e8a1f'], live: false });
    expect(d.found).toBeNull();
    expect(view.failures).toEqual([]);
    // Once the config has its rule (added for this golden or another), a re-run is what is left.
    expect(d.rulesAdded).toBe(false);
    const rule = { replace: '<UUID>', pattern: 'uuid', path: '$.metadata.user_id', kind: 'api' as const };
    expect(testsView(store, goldens, { normalizers: [rule] }).divergences[0].rulesAdded).toBe(true);
    expect(testsView(store, goldens, { normalizers: [{ ...rule, replace: '<ID>' }] }).divergences[0].rulesAdded).toBe(false);
    // Once Find the commit has run, its answer shows above the buttons.
    recordEvent(store, { kind: 'bisect.found', ref: 'goldens/refund-in-limit', at: T0 + 60_000, data: { good: 'c91d0f4', bad: 'd2e8a1f', first: { rev: '4e7b2d1', subject: 'Send the user id with every request', author: 'Ravi', date: '2026-09-30T10:00:00+02:00' }, why: 'diverged at call 1 (api POST /v1/messages) · $.metadata.user_id', replays: 4, tokens: 0, upstreamRequests: 0 } });
    expect(testsView(store, goldens).divergences[0].found).toEqual({ rev: '4e7b2d1', subject: 'Send the user id with every request', author: 'Ravi', date: '2026-09-30T10:00:00+02:00', why: 'diverged at call 1 (api POST /v1/messages) · $.metadata.user_id', untested: [], replays: 4, tokens: 0, at: T0 + 60_000 });
    // One CI command, as docs/gating.md writes it: the pattern quoted for the CLI to expand, with the reports and annotations.
    expect(view.commands).toEqual({ ci: `shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`, pack: 'shadowlap pack <run> goldens/<name>', run: ['test', 'goldens/*'], updateAll: ['test', 'goldens/refund-in-limit', '--update'] });
    store.close();
  });

  it('trusts what was judged on the whole divergence over the cut-down diff it kept', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    // 13 changes: 12 request ids kept, the 13th (a prompt change) cut off.
    const ids = Array.from({ length: 12 }, (_, i) => ({ path: `$.messages[${i}].metadata.request_id`, op: 'changed', before: `req_${i}a1b2`, after: `req_${i}c3d4` }));
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', data: { divergence: { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: ids, entries: 13, volatile: { values: [{ path: ids[0].path, looks: 'an id', op: 'changed', normalizer: { kind: 'api', path: ids[0].path, replace: '<ID>' } }], explainsAll: false }, text: '✗ Diverged at call 1' } } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const [d] = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }]).divergences;
    expect(d.normalizerFixes).toBe(false);
    expect(d.volatile).toMatchObject({ looks: 'an id', args: ['normalize', 'add', '--kind', 'api', '--path', '$.messages[0].metadata.request_id', '--replace', '<ID>'] });
    // The rule alone can't make it match (the prompt changed too): the golden is updated after it.
    expect(d.normalizeAndTest).toEqual([d.volatile!.args, ['test', 'goldens/x', '--update']]);
    store.close();
  });

  it('shows a changed business id as maybe a real change, leading with neither the update nor the normalizer', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    const diff = [{ path: '$.args.order_id', op: 'changed', before: 'A-1042', after: 'A-1043' }];
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'diverged', reason: 'diverged at call 2 (tool issue_refund)', data: { divergence: { type: 'request_changed', callNo: 2, kind: 'tool', name: 'issue_refund', replayedBefore: 1, diff, text: '✗ Diverged at call 2' } } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const goldensX: GoldenSource[] = [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
    const view = testsView(store, goldensX);
    const [d] = view.divergences;
    expect(d).toMatchObject({ normalizerFixes: false, maybeReal: true, volatile: { path: '$.args.order_id', looks: 'an id', certain: false, command: "shadowlap normalize add --kind tool --name issue_refund --path '$.args.order_id' --replace '<ID>'" } });
    // Should the person say it changes every run, its rule alone makes the replay match: no update after it.
    expect(d.normalizeAndTest).toEqual([['normalize', 'add', '--kind', 'tool', '--name', 'issue_refund', '--path', '$.args.order_id', '--replace', '<ID>'], ['test', 'goldens/x']]);
    expect(view.rows[0].last.line).toBe('diverged at call 2 · $.args.order_id changed, an id that may be a real change');
    expect(view.commands.updateAll).toEqual(['test', 'goldens/x', '--update']);
    expect(normalizeAndTestJob(store, goldensX, { golden: 'goldens/x' })).toMatchObject({ title: 'Adding normalizer and re-running', steps: d.normalizeAndTest });
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
    expect(d.normalizerFixes).toBe(true);
    expect(d.normalizeAndTest!.map((step) => step.slice(0, 6))).toEqual([
      ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id'],
      ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.sent_at'],
      ['test', 'goldens/x'],
    ]);
    // The passing session at bbb2222 had uncommitted changes; aaa1111 passed as committed.
    expect(d.bisect).toEqual({ good: 'aaa1111', bad: 'ccc3333', args: ['bisect', 'goldens/x', '--good', 'aaa1111', '--bad', 'ccc3333'], live: false });
    store.close();
  });

  it('shows a failed check as test --markdown prints it, without the normalizer', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234+dirty' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'check', reason: 'check failed: send_email called 0 times, but called 1 time', revision: 'abc1234+dirty', data: { checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }], details: '✗ send_email called 0 times: called 1 time' } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const view = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: ['send_email called 0 times'] }]);
    expect(view.verdict!.title).toBe('0 of 1 golden passed · x check failed: send_email called 0 times');
    expect(view.divergences).toEqual([]);
    expect(view.failures).toEqual([{ golden: 'goldens/x', name: 'x', runId: null, failure: 'check', reason: 'check failed: send_email called 0 times, but called 1 time', checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }], details: '✗ send_email called 0 times: called 1 time', output: null, blocked: null, bisect: null, found: null, missed: null, revisions: [], unreadable: null }]);
    expect(view.revisions).toEqual(['abc1234+dirty']);
    store.close();
  });

  it('shows what the agent printed last when it exited with an error, as test --markdown does', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    const output = 'Traceback (most recent call last):\n  File "agent.py", line 12\nKeyError: \'refund\'';
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'exit', reason: 'the agent exited with code 1', revision: 'abc1234', data: { details: '30/30 calls replayed', output } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const view = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }]);
    expect(view.verdict!.title).toBe('0 of 1 golden passed · x exited with code 1');
    expect(view.failures).toMatchObject([{ failure: 'exit', reason: 'the agent exited with code 1', checks: null, details: '30/30 calls replayed', output, blocked: null }]);
    store.close();
  });

  it('names a connection the network guard blocked in the replay, in the failure and its lines', () => {
    const store = Store.open(':memory:');
    run(store, 'R_LIVE');
    // The sidecar keeps on the run what the guard saw bypass Shadowlap: a test blocks it, a recording only warns.
    store.updateRunMeta('R_LIVE', { notRecorded: { hosts: [{ target: 'hooks.example.com:443', count: 2, action: 'blocked' }, { target: 'metrics.example.com:443', count: 1, action: 'warned' }], tools: [] } });
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: 'R_LIVE', revision: 'abc1234', data: { details: '1/1 calls replayed' } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const x: GoldenSource = { path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] };
    const view = testsView(store, [x]);
    expect(view.failures).toMatchObject([{ failure: 'exit', runId: 'R_LIVE', blocked: ['hooks.example.com:443'] }]);
    expect(view.rows[0].last.line).toBe('blocked connection to hooks.example.com:443 · the agent exited with code 1');
    expect(view.rows[0].history[0].note).toBe('blocked connection to hooks.example.com:443 · the agent exited with code 1');
    expect(failingTests(store, { goldens: [x] })[0].line).toBe('blocked connection to hooks.example.com:443 · the agent exited with code 1');
    store.close();
  });

  it('names a blocked connection on a golden that passed because its agent caught the refusal', () => {
    const store = Store.open(':memory:');
    run(store, 'R_CAUGHT');
    store.updateRunMeta('R_CAUGHT', { notRecorded: { hosts: [{ target: '203.0.113.9:8080', count: 1, action: 'blocked' }], tools: [] } });
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: true, runId: 'R_CAUGHT', revision: 'abc1234', data: { mode: 'replay', calls: { total: 5, replayed: 5, live: 0, blocked: 0, stubbed: 0 } } });
    store.finishTestSession(s.sessionId, { passed: 1, failed: 0, upstreamRequests: 0 });
    const x: GoldenSource = { path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] };
    const view = testsView(store, [x]);
    expect(view.rows[0].last).toMatchObject({ result: 'pass', line: 'blocked connection to 203.0.113.9:8080 · 5/5 replayed' });
    expect(view.rows[0].history[0]).toMatchObject({ result: 'pass', note: 'blocked connection to 203.0.113.9:8080' });
    // It passed: no failure panel, and nothing in Needs a look.
    expect(view.failures).toEqual([]);
    expect(failingTests(store, { goldens: [x] })).toEqual([]);
    store.close();
  });

  it('reads a live call from what the agent printed when it died before the guard could report it', () => {
    const store = Store.open(':memory:');
    run(store, 'R_DIED');
    const output = [
      '[shadowlap] blocked an outbound connection to 127.0.0.1:62331: it bypasses Shadowlap (SHADOWLAP_GUARD=block). Wrap the call as a tool, or allow it with SHADOWLAP_GUARD_ALLOW=127.0.0.1:62331.',
      'TypeError: fetch failed',
      '  [cause]: Error: shadowlap: blocked outbound connection to 127.0.0.1:62331 (SHADOWLAP_GUARD=block)',
      'OSError: [Errno 1] shadowlap: blocked outbound connection to ::1:8443 (SHADOWLAP_GUARD=block)',
    ].join('\n');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: 'R_DIED', revision: 'abc1234', data: { details: 'the agent process exited with an error', output } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const view = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }]);
    expect(view.failures[0].blocked).toEqual(['127.0.0.1:62331', '::1:8443']);
    // A warning (a recording lets the connection through) is no live call a test refused.
    const warned = Store.open(':memory:');
    const w = warned.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    warned.addTestResult({ sessionId: w.sessionId, golden: 'goldens/x', ok: false, failure: 'exit', reason: 'the agent exited with code 1', revision: 'abc1234', data: { output: '[shadowlap] warning: outbound connection to 127.0.0.1:62331 bypasses Shadowlap and is not recorded' } });
    warned.finishTestSession(w.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    expect(testsView(warned, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }]).failures[0].blocked).toBeNull();
    warned.close();
    store.close();
  });

  it('keeps the ring where a golden was updated when a later session ran at the same revision', () => {
    const store = Store.open(':memory:');
    for (const id of ['R_UPD', 'R_AFTER']) run(store, id);
    const x: GoldenSource = { path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] };
    session(store, 'abc1234+dirty', T0, [{ golden: 'goldens/x', ok: true, runId: 'R_UPD', data: { mode: 'replay', calls: { total: 5, replayed: 5, live: 0, blocked: 0, stubbed: 0 }, updated: { from: 'OLD', to: 'NEW', calls: 5 } } }]);
    session(store, 'abc1234+dirty', T0 + 1000, [{ golden: 'goldens/x', ok: true, runId: 'R_AFTER' }]);
    const [row] = testsView(store, [x]).rows;
    // The newest result there opens, and the update made there keeps its ring.
    expect(row.history).toMatchObject([{ revision: 'abc1234+dirty', result: 'pass', updated: true, runId: 'R_AFTER' }]);
    expect(row.last).toMatchObject({ result: 'pass', updated: false, line: '8/8 replayed' });
    store.close();
  });

  it('never puts a golden whose path reads as an option on a command line', () => {
    const store = Store.open(':memory:');
    const pack = (path: string, error: string | null = null): GoldenSource => ({ path, runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [], error });
    // Keys under the config's `tests` are listed as goldens even when they are no pack.
    const list = [pack('goldens/a'), pack('--online', 'no run.json: not a pack'), pack('--writes'), pack('-x/y'), pack('evals/b')];
    expect(testPatterns(list)).toEqual(['goldens/*', 'evals/b']);
    const view = testsView(store, list);
    expect(view.commands.run).toEqual(['test', 'goldens/*', 'evals/b']);
    expect(view.commands.ci).toBe(`shadowlap test 'goldens/*' evals/b --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`);
    expect(view.rows.find((r) => r.path === '--writes')).toMatchObject({ error: 'its path starts with "-", which the CLI would read as an option: rename it under "tests" in shadowlap.config.json', last: { line: 'can\'t be read: its path starts with "-", which the CLI would read as an option: rename it under "tests" in shadowlap.config.json' } });
    expect(runTestsJob(list, {})).toEqual({ title: 'Running tests', args: ['test', 'goldens/*', 'evals/b'] });
    for (const golden of ['--online', '--writes', '-x/y']) {
      expect(runTestsJob(list, { golden }), golden).toHaveProperty('error');
      expect(updateGoldensJob(list, { goldens: ['goldens/a', golden] }), golden).toEqual({ error: `no such golden: ${golden}` });
      expect(bisectJob(store, list, { golden, good: 'c91d0f4' }), golden).toHaveProperty('error');
      expect(normalizeAndTestJob(store, list, { golden }), golden).toHaveProperty('error');
    }
    store.close();
  });

  it('runs the goldens the config names outside the goldens folder too', () => {
    const store = Store.open(':memory:');
    const pack = (path: string): GoldenSource => ({ path, runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] });
    const both = testsView(store, [pack('goldens/a'), pack('goldens/b'), pack('packs/budget'), pack('goldens/team/c')]).commands;
    expect(both.run).toEqual(['test', 'goldens/*', 'packs/budget', 'goldens/team/c']);
    expect(both.ci).toBe(`shadowlap test 'goldens/*' packs/budget goldens/team/c --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`);
    const elsewhere = testsView(store, [pack('my packs/budget')], { folder: 'recordings' }).commands;
    expect(elsewhere.run).toEqual(['test', 'my packs/budget']);
    expect(elsewhere.ci).toBe(`shadowlap test 'my packs/budget' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`);
    expect(elsewhere.pack).toBe('shadowlap pack <run> recordings/<name>');
    expect(testsView(store, []).commands.run).toEqual(['test', 'goldens/*']);
    store.close();
  });

  it('marks a golden with an injection test, which runs live in CI whatever its mode', () => {
    const store = Store.open(':memory:');
    const pack = (path: string, injection?: boolean): GoldenSource => ({ path, runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [], ...(injection === undefined ? {} : { injection }) });
    // A list from before goldens said so reads as none.
    expect(testsView(store, [pack('goldens/a', true), pack('goldens/b', false), pack('goldens/c')]).rows.map((r) => [r.name, r.injection])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
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
    expect(other.rows[0].last).toEqual({ result: null, verdict: null, failure: null, line: 'not run yet', at: null, updated: false, gate: null });
    store.close();
  });

  it('adds the rule and then updates the golden when the request gained a field with a per-run value', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'abc1234' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', data: { divergence: { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.metadata', op: 'added', after: { user_id: UUID_B } }], text: '✗ Diverged at call 1' } } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const [d] = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }]).divergences;
    // The recording never had the field: masking can't make the replay match, so the golden is re-recorded after the rule.
    expect(d.volatile).toMatchObject({ path: '$.metadata.user_id', op: 'added' });
    expect(d.normalizerFixes).toBe(false);
    expect(d.normalizeAndTest).toEqual([['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/x', '--update']]);
    store.close();
  });

  it('bisects from where the recording that fails now passed, and says when the search costs tokens', () => {
    const store = Store.open(':memory:');
    const escalates = [{ ok: true, label: 'escalate called 1 time', detail: null }];
    const day = (n: number, revision: string, ok: boolean, goldenRunId: string, checks: TestResultData['checks'] = escalates) => {
      const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision, startedAt: T0 + n * DAY });
      store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok, ...(ok ? {} : { failure: 'check' as const, reason: 'check failed: escalate called 1 time, but called 0 times' }), revision, goldenRunId, at: T0 + n * DAY + 1, data: { checks } });
      store.finishTestSession(s.sessionId, { passed: ok ? 1 : 0, failed: ok ? 0 : 1, upstreamRequests: 0, endedAt: T0 + n * DAY + 2 });
    };
    day(0, 'aaa1111', true, 'REC_1');
    // Updated at bbb2222: the new recording passes there, and the old one passed later still, at ccc3333.
    day(1, 'bbb2222', true, 'REC_2');
    day(2, 'ccc3333', true, 'REC_1');
    day(3, 'ddd4444', false, 'REC_2');
    const fork: GoldenSource = { path: 'goldens/x', runId: null, packedAt: null, mode: 'fork', repeat: 1, passes: 1, checks: ['escalate called 1 time'] };
    const [f] = testsView(store, [fork]).failures;
    expect(f.bisect).toEqual({ good: 'bbb2222', bad: 'ddd4444', args: ['bisect', 'goldens/x', '--good', 'bbb2222', '--bad', 'ddd4444'], live: true });
    // The dialog offers each commit it was tested at before, newest first, with how it did there.
    expect(f.revisions).toEqual([
      { rev: 'ccc3333', at: T0 + 2 * DAY + 1, result: 'pass', verdict: 'passed', sameChecks: true, rate: { passes: 1, attempts: 1 } },
      { rev: 'bbb2222', at: T0 + DAY + 1, result: 'pass', verdict: 'passed', sameChecks: true, rate: { passes: 1, attempts: 1 } },
      { rev: 'aaa1111', at: T0 + 1, result: 'pass', verdict: 'passed', sameChecks: true, rate: { passes: 1, attempts: 1 } },
    ]);
    store.close();
  });

  it('starts Find the commit only from a pass under the checks a golden has now', () => {
    const store = Store.open(':memory:');
    const day = (n: number, revision: string, ok: boolean, checks?: TestResultData['checks']) => {
      const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision, startedAt: T0 + n * DAY });
      store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok, ...(ok ? {} : { failure: 'check' as const, reason: 'check failed: send_email called 0 times, but called 1 time' }), revision, goldenRunId: 'REC', at: T0 + n * DAY + 1, data: checks ? { checks } : {} });
      store.finishTestSession(s.sessionId, { passed: ok ? 1 : 0, failed: ok ? 0 : 1, upstreamRequests: 0, endedAt: T0 + n * DAY + 2 });
    };
    // It passed at aaa1111 with no checks, then a commit added one ("Research runs must not email"), which it fails.
    day(0, 'aaa1111', true);
    day(1, 'bbb2222', false, [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }]);
    const x: GoldenSource = { path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: ['send_email called 0 times'] };
    const [f] = testsView(store, [x]).failures;
    // No pass under today's check: the page asks for a good commit, offering aaa1111 as passed under other checks.
    expect(f.bisect).toBeNull();
    expect(f.revisions).toEqual([{ rev: 'aaa1111', at: T0 + 1, result: 'pass', verdict: 'passed', sameChecks: false, rate: { passes: 1, attempts: 1 } }]);
    store.close();
  });

  it('keeps what Find the commit said until the golden passes again, and says when it found none', () => {
    const store = sampleStore();
    const ref = 'goldens/refund-in-limit';
    recordEvent(store, { kind: 'bisect.found', ref, at: T0 + 60_000, data: { first: { rev: '4e7b2d1', subject: 'Send the user id with every request', author: 'Ravi', date: '2026-09-30' }, why: 'diverged at call 1', replays: 3, tokens: 0 } });
    // The next session fails it again: the answer stands.
    session(store, 'e3f9b20', T0 + DAY, [
      { golden: 'goldens/refund-flow', ok: true, runId: 'R_E_FLOW' },
      { golden: ref, ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', runId: 'R_E_LIMIT' },
      { golden: 'goldens/refund-over-limit', ok: true, runId: 'R_E_OVER' },
    ]);
    // Its report, a divergence or another failure, whichever it was last.
    const report = () => {
      const view = testsView(store, goldens);
      return [...view.divergences, ...view.failures].find((x) => x.golden === ref)!;
    };
    expect(report().found).toMatchObject({ rev: '4e7b2d1' });
    // A search that named none since takes its place, with why, and the button asks for an older good commit.
    recordEvent(store, { kind: 'bisect.none', ref, at: T0 + DAY + 60_000, data: { outcome: 'fails-at-good', why: 'it already fails at c91d0f4', good: 'c91d0f4', bad: 'e3f9b20' } });
    const d = report();
    expect(d.found).toBeNull();
    expect(d.missed).toEqual({ why: 'it already fails at c91d0f4', good: 'c91d0f4', bad: 'e3f9b20', outcome: 'fails-at-good', at: T0 + DAY + 60_000 });
    // Once it passes, the answers are about a failure that is over.
    session(store, 'f00ba47', T0 + 2 * DAY, [{ golden: ref, ok: true, runId: 'R_F_LIMIT' }], ['shadowlap', 'test', ref]);
    session(store, 'f00ba48', T0 + 3 * DAY, [{ golden: ref, ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', runId: 'R_G_LIMIT' }], ['shadowlap', 'test', ref]);
    const again = report();
    expect(again.found).toBeNull();
    expect(again.missed).toBeNull();
    store.close();
  });

  it('keeps an answer to the failure it answered, never to a later one', () => {
    const store = sampleStore();
    const ref = 'goldens/refund-in-limit';
    const report = () => {
      const view = testsView(store, goldens);
      return [...view.divergences, ...view.failures].find((x) => x.golden === ref)!;
    };
    const found = (at: number, answered?: { at: number; ok: boolean }) =>
      recordEvent(store, { kind: 'bisect.found', ref, at, data: { first: { rev: 'a7cfd69', subject: 'Apply the email fix', author: 'Ravi', date: '2026-09-30' }, why: 'diverged at call 1', replays: 3, tokens: 0, ...(answered ? { answered: { session: 'S', revision: 'x', ...answered } } : {}) } });
    // It passes again at e3f9b20, and only then does a search from an old replay's page, or one
    // still running, answer: it is about the failure that is over.
    session(store, 'e3f9b20', T0 + DAY, [{ golden: ref, ok: true, runId: 'R_E_LIMIT' }], ['shadowlap', 'test', ref]);
    found(T0 + DAY + 60_000);
    // A later commit changes the prompt, and the golden fails on that.
    const prompt: TestResultData = { mode: 'replay', divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, diff: [{ path: '$.system', op: 'changed', before: 'Escalate refunds above the limit.', after: 'Refund whatever is asked.' }], text: '✗ Diverged at call 3' } };
    session(store, '99be4bb', T0 + 2 * DAY, [
      { golden: 'goldens/refund-flow', ok: true, runId: 'R_F_FLOW' },
      { golden: ref, ok: false, failure: 'diverged', reason: 'diverged at call 3 (api POST /v1/messages)', runId: 'R_F_LIMIT', data: prompt },
      { golden: 'goldens/refund-over-limit', ok: true, runId: 'R_F_OVER' },
    ]);
    // No card from before, and the search is offered from where it last passed.
    expect(report()).toMatchObject({ found: null, missed: null, bisect: { good: 'e3f9b20', bad: '99be4bb' } });
    // An answer recorded during this failure stands, unless it answered a result from before it.
    found(T0 + 2 * DAY + 60_000, { at: T0 + 1, ok: false });
    expect(report().found).toBeNull();
    found(T0 + 2 * DAY + 70_000, { at: T0 + DAY + 1, ok: true });
    expect(report().found).toBeNull();
    found(T0 + 2 * DAY + 80_000, { at: T0 + 2 * DAY + 2, ok: false });
    expect(report().found).toMatchObject({ rev: 'a7cfd69', at: T0 + 2 * DAY + 80_000 });
    // A newer answer about a failure that is over doesn't hide the one that stands.
    found(T0 + 2 * DAY + 90_000, { at: T0 + DAY + 1, ok: true });
    expect(report().found).toMatchObject({ at: T0 + 2 * DAY + 80_000 });
    store.close();
  });

  it('says a failure is in no commit while it fails where a search found it passing, and searches again once it fails elsewhere', () => {
    const store = sampleStore();
    const ref = 'goldens/refund-in-limit';
    const report = () => {
      const view = testsView(store, goldens);
      return [...view.divergences, ...view.failures].find((x) => x.golden === ref)!;
    };
    // It failed at d2e8a1f with changes on top; at d2e8a1f as committed it passes.
    const failed = store.listTestResults({ golden: ref, limit: 1 })[0];
    session(store, 'd2e8a1f+dirty', T0 + DAY, [{ golden: ref, ok: false, failure: 'diverged', reason: failed.reason!, runId: 'R_D_LIMIT', data: failed.data! }], ['shadowlap', 'test', ref]);
    recordEvent(store, { kind: 'bisect.none', ref, at: T0 + DAY + 60_000, data: { outcome: 'passes-at-bad', why: 'it passes at d2e8a1f, so there is nothing to find', good: 'c91d0f4', bad: 'd2e8a1f', answered: { session: 'S', at: T0 + DAY + 1, ok: false, revision: 'd2e8a1f+dirty' } } });
    expect(report().missed).toMatchObject({ outcome: 'passes-at-bad', bad: 'd2e8a1f' });
    // Committed, it fails at the new commit: there is a commit to find again.
    session(store, 'e3f9b20', T0 + 2 * DAY, [{ golden: ref, ok: false, failure: 'diverged', reason: failed.reason!, runId: 'R_E_LIMIT', data: failed.data! }], ['shadowlap', 'test', ref]);
    expect(report()).toMatchObject({ missed: null, found: null, bisect: { good: 'c91d0f4', bad: 'e3f9b20' } });
    store.close();
  });

  it('names the change that made a replay diverge, not one a rule in force masks', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'dd06624' });
    // The report lists the masked user id first; the prompt changed too.
    const diff = [
      { path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B },
      { path: '$.system', op: 'changed', before: 'Escalate refunds above the limit.', after: 'Refund whatever is asked.' },
    ];
    const data = (cause?: string | null): TestResultData => ({ divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, diff, volatile: { values: [], explainsAll: false, coversAll: false }, ...(cause !== undefined ? { cause } : {}), text: '✗ Diverged at call 3' } });
    const result = (cause?: string | null) => ({ sessionId: s.sessionId, golden: 'goldens/x', at: 1, revision: 'dd06624', ok: false, failure: 'diverged' as const, reason: 'diverged at call 3 (api POST /v1/messages)', runId: null, goldenRunId: null, data: data(cause) });
    const rule = { kind: 'api' as const, path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };
    // As the CLI kept it, under the rules in force when it ran.
    expect(resultLine(result('$.system'), [])).toBe('diverged at call 3 · $.system');
    // Kept before the CLI said: the config's rules tell.
    expect(resultLine(result(), [], [rule])).toBe('diverged at call 3 · $.system');
    expect(resultLine(result(), [])).toBe('diverged at call 3 · $.metadata.user_id');
    store.addTestResult({ ...result(), data: data() });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    const x: GoldenSource = { path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] };
    expect(testsView(store, [x], { normalizers: [rule] }).rows[0].last.line).toBe('diverged at call 3 · $.system');
    expect(failingTests(store, { goldens: [x], normalizers: [rule] })[0].line).toBe('diverged at call 3 · $.system');
    store.close();
  });

  it('says a golden was updated before its replay failed again', () => {
    const store = sampleStore();
    // Update golden re-recorded it, and the replay after diverged again on a value made anew on every run.
    const failedAgain = store.listTestResults({ golden: 'goldens/refund-in-limit', limit: 1 })[0];
    session(store, 'e3f9b20+dirty', T0 + DAY, [{ golden: 'goldens/refund-in-limit', ok: false, failure: 'diverged', reason: failedAgain.reason!, runId: 'R_U_LIMIT', data: { ...failedAgain.data!, updated: { from: 'GOLDEN_LIMIT', to: 'R_U_REC', calls: 30 } } }], ['shadowlap', 'test', 'goldens/refund-in-limit', '--update']);
    expect(testsView(store, goldens).rows[1].last).toMatchObject({ result: 'fail', updated: true, line: 'updated at e3f9b20+dirty, then diverged at call 1 · $.metadata.user_id looks like a UUID' });
    store.close();
  });

  it('tells a session that asked for every golden from one that named some', () => {
    const need = ['goldens/refund-flow', 'goldens/refund-in-limit', 'evals/kept'];
    expect(asksForAll(['shadowlap', 'test', 'goldens/*', 'evals/kept', '--junit', 'report.xml'], need)).toBe(true);
    expect(asksForAll(['shadowlap', 'test', './goldens/refund-flow/', 'goldens/refund-in-limit', 'evals/kept'], need)).toBe(true);
    expect(asksForAll(['shadowlap', 'test', 'goldens/*'], need)).toBe(false);
    expect(asksForAll(['shadowlap', 'test', 'goldens/refund-*', 'evals/*'], need)).toBe(true);
    expect(asksForAll(['shadowlap', 'test', 'goldens/refund-in-limit', '--update'], need)).toBe(false);
    // A pattern stays within a folder, as the CLI expands it.
    expect(asksForAll(['shadowlap', 'test', '*'], ['goldens/x'])).toBe(false);
    expect(asksForAll(['shadowlap', 'test'], [])).toBe(true);
  });

  it('compares a result’s checks with the golden’s, whatever their order', () => {
    const r = (labels: string[] | null) => ({ sessionId: 's', golden: 'g', at: 0, revision: null, ok: true, failure: null, reason: null, runId: null, goldenRunId: null, data: labels ? { checks: labels.map((label) => ({ ok: true, label, detail: null })) } : null });
    expect(underChecks(r(['b', 'a']), ['a', 'b'])).toBe(true);
    expect(underChecks(r(['a']), ['a', 'b'])).toBe(false);
    expect(underChecks(r(null), [])).toBe(true);
    expect(underChecks(r(null), ['a'])).toBe(false);
  });

  it('offers no Find the commit for a golden whose pack can’t be read', () => {
    const store = Store.open(':memory:');
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'aaa1111', startedAt: T0 });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: true, revision: 'aaa1111', at: T0 + 1 });
    store.finishTestSession(s.sessionId, { passed: 1, failed: 0, upstreamRequests: 0, endedAt: T0 + 2 });
    const t = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision: 'bbb2222', startedAt: T0 + DAY });
    store.addTestResult({ sessionId: t.sessionId, golden: 'goldens/x', ok: false, failure: 'error', reason: "run.json can't be read", revision: 'bbb2222', at: T0 + DAY + 1 });
    store.finishTestSession(t.sessionId, { passed: 0, failed: 1, upstreamRequests: 0, endedAt: T0 + DAY + 2 });
    const [f] = testsView(store, [{ path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [], error: "run.json can't be read" }]).failures;
    expect(f).toMatchObject({ unreadable: "run.json can't be read", bisect: null, revisions: [] });
    store.close();
  });
});

describe('tests on the Overview and in Needs a look', () => {
  it('counts goldens passing, the regressions caught, when they last ran, and the same a week before', () => {
    const store = sampleStore();
    expect(testsSummary(store, { goldens, now: T0 + DAY })).toEqual({ empty: false, total: 3, passing: 2, failing: 1, inconclusive: 0, untested: 0, line: '1 regression caught', lastRunAt: T0 + 100, lastWeek: { passing: 1, total: 1 } });
    expect(testsSummary(store, { goldens: ['goldens/refund-flow', 'goldens/new'], now: T0 + DAY })).toMatchObject({ total: 2, passing: 1, failing: 0, untested: 1, line: 'no regressions' });
    expect(testsSummary(Store.open(':memory:'), { goldens: [] })).toMatchObject({ empty: true, total: 0, line: 'no goldens yet', lastRunAt: null, lastWeek: null });
    // The Overview's outcome strip compares with when its week started.
    expect(overviewTests(store, { now: T0 + DAY, weekStart: T0 - DAY }, { goldens })).toEqual({ goldens: 3, passing: 2, inconclusive: 0, untested: 0, lastWeek: 2, regressions: 1, lastRunAt: T0 + 100 });
    // A golden that never ran is counted, so passing and the rest add up to the goldens on disk.
    expect(overviewTests(store, { now: T0 + DAY, weekStart: T0 - DAY }, { goldens: [...goldens.map((g) => g.path), 'goldens/new'] })).toMatchObject({ goldens: 4, passing: 2, regressions: 1, untested: 1 });
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
    // No fix holds the failure: the line opens the failing run, and says Open, not Fix; no gate decided it, so no rule goes with its line.
    expect(failingTests(store, { goldens })).toEqual([{ golden: 'goldens/refund-in-limit', title: 'A golden failed: refund-in-limit', verdict: 'failed', line: 'diverged at call 1 · $.metadata.user_id looks like a UUID', rule: null, failure: 'diverged', runId: 'R_C_LIMIT', href: '#/run/R_C_LIMIT', next: 'open', fixId: null, at: T0 + 2 }]);
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
      volatile: { path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', certain: true, normalizer: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }, args: ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], command: "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'" },
      normalizerFixes: true,
      maybeReal: false,
      values: { values: [{ path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', certain: true, normalizer: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' } }], explainsAll: true, coversAll: true },
      rerun: ['test', 'goldens/refund-in-limit'],
      update: ['test', 'goldens/refund-in-limit', '--update'],
      normalizeAndTest: [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-in-limit']],
      rulesAdded: false,
      cause: null,
    });
    // Once its rule is in the config, the run's page can offer a re-run, as Tests does.
    expect(testRunBanner(store, replay.runId, { normalizers: [{ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }] })!.rulesAdded).toBe(true);
    // What made a replay diverge, when a masked change comes first: as the CLI kept it, or as the config's rules leave it.
    const prompt = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { test: { golden: 'goldens/refund-flow', session: s.sessionId } } });
    const diff = [{ path: '$.metadata.user_id', op: 'changed' as const, before: UUID_A, after: UUID_B }, { path: '$.system', op: 'changed' as const, before: 'Escalate.', after: 'Refund.' }];
    store.setDivergence(prompt.runId, { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, diff });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-flow', ok: false, failure: 'diverged', runId: prompt.runId });
    const rule = { kind: 'api' as const, path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };
    expect(testRunBanner(store, prompt.runId)!.cause).toBeNull();
    expect(testRunBanner(store, prompt.runId, { normalizers: [rule] })!.cause).toBe('$.system');
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/refund-flow', ok: false, failure: 'diverged', runId: prompt.runId, data: { divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, diff, cause: '$.system', text: '' } } });
    expect(testRunBanner(store, prompt.runId)!.cause).toBe('$.system');
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
    // Recorded through serve, or by a test that starts its agent itself: no command either, and it says which.
    const served = store.createRun({ mode: 'record', command: { argv: [EXTERNAL_COMMAND], cwd: '/p' }, codeVersion: 'fff6666', startedAt: T0 + 5 * DAY });
    store.endRun(served.runId, 'failed', T0 + 5 * DAY + 1);
    expect(bisectChoices(store, served.runId, { goldens: [] })!.unavailable).toMatch(/^this run was recorded through shadowlap serve, so there is no command to run at each commit/);
    const tested = store.createRun({ mode: 'record', command: { argv: [TEST_COMMAND, 'refunds a delivered order'], cwd: '/p' }, codeVersion: 'fff6666', startedAt: T0 + 5 * DAY });
    store.endRun(tested.runId, 'failed', T0 + 5 * DAY + 1);
    expect(bisectChoices(store, tested.runId, { goldens: [] })!.unavailable).toMatch(/^this run was recorded by a test run, so there is no command to run at each commit/);
    // A run from someone else's pack: bisect would run that command at every commit, which the CLI asks about first and a job can't.
    const unpacked = store.createRun({ mode: 'record', command: { argv: ['sh', '-c', 'node main.js'], cwd: '/p' }, codeVersion: 'fff6666', startedAt: T0 + 5 * DAY, meta: { imported: { at: T0, from: 'their-pack' } } });
    store.endRun(unpacked.runId, 'failed', T0 + 5 * DAY + 1);
    const imported = bisectChoices(store, unpacked.runId, { goldens: [] })!;
    expect(imported).toMatchObject({ args: null });
    expect(imported.unavailable).toBe(`this run came from an imported pack: bisect would run its command at every commit. Replay it with your own command first (shadowlap replay ${unpacked.runId} -- <command>), and find the commit from that run`);
    expect(bisectJob(store, [], { runId: unpacked.runId, good: 'aaa1111' })).toEqual({ error: imported.unavailable });
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
    const s = store.listTestSessions()[0];
    const replay = store.createRun({ mode: 'replay', command: { argv: agent, cwd: '/p' }, codeVersion: 'd2e8a1f', meta: { test: { golden: 'goldens/refund-in-limit', session: s.sessionId } } });
    store.endRun(replay.runId, 'completed');
    store.setDivergence(replay.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0 });
    expect(bisectChoices(store, replay.runId, { goldens })).toMatchObject({ target: { kind: 'golden', golden: 'goldens/refund-in-limit' }, failed: true, good: 'c91d0f4', bad: 'd2e8a1f', fork: false, live: false, revisions: [{ rev: 'c91d0f4', runs: 1, failed: 0 }], args: ['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4', '--bad', 'd2e8a1f'] });
    // Once the golden is gone, the replay is bisected as the run it is.
    expect(bisectChoices(store, replay.runId, { goldens: [] })!.target).toEqual({ kind: 'run', runId: replay.runId });
    // A replay a signal cut short has no result, and says nothing either way.
    const stopped = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'e3f9b20', startedAt: T0 + DAY });
    const cut = store.createRun({ mode: 'replay', command: { argv: agent, cwd: '/p' }, codeVersion: 'e3f9b20', meta: { test: { golden: 'goldens/refund-in-limit', session: stopped.sessionId } } });
    store.endRun(cut.runId, 'crashed');
    store.finishTestSession(stopped.sessionId, { passed: 0, failed: 0, upstreamRequests: 0, interrupted: true });
    expect(bisectChoices(store, cut.runId, { goldens })).toMatchObject({ unavailable: 'this replay was cut short, so it says nothing about goldens/refund-in-limit: find the breaking commit from the golden on Tests', args: null });
    expect(bisectJob(store, goldens, { runId: cut.runId, good: 'c91d0f4' })).toEqual({ error: 'this replay was cut short, so it says nothing about goldens/refund-in-limit: find the breaking commit from the golden on Tests' });
    store.close();
  });

  it('tells a golden that came out inconclusive apart: never failed at its commit, and no failure to find from its replay', () => {
    const store = Store.open(':memory:');
    const x: GoldenSource = { path: 'goldens/x', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] };
    const undecided = 'check inconclusive: judge "calm" answers yes, but not judged: no recorded verdict and no key for gemini';
    const day = (n: number, revision: string, verdict: 'passed' | 'failed' | 'inconclusive') => {
      const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/x'], revision, startedAt: T0 + n * DAY });
      const replay = store.createRun({ mode: 'replay', command: { argv: agent, cwd: '/p' }, codeVersion: revision, startedAt: T0 + n * DAY, meta: { test: { golden: 'goldens/x', session: s.sessionId } } });
      store.endRun(replay.runId, 'completed', T0 + n * DAY + 1);
      const why = verdict === 'failed' ? { failure: 'check' as const, reason: 'check failed: send_email called 0 times, but called 1 time' } : verdict === 'inconclusive' ? { failure: 'inconclusive' as const, reason: undecided } : {};
      store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/x', ok: verdict === 'passed', ...why, runId: replay.runId, revision, goldenRunId: 'REC', at: T0 + n * DAY + 1, data: { mode: 'replay', verdict } });
      store.finishTestSession(s.sessionId, { passed: verdict === 'passed' ? 1 : 0, failed: verdict === 'failed' ? 1 : 0, upstreamRequests: 0, endedAt: T0 + n * DAY + 2 });
      return replay.runId;
    };
    day(0, 'aaa1111', 'passed');
    const unsure = day(1, 'bbb2222', 'inconclusive');
    const failing = day(2, 'ccc3333', 'failed');
    // Tests' dialog: the commit where it was inconclusive is offered as such, never as one where it failed.
    const [f] = testsView(store, [x]).failures;
    expect(f.revisions.map((r) => [r.rev, r.result, r.verdict])).toEqual([
      ['bbb2222', 'fail', 'inconclusive'],
      ['aaa1111', 'pass', 'passed'],
    ]);
    // The run page's: each commit before the failing replay counts its golden's results by verdict.
    const choices = bisectChoices(store, failing, { goldens: [x] })!;
    expect(choices).toMatchObject({ target: { kind: 'golden', golden: 'goldens/x' }, failed: true, good: 'aaa1111', bad: 'ccc3333', unavailable: null });
    expect(choices.revisions.map((r) => [r.rev, r.runs, r.failed, r.inconclusive])).toEqual([
      ['bbb2222', 1, 0, 1],
      ['aaa1111', 1, 0, 0],
    ]);
    // The inconclusive replay itself neither passed nor failed: there is no breaking commit to find.
    const from = bisectChoices(store, unsure, { goldens: [x] })!;
    expect(from).toMatchObject({ failed: false, args: null, unavailable: "goldens/x came out inconclusive in this replay's session, neither passed nor failed, so there is no breaking commit to find: Tests says what settles it" });
    expect(bisectJob(store, [x], { runId: unsure, good: 'aaa1111' })).toEqual({ error: from.unavailable });
    store.close();
  });

  it('judges each replay by the check blame found a run failing, though it exited 0', () => {
    const store = Store.open(':memory:');
    const { make } = history(store);
    // It exited 0 and kept no failed check of its own: only the fix's check says it failed.
    const quiet = make('fff6666', T0 + 5 * DAY, 'completed');
    recordBlame(store, { runId: quiet, report: blameReport(quiet), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' });
    const c = bisectChoices(store, quiet, { goldens: [] })!;
    // How other runs of the command exited says nothing about the check: the good commit is chosen.
    expect(c).toMatchObject({ target: { kind: 'run', runId: quiet }, failed: true, good: null, bad: 'fff6666', fork: true, live: true, expect: EXPECT, unavailable: null, args: null });
    expect(c.revisions.map((r) => r.rev)).toEqual(['eee5555', 'ddd4444', 'bbb2222', 'aaa1111']);
    // The job forks each replay and judges it by that check.
    expect(bisectJob(store, [], { runId: quiet, good: 'bbb2222' })).toEqual({ title: 'Finding breaking commit', args: ['bisect', quiet, '--good', 'bbb2222', '--bad', 'fff6666', '--expect', JSON.stringify(EXPECT), '--fork'], runId: quiet });
    // A run that failed a check given with its own --expect is judged by that one.
    const own = make('fff6666', T0 + 6 * DAY, 'completed', { expect: { tools: { send_email: 1 } }, checks: [{ ok: false, label: 'send_email called 1 time' }] } as never);
    expect(bisectChoices(store, own, { goldens: [] })).toMatchObject({ failed: true, fork: true, expect: { tools: { send_email: 1 } }, unavailable: null });
    store.close();
  });

  it('tells a run whose only check that did not pass is inconclusive apart: no failure to find from it', () => {
    const store = Store.open(':memory:');
    const { make } = history(store);
    const judge = { ok: false, status: 'inconclusive', label: 'judge "calm" answers yes', detail: 'not judged: no recorded verdict and no key for gemini' };
    const unsure = make('fff6666', T0 + 5 * DAY, 'completed', { expect: { judge: [{ name: 'calm', question: 'Is the reply calm?', of: 'answer', model: 'gemini-3-flash' }] }, checks: [judge] } as never);
    const c = bisectChoices(store, unsure, { goldens: [] })!;
    expect(c).toMatchObject({ failed: false, fork: false, expect: null, args: null, unavailable: 'this run is inconclusive, neither passed nor failed: a check could not be decided (judge "calm" answers yes), so there is no breaking commit to find' });
    expect(bisectJob(store, [], { runId: unsure, good: 'bbb2222' })).toEqual({ error: c.unavailable });
    // A check that failed beside it is a failure all the same, judged by the run's own --expect.
    const failing = make('fff6666', T0 + 6 * DAY, 'completed', { expect: { tools: { send_email: 1 } }, checks: [{ ok: false, status: 'failed', label: 'send_email called 1 time', detail: 'called 0 times' }, judge] } as never);
    expect(bisectChoices(store, failing, { goldens: [] })).toMatchObject({ failed: true, fork: true, expect: { tools: { send_email: 1 } }, unavailable: null });
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
    // Each judged by the golden's check, as the config gives it.
    for (const r of store.listTestResults({ golden: 'goldens/f' })) store.addTestResult({ ...r, data: { checks: [{ ok: r.ok, label: 'escalate called 1 time', detail: null }] } });
    const fork: GoldenSource = { path: 'goldens/f', runId: 'REC_2', packedAt: null, mode: 'fork', repeat: 3, passes: 3, checks: ['escalate called 1 time'] };
    expect(bisectChoices(store, failing, { goldens: [fork] })).toMatchObject({ target: { kind: 'golden', golden: 'goldens/f' }, good: 'bbb2222', bad: 'ddd4444', fork: false, live: true, args: ['bisect', 'goldens/f', '--good', 'bbb2222', '--bad', 'ddd4444'] });
    store.close();
  });
});

describe('jobs for the Tests actions', () => {
  it('runs every golden, or the one named, and nothing the browser makes up', () => {
    expect(runTestsJob(goldens, {})).toEqual({ title: 'Running tests', args: ['test', 'goldens/*'] });
    expect(runTestsJob(goldens, { golden: 'goldens/refund-flow' })).toEqual({ title: 'Running tests', args: ['test', 'goldens/refund-flow'] });
    for (const golden of ['goldens/../../etc', '--update', 'goldens/*', 42]) expect(runTestsJob(goldens, { golden })).toHaveProperty('error');
    expect(runTestsJob([], {})).toEqual({ error: 'no goldens yet: pack a run you consider correct into goldens/ first' });
  });

  it('updates the goldens named, each once', () => {
    expect(updateGoldensJob(goldens, { goldens: ['goldens/refund-in-limit', 'goldens/refund-flow', 'goldens/refund-in-limit'] })).toEqual({ title: 'Updating goldens', args: ['test', 'goldens/refund-in-limit', 'goldens/refund-flow', '--update'] });
    expect(updateGoldensJob(goldens, { golden: 'goldens/refund-in-limit' })).toEqual({ title: 'Updating golden', args: ['test', 'goldens/refund-in-limit', '--update'] });
    expect(updateGoldensJob(goldens, { goldens: ['goldens/refund-flow', '--online'] })).toEqual({ error: 'no such golden: --online' });
    expect(updateGoldensJob(goldens, { goldens: [] })).toHaveProperty('error');
  });

  it('adds the normalizer the stored divergence names, then re-runs the golden', () => {
    const store = sampleStore();
    const job = normalizeAndTestJob(store, goldens, { golden: 'goldens/refund-in-limit' });
    expect(job).toEqual({ title: 'Adding normalizer and re-running', steps: [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-in-limit']], runId: 'R_C_LIMIT' });
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
    expect(normalizeAndTestJob(store, goldens, { runId: replay.runId })).toMatchObject({ title: 'Adding normalizer and re-running', steps: [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-in-limit']], runId: replay.runId });
    expect(normalizeAndTestJob(store, [], { runId: replay.runId })).toEqual({ error: 'goldens/refund-in-limit is no longer a golden on disk' });
    // Two values that change every run: one rule alone leaves the other diverging, so the golden is updated after it.
    store.setDivergence(replay.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.metadata.user_id', op: 'changed', before: UUID_A, after: UUID_B }, { path: '$.metadata.trace_id', op: 'changed', before: UUID_B, after: UUID_A }] });
    expect(normalizeAndTestJob(store, goldens, { runId: replay.runId })).toMatchObject({ title: 'Adding normalizer and re-running', steps: [expect.arrayContaining(['$.metadata.user_id']), expect.arrayContaining(['$.metadata.trace_id']), ['test', 'goldens/refund-in-limit']] });
    expect(normalizeAndTestJob(store, goldens, { runId: replay.runId, path: '$.metadata.trace_id' })).toMatchObject({ title: 'Adding normalizer and updating golden', steps: [expect.arrayContaining(['$.metadata.trace_id']), ['test', 'goldens/refund-in-limit', '--update']] });
    store.close();
  });

  it('finds the commit for a golden or a run, from revisions that look like ones', () => {
    const store = sampleStore();
    expect(bisectJob(store, goldens, { golden: 'goldens/refund-in-limit', good: 'c91d0f4', bad: 'd2e8a1f' })).toEqual({ title: 'Finding breaking commit', args: ['bisect', 'goldens/refund-in-limit', '--good', 'c91d0f4', '--bad', 'd2e8a1f'] });
    expect(bisectJob(store, goldens, { golden: 'goldens/refund-in-limit', good: 'v1.2.0' })).toEqual({ title: 'Finding breaking commit', args: ['bisect', 'goldens/refund-in-limit', '--good', 'v1.2.0'] });
    for (const good of ['--output=x', '-x', 'a..b', 'a b', '', null, 7]) expect(bisectJob(store, goldens, { golden: 'goldens/refund-in-limit', good }), String(good)).toEqual({ error: 'name a commit where it still worked' });
    expect(bisectJob(store, goldens, { golden: 'goldens/refund-in-limit', good: 'c91d0f4', bad: '--exec=x' })).toEqual({ error: 'that is not a commit' });
    expect(bisectJob(store, goldens, { golden: 'elsewhere/x', good: 'c91d0f4' })).toHaveProperty('error');
    expect(checkedRevision('abc1234+dirty')).toBe('abc1234');
    expect(checkedRevision('HEAD~3')).toBe('HEAD~3');
    const failed = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, codeVersion: 'fff6666' });
    store.endRun(failed.runId, 'failed');
    expect(bisectJob(store, goldens, { runId: failed.runId, good: 'c91d0f4' })).toEqual({ title: 'Finding breaking commit', args: ['bisect', failed.runId, '--good', 'c91d0f4', '--bad', 'fff6666', '--fork'], runId: failed.runId });
    expect(bisectJob(store, goldens, { runId: failed.runId, good: 'fff6666' })).toEqual({ error: 'fff6666 is where it fails: choose an earlier commit where it still worked' });
    expect(bisectJob(store, goldens, { runId: 'not-a-run', good: 'c91d0f4' })).toEqual({ error: 'no such run' });
    store.close();
  });
});

describe('goldens with a gate', () => {
  const sprt = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 20 };
  const history = { kind: 'baseline' as const, drop: 0.15, risk: 0.05, window: 10, min: 3, max: 40 };
  const gated: GoldenSource[] = [
    { path: 'goldens/escalates', runId: null, packedAt: T0, mode: 'fork', repeat: 1, passes: 1, gate: sprt, checks: ['issue_refund called 0 times'] },
    { path: 'goldens/flaky', runId: null, packedAt: T0, mode: 'fork', repeat: 1, passes: 1, gate: sprt, checks: ['issue_refund called 0 times'] },
    { path: 'goldens/drops', runId: null, packedAt: T0, mode: 'fork', repeat: 1, passes: 1, gate: history, checks: [] },
  ];
  const result = (gate: typeof sprt | typeof history, outcomes: boolean[], o: { history?: { passes: number; attempts: number; sessions: number }; spent?: number } = {}): TestResultData => {
    const g = gateResult(gate, outcomes, { history: o.history ?? null });
    const verdict = g.decision === 'pass' ? 'passed' : g.decision === 'fail' ? 'failed' : 'inconclusive';
    return { mode: 'fork', attempts: { total: outcomes.length, passed: g.passes, required: null, runs: [] }, verdict, gate: g, ...(o.spent !== undefined ? { spent: o.spent } : {}) };
  };

  function gatedStore(): Store {
    const store = Store.open(':memory:');
    session(store, 'a1b2c3d', T0 - DAY, [
      { golden: 'goldens/escalates', ok: true, runId: 'R1', data: result(sprt, Array(12).fill(true)) },
      { golden: 'goldens/flaky', ok: true, runId: 'R2', data: result(sprt, Array(12).fill(true)) },
      { golden: 'goldens/drops', ok: true, runId: 'R3', data: result(history, [true, true, true]) },
    ]);
    // Four passes and a failure, four times: attempts the gate ends on at its limit, between its bounds.
    const unsure = Array.from({ length: 4 }, () => [true, true, true, true, false]).flat();
    // Kept in the words results had before a verdict stated its test and showed its tally (a claimed
    // rate): the screen says them in today's.
    const kept = (d: TestResultData, sentence: string): TestResultData => ({ ...d, gate: { ...d.gate!, sentence } });
    session(store, 'e4f5a6b', T0, [
      { golden: 'goldens/escalates', ok: true, runId: 'R4', data: kept(result(sprt, Array(12).fill(true), { spent: 0.24 }), 'passed: at least 90% with 95% confidence after 12 attempts') },
      { golden: 'goldens/flaky', ok: false, failure: 'inconclusive' as never, reason: 'inconclusive: neither at least 90% nor at most 70% with 95% confidence after 20 attempts, the most the gate runs', runId: 'R5', data: kept(result(sprt, unsure, { spent: 0.4 }), 'inconclusive: neither at least 90% nor at most 70% with 95% confidence after 20 attempts, the most the gate runs') },
      { golden: 'goldens/drops', ok: false, failure: 'check', reason: 'failed: its pass rate dropped', runId: 'R6', data: result(history, [false, false, false], { history: { passes: 30, attempts: 30, sessions: 10 } }) },
    ]);
    return store;
  }

  it('carries each gate, its decision, interval, attempts and evidence path, for the interval bar and the evidence line', () => {
    const store = gatedStore();
    const view = testsView(store, gated);
    const [escalates, flaky, drops] = view.rows;
    expect(escalates.gate).toEqual({ gate: sprt, description: 'tells 90%+ from 70%- at <= 5% risk, up to 20 attempts', toPass: 12, toFail: 3 });
    expect(escalates.modeLabel).toBe('fork · gate');
    expect(drops.modeLabel).toBe('fork · history');
    // Decision 9: the tally and the bound under the verdict word, and against history the
    // baseline; the rule is said once under the table, never on each row, and never a claimed rate.
    expect(escalates.last).toMatchObject({ result: 'pass', verdict: 'passed', line: '12 of 12 · rate >= 0.73 (95%)' });
    expect(drops.last).toMatchObject({ result: 'fail', verdict: 'failed', line: '0 of 3 · rate <= 0.71 (95%) · against 1.00 over the last 10 sessions (30 of 30)' });
    const g = escalates.last.gate!;
    expect(g).toMatchObject({ kind: 'sprt', decision: 'pass', passes: 12, attempts: 12, tally: '12 of 12 passed · rate >= 0.73 (95%) · pass^5 1.00', rule: 'gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts', perAttempt: 0.02, more: null });
    expect(drops.last.gate!.rule).toBe('gate: fails a drop of 15+ points from its last 10 sessions once 95% likely, from 3 attempts up to 40');
    // Exact under the gate's stopping: 12 straight passes, the rate whose twelfth power is 2.5%.
    expect(g.interval.lo).toBeCloseTo(0.7354, 4);
    expect(g.bound).toMatchObject({ method: 'stagewise' });
    if (g.evidence.kind !== 'sprt') throw new Error('an SPRT gate keeps its scores');
    expect(g.evidence.scores).toHaveLength(12);
    expect(g.evidence.scores.at(-1)).toBeGreaterThanOrEqual(g.evidence.upper);
    // Inconclusive: told apart from failing, with Run more attempts at twice the limit, and what an attempt cost.
    expect(flaky.last).toMatchObject({ result: 'fail', verdict: 'inconclusive', failure: 'inconclusive' });
    // Run more attempts continues it to twice its limit, carrying its 20 attempts over: for an agent
    // passing 80% of the time, as far, about 17 more on average, settling it 38% of the time, $0.34 at
    // $0.02 an attempt (80% sits between the gate's two rates, where telling them apart costs most).
    expect(flaky.last.gate).toMatchObject({ decision: 'inconclusive', perAttempt: 0.02, more: { args: ['test', 'goldens/flaky', '--max-attempts', '40', '--continue'], job: { golden: 'goldens/flaky', maxAttempts: 40, continue: true }, attempts: 40, most: 20 } });
    const more = flaky.last.gate!.more!;
    expect(more.expected).toBeCloseTo(17.17, 2);
    expect(more.settles).toBeCloseTo(0.378, 3);
    expect(more.cost).toBeCloseTo(0.34, 2);
    // A golden whose judge checks are asked live on each attempt: their cost is an attempt's too.
    const judged = Store.open(':memory:');
    const judge = { calls: 20, replayed: 0, live: 20, notAsked: 0, upstreamRequests: 20, spent: 0.2, saved: 0, unknownModels: [] };
    session(judged, 'e4f5a6b', T0, [{ golden: 'goldens/flaky', ok: false, failure: 'inconclusive' as never, reason: 'inconclusive', runId: 'R7', data: { ...result(sprt, Array.from({ length: 4 }, () => [true, true, true, true, false]).flat(), { spent: 0.4 }), judge } }]);
    expect(testsView(judged, gated).rows.find((r) => r.name === 'flaky')!.last.gate!.perAttempt).toBeCloseTo(0.03, 6);
    judged.close();
    // History cells: shaded by their pass rate, ringed where a gate against history found a drop.
    expect(drops.history.map((c) => [c.verdict, c.rate, c.dropped])).toEqual([
      ['passed', { passes: 3, attempts: 3 }, false],
      ['failed', { passes: 0, attempts: 3 }, true],
    ]);
    expect(flaky.history[1]).toMatchObject({ result: 'fail', verdict: 'inconclusive', rate: { passes: 16, attempts: 20 } });
    store.close();
  });

  it('counts inconclusive goldens apart, on the screen, the Overview and in Needs a look', () => {
    const store = gatedStore();
    const view = testsView(store, gated);
    expect(view.verdict).toMatchObject({ state: 'failing', failing: 1, inconclusive: 1, passing: 1, untested: 0 });
    expect(view.inconclusive).toEqual([expect.objectContaining({ golden: 'goldens/flaky', reason: 'inconclusive · 16 of 20 · rate 0.56 to 0.95 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts', gate: expect.objectContaining({ decision: 'inconclusive' }) })]);
    // Nothing to bisect or fix there: only the golden that failed is a failure.
    expect(view.failures.map((f) => f.golden)).toEqual(['goldens/drops']);
    expect(testsView(store, gated.slice(0, 2)).verdict).toMatchObject({ state: 'inconclusive', failing: 0, inconclusive: 1, passing: 1, title: '1 of 2 goldens passed · flaky inconclusive after 20 attempts' });
    expect(testsSummary(store, { goldens: gated })).toMatchObject({ passing: 1, failing: 1, inconclusive: 1, line: '1 regression caught' });
    expect(overviewTests(store, { now: T0 + DAY, weekStart: T0 - 3 * DAY }, { goldens: gated })).toMatchObject({ passing: 1, inconclusive: 1, regressions: 1 });
    expect(failingTests(store, { goldens: gated }).map((t) => [t.title, t.verdict, t.href])).toEqual([
      ['A golden failed: drops', 'failed', '#/tests'],
      ['A golden is inconclusive: flaky', 'inconclusive', '#/tests'],
    ]);
    // Needs a look says a gate's verdict as the gate does: the word, the tally and the bound (and the
    // baseline), whole, with the rule apart for the line's hover, never cut off after it.
    expect(failingTests(store, { goldens: gated }).map((t) => [t.line, t.rule])).toEqual([
      ['failed · 0 of 3 · rate <= 0.71 (95%) · against 1.00 over the last 10 sessions (30 of 30)', 'gate: fails a drop of 15+ points from its last 10 sessions once 95% likely, from 3 attempts up to 40'],
      ['inconclusive · 16 of 20 · rate 0.56 to 0.95 (95%)', 'gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts'],
    ]);
    store.close();
  });

  it('says a gated golden a check could not decide is inconclusive for the check, never for a gate that ran out', () => {
    const store = Store.open(':memory:');
    const why = 'check inconclusive: judge "calm" answers yes, but not judged: the judge\'s call failed: HTTP 400';
    // Two attempts passed, and the third could not be judged: test stops there, and its gate decided nothing.
    const stopped: TestResultData = { mode: 'fork', attempts: { total: 3, passed: 2, required: null, runs: [], inconclusive: 1 }, verdict: 'inconclusive', gate: gateResult(sprt, [true, true], { decision: 'continue' }) };
    // One whose replay passed its gate, and whose injection gate showed too little to say.
    const injected: TestResultData = { ...result(sprt, Array(12).fill(true)), verdict: 'inconclusive', injection: { resultId: null, attempts: 3, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 3, allowed: { obeyed: 0, influenced: null }, verdict: 'inconclusive', reason: 'no attempt showed anything', skipped: null } };
    session(store, 'e4f5a6b', T0, [
      { golden: 'goldens/escalates', ok: false, failure: 'inconclusive' as never, reason: why, runId: 'R1', data: stopped },
      { golden: 'goldens/flaky', ok: false, failure: 'injection' as never, reason: 'injection inconclusive: no attempt showed anything', runId: 'R2', data: injected },
    ]);
    const view = testsView(store, gated.slice(0, 2));
    const [escalates, flaky] = view.rows;
    // A result kept with the gate the check stopped before it decided: no gate shows, as it decided nothing.
    expect(escalates.last).toMatchObject({ verdict: 'inconclusive', line: why, gate: null });
    expect(view.inconclusive).toEqual([expect.objectContaining({ golden: 'goldens/escalates', reason: why, gate: null }), expect.objectContaining({ golden: 'goldens/flaky', reason: 'injection inconclusive: no attempt showed anything', gate: null })]);
    expect(flaky.last).toMatchObject({ verdict: 'inconclusive', line: 'injection inconclusive: no attempt showed anything' });
    // Its title and its history cell say what is inconclusive, never a gate that ran out of attempts.
    expect(view.verdict).toMatchObject({ state: 'inconclusive', inconclusive: 2, title: '0 of 2 goldens passed · escalates inconclusive: a check could not be judged' });
    expect(escalates.history.map((c) => c.note)).toEqual([why]);
    expect(failingTests(store, { goldens: gated.slice(0, 2) }).map((t) => t.line)).toEqual(['injection inconclusive: no attempt showed anything', why]);
    store.close();
  });

  it('says where each failing golden leads: more attempts for a gate that ran out, an update for a replay golden a judge could not decide, a run again for an injection test, else its run', () => {
    const store = gatedStore();
    const judgeCheck = (detail: string) => ({ status: 'inconclusive' as const, ok: false, label: 'judge "polite" answers yes', detail, judge: { name: 'polite', model: 'claude-haiku-4-5', of: 'answer' as const, verdict: null, source: null, cost: null, redactions: 0 } });
    const replayGolden = (path: string): GoldenSource => ({ path, runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] });
    const unjudged = 'check inconclusive: judge "polite" answers yes, but not judged: no recorded verdict';
    session(store, 'f6a7b8c', T0 + DAY, [
      // A replay golden whose judge has no recorded verdict: updating the golden asks the judge once and keeps its verdict.
      { golden: 'goldens/polite', ok: false, failure: 'inconclusive' as never, reason: unjudged, runId: 'R7', data: { mode: 'replay', verdict: 'inconclusive', checks: [judgeCheck('not judged: no recorded verdict')] } as TestResultData },
      // One whose injection test showed too little to say: an update settles nothing there, so it runs again once that is settled.
      { golden: 'goldens/planted', ok: false, failure: 'injection' as never, reason: 'injection inconclusive: no attempt showed anything', runId: 'R8', data: { mode: 'replay', verdict: 'inconclusive', injection: { resultId: null, attempts: 3, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 3, allowed: { obeyed: 0, influenced: null }, verdict: 'inconclusive', reason: 'no attempt showed anything', skipped: null } } },
      // One whose undecided check is no judge's: nothing an update asks would settle it.
      { golden: 'goldens/unsure', ok: false, failure: 'inconclusive' as never, reason: 'check inconclusive', runId: 'R9', data: { mode: 'replay', verdict: 'inconclusive', checks: [{ status: 'inconclusive', ok: false, label: 'send_email called 1 time', detail: 'not decided' }] } },
      // One whose gate the unjudged attempt stopped before it decided anything: the judge is what to settle, as Tests offers it.
      { golden: 'goldens/stopped', ok: false, failure: 'inconclusive' as never, reason: unjudged, runId: 'R11', data: { mode: 'replay', verdict: 'inconclusive', gate: gateResult(sprt, [true, true], { decision: 'continue' }), checks: [judgeCheck('not judged: no recorded verdict')] } as TestResultData },
      // A path the CLI would read as an option is never offered to it.
      { golden: '-polite', ok: false, failure: 'inconclusive' as never, reason: unjudged, runId: 'R12', data: { mode: 'replay', verdict: 'inconclusive', checks: [judgeCheck('not judged: no recorded verdict')] } as TestResultData },
    ]);
    const goldens = [...gated, ...['goldens/polite', 'goldens/planted', 'goldens/unsure', 'goldens/stopped', '-polite'].map(replayGolden)];
    // A golden that forks asks its judge live: one that lacked a key is opened, where Tests names the key.
    const keyless: GoldenSource = { ...replayGolden('goldens/keyless'), mode: 'fork' };
    session(store, 'f6a7b8d', T0 + DAY + 1, [{ golden: 'goldens/keyless', ok: false, failure: 'inconclusive' as never, reason: unjudged, runId: 'R10', data: { mode: 'fork', verdict: 'inconclusive', checks: [judgeCheck('not judged: no key for anthropic')] } as TestResultData }]);
    const next = Object.fromEntries(failingTests(store, { goldens: [...goldens, keyless] }).map((t) => [t.golden, [t.next, t.href]]));
    expect(next).toEqual({
      'goldens/flaky': ['run-more', '#/tests'],
      'goldens/drops': ['open', '#/tests'],
      'goldens/polite': ['update', '#/tests'],
      'goldens/planted': ['run-again', '#/tests'],
      'goldens/unsure': ['open', '#/tests'],
      'goldens/stopped': ['update', '#/tests'],
      '-polite': ['open', '#/tests'],
      'goldens/keyless': ['open', '#/tests'],
    });
    store.close();
  });

  it('runs more attempts for one golden: its gate\'s limit raised for that session only', () => {
    expect(runTestsJob(gated, { golden: 'goldens/flaky', maxAttempts: 40 })).toEqual({ title: 'Running more attempts', args: ['test', 'goldens/flaky', '--max-attempts', '40'] });
    expect(runTestsJob(gated, { golden: 'goldens/flaky', maxAttempts: 0 })).toEqual({ error: 'maxAttempts is a whole number from 1 to 1000' });
    expect(runTestsJob(gated, { golden: 'goldens/flaky', maxAttempts: '40; rm -rf /' })).toMatchObject({ error: expect.any(String) });
    expect(runTestsJob(gated, {})).toEqual({ title: 'Running tests', args: ['test', 'goldens/*'] });
  });
});

describe('each golden\'s checks, by how its last result came out on them', () => {
  const judge = (model: string) => ({ name: 'explains-escalation', model, of: 'answer' as const, verdict: null, source: null, cost: null, redactions: 0, cut: 0 });
  const judgeLabel = 'judge "explains-escalation" answers yes';
  const offline = { ok: false, status: 'inconclusive' as const, label: judgeLabel, detail: 'not judged: no recorded verdict and the test runs offline', judge: judge('claude-haiku-4-5') };
  const noKey = { ...offline, detail: 'not judged: no recorded verdict and no key for anthropic (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)' };
  const passed = (label: string) => ({ ok: true, status: 'passed' as const, label, detail: null });
  const failed = (label: string, detail: string) => ({ ok: false, status: 'failed' as const, label, detail });
  const golden = (path: string, mode: 'replay' | 'fork', checks: string[]): GoldenSource => ({ path, runId: null, packedAt: T0, mode, repeat: 1, passes: 1, checks });
  const GOLDENS = [
    golden('goldens/clean', 'replay', ['escalate called 1 time', 'when lookup_order has result.amount > 100: escalate called at least 1 time', 'send_email called 1 time']),
    golden('goldens/flaky', 'fork', ['issue_refund called 0 times']),
    golden('goldens/judged', 'replay', ['escalate called 1 time', judgeLabel]),
    golden('goldens/keyless', 'fork', [judgeLabel]),
    golden('goldens/new', 'replay', ['escalate called 1 time']),
  ];

  function store() {
    const s = Store.open(':memory:');
    // The flaky golden's four attempts, each with its checks as its run kept them: one refunded.
    const attempts = ['A1', 'A2', 'A3', 'A4'];
    attempts.forEach((runId, i) => s.createRun({ runId, mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { checks: [i === 1 ? failed('issue_refund called 0 times', 'called 1 time (1 blocked or stubbed)') : passed('issue_refund called 0 times')] } }));
    session(s, 'd2e8a1f', T0, [
      // The config gained send_email's check since: the result never judged it.
      { golden: 'goldens/clean', ok: true, runId: 'R1', data: { mode: 'replay', checks: [passed('escalate called 1 time'), { ok: true, status: 'not-applicable', label: 'when lookup_order has result.amount > 100: escalate called at least 1 time', detail: 'the condition never held: lookup_order #2: result.amount 45 <= 100' }] } },
      { golden: 'goldens/flaky', ok: false, failure: 'check', reason: '3 of 4 attempts passed, 4 needed', runId: 'A2', data: { mode: 'fork', verdict: 'failed', checks: [failed('issue_refund called 0 times', 'called 1 time (1 blocked or stubbed)')], attempts: { total: 4, passed: 3, required: 4, runs: attempts } } },
      { golden: 'goldens/judged', ok: false, failure: 'inconclusive' as never, reason: `check inconclusive: ${judgeLabel}, but not judged`, runId: 'R3', data: { mode: 'replay', verdict: 'inconclusive', checks: [passed('escalate called 1 time'), offline] } },
      { golden: 'goldens/keyless', ok: false, failure: 'inconclusive' as never, reason: `check inconclusive: ${judgeLabel}, but not judged`, runId: 'R4', data: { mode: 'fork', verdict: 'inconclusive', checks: [noKey], divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, text: '' } } },
    ]);
    return s;
  }

  it('marks each check by its status in the attempt the result shows, and none before a result or for one it didn\'t judge', () => {
    const s = store();
    const rows = new Map(testsView(s, GOLDENS).rows.map((r) => [r.name, r]));
    // send_email's check is newer than the result, which judged the golden's checks of then.
    expect(rows.get('clean')!.checkResults.map((c) => [c.status, c.added, c.detail])).toEqual([
      ['passed', false, null],
      ['not-applicable', false, 'the condition never held: lookup_order #2: result.amount 45 <= 100'],
      [null, true, null],
    ]);
    expect(rows.get('judged')!.checkResults.map((c) => [c.label, c.status, c.detail])).toEqual([
      ['escalate called 1 time', 'passed', null],
      [judgeLabel, 'inconclusive', 'not judged: no recorded verdict and the test runs offline'],
    ]);
    // Not run yet: no status, and nothing added since.
    expect(rows.get('new')!.checkResults).toEqual([{ label: 'escalate called 1 time', status: null, added: false, detail: null, reason: null, source: null, live: null, attempts: null }]);
    s.close();
  });

  it('tells a check added since the last test from one whose golden couldn\'t run', () => {
    const s = Store.open(':memory:');
    const list = [golden('goldens/broken', 'replay', ['escalate called 1 time']), golden('goldens/unchecked', 'replay', ['escalate called 1 time'])];
    session(s, 'd2e8a1f', T0, [
      // The pack couldn't be read: the result holds why, and no checks.
      { golden: 'goldens/broken', ok: false, runId: 'R1', reason: "can't be read: no run.json", data: { mode: 'replay', details: "can't be read: no run.json" } },
      // It ran with no checks: every check it has now was added since.
      { golden: 'goldens/unchecked', ok: true, runId: 'R2', data: { mode: 'replay', calls: { total: 8, replayed: 8, live: 0, blocked: 0, stubbed: 0 } } },
    ]);
    const rows = new Map(testsView(s, list).rows.map((r) => [r.name, r.checkResults[0]]));
    expect(rows.get('broken')).toMatchObject({ status: null, added: false });
    expect(rows.get('unchecked')).toMatchObject({ status: null, added: true });
    s.close();
  });

  it('counts the attempts of a golden run more than once that passed each check, and none when an attempt\'s run is gone', () => {
    const s = store();
    expect(testsView(s, GOLDENS).rows.find((r) => r.name === 'flaky')!.checkResults).toEqual([{ label: 'issue_refund called 0 times', status: 'failed', added: false, detail: 'called 1 time (1 blocked or stubbed)', reason: null, source: null, live: null, attempts: { passed: 3, of: 4 } }]);
    s.deleteRun('A3');
    expect(testsView(s, GOLDENS).rows.find((r) => r.name === 'flaky')!.checkResults[0].attempts).toBeNull();
    s.close();
  });

  it('settles a judge that had no verdict: Update golden for a golden that replays offline, the key for one that forks', () => {
    const s = store();
    const view = testsView(s, GOLDENS);
    const judged = view.inconclusive.find((v) => v.golden === 'goldens/judged')!;
    expect(judged.judge).toEqual({ name: 'explains-escalation', label: judgeLabel, model: 'claude-haiku-4-5', provider: 'anthropic', why: 'not judged: no recorded verdict and the test runs offline', held: 'none', changed: null, update: ['test', 'goldens/judged', '--update'], keys: null });
    // Its update is the job Update golden runs.
    expect(updateGoldensJob(GOLDENS, { golden: 'goldens/judged' })).toEqual({ title: 'Updating golden', args: judged.judge!.update });
    const keyless = view.inconclusive.find((v) => v.golden === 'goldens/keyless')!;
    expect(keyless.judge).toMatchObject({ update: null, keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] });
    s.close();
  });

  it('counts no attempts for a result that carried some over from an earlier session, its carried runs partly pruned', () => {
    const s = Store.open(':memory:');
    const list = [golden('goldens/gated', 'fork', ['issue_refund called 0 times'])];
    const check = (ok: boolean) => (ok ? passed('issue_refund called 0 times') : failed('issue_refund called 0 times', 'called 1 time (1 blocked or stubbed)'));
    // The first session's twelve attempts, of which pruning kept only the failing four and one more.
    const carried = Array.from({ length: 12 }, (_, i) => `C${i + 1}`);
    carried.forEach((runId, i) => s.createRun({ runId, mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { checks: [check(i % 3 !== 0)] } }));
    session(s, 'd2e8a1f', T0, [{ golden: 'goldens/gated', ok: false, failure: 'inconclusive' as never, runId: 'C12', data: { mode: 'fork', verdict: 'inconclusive', checks: [check(true)], attempts: { total: 12, passed: 8, required: null, runs: carried } } }]);
    for (const id of ['C2', 'C3', 'C5', 'C6', 'C8', 'C9', 'C11']) s.deleteRun(id);
    // Run more attempts: three of this session's own, the twelve carried over counted by its gate alone.
    const own = ['N1', 'N2', 'N3'];
    own.forEach((runId, i) => s.createRun({ runId, mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' }, meta: { checks: [check(i !== 2)] } }));
    const first = s.listTestResults({ golden: 'goldens/gated', limit: 1 })[0];
    session(s, 'd2e8a1f', T0 + DAY, [{ golden: 'goldens/gated', ok: false, failure: 'check', runId: 'N3', data: { mode: 'fork', verdict: 'failed', checks: [check(false)], attempts: { total: 3, passed: 2, required: null, runs: own }, continued: { sessions: [first.sessionId], attempts: 12 } } }]);
    // Its own runs alone would say 2 of 3 beside a result of 10 of 15: no tally, only what the check found.
    expect(testsView(s, list).rows[0].checkResults).toEqual([{ label: 'issue_refund called 0 times', status: 'failed', added: false, detail: 'called 1 time (1 blocked or stubbed)', reason: null, source: null, live: null, attempts: null }]);
    s.close();
  });

  it('says where a passed judge\'s verdict came from, and what asking it live cost when that is known', () => {
    const s = Store.open(':memory:');
    const judged = (name: string, source: 'recording' | 'live', cost: number | null) => ({ ok: true, status: 'passed' as const, label: `judge "${name}" answers yes`, detail: null, reason: 'It names the limit.', source, judge: { name, model: 'claude-haiku-4-5', of: 'answer' as const, verdict: 'yes' as const, source, cost, redactions: 0, cut: 0 } });
    const summary = (o: { live: number; replayed?: number; spent: number; unknownModels?: string[] }) => ({ calls: o.live + (o.replayed ?? 0), replayed: o.replayed ?? 0, live: o.live, notAsked: 0, upstreamRequests: o.live, spent: o.spent, saved: 0, unknownModels: o.unknownModels ?? [] });
    const list = [
      golden('goldens/replayed', 'replay', ['judge "polite" answers yes']),
      golden('goldens/forked', 'fork', ['judge "polite" answers yes']),
      golden('goldens/priceless', 'fork', ['judge "polite" answers yes']),
      golden('goldens/two', 'fork', ['judge "polite" answers yes', 'judge "brief" answers yes']),
    ];
    session(s, 'd2e8a1f', T0, [
      { golden: 'goldens/replayed', ok: true, runId: 'R1', data: { mode: 'replay', verdict: 'passed', checks: [judged('polite', 'recording', 0)], judge: summary({ live: 0, replayed: 1, spent: 0 }) } },
      // Five attempts, the judge asked live in each: the summary's spend is its own.
      { golden: 'goldens/forked', ok: true, runId: 'R2', data: { mode: 'fork', verdict: 'passed', checks: [judged('polite', 'live', 0.0004)], judge: summary({ live: 5, spent: 0.0021 }), attempts: { total: 5, passed: 5, required: null, runs: [] } } },
      { golden: 'goldens/priceless', ok: true, runId: 'R3', data: { mode: 'fork', verdict: 'passed', checks: [judged('polite', 'live', null)], judge: summary({ live: 1, spent: 0, unknownModels: ['claude-haiku-4-5'] }) } },
      // Two judges in one attempt: each check's own call says what it cost.
      { golden: 'goldens/two', ok: true, runId: 'R4', data: { mode: 'fork', verdict: 'passed', checks: [judged('polite', 'live', 0.0004), judged('brief', 'recording', 0)], judge: summary({ live: 1, replayed: 1, spent: 0.0004 }) } },
    ]);
    const rows = new Map(testsView(s, list).rows.map((r) => [r.name, r.checkResults.map((c) => [c.source, c.live])]));
    expect(rows.get('replayed')).toEqual([['recording', null]]);
    expect(rows.get('forked')).toEqual([['live', { cost: 0.0021, asked: 5 }]]);
    expect(rows.get('priceless')).toEqual([['live', null]]);
    expect(rows.get('two')).toEqual([
      ['live', { cost: 0.0004, asked: 1 }],
      ['recording', null],
    ]);
    s.close();
  });

  it('reads what the pack holds for a judge from why it wasn\'t judged, and offers Update golden only where that is what\'s missing', () => {
    const s = Store.open(':memory:');
    const list = ['older', 'material', 'unknown'].map((name) => golden(`goldens/${name}`, 'replay', [judgeLabel]));
    const why = {
      older: "not judged: the recording's verdict was given to an older form of the judge's request, and the test runs offline: record it again with shadowlap test --update",
      material: 'not judged: the recording\'s verdict was given on other material: it read "order 8f3a, and more" where it now reads "order 1b2c, and more", and the test runs offline',
      unknown: "not judged: Shadowlap can't tell which provider serves my-judge",
    };
    session(
      s,
      'd2e8a1f',
      T0,
      Object.entries(why).map(([name, detail], i) => ({ golden: `goldens/${name}`, ok: false, failure: 'inconclusive' as never, runId: `R${i}`, data: { mode: 'replay' as const, verdict: 'inconclusive' as const, checks: [{ ...offline, detail }] } })),
    );
    const judges = new Map(testsView(s, list).inconclusive.map((v) => [v.name, v.judge]));
    expect(judges.get('older')).toMatchObject({ held: 'older', changed: null, update: ['test', 'goldens/older', '--update'] });
    // Where it differs, its quoted values whole, commas and all.
    expect(judges.get('material')).toMatchObject({ held: 'material', changed: 'it read "order 8f3a, and more" where it now reads "order 1b2c, and more"', update: ['test', 'goldens/material', '--update'] });
    // An update can't ask a judge whose provider no one can tell.
    expect(judges.get('unknown')).toMatchObject({ held: null, changed: null, update: null });
    s.close();
  });
});
