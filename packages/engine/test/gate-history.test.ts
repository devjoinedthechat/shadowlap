import { describe, expect, it } from 'vitest';
import { attemptsOf, gateHistory, judgedUnder, notBaseline, testResultVerdict } from '../src/gate-history.js';
import { Store, type TestFailure, type TestResultData } from '../src/store.js';

/**
 * A golden's baseline for a gate against history: its last sessions' attempts, pooled, only those
 * that speak to the agent as it is tested now, and only those that are a standard to keep: the
 * golden passed, on the baseline branch, outside any pull request, on a committed revision.
 */
const T0 = Date.UTC(2026, 9, 1);
const CHECKS = [{ ok: true, label: 'issue_refund called 0 times', detail: null }];
/** Where a session on the default branch ran: what a baseline is made of. */
const MAIN: Partial<TestResultData> = { branch: 'main', pullRequest: false, baselineBranch: 'main', revision: 'a1b2c3d' };
const fork = (passed: number, total: number, extra: Partial<TestResultData> = {}): TestResultData => ({ mode: 'fork', checks: CHECKS, attempts: { total, passed, required: null, runs: [] }, ...MAIN, verdict: 'passed', ...extra });

function store(results: Array<{ ok: boolean; at: number; data?: TestResultData | null; failure?: TestFailure; goldenRunId?: string; golden?: string; revision?: string }>): { store: Store; sessions: string[] } {
  const s = Store.open(':memory:');
  const sessions = results.map((r) => {
    const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: r.at, owner: null });
    s.addTestResult({ sessionId: session.sessionId, golden: r.golden ?? 'goldens/refund', ok: r.ok, ...(r.failure ? { failure: r.failure } : {}), goldenRunId: r.goldenRunId ?? 'REC', at: r.at, revision: r.revision ?? 'a1b2c3d', data: r.data ?? null });
    return session.sessionId;
  });
  return { store: s, sessions };
}

describe('attemptsOf', () => {
  it('reads the attempts a result kept, and one attempt for a result kept before attempts were', () => {
    expect(attemptsOf({ ok: false, failure: 'check', data: fork(3, 5) })).toEqual({ passes: 3, attempts: 5 });
    expect(attemptsOf({ ok: true, failure: null, data: { mode: 'fork' } })).toEqual({ passes: 1, attempts: 1 });
    expect(attemptsOf({ ok: false, failure: 'check', data: null })).toEqual({ passes: 0, attempts: 1 });
  });

  it('counts no attempt a check couldn\'t judge, and nothing for a golden that couldn\'t run', () => {
    expect(attemptsOf({ ok: false, failure: 'inconclusive', data: fork(2, 3, { attempts: { total: 3, passed: 2, required: null, runs: [], inconclusive: 1 } }) })).toEqual({ passes: 2, attempts: 2 });
    expect(attemptsOf({ ok: false, failure: 'error', data: { mode: 'fork' } })).toBeNull();
  });
});

describe('testResultVerdict', () => {
  it('reads the verdict a result kept, and for one kept before verdicts were, its ok and failure', () => {
    // An inconclusive gate shows a failing attempt and is not ok, but its verdict is its own.
    expect(testResultVerdict({ ok: false, failure: 'inconclusive', data: fork(8, 12, { verdict: 'inconclusive' }) })).toBe('inconclusive');
    expect(testResultVerdict({ ok: false, failure: 'injection', data: { verdict: 'inconclusive' } })).toBe('inconclusive');
    expect(testResultVerdict({ ok: false, failure: 'check', data: { verdict: 'failed' } })).toBe('failed');
    expect(testResultVerdict({ ok: true, failure: null, data: null })).toBe('passed');
    expect(testResultVerdict({ ok: false, failure: 'inconclusive', data: null })).toBe('inconclusive');
    expect(testResultVerdict({ ok: false, failure: 'diverged', data: null })).toBe('failed');
  });
});

describe('gateHistory', () => {
  it('pools the last window sessions, newest first, leaving out the one deciding now', () => {
    const { store: s, sessions } = store([
      { ok: true, at: T0, data: fork(5, 5) },
      { ok: true, at: T0 + 1, data: fork(4, 5) },
      { ok: true, at: T0 + 2, data: fork(9, 10) },
      { ok: true, at: T0 + 3, data: fork(5, 5) },
    ]);
    const h = gateHistory(s, 'goldens/refund', { window: 2, mode: 'fork', checks: ['issue_refund called 0 times'], goldenRunId: 'REC', excludeSession: sessions[3] });
    expect(h).toMatchObject({ passes: 13, attempts: 15, sessions: 2 });
    expect(h.pooled.map((x) => x.sessionId)).toEqual([sessions[2], sessions[1]]);
    expect(gateHistory(s, 'goldens/refund', { window: 10 })).toMatchObject({ passes: 23, attempts: 25, sessions: 4 });
    s.close();
  });

  it('pools only sessions that passed, on the baseline branch, for no pull request, on a committed revision', () => {
    const { store: s, sessions } = store([
      { ok: true, at: T0, data: fork(5, 5) },
      // A session the golden failed: a regression's, which must never become the standard.
      { ok: false, at: T0 + 1, failure: 'check', data: fork(1, 5, { verdict: 'failed' }) },
      // Inconclusive is no pass either.
      { ok: false, at: T0 + 2, failure: 'inconclusive', data: fork(30, 40, { verdict: 'inconclusive' }) },
      // A pull request's, and a feature branch's, which passed: not the baseline branch's.
      { ok: true, at: T0 + 3, data: fork(5, 5, { branch: 'fix-refunds', pullRequest: true }) },
      { ok: true, at: T0 + 4, data: fork(5, 5, { branch: 'fix-refunds' }) },
      // Uncommitted changes on main: not main's code.
      { ok: true, at: T0 + 5, data: fork(5, 5), revision: 'a1b2c3d+dirty' },
      // Kept before sessions said where they ran.
      { ok: true, at: T0 + 6, data: { mode: 'fork', checks: CHECKS, attempts: { total: 5, passed: 5, required: null, runs: [] }, verdict: 'passed' } },
      { ok: true, at: T0 + 7, data: fork(4, 5) },
    ]);
    const h = gateHistory(s, 'goldens/refund', { window: 10, branch: 'main' });
    expect(h.pooled.map((x) => x.sessionId)).toEqual([sessions[7], sessions[0]]);
    expect(h).toMatchObject({ passes: 9, attempts: 10, sessions: 2 });
    // Each result's own baseline branch, when the caller names none; none known, nothing pools.
    expect(gateHistory(s, 'goldens/refund', { window: 10 }).sessions).toBe(2);
    expect(gateHistory(s, 'goldens/refund', { window: 10, branch: null }).sessions).toBe(0);
    // A pull request into a release branch takes that branch's sessions.
    expect(gateHistory(s, 'goldens/refund', { window: 10, branch: 'fix-refunds' }).pooled.map((x) => x.sessionId)).toEqual([sessions[4]]);
    s.close();
  });

  it('says why a result is no baseline', () => {
    const r = (data: Partial<TestResultData>, o: { ok?: boolean; revision?: string } = {}) => ({ ok: o.ok ?? true, failure: o.ok === false ? ('check' as const) : null, revision: o.revision ?? 'abc', data: fork(5, 5, data) });
    expect(notBaseline(r({}), 'main')).toBeNull();
    expect(notBaseline(r({ verdict: 'failed' }, { ok: false }), 'main')).toBe('its golden did not pass');
    expect(notBaseline(r({ pullRequest: true }), 'main')).toBe('its session ran for a pull request');
    expect(notBaseline(r({ branch: 'dev' }), 'main')).toBe('its session ran on dev, not main');
    expect(notBaseline(r({}, { revision: 'abc+dirty' }), 'main')).toBe('its session tested uncommitted changes');
    expect(notBaseline(r({ branch: null }), 'main')).toBe('its session recorded no branch');
    expect(notBaseline(r({}), null)).toBe('no baseline branch is known');
  });

  it('pools only results under the same recording, the same checks and the same mode, that ran', () => {
    const { store: s } = store([
      { ok: true, at: T0, data: fork(5, 5), goldenRunId: 'OLD' },
      { ok: true, at: T0 + 1, data: fork(5, 5, { checks: [{ ok: true, label: 'escalate called 1 time', detail: null }] }) },
      { ok: true, at: T0 + 2, data: { mode: 'replay', checks: CHECKS, ...MAIN } },
      { ok: false, at: T0 + 3, failure: 'error', data: { mode: 'fork', checks: CHECKS, ...MAIN } },
      { ok: true, at: T0 + 4, data: fork(3, 3), golden: 'goldens/other' },
      { ok: true, at: T0 + 5, data: fork(2, 3) },
    ]);
    expect(gateHistory(s, 'goldens/refund', { window: 10, goldenRunId: 'REC', checks: ['issue_refund called 0 times'], mode: 'fork' })).toMatchObject({ passes: 2, attempts: 3, sessions: 1 });
    expect(gateHistory(s, 'goldens/refund', { window: 10, before: T0 + 5 })).toMatchObject({ sessions: 3 });
    s.close();
  });

  it('leaves out every session a continued result carries attempts over from, besides the one deciding now', () => {
    const { store: s, sessions } = store([
      { ok: true, at: T0, data: fork(5, 5) },
      // An inconclusive session continued later, that then passed.
      { ok: true, at: T0 + 1, data: fork(36, 40) },
      { ok: true, at: T0 + 2, data: fork(4, 5) },
    ]);
    expect(gateHistory(s, 'goldens/refund', { window: 10, excludeSession: [sessions[2]!, sessions[1]!] })).toMatchObject({ passes: 5, attempts: 5, sessions: 1 });
    expect(gateHistory(s, 'goldens/refund', { window: 10, excludeSession: sessions[2]! })).toMatchObject({ passes: 41, attempts: 45, sessions: 2 });
    s.close();
  });

  it('is empty for a golden with no history', () => {
    const s = Store.open(':memory:');
    expect(gateHistory(s, 'goldens/new', { window: 10 })).toEqual({ passes: 0, attempts: 0, sessions: 0, pooled: [] });
    s.close();
  });

  it('compares checks by their labels, in any order', () => {
    expect(judgedUnder({ data: { checks: [{ ok: true, label: 'b', detail: null }, { ok: false, label: 'a', detail: 'x' }] } }, ['a', 'b'])).toBe(true);
    expect(judgedUnder({ data: null }, [])).toBe(true);
    expect(judgedUnder({ data: null }, ['a'])).toBe(false);
  });
});
