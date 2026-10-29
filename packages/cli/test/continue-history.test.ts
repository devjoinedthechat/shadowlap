import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BASELINE_DEFAULTS, Store, gateOdds, gateResult, planSuite, type BaselineGate } from '@shadowlap/engine';
import { carryFor, withLimit } from '../src/golden-test.js';

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

  it('keeps the record bound when --max-attempts or Run more attempts raises a gate the plan held at 40, so a regressed agent continued past it all but never passes', () => {
    // A golden of 20 whose last 10 sessions sit below the 20 before them beyond chance: a drop, held at 40.
    const base = { passes: 48, attempts: 50 };
    const plan = planSuite([{ golden: 'goldens/g', gate: { kind: 'baseline', ...BASELINE_DEFAULTS }, maxGiven: false, history: base, sessions: { passes: 40, attempts: 56 }, record: { passes: 145, attempts: 168, sessions: 30 } }], { risk: 0.05 / 20 })!.planned[0];
    expect(plan.drop).toBeDefined();
    expect(plan.gate.max).toBe(40);
    const raised = withLimit(plan.gate, 160) as BaselineGate;
    expect(raised).toMatchObject({ max: 160, widened: { from: 40, record: { passes: 105, attempts: 112, sessions: 20 }, before: 10, risk: 0.05 } });
    // Of the agents at 75% still undecided at 40, those that pass by 160: 17.9% under the plain rule,
    // 0.15% held to the sessions before the drop (93.75%, from which 75% is a drop of 18.75 points).
    const at40 = gateOdds(plan.gate, 0.75, base);
    const { widened: _bound, ...unbound } = raised;
    const plain = gateOdds(unbound, 0.75, base);
    const held = gateOdds(raised, 0.75, base);
    expect((plain.pass - at40.pass) / at40.inconclusive).toBeCloseTo(0.1793, 3);
    expect((held.pass - at40.pass) / at40.inconclusive).toBeLessThan(0.002);
  });
});
