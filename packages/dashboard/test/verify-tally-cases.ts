import { decideVerify, gateResult, type VerifiedRun, type VerifyAttempt, type VerifyReport, type VerifyTally } from '@shadowlap/engine';
import { makeRun, verifyReport } from '../../engine/test/fix-fixtures.js';

/**
 * Runs verify took, one of each kind its tally words apart, with the words `shadowlap verify` prints
 * for each: for the parity of its line with the dashboard's (verify-tally.test.ts) and with the Verify
 * step's Attempts cells (ui-fix-steps.test.ts).
 */

type FixtureStore = Parameters<typeof makeRun>[0];

export const GATE = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 80 };
const KEPT = { margin: 0.1, risk: 0.05, max: 200, source: 'paired' as const, revision: '35034be' };
const footprint = { inputTokens: 1000, outputTokens: 10, cost: 0.001 };

let n = 0;
/** An attempt as verify keeps it: passed unless `o` says otherwise. */
export function attempt(o: Partial<VerifyAttempt> = {}): VerifyAttempt {
  const passed = o.passed ?? true;
  return { runId: `01M7A${String(n++).padStart(4, '0')}`.padEnd(26, '0'), passed, verdict: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1, failures: passed ? [] : ['issue_refund called'], forkedAt: 3, spent: 0.001, upstreamRequests: 2, footprint, ...o };
}
export const passing = (k: number): VerifyAttempt[] => Array.from({ length: k }, () => attempt());

/** A run of the store that verify took in `role`, with its attempts' passes. */
export function verifiedRun(store: FixtureStore, role: VerifiedRun['role'], attempts: VerifyAttempt[], o: Partial<VerifiedRun> = {}): VerifiedRun {
  const runId = makeRun(store, { labels: [role === 'good' ? 'good' : 'refund-bug'], ...(role === 'good' ? { status: 'completed' as const } : {}) });
  return { runId, role, attempts, passes: attempts.filter((a) => a.passed).length, deterministic: false, verdict: 'pass', recorded: { passed: role === 'good', failures: [], footprint }, ...o };
}

export interface TallyCase {
  kind: string;
  run: VerifiedRun;
  /** Its outcome, as the dashboard words it. */
  word: string;
  parts: VerifyTally;
  /** Its tally as verify prints it. */
  line: string;
}

/** A gated run, one with an attempt the provider cut short, one the provider stopped unavailable, one kept against its baseline, and one an attempt it couldn't judge stopped after one the provider cut short. */
export function tallyCases(store: FixtureStore): TallyCase[] {
  const twelve = passing(12);
  const gated = gateResult(GATE, twelve.map((a) => a.passed));
  const cut = [...passing(17), attempt({ passed: false, verdict: 'inconclusive', cutShort: true })];
  const cutGate = gateResult(GATE, cut.map((a) => a.passed), { unavailableAt: [17] });
  const CUT = '1 cut short by the provider, counted against either verdict';
  return [
    { kind: 'gated', run: verifiedRun(store, 'target', twelve, { decision: gated.decision, gate: gated }), word: 'fixed', parts: { tally: '12 of 12 passed', undecided: null, cutShort: null, bound: 'rate >= 0.73 (95%)' }, line: '12 of 12 passed · rate >= 0.73 (95%)' },
    { kind: 'cut short', run: verifiedRun(store, 'target', cut, { decision: cutGate.decision, gate: cutGate, cutShort: 1 }), word: 'fixed', parts: { tally: '17 of 18 passed', undecided: null, cutShort: CUT, bound: 'rate >= 0.60 (95%)' }, line: `17 of 18 passed (${CUT}) · rate >= 0.60 (95%)` },
    {
      kind: 'unavailable',
      run: verifiedRun(store, 'target', [...passing(2), attempt({ passed: false, verdict: 'inconclusive', unavailable: true })], { verdict: 'open', decision: 'inconclusive', undecided: 'provider unavailable: 3 attempts in a row ended on HTTP 529', unavailable: 3 }),
      word: 'inconclusive',
      parts: { tally: '2 of 2 passed', undecided: 'the provider unavailable', cutShort: null, bound: null },
      line: '2 of 2 passed, the provider unavailable',
    },
    {
      kind: 'baseline',
      run: verifiedRun(store, 'good', passing(38), { decision: 'pass', baseline: { passes: 38, attempts: 38, source: 'paired', revision: '35034be' }, margin: 0.1, drop: { lo: -0.06, hi: 0.1, confidence: 0.95, method: 'betting' } }),
      word: 'kept',
      parts: { tally: '38 of 38 passed, baseline 38 of 38', undecided: null, cutShort: null, bound: 'drop <= 0.10 (95%)' },
      line: '38 of 38 passed, baseline 38 of 38 · drop <= 0.10 (95%)',
    },
    // The attempt the provider cut short counts, against either verdict: 2 of 3, never 2 of 2.
    {
      kind: 'undecided after a cut-short attempt',
      run: verifiedRun(store, 'target', [...passing(2), attempt({ passed: false, verdict: 'inconclusive', cutShort: true }), attempt({ passed: false, verdict: 'inconclusive' })], { verdict: 'open', undecided: 'judge "polite" could not answer: it timed out', cutShort: 1 }),
      word: 'inconclusive',
      parts: { tally: '2 of 3 passed', undecided: 'attempt 4 not judged', cutShort: null, bound: null },
      line: '2 of 3 passed, attempt 4 not judged',
    },
  ];
}

/** A report of `runs`, decided as verify decides it, under the gate and the baseline's rule. */
export function reportOf(runs: VerifiedRun[]): VerifyReport {
  return { ...verifyReport([]), ...decideVerify(runs, null), runs, gate: GATE, kept: KEPT, attemptsPerRun: GATE.max, needed: 0, attempts: runs.reduce((s, x) => s + x.attempts.length, 0) };
}
