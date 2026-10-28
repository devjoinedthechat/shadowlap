import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sessionAttempts } from '../src/gate-history.js';
import { BASELINE_DEFAULTS, decide, type BaselineGate, type GateResult, type Tally } from '../src/stats.js';
import { planSuite, type PlannedGolden } from '../src/suite.js';
import type { TestResultData } from '../src/store.js';

/**
 * A healthy agent's goldens gated against their own history, session after session from a golden's
 * first, as `shadowlap test` runs them: each session's gate sized by `planSuite` at its golden's share
 * of the suite's 5%, against its baseline (the first `min` attempts of its last 10 sessions that
 * passed, `sessionAttempts`) for the agent its last 10 sessions show (every attempt of them, whatever
 * they came to), and decided after every attempt by `decide`. The planner, the rule and the pooling
 * are black boxes here; the loop, the agent and the measure are this test's: each session's exact
 * chance of going red for nothing against its own baseline and gate, by a walk of its own. Where the
 * plan says a golden keeps within its share, it must; where it says it can't, it must say about as
 * often as it goes red. Planned at the low end of the rate its baseline showed instead, an agent at
 * 60% went red 1.5 times its share once its window was full, and 18 times in its first 10 sessions,
 * where the plan said it kept within it. Seeded: every run sees the same coin flips.
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
/** Independent histories, and the sessions each runs from its first. */
const REPLICAS = 80;
const SESSIONS = 30;
/** The sessions measured together: a golden's first, the rest of its first 10, and once its window is full and settled. */
const STAGES = [
  { name: 'session 1', from: 0, to: 1 },
  { name: 'sessions 2-10', from: 1, to: 10 },
  { name: 'sessions 21-30', from: 20, to: 30 },
] as const;

/**
 * The chance a gate goes red at rate p against baseline h, exactly: every tally it can see, stopped
 * where `decide` decides. Its rule only ever fails up to some count of passes and passes from some
 * count on, so the walk looks for the two counts where it changes, attempt by attempt, and adds up
 * the chance between them, instead of asking for every tally.
 */
function redAt(gate: BaselineGate, h: Tally | null, p: number): number {
  const says = (s: number, n: number) => decide(s, n, gate, h);
  let mass = new Float64Array([1]);
  let lo = 0;
  let hi = 0;
  let passFrom = 0;
  let failTo = -1;
  let passed = 0;
  for (let n = 1; n <= gate.max; n++) {
    const next = new Float64Array(n + 1);
    for (let s = lo; s <= hi; s++) {
      next[s + 1] += mass[s] * p;
      next[s] += mass[s] * (1 - p);
    }
    let pass = n + 1;
    let fail = -1;
    if (n >= gate.min) {
      pass = Math.min(Math.max(passFrom, 0), n + 1);
      while (pass > 0 && says(pass - 1, n) === 'pass') pass--;
      while (pass <= n && says(pass, n) !== 'pass') pass++;
      fail = Math.min(failTo, pass - 1);
      while (fail + 1 < pass && says(fail + 1, n) === 'fail') fail++;
      while (fail >= 0 && says(fail, n) !== 'fail') fail--;
      passFrom = pass;
      failTo = fail;
    }
    const top = Math.min(hi + 1, n);
    for (let s = Math.max(lo, pass); s <= top; s++) passed += next[s];
    lo = Math.max(lo, fail + 1);
    hi = Math.min(top, pass - 1);
    mass = next;
    if (lo > hi) break;
  }
  return 1 - passed;
}

/** The plans and red rates already worked out: a loop asks for the same ones again and again. */
const plans = new Map<string, PlannedGolden>();
const reds = new Map<string, number>();
const tally = (t: Tally | null) => (t ? `${t.passes}/${t.attempts}` : '-');

function planFor(goldens: number, history: Tally | null, sessions: Tally | null): PlannedGolden {
  const key = `${goldens} ${tally(history)} ${tally(sessions)}`;
  let p = plans.get(key);
  if (!p) {
    // The suite's risk split `goldens` ways: one golden here, its share as the whole risk planned.
    p = planSuite([{ golden: 'goldens/refund', gate: GATE, maxGiven: false, history, sessions }], { risk: SUITE_RISK / goldens })!.planned[0]!;
    plans.set(key, p);
  }
  return p;
}

function redFor(rate: number, h: Tally | null, gate: BaselineGate): number {
  const key = `${rate} ${tally(h)} ${gate.risk} ${gate.max}`;
  let r = reds.get(key);
  if (r === undefined) reds.set(key, (r = redAt(gate, h, rate)));
  return r;
}

interface Stage {
  name: string;
  from: number;
  sessions: number;
  /** Their chance of going red, exactly against each session's baseline and gate, averaged; and what the plan said, averaged. */
  red: number;
  planned: number;
  /** Of the sessions the plan said keep within the share, how many and their red rate; and of those it said can't, the same, and what it said. */
  within: number;
  redWithin: number;
  over: number;
  redOver: number;
  plannedOver: number;
}

interface Loop {
  goldens: number;
  rate: number;
  share: number;
  stages: Stage[];
}

const pool = (xs: Tally[]): Tally | null => (xs.length ? { passes: xs.reduce((a, x) => a + x.passes, 0), attempts: xs.reduce((a, x) => a + x.attempts, 0) } : null);

/** The loop: every history starts with no session at all, the golden's recording its only baseline. */
function loop(goldens: number, rate: number, seed: number): Loop {
  const random = seeded(seed);
  const share = SUITE_RISK / goldens;
  const sums = STAGES.map(() => ({ sessions: 0, red: 0, planned: 0, within: 0, redWithin: 0, over: 0, redOver: 0, plannedOver: 0 }));
  for (let r = 0; r < REPLICAS; r++) {
    // Each session as the store keeps it, newest last: the baseline's part of it if it passed, and every attempt of it.
    const passed: Tally[] = [];
    const every: Tally[] = [];
    for (let k = 0; k < SESSIONS; k++) {
      const h = pool(passed.slice(-GATE.window));
      const p = planFor(goldens, h, pool(every.slice(-GATE.window)));
      const gate = p.gate as BaselineGate;
      const outcomes: boolean[] = [];
      let passes = 0;
      let d = decide(0, 0, gate, h);
      while (d === 'continue') {
        const x = random() < rate;
        outcomes.push(x);
        if (x) passes++;
        d = decide(passes, outcomes.length, gate, h);
      }
      const i = STAGES.findIndex((s) => k >= s.from && k < s.to);
      if (i >= 0) {
        const red = redFor(rate, h, gate);
        const s = sums[i];
        s.sessions++;
        s.red += red;
        s.planned += p.red;
        if (p.over) {
          s.over++;
          s.redOver += red;
          s.plannedOver += p.red;
        } else {
          s.within++;
          s.redWithin += red;
        }
      }
      // Kept as `shadowlap test` keeps a result, and read back as the store reads it.
      const verdict = d === 'pass' ? 'passed' : d === 'fail' ? 'failed' : 'inconclusive';
      const result = { ...gate, decision: d, passes, attempts: outcomes.length, outcomes } as unknown as GateResult;
      const data: TestResultData = { mode: 'fork', attempts: { total: outcomes.length, passed: passes, required: null, runs: [] }, verdict, gate: result };
      const kept = { ok: d === 'pass', failure: d === 'pass' ? null : d === 'fail' ? ('check' as const) : ('inconclusive' as const), data };
      every.push(sessionAttempts(kept)!);
      if (d === 'pass') passed.push(sessionAttempts(kept, GATE.min)!);
    }
  }
  const stages = STAGES.map((st, i): Stage => {
    const s = sums[i];
    return { name: st.name, from: st.from, sessions: s.sessions, red: s.red / s.sessions, planned: s.planned / s.sessions, within: s.within, redWithin: s.within ? s.redWithin / s.within : 0, over: s.over, redOver: s.over ? s.redOver / s.over : 0, plannedOver: s.over ? s.plannedOver / s.over : 0 };
  });
  return { goldens, rate, share, stages };
}

const pct = (x: number, places = 3) => `${(100 * x).toFixed(places)}%`;

describe('a healthy suite of goldens gated against their own history, from their first session on', { timeout: 900_000 }, () => {
  const cases: Loop[] = [];
  const run = (goldens: number, rate: number, seed: number) => {
    const l = loop(goldens, rate, seed);
    cases.push(l);
    return l;
  };
  const stage = (l: Loop, name: string) => l.stages.find((s) => s.name === name)!;

  it('keeps 20 goldens within their share wherever the plan says they do, and says how often they go red where it says they can’t, at 80%, 70%, 60% and 50%', () => {
    for (const [rate, seed] of [
      [0.8, 80],
      [0.7, 70],
      [0.6, 60],
      [0.5, 50],
    ] as const) {
      const l = run(20, rate, seed);
      for (const s of l.stages) {
        // Where it says within, it is: its red rate, exactly, averaged over the sessions it said so for.
        if (s.within) expect(s.redWithin, `${rate}, ${s.name}, said within`).toBeLessThanOrEqual(l.share);
        // Where it says it can't, it says at least about as much as it goes red: never a tenth less.
        if (s.over) expect(s.plannedOver, `${rate}, ${s.name}, said over`).toBeGreaterThanOrEqual(0.9 * s.redOver);
      }
      // Its first session has no baseline: it says it can't keep within its share, whatever the agent, and no less than it goes red.
      expect(stage(l, 'session 1').within).toBe(0);
      expect(stage(l, 'session 1').plannedOver).toBeGreaterThanOrEqual(stage(l, 'session 1').redOver);
    }
  });

  it('and at 90%, and a single golden at 80% and at 50% within the whole 5%', () => {
    for (const [goldens, rate, seed] of [
      [20, 0.9, 90],
      [1, 0.8, 18],
      [1, 0.5, 15],
    ] as const) {
      const l = run(goldens, rate, seed);
      for (const s of l.stages) {
        if (s.within) expect(s.redWithin, `${goldens} at ${rate}, ${s.name}, said within`).toBeLessThanOrEqual(l.share);
        if (s.over) expect(s.plannedOver, `${goldens} at ${rate}, ${s.name}, said over`).toBeGreaterThanOrEqual(0.9 * s.redOver);
      }
    }
  });

  it('as docs/gating.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    console.log(
      [
        'goldens  rate  stage            sessions  red (exact)   planned  within      red   over       red   planned',
        ...cases.flatMap((c) =>
          c.stages.map(
            (s) =>
              `${String(c.goldens).padStart(7)}  ${c.rate.toFixed(2)}  ${s.name.padEnd(15)}  ${String(s.sessions).padStart(8)}  ${pct(s.red).padStart(11)}  ${pct(s.planned).padStart(8)}  ${String(s.within).padStart(6)}  ${pct(s.redWithin).padStart(7)}  ${String(s.over).padStart(5)}  ${pct(s.redOver).padStart(8)}  ${pct(s.plannedOver).padStart(8)}`,
          ),
        ),
      ].join('\n'),
    );
    const at = (rate: number) => cases.find((c) => c.goldens === 20 && c.rate === rate)!;
    const within = cases.filter((c) => c.goldens === 20 && c.rate <= 0.8).flatMap((c) => c.stages.filter((s) => s.within).map((s) => s.redWithin));
    const half = at(0.5);
    const text = `where the plan says a golden of 20 keeps within its 0.25% share, it goes red ${pct(Math.min(...within), 2)} to ${pct(Math.max(...within), 2)} of the time, at 80% down to 50%`;
    expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    const first = `an agent at 50% goes red ${pct(stage(half, 'session 1').redOver, 0)} of the time in its first session, where the plan says ${pct(stage(half, 'session 1').plannedOver, 0)}`;
    expect(page.includes(first), `docs/gating.md says: ${first}`).toBe(true);
  });
});
