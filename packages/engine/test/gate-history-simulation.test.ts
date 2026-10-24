import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attemptsOf, gateHistory } from '../src/gate-history.js';
import { BASELINE_DEFAULTS, decide, gateOdds, type BaselineGate, type GateDecision, type Tally } from '../src/stats.js';
import { Store, type TestResultData } from '../src/store.js';

/**
 * A regression on the default branch, re-run in CI again and again: does the gate against history
 * keep catching it? Each CI run keeps its result, and the next run's baseline is read back from the
 * store by `gateHistory`, as `shadowlap test` reads it. When every session joined the baseline,
 * whatever it found, the regressed sessions soon made up the baseline and the gate stopped catching
 * the drop it was there for. With only sessions that passed on the baseline branch, the baseline
 * stays the agent before the regression, and the drop is caught on every run, at the rate the exact
 * odds give for the first. Seeded: every run of this test sees the same coin flips.
 */

/** mulberry32: a small, seeded generator with a period of 2^32. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GATE: BaselineGate = { kind: 'baseline', ...BASELINE_DEFAULTS };
const CHECKS = [{ ok: true, label: 'issue_refund called 0 times', detail: null }];
const HEALTHY = 0.95;
const REGRESSED = 0.6;
/** Independent histories, and CI runs of each after the regression lands. */
const REPLICAS = 300;
const RERUNS = 10;

interface Session {
  decision: GateDecision;
  passes: number;
  attempts: number;
}

/** One session of the gate: attempts until it decides, against `history` (none: the recording). */
function session(random: () => number, rate: number, history: Tally | null): Session {
  let passes = 0;
  for (let n = 1; ; n++) {
    if (random() < rate) passes++;
    const d = decide(passes, n, GATE, history);
    if (d !== 'continue') return { decision: d, passes, attempts: n };
  }
}

/** Keeps a session's result as `shadowlap test` keeps it: on main, for no pull request, with its verdict. */
function keep(store: Store, golden: string, s: Session, at: number): void {
  const verdict = s.decision === 'pass' ? 'passed' : s.decision === 'fail' ? 'failed' : 'inconclusive';
  const { sessionId } = store.startTestSession({ command: ['shadowlap', 'test', golden], startedAt: at, owner: null });
  const data: TestResultData = { mode: 'fork', checks: CHECKS, attempts: { total: s.attempts, passed: s.passes, required: null, runs: [] }, verdict, branch: 'main', pullRequest: false, baselineBranch: 'main', revision: 'a1b2c3d' };
  store.addTestResult({ sessionId, golden, ok: verdict === 'passed', failure: verdict === 'passed' ? null : verdict === 'inconclusive' ? 'inconclusive' : 'check', goldenRunId: 'REC', at, revision: 'a1b2c3d', data });
}

/** The baseline as it was pooled before: the last `window` sessions, whatever they found. */
function everySession(store: Store, golden: string): Tally {
  const pooled = store.listTestResults({ golden, limit: GATE.window }).map(attemptsOf).filter((t): t is Tally => t !== null);
  return { passes: pooled.reduce((n, t) => n + t.passes, 0), attempts: pooled.reduce((n, t) => n + t.attempts, 0) };
}

/** The baseline as `shadowlap test` pools it: sessions that passed on main, for no pull request. */
const passedOnMain = (store: Store, golden: string): Tally => gateHistory(store, golden, { window: GATE.window, branch: 'main', mode: 'fork', checks: CHECKS.map((c) => c.label), goldenRunId: 'REC' });

describe('a regression from 95% to 60% on the default branch, re-run in CI', () => {
  // The agent before the regression: 10 sessions at 95% that passed, the same for every replica.
  const before: Session[] = [];
  const warm = seeded(11);
  while (before.length < GATE.window) {
    const s = session(warm, HEALTHY, null);
    if (s.decision === 'pass') before.push(s);
  }
  const start: Tally = { passes: before.reduce((n, s) => n + s.passes, 0), attempts: before.reduce((n, s) => n + s.attempts, 0) };
  // The power stated for the first run: exactly, every look counted, against that baseline.
  const first = gateOdds(GATE, REGRESSED, start);
  const stated = first.fail + first.inconclusive;

  const run = (pool: (store: Store, golden: string) => Tally, seed: number, rate: number) => {
    const store = Store.open(':memory:');
    const random = seeded(seed);
    const red = Array<number>(RERUNS).fill(0);
    const failed = Array<number>(RERUNS).fill(0);
    let at = Date.UTC(2026, 9, 1);
    for (let r = 0; r < REPLICAS; r++) {
      const golden = `goldens/refund-${r}`;
      for (const s of before) keep(store, golden, s, at++);
      for (let k = 0; k < RERUNS; k++) {
        const history = pool(store, golden);
        const s = session(random, rate, history.attempts ? history : null);
        if (s.decision !== 'pass') red[k]!++;
        if (s.decision === 'fail') failed[k]!++;
        keep(store, golden, s, at++);
      }
    }
    store.close();
    return { red: red.map((n) => n / REPLICAS), failed: failed.map((n) => n / REPLICAS) };
  };
  const now = run(passedOnMain, 12, REGRESSED);
  const then = run(everySession, 12, REGRESSED);
  const healthy = run(passedOnMain, 13, HEALTHY);
  /** The sampling error of a share of the replicas near `stated`. */
  const sigma = Math.sqrt((stated * (1 - stated)) / REPLICAS);

  it('prints the share of CI runs that catch it, run by run, before and after', () => {
    const row = (name: string, xs: number[]) => `${name.padEnd(38)} ${xs.map((x) => `${Math.round(100 * x)}%`.padStart(5)).join('')}`;
    const lines = [
      `${REPLICAS} histories of 10 sessions at ${HEALTHY * 100}% that passed (${start.passes} of ${start.attempts}); then the agent passes ${REGRESSED * 100}% of the time (seeded).`,
      `Stated for the first run, exactly: caught (red under --inconclusive fail) ${(100 * stated).toFixed(1)}%, failed ${(100 * first.fail).toFixed(1)}%.`,
      `${'CI run after the regression'.padEnd(38)} ${Array.from({ length: RERUNS }, (_, k) => `#${k + 1}`.padStart(5)).join('')}`,
      row('caught, passed sessions on main only', now.red),
      row('caught, every session (before)', then.red),
      row('a healthy agent red, passed on main', healthy.red),
    ];
    console.log(lines.join('\n'));
    expect(lines).toHaveLength(6);
  });

  it('is caught on every run at the power stated for the first, with no decay', () => {
    for (const [k, x] of now.red.entries()) expect(x, `run ${k + 1}`).toBeGreaterThanOrEqual(stated - 4 * sigma);
    // The last runs catch it as often as the first: the baseline is still the agent before the regression.
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(now.red.slice(-3))).toBeGreaterThanOrEqual(mean(now.red.slice(0, 3)) - 3 * sigma);
    expect(stated).toBeGreaterThan(0.8);
  });

  it('decayed when every session joined the baseline: caught a third as often by the fourth run, almost never by the tenth', () => {
    expect(then.red[0]).toBeGreaterThan(stated - 4 * sigma);
    expect(then.red[3]).toBeLessThan(0.45);
    expect(then.red[RERUNS - 1]).toBeLessThan(0.1);
  });

  it('turns a healthy agent red no more often for keeping only passed sessions', () => {
    for (const x of healthy.red) expect(x).toBeLessThan(0.03);
  });

  it('as docs/gating.md states it, from these coin flips', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const whole = (x: number) => `${Math.round(100 * x)}%`;
    const text = `In a seeded simulation of ${REPLICAS} histories (in the engine's tests), a drop from 95% to 60% was caught on each of the ${RERUNS} runs after it ${whole(Math.min(...now.red))} to ${whole(Math.max(...now.red))} of the time, against ${(100 * stated).toFixed(1)}% the exact odds give for the first; when every session joined the baseline, it was caught ${whole(then.red[0]!)} of the time on the first run, ${whole(then.red[3]!)} on the fourth and ${whole(then.red[RERUNS - 1]!)} on the tenth`;
    expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
  });
});
