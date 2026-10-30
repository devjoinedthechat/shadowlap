import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attemptsOf, gateHistory } from '../src/gate-history.js';
import { BASELINE_DEFAULTS, decide, gateOdds, type BaselineGate, type GateDecision, type GateResult, type Tally } from '../src/stats.js';
import { Store, type TestResultData } from '../src/store.js';

/**
 * A regression on the default branch, re-run in CI again and again: does the gate against history
 * keep catching it? Each CI run keeps its result, and the next run's baseline is read back from the
 * store by `gateHistory`, as `shadowlap test` reads it. When every session joined the baseline,
 * whatever it found, the regressed sessions soon made up the baseline and the gate stopped catching
 * the drop it was there for. With only sessions that passed on the baseline branch, the baseline
 * stays mostly the agent before the regression: only the regressed sessions that pass by chance join
 * it, and the drop is caught on every run, a little less often each time. Each history has a
 * baseline of its own, 10 sessions of the agent before, so the power is averaged over the baselines
 * such an agent leaves, as well as worked out exactly against each. Seeded: every run of this test
 * sees the same coin flips.
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
  outcomes: boolean[];
}

/** One session of the gate: attempts until it decides, against `history` (none: the recording). */
function session(random: () => number, rate: number, history: Tally | null): Session {
  const outcomes: boolean[] = [];
  let passes = 0;
  for (let n = 1; ; n++) {
    const x = random() < rate;
    outcomes.push(x);
    if (x) passes++;
    const d = decide(passes, n, GATE, history);
    if (d !== 'continue') return { decision: d, passes, attempts: n, outcomes };
  }
}

/** Keeps a session's result as `shadowlap test` keeps it: on main, for no pull request, with its verdict. */
function keep(store: Store, golden: string, s: Session, at: number): void {
  const verdict = s.decision === 'pass' ? 'passed' : s.decision === 'fail' ? 'failed' : 'inconclusive';
  const { sessionId } = store.startTestSession({ command: ['shadowlap', 'test', golden], startedAt: at, owner: null });
  // Its gate's outcomes in order, which a baseline reads its first attempts from (the rest of a gate result is no part of one).
  const gate = { ...GATE, decision: s.decision, passes: s.passes, attempts: s.attempts, outcomes: s.outcomes } as unknown as GateResult;
  const data: TestResultData = { mode: 'fork', checks: CHECKS, attempts: { total: s.attempts, passed: s.passes, required: null, runs: [] }, verdict, gate, branch: 'main', pullRequest: false, baselineBranch: 'main', revision: 'a1b2c3d' };
  store.addTestResult({ sessionId, golden, ok: verdict === 'passed', failure: verdict === 'passed' ? null : verdict === 'inconclusive' ? 'inconclusive' : 'check', goldenRunId: 'REC', at, revision: 'a1b2c3d', data });
}

/** The baseline as it was pooled before: the last `window` sessions, whatever they found. */
function everySession(store: Store, golden: string): Tally {
  const pooled = store.listTestResults({ golden, limit: GATE.window }).map(attemptsOf).filter((t): t is Tally => t !== null);
  return { passes: pooled.reduce((n, t) => n + t.passes, 0), attempts: pooled.reduce((n, t) => n + t.attempts, 0) };
}

/** The baseline as `shadowlap test` pools it: sessions that passed on main, for no pull request, each by its first `min` attempts. */
const passedOnMain = (store: Store, golden: string): Tally => gateHistory(store, golden, { window: GATE.window, first: GATE.min, branch: 'main', mode: 'fork', checks: CHECKS.map((c) => c.label), goldenRunId: 'REC' });

describe('a regression from 95% to 60% on the default branch, re-run in CI', () => {
  // Each history's agent before the regression: 10 sessions at 95% that passed, its own, the same under either pooling.
  const before = Array.from({ length: REPLICAS }, (_, r) => {
    const warm = seeded(1000 + r);
    const sessions: Session[] = [];
    while (sessions.length < GATE.window) {
      const s = session(warm, HEALTHY, null);
      if (s.decision === 'pass') sessions.push(s);
    }
    return sessions;
  });
  // The baseline each history starts from, pooled by each session's first `min` attempts, as passedOnMain reads them back.
  const starts: Tally[] = before.map((sessions) => ({ passes: sessions.reduce((n, s) => n + s.outcomes.slice(0, GATE.min).filter(Boolean).length, 0), attempts: sessions.reduce((n, s) => n + Math.min(GATE.min, s.attempts), 0) }));
  // One history's baseline alone, as this was stated before: the power against it, exactly, every look counted.
  const one = gateOdds(GATE, REGRESSED, starts[0]);

  const run = (pool: (store: Store, golden: string) => Tally, seed: number, rate: number) => {
    const store = Store.open(':memory:');
    const random = seeded(seed);
    const red = Array<number>(RERUNS).fill(0);
    const failed = Array<number>(RERUNS).fill(0);
    // Each run's chance of going red, exactly, against the baseline each history had then, averaged.
    const exact = Array<number>(RERUNS).fill(0);
    let at = Date.UTC(2026, 9, 1);
    for (let r = 0; r < REPLICAS; r++) {
      const golden = `goldens/refund-${r}`;
      for (const s of before[r]) keep(store, golden, s, at++);
      for (let k = 0; k < RERUNS; k++) {
        const history = pool(store, golden);
        const o = gateOdds(GATE, rate, history.attempts ? history : null);
        exact[k] += (o.fail + o.inconclusive) / REPLICAS;
        const s = session(random, rate, history.attempts ? history : null);
        if (s.decision !== 'pass') red[k]++;
        if (s.decision === 'fail') failed[k]++;
        keep(store, golden, s, at++);
      }
    }
    store.close();
    return { red: red.map((n) => n / REPLICAS), failed: failed.map((n) => n / REPLICAS), exact };
  };
  const now = run(passedOnMain, 12, REGRESSED);
  const then = run(everySession, 12, REGRESSED);
  const healthy = run(passedOnMain, 13, HEALTHY);
  /** The power stated for the first run: exactly against each history's baseline, averaged over them. */
  const stated = now.exact[0];
  /** The sampling error of a share of the replicas near `stated`. */
  const sigma = Math.sqrt((stated * (1 - stated)) / REPLICAS);

  it('prints the share of CI runs that catch it, run by run, before and after', () => {
    const row = (name: string, xs: number[]) => `${name.padEnd(38)} ${xs.map((x) => `${Math.round(100 * x)}%`.padStart(5)).join('')}`;
    const lines = [
      `${REPLICAS} histories, each of 10 sessions at ${HEALTHY * 100}% that passed; then the agent passes ${REGRESSED * 100}% of the time (seeded).`,
      `Against one history's baseline alone (${starts[0].passes} of ${starts[0].attempts}), the first run catches it ${(100 * (one.fail + one.inconclusive)).toFixed(1)}% of the time; over all of theirs, ${(100 * stated).toFixed(1)}%.`,
      `${'CI run after the regression'.padEnd(38)} ${Array.from({ length: RERUNS }, (_, k) => `#${k + 1}`.padStart(5)).join('')}`,
      row('caught, exactly, passed on main only', now.exact),
      row('caught, passed sessions on main only', now.red),
      row('caught, exactly, every session (before)', then.exact),
      row('caught, every session (before)', then.red),
      row('a healthy agent red, passed on main', healthy.red),
    ];
    console.log(lines.join('\n'));
    expect(lines).toHaveLength(8);
  });

  it('is caught on every run, a little less often each time, as the regressed sessions that pass by chance join the baseline', () => {
    // The coin flips agree with the exact odds, run by run.
    for (const [k, x] of now.red.entries()) expect(Math.abs(x - now.exact[k]), `run ${k + 1}`).toBeLessThan(4 * sigma);
    // It creeps down, never up, and by the tenth run has lost a tenth of its power or so: far from the decay of pooling every session.
    for (let k = 1; k < RERUNS; k++) expect(now.exact[k]).toBeLessThanOrEqual(now.exact[k - 1] + 1e-12);
    expect(now.exact[RERUNS - 1]).toBeGreaterThan(stated - 0.15);
    expect(now.exact[RERUNS - 1]).toBeGreaterThan(0.6);
    // One baseline alone overstated it: the baselines 10 healthy sessions leave are spread around it.
    expect(stated).toBeGreaterThan(0.7);
    expect(stated).toBeLessThan(0.8);
  });

  it('decayed when every session joined the baseline: caught a third as often by the fourth run, almost never by the tenth', () => {
    expect(then.red[0]).toBeGreaterThan(stated - 4 * sigma);
    expect(then.exact[3]).toBeLessThan(0.45);
    expect(then.red[3]).toBeLessThan(0.45);
    expect(then.exact[RERUNS - 1]).toBeLessThan(0.1);
    expect(then.red[RERUNS - 1]).toBeLessThan(0.1);
  });

  it('turns a healthy agent red no more often for keeping only passed sessions', () => {
    for (const x of healthy.red) expect(x).toBeLessThan(0.03);
  });

  it('as docs/gating.md states it, from these coin flips', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const whole = (x: number) => `${Math.round(100 * x)}%`;
    // The first run is the same under either pooling: the same baselines, before any regressed session joined one.
    expect(whole(then.exact[0])).toBe(whole(stated));
    const text = `In a seeded simulation of ${REPLICAS} histories (in the engine's tests), each with a baseline of its own from 10 sessions at 95%, a drop to 60% was caught on the first run after it ${whole(stated)} of the time and on the tenth ${whole(now.exact[RERUNS - 1])}. Both are worked out exactly against each history's baseline and averaged over them. When every session joined the baseline, it was caught as often on the first run, ${whole(then.exact[3])} on the fourth and ${whole(then.exact[RERUNS - 1])} on the tenth`;
    expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
  });
});
