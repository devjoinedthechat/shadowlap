import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BASELINE_DEFAULTS, Store, gateResult, type BaselineGate } from '@shadowlap/engine';
import { carryFor } from '../src/golden-test.js';

/**
 * `test --continue` for a gate against history its session's plan widened past its own max: each
 * session's plan reads the golden's record afresh, so the record a pass past that max is held to
 * changes from session to session, as its limit does, and neither makes it another gate.
 */
const dir = mkdtempSync(join(tmpdir(), 'sl-continue-history-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('test --continue with a gate against history widened past its own max', () => {
  it('carries its attempts over to a session whose plan read another record, or whose limit the config or the command line set', () => {
    const store = Store.open(join(dir, 'continue.db'));
    try {
      const s = store.startTestSession({ command: ['shadowlap', 'test'], revision: 'abc1234' });
      const was: BaselineGate = { kind: 'baseline', ...BASELINE_DEFAULTS, risk: 0.0025, max: 60, widened: { from: 40, record: { passes: 150, attempts: 170, sessions: 30 }, risk: 0.05 } };
      // 60 attempts, 48 of them passed, that never settled it.
      const outcomes = Array.from({ length: 60 }, (_, i) => i % 5 !== 2);
      const gate = gateResult(was, outcomes, { history: { passes: 47, attempts: 50, sessions: 10 }, decision: 'inconclusive' });
      expect(gate).toMatchObject({ decision: 'inconclusive', widened: was.widened });
      store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/g', ok: false, failure: 'inconclusive', goldenRunId: 'R0', data: { verdict: 'inconclusive', gate } });
      const later: BaselineGate = { ...was, max: 120, widened: { from: 40, record: { passes: 152, attempts: 176, sessions: 30 }, risk: 0.05 } };
      const set: BaselineGate = { kind: 'baseline', ...BASELINE_DEFAULTS, risk: 0.0025, max: 120 };
      for (const now of [later, set]) expect(carryFor(store, 'goldens/g', { goldenRunId: 'R0', checks: [], gate: now, limit: 120 })).toMatchObject({ carry: { sessions: [s.sessionId], outcomes } });
      // Another drop is another gate.
      expect(carryFor(store, 'goldens/g', { goldenRunId: 'R0', checks: [], gate: { ...later, drop: 0.2 }, limit: 120 })).toEqual({ why: 'its gate changed since its last result' });
    } finally {
      store.close();
    }
  });
});
