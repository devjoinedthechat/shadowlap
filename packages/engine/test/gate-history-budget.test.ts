import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sessionAttempts } from '../src/gate-history.js';
import { BASELINE_DEFAULTS, decide, gateOdds, type BaselineGate, type GateResult, type Tally } from '../src/stats.js';
import { HISTORY_SIZED_AT, planSuite, type PlannedGolden } from '../src/suite.js';
import type { TestResultData } from '../src/store.js';

/**
 * A healthy agent's goldens gated against their own history, session after session, as `shadowlap
 * test` runs them: each session's gate sized by `planSuite` at its golden's share of the suite's 5%,
 * decided after every attempt by `decide` against its baseline, and kept as the store keeps it;
 * only a session that passed joins the baseline, each by its first `min` attempts
 * (`sessionAttempts`), its last 10 pooled. The engine's planner, rule and pooling are black boxes
 * here; the loop, the agent and the measure are this test's. The measure is the steady state's chance
 * a golden goes red for nothing, worked out exactly against each session's own baseline and gate
 * (`gateOdds`) and averaged over the sessions: within the share, the suite within its risk. Pooled
 * whole and sized at the rate its baseline showed, 20 goldens of an agent at 80% went red 1.24% of
 * the time each against a 0.25% share. Seeded: every run sees the same coin flips.
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
const SUITE_RISK = 0.05;
/** Independent histories, the sessions each runs before the window is read as settled, and those measured after. */
const REPLICAS = 200;
const SETTLE = 40;
const MEASURED = 40;

/** The plans and red rates already worked out, by the baseline they were made for: a loop asks for the same few again and again. */
const plans = new Map<string, PlannedGolden>();
const reds = new Map<string, number>();

function planFor(goldens: number, h: Tally): PlannedGolden {
  const key = `${goldens} ${h.passes}/${h.attempts}`;
  let p = plans.get(key);
  if (!p) {
    // The suite's risk split `goldens` ways: one golden here, its share as the whole risk planned.
    p = planSuite([{ golden: 'goldens/refund', gate: GATE, maxGiven: false, history: h }], { risk: SUITE_RISK / goldens })!.planned[0]!;
    plans.set(key, p);
  }
  return p;
}

function redFor(goldens: number, rate: number, h: Tally, p: PlannedGolden): number {
  const key = `${goldens} ${rate} ${h.passes}/${h.attempts}`;
  let r = reds.get(key);
  if (r === undefined) {
    const o = gateOdds(p.gate, rate, h);
    reds.set(key, (r = o.fail + o.inconclusive));
  }
  return r;
}

interface Loop {
  goldens: number;
  rate: number;
  share: number;
  /** The steady state's chance a golden goes red, exactly for each session's baseline and gate, averaged. */
  red: number;
  /** The same, counted from the coin flips. */
  simulated: number;
  /** The baseline's pass rate, averaged: what the pooling makes of an agent at `rate`. */
  pooled: number;
  /** What the planner said each session would go red, averaged, and how many sessions it said that is more than the share. */
  planned: number;
  over: number;
}

/**
 * The loop. Each history starts from a window of 10 sessions' first attempts drawn at the agent's
 * rate, then runs SETTLE sessions so the passed-only pooling settles it, then MEASURED more.
 */
function loop(goldens: number, rate: number, seed: number): Loop {
  const random = seeded(seed);
  const share = SUITE_RISK / goldens;
  let n = 0;
  let red = 0;
  let simulated = 0;
  let pooled = 0;
  let planned = 0;
  let over = 0;
  for (let r = 0; r < REPLICAS; r++) {
    const window: Tally[] = [];
    for (let i = 0; i < GATE.window; i++) {
      let passes = 0;
      for (let k = 0; k < GATE.min; k++) if (random() < rate) passes++;
      window.push({ passes, attempts: GATE.min });
    }
    for (let k = 0; k < SETTLE + MEASURED; k++) {
      const last = window.slice(-GATE.window);
      const h: Tally = { passes: last.reduce((a, x) => a + x.passes, 0), attempts: last.reduce((a, x) => a + x.attempts, 0) };
      const p = planFor(goldens, h);
      const outcomes: boolean[] = [];
      let d = decide(0, 0, p.gate, h);
      while (d === 'continue') {
        outcomes.push(random() < rate);
        d = decide(outcomes.filter(Boolean).length, outcomes.length, p.gate, h);
      }
      if (k >= SETTLE) {
        n++;
        red += redFor(goldens, rate, h, p);
        if (d !== 'pass') simulated++;
        pooled += h.passes / h.attempts;
        planned += p.red;
        if (p.over) over++;
      }
      if (d !== 'pass') continue;
      // Kept as `shadowlap test` keeps a result that passed, and pooled as gateHistory pools it: by
      // the outcomes its gate result keeps in order (the rest of that result, its bound worked out
      // under the gate's stopping, is no part of a baseline, and costs a bisection a session).
      const passes = outcomes.filter(Boolean).length;
      const gate = { ...p.gate, decision: d, passes, attempts: outcomes.length, outcomes } as unknown as GateResult;
      const data: TestResultData = { mode: 'fork', attempts: { total: outcomes.length, passed: passes, required: null, runs: [] }, verdict: 'passed', gate };
      window.push(sessionAttempts({ ok: true, failure: null, data }, GATE.min)!);
    }
  }
  return { goldens, rate, share, red: red / n, simulated: simulated / n, pooled: pooled / n, planned: planned / n, over };
}

const pct = (x: number, places = 3) => `${(100 * x).toFixed(places)}%`;

describe('a healthy suite of goldens gated against their own history, session after session', { timeout: 600_000 }, () => {
  const cases: Loop[] = [];
  const run = (goldens: number, rate: number, seed: number) => {
    const l = loop(goldens, rate, seed);
    cases.push(l);
    return l;
  };

  it('keeps 20 goldens at 80% within their share of the suite’s 5%: the baseline no longer overstates the agent, and its gate is sized for a rate it may be at', () => {
    const l = run(20, 0.8, 80);
    expect(l.red).toBeLessThanOrEqual(l.share);
    expect(l.over).toBe(0);
    // Each session's first attempts, every one of them run whatever it showed: the baseline is the agent.
    expect(Math.abs(l.pooled - 0.8)).toBeLessThan(0.005);
    // The simulated count agrees with the exact average, within its sampling error.
    expect(Math.abs(l.simulated - l.red)).toBeLessThan(4 * Math.sqrt(l.red / (REPLICAS * MEASURED)));
  });

  it('and at 90%, and a single golden at 80% and at 50% within the whole 5%', () => {
    for (const [goldens, rate, seed] of [
      [20, 0.9, 90],
      [1, 0.8, 18],
      [1, 0.5, 15],
    ] as const) {
      const l = run(goldens, rate, seed);
      expect(l.red, `${goldens} at ${rate}`).toBeLessThanOrEqual(l.share);
      expect(l.over).toBe(0);
    }
  });

  it('as docs/gating.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const twenty = cases.find((c) => c.goldens === 20 && c.rate === 0.8)!;
    const ninety = cases.find((c) => c.goldens === 20 && c.rate === 0.9)!;
    const text = `In a seeded loop of sessions in the engine's tests, each sized and decided as \`shadowlap test\` does and pooled as the store pools them, once their baselines hold a full window 20 goldens of an agent at 80% go red ${pct(twenty.red, 2)} of the time each against their ${pct(twenty.share, 2)} share, and at 90%, ${pct(ninety.red, 2)}`;
    expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    expect(page.includes(`the one-sided ${Math.round(100 * HISTORY_SIZED_AT)}% bound`), 'docs/gating.md names the bound').toBe(true);
    console.log(['goldens  rate  share     red (exact)  red (counted)  planned   baseline', ...cases.map((c) => `${String(c.goldens).padStart(7)}  ${c.rate.toFixed(2)}  ${pct(c.share, 3).padEnd(8)}  ${pct(c.red, 4).padEnd(11)}  ${pct(c.simulated, 3).padEnd(13)}  ${pct(c.planned, 3).padEnd(8)}  ${c.pooled.toFixed(4)}`)].join('\n'));
  });
});
