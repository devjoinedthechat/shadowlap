import { describe, expect, it } from 'vitest';
import { gateResult, sessionUnavailableReason, Store, unavailableReason, type TestResultData } from '@shadowlap/engine';
import { testsView, type GoldenSource } from '../src/tests.js';

/**
 * States of a golden the Tests screen says in its own words: one the provider left undecided, which
 * its verdict names as the provider's, never a check's; and one whose pack can't be read since its
 * last test, which says so over the result it had and offers no search from it.
 */

const T0 = Date.UTC(2026, 8, 20, 10, 0);
const SPRT = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 20 };
const DOWN = { callNo: 3, provider: 'anthropic', status: 529, error: null, retryAfterMs: null, reason: 'HTTP 529 from anthropic at call #3', early: true };

const golden = (path: string, over: Partial<GoldenSource> = {}): GoldenSource => ({ path, runId: 'GOLDEN', packedAt: T0, mode: 'fork', repeat: 1, passes: 1, gate: SPRT, checks: [], ...over });

/** One session at T0 with each result given. */
function store(results: Array<{ golden: string; ok: boolean; failure?: string; reason?: string; data: TestResultData }>): Store {
  const s = Store.open(':memory:');
  const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'e4f5a6b', actor: 'ci', startedAt: T0 });
  results.forEach((r, i) => s.addTestResult({ sessionId: session.sessionId, golden: r.golden, ok: r.ok, ...(r.failure ? { failure: r.failure as never } : {}), reason: r.reason ?? null, runId: `R${i}`, revision: 'e4f5a6b', at: T0 + i + 1, data: r.data }));
  s.finishTestSession(session.sessionId, { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, upstreamRequests: 0, endedAt: T0 + 100 });
  return s;
}

describe('a golden the provider left undecided', () => {
  const title = (reason: string, data: TestResultData) => {
    const s = store([{ golden: 'goldens/escalates', ok: false, failure: 'inconclusive', reason, data }]);
    const view = testsView(s, [golden('goldens/escalates')]);
    s.close();
    return view.verdict?.title;
  };

  it('says the provider was unavailable, whether it stopped the golden while its gate was open or the session before it ran', () => {
    // Its gate still open when the provider was unavailable three attempts in a row (golden-test.ts judgeAttempts).
    const gaveUp: TestResultData = { mode: 'fork', attempts: { total: 2, passed: 2, required: null, runs: [], unavailable: 3 }, verdict: 'inconclusive', gate: gateResult(SPRT, [true, true], { decision: 'continue' }) };
    expect(title(unavailableReason(3, DOWN), gaveUp)).toBe('0 of 1 golden passed · escalates inconclusive: the provider was unavailable');
    // The session's provider stopped it before it ran: no result to keep but the reason (golden-test.ts testGolden).
    const stopped = sessionUnavailableReason(4, DOWN);
    expect(title(stopped, { mode: 'fork', details: stopped })).toBe('0 of 1 golden passed · escalates inconclusive: the provider was unavailable');
  });

  it('says how many attempts the provider cut short where they decide a count either way', () => {
    // In the words test-unavailable.test.ts pins for golden-test.ts failureOf.
    const cut = 'inconclusive: 2 of 3 attempts passed, 1 of them cut short by the provider, 3 needed: counted as failures the count is lost, as passes it is met, so it rests on how they would have ended';
    expect(title(cut, { mode: 'fork', attempts: { total: 3, passed: 2, required: 3, runs: [], cutShort: 1 }, verdict: 'inconclusive' })).toBe('0 of 1 golden passed · escalates inconclusive: 1 attempt cut short by the provider');
  });
});

describe('a golden whose pack can’t be read', () => {
  it('says so over the result it had before, and offers no search from it', () => {
    const diverged: TestResultData = { mode: 'replay', divergence: { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, text: '' } };
    const s = store([{ golden: 'goldens/refund-in-limit', ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', data: diverged }]);
    // Its pack lost its run.json since its last test (readPackHead's words).
    const view = testsView(s, [golden('goldens/refund-in-limit', { runId: null, mode: 'replay', gate: null, error: 'no run.json: not a pack' })]);
    s.close();
    expect(view.rows[0]).toMatchObject({ error: 'no run.json: not a pack', last: { verdict: 'failed', line: "can't be read: no run.json: not a pack" } });
    expect(view.divergences[0]).toMatchObject({ unreadable: 'no run.json: not a pack', bisect: null, revisions: [] });
  });
});
