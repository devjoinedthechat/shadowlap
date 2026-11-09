import { describe, expect, it } from 'vitest';
import { recordEvent, Store, type StoredCheck, type TestFailure, type TestResult } from '@shadowlap/engine';
import { checksChanged } from '../src/tests-checks.js';
import { failingTests, testsView, type GoldenSource } from '../src/tests.js';

/**
 * A golden's checks on Tests against its entry as it is now: the checks its last result failed or
 * couldn't decide that the config no longer holds, and when the check builder added a check since.
 */
const T0 = Date.UTC(2026, 10, 9, 10, 0);
const failed = (label: string, detail = 'called 1 time'): StoredCheck => ({ status: 'failed', ok: false, label, detail });
const passed = (label: string): StoredCheck => ({ status: 'passed', ok: true, label, detail: null });
const undecided = (label: string): StoredCheck => ({ status: 'inconclusive', ok: false, label, detail: 'not judged: no recorded verdict and the test runs offline' });
const result = (ok: boolean, failure: TestFailure | undefined, checks: StoredCheck[]): Pick<TestResult, 'ok' | 'failure' | 'data'> => ({ ok, ...(failure ? { failure } : {}), data: { mode: 'replay', checks } }) as Pick<TestResult, 'ok' | 'failure' | 'data'>;

describe('the checks changed since a golden’s last test', () => {
  it('are the checks it failed or couldn’t decide that the config no longer holds', () => {
    const r = result(false, 'check', [failed('issue_refund called 0 times'), passed('escalate called 1 time'), failed('send_email called 0 times')]);
    expect(checksChanged(r, ['escalate called 1 time', 'send_email called 0 times'])).toEqual([{ label: 'issue_refund called 0 times', status: 'failed' }]);
    // A changed check reads as another: the old label is gone.
    expect(checksChanged(r, ['issue_refund called at most 1 time', 'escalate called 1 time', 'send_email called 0 times'])).toEqual([{ label: 'issue_refund called 0 times', status: 'failed' }]);
    expect(checksChanged(result(false, 'inconclusive', [passed('escalate called 1 time'), undecided('judge "calm" answers yes')]), ['escalate called 1 time'])).toEqual([{ label: 'judge "calm" answers yes', status: 'inconclusive' }]);
  });

  it('are none while the result’s failed checks are all still there, or when only a passed check left', () => {
    const r = result(false, 'check', [failed('issue_refund called 0 times'), passed('escalate called 1 time')]);
    expect(checksChanged(r, ['issue_refund called 0 times', 'escalate called 1 time'])).toBeNull();
    expect(checksChanged(r, ['issue_refund called 0 times'])).toBeNull();
    expect(checksChanged(r, ['issue_refund called 0 times', 'escalate called 1 time', 'send_email called 0 times'])).toBeNull();
  });

  it('are none for a result that passed, or failed for a reason other than its checks, which keeps its own step', () => {
    const checks = [failed('issue_refund called 0 times')];
    expect(checksChanged(result(true, undefined, [passed('issue_refund called 0 times')]), [])).toBeNull();
    for (const failure of ['diverged', 'exit', 'no-calls', 'error', 'injection', 'guard'] as const) expect(checksChanged(result(false, failure, checks), [])).toBeNull();
    expect(checksChanged(null, [])).toBeNull();
  });
});

describe('a golden row on Tests', () => {
  const golden = (checks: string[]): GoldenSource => ({ path: 'goldens/refund-flow', runId: 'GOLDEN', packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks });
  function store(checks: StoredCheck[], failure?: TestFailure) {
    const s = Store.open(':memory:');
    s.createRun({ runId: 'GOLDEN', mode: 'replay', command: { argv: ['node', 'agent.mjs'], cwd: '/p' } });
    const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', actor: 'ci', startedAt: T0 });
    s.addTestResult({ sessionId: session.sessionId, golden: 'goldens/refund-flow', ok: !failure, ...(failure ? { failure } : {}), reason: failure ? 'check failed' : null, runId: 'R1', revision: 'd2e8a1f', at: T0 + 1, data: { mode: 'replay', calls: { total: 4, replayed: 4, live: 0, blocked: 0, stubbed: 0 }, checks } });
    s.finishTestSession(session.sessionId, { passed: failure ? 0 : 1, failed: failure ? 1 : 0, upstreamRequests: 0, endedAt: T0 + 100 });
    return s;
  }

  it('says which checks changed since its last test', () => {
    const s = store([failed('issue_refund called 0 times'), passed('escalate called 1 time')], 'check');
    expect(testsView(s, [golden(['escalate called 1 time'])]).rows[0].changed).toEqual([{ label: 'issue_refund called 0 times', status: 'failed' }]);
    expect(testsView(s, [golden(['issue_refund called 0 times', 'escalate called 1 time'])]).rows[0].changed).toBeNull();
  });

  it('says when the builder added a check since its last test, from the newest event that added it', () => {
    const s = store([passed('escalate called 1 time')]);
    // Before the last result, the check it added was judged then; another golden's says nothing here.
    recordEvent(s, { kind: 'checks.changed', ref: 'goldens/refund-flow', at: T0 - 60_000, data: { key: 'goldens/refund-flow', added: ['escalate called 1 time'], removed: [] } });
    recordEvent(s, { kind: 'checks.changed', ref: 'goldens/refund-flow', at: T0 + 60_000, data: { key: 'goldens/refund-flow', added: ['send_email called 0 times'], removed: [] } });
    recordEvent(s, { kind: 'checks.changed', ref: 'goldens/refund-flow', at: T0 + 120_000, data: { key: 'goldens/refund-flow', added: ['send_email called 0 times'], removed: ['send_email called 0 times'] } });
    recordEvent(s, { kind: 'checks.changed', ref: 'goldens/other', at: T0 + 180_000, data: { key: 'goldens/other', added: ['cost at most $0.02'], removed: [] } });
    const [row] = testsView(s, [golden(['escalate called 1 time', 'send_email called 0 times', 'cost at most $0.02'])]).rows;
    expect(row.checkResults.map((c) => [c.label, c.added, c.addedAt])).toEqual([
      ['escalate called 1 time', false, null],
      ['send_email called 0 times', true, T0 + 120_000],
      // Added in an editor: since its last test, with no time.
      ['cost at most $0.02', true, null],
    ]);
  });

  it('words the verdict of a golden whose checks changed since by its base, and leads Needs a look with Run tests', () => {
    const s = store([failed('issue_refund called 0 times'), passed('escalate called 1 time')], 'check');
    const stale = [golden(['escalate called 1 time'])];
    expect(testsView(s, stale).verdict!.title).toContain('refund-flow failed its check, its checks changed since');
    expect(failingTests(s, { goldens: stale })[0].next).toBe('run-tests');
    // Its checks as they were: the check's own words, and its failing steps.
    const same = [golden(['issue_refund called 0 times', 'escalate called 1 time'])];
    expect(testsView(s, same).verdict!.title).not.toContain('changed since');
    expect(failingTests(s, { goldens: same })[0].next).not.toBe('run-tests');
  });

  it('has every mark again once a session judged its checks as they are now: nothing added, nothing changed since', () => {
    const s = store([failed('issue_refund called 0 times'), passed('escalate called 1 time')], 'check');
    const now = [golden(['escalate called 1 time', 'send_email called 0 times'])];
    expect(testsView(s, now).rows[0]).toMatchObject({ changed: [{ label: 'issue_refund called 0 times', status: 'failed' }], checkResults: [{ status: 'passed', added: false }, { status: null, added: true }] });
    // The next session judges the checks the entry holds now, as `shadowlap test` reads each entry when it runs it.
    const again = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'e3f9b20', actor: 'ci', startedAt: T0 + 10 * 60_000 });
    s.addTestResult({ sessionId: again.sessionId, golden: 'goldens/refund-flow', ok: true, reason: null, runId: 'R2', revision: 'e3f9b20', at: T0 + 10 * 60_000 + 1, data: { mode: 'replay', calls: { total: 4, replayed: 4, live: 0, blocked: 0, stubbed: 0 }, checks: [passed('escalate called 1 time'), passed('send_email called 0 times')] } });
    s.finishTestSession(again.sessionId, { passed: 1, failed: 0, upstreamRequests: 0, endedAt: T0 + 10 * 60_000 + 100 });
    const row = testsView(s, now).rows[0];
    expect(row.changed).toBeNull();
    expect(row.checkResults.map((c) => [c.label, c.status, c.added, c.addedAt])).toEqual([
      ['escalate called 1 time', 'passed', false, null],
      ['send_email called 0 times', 'passed', false, null],
    ]);
    expect(failingTests(s, { goldens: now })).toEqual([]);
  });
});
