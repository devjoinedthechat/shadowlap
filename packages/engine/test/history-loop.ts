import { sessionAttempts } from '../src/gate-history.js';
import { BASELINE_DEFAULTS, decide, dropProbability, type BaselineGate, type GateResult, type Tally } from '../src/stats.js';
import { RECORD_WINDOWS, planSuite, type PlannedGolden } from '../src/suite.js';
import type { TestResultData } from '../src/store.js';

/**
 * Goldens gated against their own history, session after session from a golden's first, as
 * `shadowlap test` runs them: each session's gate planned by `planSuite` at its golden's share of the
 * suite's 5%, with its baseline (the first `min` attempts of its last 10 sessions that passed,
 * `sessionAttempts`), its last 10 sessions and its record (every attempt of its last 30, whatever they
 * came to), and decided after every attempt by `decide`. The planner, the rule and the pooling are
 * black boxes here; the loop, the agent and the measures are the tests': each session's exact chance
 * of going red, against its own baseline and gate, by a walk of their own. Seeded: every run sees
 * the same coin flips. gate-history-budget.test.ts runs it for a healthy agent,
 * gate-history-regression.test.ts for one that drops.
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

export const GATE: BaselineGate = { kind: 'baseline', ...BASELINE_DEFAULTS };
export const SUITE_RISK = 0.05;
/** The sessions a record reads: `RECORD_WINDOWS` windows, as `shadowlap test` reads them. */
const RECORD = RECORD_WINDOWS * GATE.window;
/**
 * The sessions measured together, as the review measured them: a golden's first, the rest of its first
 * 10, the 10 after, and the rest, these split where its record fills, at 30 sessions, from which its
 * inconclusive counts by default.
 */
export const STAGES = [
  { name: 'session 1', from: 0, to: 1 },
  { name: 'sessions 2-10', from: 1, to: 10 },
  { name: 'sessions 11-20', from: 10, to: 20 },
  { name: 'sessions 21-30', from: 20, to: 30 },
  { name: 'sessions 31-40', from: 30, to: 40 },
] as const;

/**
 * The chance a gate goes red at rate p against baseline h, exactly, and of that its chance of failing
 * (the rest ends inconclusive): every tally it can see, stopped where `decide` decides. Its rule only
 * ever fails up to some count of passes and passes from some count on, so the walk looks for the two
 * counts where it changes, attempt by attempt, in either direction, and adds up the chance between
 * them, instead of asking for every tally.
 */
function redAt(gate: BaselineGate, h: Tally | null, p: number): { red: number; fail: number } {
  const says = (s: number, n: number) => decide(s, n, gate, h);
  let mass = new Float64Array([1]);
  let lo = 0;
  let hi = 0;
  let passFrom = 0;
  let failTo = -1;
  let passed = 0;
  let failed = 0;
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
    for (let s = lo; s <= Math.min(fail, top); s++) failed += next[s];
    lo = Math.max(lo, fail + 1);
    hi = Math.min(top, pass - 1);
    mass = next;
    // Nothing left to decide, or less than any figure here could show.
    let left = 0;
    for (let s = lo; s <= hi; s++) left += mass[s];
    if (lo > hi || left < 1e-13) break;
  }
  return { red: 1 - passed, fail: failed };
}

/** The plans and red rates already worked out: a loop asks for the same ones again and again. */
const plans = new Map<string, PlannedGolden>();
const reds = new Map<string, { red: number; fail: number }>();
const tally = (t: Tally | null) => (t ? `${t.passes}/${t.attempts}` : '-');

function planFor(goldens: number, history: Tally | null, sessions: Tally | null, record: (Tally & { sessions: number }) | null, warns: boolean): PlannedGolden {
  const key = `${goldens} ${tally(history)} ${tally(sessions)} ${tally(record)}/${record?.sessions ?? 0} ${warns}`;
  let p = plans.get(key);
  if (!p) {
    // The suite's risk split `goldens` ways: one golden here, its share as the whole risk planned.
    p = planSuite([{ golden: 'goldens/refund', gate: GATE, maxGiven: false, history, sessions, record, ...(warns ? { inconclusive: 'warn' as const } : {}) }], { risk: SUITE_RISK / goldens })!.planned[0]!;
    plans.set(key, p);
  }
  return p;
}

function redFor(rate: number, h: Tally | null, gate: BaselineGate): { red: number; fail: number } {
  const w = gate.widened;
  const key = `${rate} ${tally(h)} ${gate.risk} ${gate.max} ${w ? `${w.from} ${tally(w.record)} ${w.risk}` : '-'}`;
  let r = reds.get(key);
  if (r === undefined) reds.set(key, (r = redAt(gate, h, rate)));
  return r;
}

export interface Stage {
  name: string;
  sessions: number;
  /** Their chance of going red, exactly against each session's baseline and gate, averaged: for a golden with fewer than 30 sessions whose inconclusive only warns, its chance of failing (where its plan reads its last sessions below the sessions before them, its inconclusive counts). */
  red: number;
  /** The same with every inconclusive counted, as `--inconclusive fail` counts it, against the same gates. */
  redCounted: number;
  /** Of the sessions the plan said keep within the share, how many, their red rate, and how many went red more often than the share; of those it said can't (over, or too few sessions yet), the same, and what it said; and the drops it read. */
  within: number;
  redWithin: number;
  aboveShare: number;
  over: number;
  redOver: number;
  plannedOver: number;
  early: number;
  redEarly: number;
  plannedEarly: number;
  drop: number;
  /** The sessions whose last 10 sat below its baseline beyond chance at its share: what a drop was read from before (round 3). */
  dropAgainstBaseline: number;
  /** Suites of `goldens` of them, replicas taken that many at a time: how often their plans' reds add up past the suite's risk, how often one of them says it can't keep within its share then, how often they go red more often than the risk in fact, and how often they say so when they don't. */
  suites: number;
  flagged: number;
  saysOver: number;
  overInFact: number;
  falseAlarms: number;
  /** Those suites' exact chance of going red, averaged: by default, and with every inconclusive counted against the same gates. */
  suiteRed: number;
  suiteRedCounted: number;
}

export interface Loop {
  goldens: number;
  rate: number;
  /** Every inconclusive counted, as `--inconclusive fail` has it; else as `shadowlap test` does with none given. */
  counted: boolean;
  /** The rate it dropped to, with a regression. */
  to: number | null;
  share: number;
  stages: Stage[];
  /**
   * With a regression: each session after it, the chance it is caught (goes red), averaged, and a
   * gate's held at the share with max 40 against the same baselines; how often the plan read a drop.
   * And how it ends: red with every inconclusive counted (`counted`, as under --inconclusive fail),
   * red by failing alone (`failing`, as when every inconclusive of a golden with fewer than 30
   * sessions only warned), inconclusive and only warning (`warned`), and passed.
   */
  after: Array<{ red: number; fixed: number; drop: number; counted: number; failing: number; warned: number; passed: number }>;
}

const pool = (xs: Tally[]): Tally | null => (xs.length ? { passes: xs.reduce((a, x) => a + x.passes, 0), attempts: xs.reduce((a, x) => a + x.attempts, 0) } : null);

type After = { red: number; fixed: number; drop: number; counted: number; failing: number; warned: number; passed: number; n: number };

/** A session after a regression, added to its tally: how it ends by default, with every inconclusive counted, failing alone, warned and passed. */
function countAfter(a: After, s: { red: number; odds: { red: number; fail: number }; young: boolean; warns: boolean; drop: boolean; fixed: number }): void {
  a.n++;
  a.red += s.red;
  a.fixed += s.fixed;
  if (s.drop) a.drop++;
  a.counted += s.odds.red;
  a.failing += s.young ? s.odds.fail : s.odds.red;
  if (s.warns) a.warned += s.odds.red - s.odds.fail;
  a.passed += 1 - s.odds.red;
}

/** The loop: every history starts with no session at all, the golden's recording its only baseline. With `drop`, the agent passes `drop.to` of the time from session `drop.at` on. */
export function loop(goldens: number, rate: number, seed: number, o: { replicas: number; sessions: number; drop?: { at: number; to: number }; inconclusive?: 'fail' }): Loop {
  const random = seeded(seed);
  const share = SUITE_RISK / goldens;
  const fixed: BaselineGate = { ...GATE, risk: share };
  const zero = () => ({ sessions: 0, red: 0, redCounted: 0, within: 0, redWithin: 0, aboveShare: 0, over: 0, redOver: 0, plannedOver: 0, early: 0, redEarly: 0, plannedEarly: 0, drop: 0, dropAgainstBaseline: 0 });
  const sums = STAGES.map(zero);
  // Each session's stated red, exact red, whether it said over, and its exact red with every inconclusive counted, replica by replica.
  const said: Array<Array<[number, number, boolean, number]>> = Array.from({ length: o.sessions }, () => []);
  const after = Array.from({ length: o.drop ? o.sessions - o.drop.at : 0 }, (): After => ({ red: 0, fixed: 0, drop: 0, counted: 0, failing: 0, warned: 0, passed: 0, n: 0 }));
  for (let r = 0; r < o.replicas; r++) {
    // Each session as the store keeps it, newest last: the baseline's part of it if it passed, and every attempt of it.
    const passed: Tally[] = [];
    const every: Tally[] = [];
    for (let k = 0; k < o.sessions; k++) {
      const p = o.drop && k >= o.drop.at ? o.drop.to : rate;
      const h = pool(passed.slice(-GATE.window));
      const kept = pool(every.slice(-RECORD));
      const record = kept ? { ...kept, sessions: Math.min(every.length, RECORD) } : null;
      const recent = pool(every.slice(-GATE.window));
      // With fewer sessions than its record reads, its inconclusive only warns, as `shadowlap test` has it
      // with no --inconclusive, unless its plan reads its last sessions below the sessions before them.
      const young = o.inconclusive !== 'fail' && Math.min(every.length, RECORD) < RECORD;
      const plan = planFor(goldens, h, recent, record, young);
      const warns = young && plan.inconclusive === 'warn';
      const gate = plan.gate as BaselineGate;
      const outcomes: boolean[] = [];
      let passes = 0;
      let d = decide(0, 0, gate, h);
      while (d === 'continue') {
        const x = random() < p;
        outcomes.push(x);
        if (x) passes++;
        d = decide(passes, outcomes.length, gate, h);
      }
      const odds = redFor(p, h, gate);
      const red = warns ? odds.fail : odds.red;
      said[k].push([plan.red, red, !!plan.over, odds.red]);
      const i = STAGES.findIndex((s) => k >= s.from && k < s.to);
      if (i >= 0) {
        const s = sums[i];
        s.sessions++;
        s.red += red;
        s.redCounted += odds.red;
        if (h && recent && dropProbability(recent, h, 0) > 1 - share) s.dropAgainstBaseline++;
        if (plan.drop) s.drop++;
        else if (plan.early) {
          s.early++;
          s.redEarly += red;
          s.plannedEarly += plan.red;
        } else if (plan.over) {
          s.over++;
          s.redOver += red;
          s.plannedOver += plan.red;
        } else {
          s.within++;
          s.redWithin += red;
          if (red > share) s.aboveShare++;
        }
      }
      if (o.drop && k >= o.drop.at) countAfter(after[k - o.drop.at], { red, odds, young, warns, drop: !!plan.drop, fixed: redFor(p, h, fixed).red });
      // Kept as `shadowlap test` keeps a result, and read back as the store reads it.
      const verdict = d === 'pass' ? 'passed' : d === 'fail' ? 'failed' : 'inconclusive';
      const result = { ...gate, decision: d, passes, attempts: outcomes.length, outcomes } as unknown as GateResult;
      const data: TestResultData = { mode: 'fork', attempts: { total: outcomes.length, passed: passes, required: null, runs: [] }, verdict, gate: result };
      const stored = { ok: d === 'pass', failure: d === 'pass' ? null : d === 'fail' ? ('check' as const) : ('inconclusive' as const), data };
      every.push(sessionAttempts(stored)!);
      if (d === 'pass') passed.push(sessionAttempts(stored, GATE.min)!);
    }
  }
  const stages = STAGES.map((st, i): Stage => {
    const s = sums[i];
    let suites = 0;
    let flagged = 0;
    let saysOver = 0;
    let overInFact = 0;
    let falseAlarms = 0;
    let suiteRed = 0;
    let suiteRedCounted = 0;
    for (let k = st.from; k < Math.min(st.to, o.sessions); k++)
      for (let g = 0; g + goldens <= said[k].length; g += goldens) {
        const xs = said[k].slice(g, g + goldens);
        const stated = xs.reduce((t, x) => t + x[0], 0);
        const exact = 1 - xs.reduce((t, x) => t * (1 - x[1]), 1);
        suiteRed += exact;
        suiteRedCounted += 1 - xs.reduce((t, x) => t * (1 - x[3]), 1);
        suites++;
        if (stated > SUITE_RISK) flagged++;
        if (stated > SUITE_RISK && xs.some((x) => x[2])) saysOver++;
        if (exact > SUITE_RISK) overInFact++;
        if (stated > SUITE_RISK && !(exact > SUITE_RISK)) falseAlarms++;
      }
    const of = (x: number) => (suites ? x / suites : 0);
    return {
      name: st.name,
      sessions: s.sessions,
      red: s.sessions ? s.red / s.sessions : 0,
      redCounted: s.sessions ? s.redCounted / s.sessions : 0,
      within: s.within,
      redWithin: s.within ? s.redWithin / s.within : 0,
      aboveShare: s.aboveShare,
      over: s.over,
      redOver: s.over ? s.redOver / s.over : 0,
      plannedOver: s.over ? s.plannedOver / s.over : 0,
      early: s.early,
      redEarly: s.early ? s.redEarly / s.early : 0,
      plannedEarly: s.early ? s.plannedEarly / s.early : 0,
      drop: s.drop,
      dropAgainstBaseline: s.dropAgainstBaseline,
      suites,
      flagged: of(flagged),
      saysOver: of(saysOver),
      overInFact: of(overInFact),
      falseAlarms: of(falseAlarms),
      suiteRed: of(suiteRed),
      suiteRedCounted: of(suiteRedCounted),
    };
  });
  return { goldens, rate, counted: o.inconclusive === 'fail', to: o.drop?.to ?? null, share, stages, after: after.map((a) => ({ red: a.red / a.n, fixed: a.fixed / a.n, drop: a.drop / a.n, counted: a.counted / a.n, failing: a.failing / a.n, warned: a.warned / a.n, passed: a.passed / a.n })) };
}

export const pct = (x: number, places = 3) => `${(100 * x).toFixed(places)}%`;

/** The loops' figures as a table, for the log. */
export function table(cases: readonly Loop[]): string {
  return [
    'goldens  rate  inconclusive  stage            sessions  red (exact) (counted)  within      red  above  over      red  planned  early      red  planned  drop (vs baseline)  suites flagged says-over over-in-fact false  suite-red (counted)',
    ...cases
      .filter((c) => c.to === null)
      .flatMap((c) =>
        c.stages
          .filter((s) => s.sessions)
          .map(
            (s) =>
              `${String(c.goldens).padStart(7)}  ${c.rate.toFixed(2)}  ${(c.counted ? 'counted' : 'by default').padEnd(12)}  ${s.name.padEnd(15)}  ${String(s.sessions).padStart(8)}  ${pct(s.red).padStart(11)} (${pct(s.redCounted).padStart(7)})  ${String(s.within).padStart(6)}  ${pct(s.redWithin).padStart(7)}  ${String(s.aboveShare).padStart(5)}  ${String(s.over).padStart(4)}  ${pct(s.redOver).padStart(7)}  ${pct(s.plannedOver).padStart(7)}  ${String(s.early).padStart(5)}  ${pct(s.redEarly).padStart(7)}  ${pct(s.plannedEarly).padStart(7)}  ${String(s.drop).padStart(4)} (${String(s.dropAgainstBaseline).padStart(4)})  ${String(s.suites).padStart(6)}  ${pct(s.flagged, 0).padStart(6)}  ${pct(s.saysOver, 0).padStart(8)}  ${pct(s.overInFact, 0).padStart(11)}  ${pct(s.falseAlarms, 0).padStart(5)}  ${pct(s.suiteRed, 1).padStart(6)} (${pct(s.suiteRedCounted, 1)})`,
          ),
      ),
    ...cases
      .filter((c) => c.to !== null)
      .map((c) => `${c.rate} to ${c.to}: caught ${c.after.map((a) => pct(a.red, 2)).join(' ')}; held at 40 ${c.after.map((a) => pct(a.fixed, 2)).join(' ')}; margins ${c.after.map((a) => (100 * (a.red - a.fixed)).toFixed(4)).join(' ')} points; drop said ${c.after.map((a) => pct(a.drop, 0)).join(' ')}; every inconclusive counted ${c.after.map((a) => pct(a.counted, 1)).join(' ')}; failing alone ${c.after.map((a) => pct(a.failing, 1)).join(' ')}; warned ${c.after.map((a) => pct(a.warned, 1)).join(' ')}; passed ${c.after.map((a) => pct(a.passed, 1)).join(' ')}`),
  ].join('\n');
}
