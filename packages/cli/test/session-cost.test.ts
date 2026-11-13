import { describe, expect, it } from 'vitest';
import { Store, storeView, type CallRecord } from '@shadowlap/engine';
import { keepCostPerRun, sessionCostPerRun } from '../src/session-cost.js';
import type { PackResult } from '../src/test-report.js';

/**
 * What a run of a session's goldens costs, kept with the session for the pull request comment: each
 * golden's recording and this session's replay of it, priced as each would run live, the mean over
 * the goldens whose replay ran to its end.
 */

/** A model call as the store keeps it, with what it used: 1,000 input and 100 output tokens of claude-sonnet-4-5 is $0.0045. */
const call = (model: string, input = 1_000, output = 100) => ({ kind: 'api', callNo: 1, meta: { model }, end: { outcome: 'ok', meta: { model, usage: { inputTokens: input, outputTokens: output } } } }) as unknown as CallRecord;

/** A store that has each run's calls, as `getCalls` reads them. */
const runs = (calls: Record<string, CallRecord[]>) => ({ getCalls: (runId: string) => calls[runId] ?? [] }) as unknown as Store;

const result = (o: Partial<PackResult>): PackResult => ({ name: 'g', dir: 'goldens/g', golden: 'goldens/g', mode: 'replay', ok: true, verdict: 'passed', failure: null, runId: 'replay', goldenRunId: 'recording', ...o }) as PackResult;

describe("a session's cost per run", () => {
  it('compares a fork golden as recorded with its replay, which went live after the fork', () => {
    const store = runs({ recording: [call('claude-sonnet-4-5'), call('claude-sonnet-4-5')], replay: [call('claude-sonnet-4-5'), call('claude-sonnet-4-5', 2_000, 300)] });
    const cost = sessionCostPerRun(store, [result({ mode: 'fork' })]);
    expect(cost!.before).toBeCloseTo(0.009, 6);
    expect(cost!.after).toBeCloseTo(0.015, 6);
  });

  it('costs a replay that passed what its recording costs, and takes the mean over the goldens', () => {
    const store = runs({ a: [call('claude-sonnet-4-5')], 'a-replay': [call('claude-sonnet-4-5')], b: [call('claude-sonnet-4-5', 3_000, 100)], 'b-replay': [call('claude-sonnet-4-5', 3_000, 100)] });
    const cost = sessionCostPerRun(store, [result({ golden: 'goldens/a', goldenRunId: 'a', runId: 'a-replay' }), result({ golden: 'goldens/b', goldenRunId: 'b', runId: 'b-replay' })]);
    expect(cost!.before).toBeCloseTo(0.0075, 6);
    expect(cost!.after).toBe(cost!.before);
  });

  it("leaves out a golden whose replay stopped short, and keeps nothing when no model has a price", () => {
    const store = runs({ recording: [call('claude-sonnet-4-5')], replay: [call('claude-sonnet-4-5')], cut: [], unknown: [call('a-model-no-one-prices')], 'unknown-replay': [call('a-model-no-one-prices')] });
    // A replay that diverged, or whose agent exited, never ran to its end: its cost says nothing of a run.
    expect(sessionCostPerRun(store, [result({ ok: false, verdict: 'failed', failure: 'diverged', runId: 'cut' })])).toBeNull();
    expect(sessionCostPerRun(store, [result({ ok: false, verdict: 'failed', failure: 'exit', runId: 'cut' })])).toBeNull();
    // A failed check still ran it whole.
    expect(sessionCostPerRun(store, [result({ ok: false, verdict: 'failed', failure: 'check' })])).not.toBeNull();
    expect(sessionCostPerRun(store, [result({ goldenRunId: 'unknown', runId: 'unknown-replay' })])).toBeNull();
    // Prices from the config price it.
    expect(sessionCostPerRun(store, [result({ goldenRunId: 'unknown', runId: 'unknown-replay' })], { 'a-model-no-one-prices': { input: 1, output: 10 } })).toEqual({ before: 0.002, after: 0.002 });
  });

  it('keeps it with the session, leaving the decisions part as it was, and keeps nothing without one', () => {
    const store = Store.open(':memory:');
    try {
      const session = store.startTestSession({ command: ['test'], owner: null });
      store.setTestSessionComment(session.sessionId, { decisions: 'dc-01K9A3RZ5E6G4N2V8XWQJ7T1BM' });
      const fake = storeView(store, { getCalls: runs({ recording: [call('claude-sonnet-4-5')], replay: [call('claude-sonnet-4-5', 2_000)] }).getCalls });
      const near = { before: expect.closeTo(0.0045, 9) as number, after: expect.closeTo(0.0075, 9) as number };
      expect(keepCostPerRun(fake, session.sessionId, [result({})])).toEqual(near);
      expect(store.getTestSession(session.sessionId)?.comment).toEqual({ decisions: 'dc-01K9A3RZ5E6G4N2V8XWQJ7T1BM', costPerRun: near });
      const none = store.startTestSession({ command: ['test'], owner: null });
      expect(keepCostPerRun(fake, none.sessionId, [result({ runId: null })])).toBeNull();
      expect(store.getTestSession(none.sessionId)?.comment).toBeNull();
    } finally {
      store.close();
    }
  });
});
