import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateResult, Store, type BaselineGate, type SprtGate, type TestResultData } from '@shadowlap/engine';
import { startDashboard, type GoldenSource } from '../src/index.js';
import { evidenceWords, TESTS_EVIDENCE_READS } from '../src/tests-evidence.js';
import { addRun } from './read-model-store.js';

/**
 * The evidence behind a gated golden's verdict (tests-evidence.ts): why its gate stopped where it did,
 * worded from the figures its result kept, as the mock words it, and its attempts, each judged from its
 * own run, those carried over first, read in the pool by GET /api/tests/evidence.
 */

const T0 = 1_790_000_000_000;
const GOLDEN = 'goldens/eval-damaged-order';
const SPRT: SprtGate = { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 };
const HISTORY: BaselineGate = { kind: 'baseline', drop: 0.15, risk: 0.05, window: 10, min: 5, max: 40 };
const T = true;
const F = false;

describe('the evidence’s words', () => {
  it('says why an SPRT stopped, from the score the result kept', () => {
    const passed = evidenceWords(gateResult(SPRT, Array<boolean>(12).fill(T)), 3)!;
    expect(passed).toMatchObject({
      why: 'Stopped at attempt 12: the score reached +3.02, past +3.00, where it passes.',
      carriedNote: '',
      hiLabel: 'passes at +3.00',
      loLabel: 'fails at −3.00',
      start: '',
      end: 'attempt 12',
      step: 'a pass adds 0.25, a failure −1.10',
      forked: 'forked at call 3, each attempt live from there',
      head: 'passed at attempt 12',
      tip: 'the score after each attempt: a pass adds 0.25, a failure −1.10; it passes at +3.00 and fails at −3.00',
    });
    expect(passed.row).toEqual(['pass^5', passed.passK]);
    expect(passed.passK).toMatch(/^\d\.\d\d$/);
    expect(evidenceWords(gateResult(SPRT, [F, F, F]), null)).toMatchObject({ why: 'Stopped at attempt 3: the score fell to −3.30, past −3.00, where it fails.', passK: '', row: null, forked: '' });
  });

  it('says a gate ran out at its limit, and what Run more attempts carried over', () => {
    const ten: SprtGate = { ...SPRT, max: 10 };
    const outcomes = [T, F, T, T, T, T, T, T, T, F];
    expect(evidenceWords(gateResult(ten, outcomes), null)).toMatchObject({
      why: 'Ran out at attempt 10, the most it runs: the score ended at −0.19, between −3.00 and +3.00, where neither verdict holds.',
      end: 'attempt 10, its limit',
      head: 'inconclusive after 10 attempts',
    });
    const carried = evidenceWords(gateResult(ten, outcomes, { carried: 4 }), null)!;
    expect(carried.carriedNote).toBe(' Attempts 1–4 were carried over; its limit was raised to 10 for that session only.');
    expect(carried.tip).toMatch(/, up to 10 attempts$/);
    // stopped short of its limit and of either bound (a signal): it never says it ran out
    expect(evidenceWords(gateResult(SPRT, [T, F, T], { decision: 'inconclusive' }), null)!.why).toBe('Stopped at attempt 3 before either bound: the score was −0.60, between −3.00 and +3.00.');
  });

  it('says why a gate against history stopped, its baseline and its first decision as the hover says them', () => {
    const history = { passes: 47, attempts: 50, sessions: 10 };
    const passed = evidenceWords(gateResult(HISTORY, Array<boolean>(5).fill(T), { history }), null)!;
    expect(passed.why).toMatch(/^Stopped at attempt 5: the chance of a drop was 0\.\d\d, at 0\.50 or less, where it passes\.$/);
    expect(passed).toMatchObject({ hiLabel: 'fails above 0.95', loLabel: 'passes at 0.50', start: '', end: 'attempt 5', step: 'it decides from attempt 5 on', row: ['baseline', '47 of 50 over its last 10 sessions'] });
    expect(passed.tip).toBe('the chance of a drop of 15 points or more after each attempt from the 5th: it passes at 0.50 or less and fails above 0.95');
    const failed = evidenceWords(gateResult(HISTORY, [F, F, F, F, F, F], { history: { ...history, sessions: 1 } }), null)!;
    expect(failed.why).toMatch(/^Stopped at attempt 6: the chance of a drop reached [01]\.\d\d, above 0\.95, where it fails\.$/);
    expect(failed).toMatchObject({ start: 'attempt 5', row: ['baseline', '47 of 50 over its last session'] });
    expect(evidenceWords(gateResult({ ...HISTORY, min: 1 }, [T]), null)).toMatchObject({ row: ['baseline', 'its recording, 1 of 1 (no history yet)'], tip: expect.stringContaining('from the 1st:') });
    for (const [min, nth] of [[2, '2nd'], [3, '3rd'], [11, '11th'], [22, '22nd']] as const) expect(evidenceWords(gateResult({ ...HISTORY, min }, [T]), null)!.tip).toContain(`from the ${nth}:`);
  });

  it('says what the provider did as the tally does, and has no words for a clean replay', () => {
    const g = gateResult(SPRT, [T, F, T], { unavailableAt: [1], unavailable: 2, decision: 'inconclusive' });
    expect(evidenceWords(g, null)!.provider).toBe('1 cut short by the provider, counted against either verdict · 2 unavailable, not counted');
    expect(evidenceWords(gateResult(SPRT, [T], { clean: true }), null)).toBeNull();
  });
});

describe('a golden’s attempts', () => {
  let store: Store;
  beforeEach(() => {
    store = Store.open(':memory:');
  });
  afterEach(() => store.close());

  const check = (label: string) => ({ ok: false, label, detail: null });
  /** A session of the golden at `at` whose attempts are `runs`, with `data` besides. */
  const tested = (at: number, runs: string[], data: TestResultData = {}): string => {
    const sessionId = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: at, revision: 'bbbbbbb' }).sessionId;
    store.addTestResult({ sessionId, golden: GOLDEN, ok: true, runId: runs[0] ?? null, goldenRunId: null, revision: 'bbbbbbb', at, data: { attempts: { total: runs.length, passed: 0, required: null, runs }, ...data } });
    return sessionId;
  };
  const read = (golden = GOLDEN) => {
    const a = TESTS_EVIDENCE_READS['tests-evidence'](store, { kind: 'tests-evidence', golden }, { whole: true }) as { status: number; body: string };
    return { status: a.status, body: JSON.parse(a.body) as unknown };
  };

  it('judges each attempt from its own run, those carried over first, and counts the runs gone', () => {
    const ok = (at: number) => addRun(store, { startedAt: at, calls: 'r' });
    const bad = (at: number, label: string) => addRun(store, { startedAt: at, calls: 'r', status: 'failed', meta: { checks: [check(label)] } });
    const [c1, c2] = [ok(T0), bad(T0 + 1, 'issue_refund called 1 time')];
    const earlier = tested(T0 + 10, [c1, c2]);
    const [r1, r2] = [ok(T0 + 20), bad(T0 + 21, 'send_email called 0 times')];
    tested(T0 + 30, [r1, 'gone-run', r2], { gate: gateResult(SPRT, [T, F, T, F], { carried: 2, decision: 'inconclusive' }), continued: { sessions: [earlier], attempts: 2 } });
    const { status, body } = read();
    expect(status).toBe(200);
    expect(body).toEqual({
      attempts: [
        { runId: c1, href: `#/run/${c1}`, outcome: 'passed', note: null },
        { runId: c2, href: `#/run/${c2}`, outcome: 'failed', note: expect.stringContaining('issue_refund') },
        { runId: r1, href: `#/run/${r1}`, outcome: 'passed', note: null },
        { runId: r2, href: `#/run/${r2}`, outcome: 'failed', note: expect.stringContaining('send_email') },
      ],
      carried: 2,
      gone: 1,
    });
  });

  it('answers 404 for a golden no gate decided', () => {
    tested(T0, [addRun(store, { startedAt: T0, calls: 'r' })]);
    expect(read().status).toBe(404);
    expect(read('goldens/never-run').status).toBe(404);
  });

  it('refuses a golden not on disk before it asks the pool', async () => {
    const goldens: GoldenSource[] = [{ path: GOLDEN, runId: null, packedAt: T0, mode: 'fork', repeat: 1, passes: 1, checks: [] }];
    tested(T0, [addRun(store, { startedAt: T0, calls: 'r' })], { gate: gateResult(SPRT, Array<boolean>(12).fill(T)) });
    const d = await startDashboard({ store, goldens: () => goldens });
    try {
      const get = (golden: string) => fetch(`${d.url}/api/tests/evidence?golden=${encodeURIComponent(golden)}`, { headers: { 'x-shadowlap-token': d.token } });
      expect((await get('goldens/elsewhere')).status).toBe(400);
      expect((await get('--update')).status).toBe(400);
      const ok = await get(GOLDEN);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { attempts: unknown[] }).attempts).toHaveLength(1);
    } finally {
      await d.close();
    }
  });
});
