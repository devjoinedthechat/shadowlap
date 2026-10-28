import { BASELINE_DEFAULTS, GATE_MAX_ATTEMPTS, RECORDING_BASELINE, SPRT_DEFAULTS, decide, gateOdds, type BaselineGate, type Gate, type GateDecision, type SprtGate, type Tally } from './stats.js';

/**
 * A test session's risk of going red for nothing, split across its gated goldens. One gate fails a
 * healthy golden at most about its risk of the time, so a suite of 100 forked goldens at 5% each went
 * red on most runs of a healthy agent. `shadowlap test` gives the whole session one risk instead
 * (`--suite-risk`, `tests.suiteRisk`, 5% by default) and each gated golden an equal share of it, the
 * Bonferroni split: the chance that any golden goes red is at most the sum of the chances that each
 * does, whatever they have in common (one agent behind all of them), so shares that add up to the
 * risk keep the suite within it.
 *
 * Bonferroni rather than Holm: Holm's step-down would let a golden use the risk others left unused,
 * but its thresholds depend on every golden's evidence at once, and a gate decides as its own attempts
 * come in, before the goldens after it have run. A healthy suite's goldens end far from their
 * failing bounds, where the two split alike.
 *
 * A golden's share is spent where it goes red for nothing: failing at its gate's `good` rate, and,
 * under `--inconclusive fail` (the default), running out of attempts there. An SPRT gate keeps its
 * `risk` for a pass, the safety side, and takes the lower `failRisk` the share allows, worked out
 * exactly (`gateOdds` at `good`, every look counted); its `max`, unless the config or
 * `--max-attempts` set one, is raised until at most 1% of attempts at `good` (or half the share, when
 * that is less) end inconclusive. An agent that passes more often than `good` goes red less often
 * still: the chance of a pass only rises with the pass rate. A gate against history gets the share
 * as its `risk`, halved until its red rate is within it, worked out over every pass rate the golden's
 * last sessions leave open, those that went red included (`predictive`): no single rate will do, as
 * a baseline that came out lucky makes the gate fail an agent that is as it was, and a short one
 * comes out lucky often. With no session yet, its baseline is its recording, one attempt that passed,
 * which leaves most rates open: such a gate can't keep within its share, and the plan says so
 * (`over`), and by how much, until its sessions make it a baseline. A seeded loop of sessions, each
 * sized, decided and pooled as `shadowlap test` does from a golden's first session on, holds the
 * plan to that at 80% down to 50% (gate-history-budget.test.ts).
 */

/** The most a healthy suite goes red for nothing, by default: `--suite-risk`, `tests.suiteRisk`. */
export const SUITE_RISK = 0.05;

/** A gate's inconclusive share at its `good` rate, when the session sizes its `max`: at most this, or half the golden's share when that is less. */
export const INCONCLUSIVE_AT_GOOD = 0.01;

/** The most attempts a sized gate against history runs: its odds are worked out attempt by attempt, and past this a history gate is the wrong tool. */
const HISTORY_SIZE_LIMIT = 400;

/**
 * How the agent a gate against history judges is taken to pass, attempt by attempt, given `seen`,
 * what its sessions have shown of it: its pass rate unknown, Beta(1 + passes, 2 + failures), and
 * each attempt passing with that rate's mean given the attempts before it (a beta-binomial, Pólya's
 * urn). A red rate worked out this way is the gate's averaged over every rate `seen` leaves open,
 * each weighed by how likely `seen` makes it, so a short record is sized for the low rates it
 * leaves open too. One failure more than it has shown (`PLANNED_FAILURES`) leans a short record
 * towards those, so the figure errs high where it errs; with nothing seen, what it has is its
 * recording, one attempt that passed.
 */
export function predictive(seen: Tally | null): (passes: number, attempts: number) => number {
  const b = seen && seen.attempts > 0 ? seen : RECORDING_BASELINE;
  const yes = 1 + b.passes;
  const no = 1 + PLANNED_FAILURES + b.attempts - b.passes;
  return (passes, attempts) => (yes + passes) / (yes + no + attempts);
}

/**
 * The failures a session's plan adds to what a golden's sessions show of its agent (`predictive`).
 * Taken as shown, the plan was right on average over every agent, but not for each: an agent at 50%
 * went red 22% of the time in its first session against the 17% planned, and a golden the plan said
 * kept within its share of 20 went red up to 0.26% of the time against 0.25%. With one more, a
 * plan that says within holds for every agent from 50% up, and one that says over says at least
 * about as much as it goes red (gate-history-budget.test.ts).
 */
export const PLANNED_FAILURES = 1;

/** A gated golden as the session finds it, before its gate takes its share. */
export interface SuiteGolden {
  golden: string;
  gate: Gate;
  /** The config or `--max-attempts` set the gate's `max`: the session never changes it. */
  maxGiven: boolean;
  /** A gate against history: its baseline (null or none: its recording). */
  history?: Tally | null;
  /**
   * A gate against history: every attempt of its last `window` sessions that could be part of a
   * baseline, whatever they came to (null or none: its baseline's). A baseline leaves out the
   * sessions that went red, so after one that came out lucky it overstates the agent, and the gate
   * fails it more often; these don't, and its red rate is worked out over the pass rates they leave
   * open (`predictive`). Every attempt, not each session's first `min` as a baseline takes them:
   * with no session left out for what it came to, where one stopped tells nothing of the agent's
   * rate that its attempts don't.
   */
  sessions?: Tally | null;
  /** Its pass rate as its recent results show it, for the forecast; null for one with none. */
  rate?: number | null;
  /** USD an attempt costs, from its recent results or its recording; null when no price is known. */
  costPerAttempt?: number | null;
}

/** A gated golden's gate as it runs this session, with what it costs and risks. */
export interface PlannedGolden {
  golden: string;
  gate: Gate;
  /** The chance it goes red for nothing, exactly: at its gate's `good` rate (an SPRT), averaged over the pass rates its sessions leave open (history). */
  red: number;
  /** The pass rate `red` is worked out at: its gate's `good` rate, or the mean of the rates its sessions leave open. */
  at: number;
  /** The pass rate the forecast is worked out at: its recent results', else its gate's `good` rate or what its sessions show. */
  forecastAt: number;
  /** Attempts it runs on average at `forecastAt`, and the most it can. */
  attempts: number;
  most: number;
  /** USD those attempts cost on average, or null with no price. */
  cost: number | null;
  /** Why its share could not be met, when it could not: a `max` the config set that leaves too many inconclusive, or a gate against history whose sessions are too few, or whose baseline came out too lucky, to tell a drop from chance at its share. */
  over?: string;
}

/** What `shadowlap test --json` reports as `suite`, and the session prints before it runs. */
export interface SuitePlan {
  /** The most the session may go red for nothing. */
  risk: number;
  /** Each gated golden's share: risk / goldens. */
  perGoldenRisk: number;
  /** How the risk was split. */
  method: 'bonferroni';
  /** Gated goldens sharing it. */
  goldens: number;
  /** What an inconclusive verdict does, which decides whether it is spent on running out of attempts too. */
  inconclusive: 'fail' | 'warn';
  /** The chance the session goes red for nothing, at most, as planned: each golden's `red`, summed. */
  red: number;
  planned: PlannedGolden[];
  /** Attempts on average and at most, and what they cost on average (null when no golden has a price; `unpriced` counts those without one). */
  forecast: { attempts: number; most: number; cost: number | null; unpriced: number };
}

/** A risk rounded down to two significant digits: never above what was worked out. */
function roundDown(x: number): number {
  if (!(x > 0)) return x;
  const scale = 10 ** (1 - Math.floor(Math.log10(x)));
  return Math.floor(x * scale) / scale;
}

/** After each attempt n (index n), the chance a gate has passed, failed, and is still going. */
interface Curves {
  pass: number[];
  fail: number[];
  going: number[];
}

/** A gate's curves to `limit`, or to the first attempt at which `enough` says the walk has gone far enough. */
type Walk = (gate: Gate, limit: number, enough: (attempts: number, going: number) => boolean) => Curves;

/** The curves of a rule at rate p: one walk over every count of passes it can see. */
function curves(rule: (passes: number, attempts: number) => GateDecision, p: number, limit: number, enough: (attempts: number, going: number) => boolean = () => false): Curves {
  const pass = [0];
  const fail = [0];
  const going = [1];
  let walking = new Map<number, number>([[0, 1]]);
  for (let n = 1; n <= limit; n++) {
    const next = new Map<number, number>();
    let passed = 0;
    let failed = 0;
    let left = 0;
    for (const [s, mass] of walking) {
      for (const [passes, q] of [
        [s + 1, p],
        [s, 1 - p],
      ] as const) {
        if (q === 0) continue;
        const m = mass * q;
        const d = rule(passes, n);
        if (d === 'pass') passed += m;
        else if (d === 'fail') failed += m;
        else {
          next.set(passes, (next.get(passes) ?? 0) + m);
          left += m;
        }
      }
    }
    pass.push(pass[n - 1]! + passed);
    fail.push(fail[n - 1]! + failed);
    going.push(left);
    walking = next;
    if (enough(n, left)) break;
    if (left < 1e-15) {
      pad({ pass, fail, going }, n, limit);
      break;
    }
  }
  return { pass, fail, going };
}

/** Curves that stopped at attempt n with nothing going, carried on to `limit`. */
function pad(c: Curves, n: number, limit: number): void {
  for (let k = n + 1; k <= limit; k++) {
    c.pass.push(c.pass[n]!);
    c.fail.push(c.fail[n]!);
    c.going.push(0);
  }
}

/**
 * The curves of a gate against history for an agent that passes with `chance` after the attempts
 * before (`predictive`). From `min` on, the gate fails up to some count of passes and passes from
 * some count on, as a drop only gets less likely as passes rise: so only the counts where its
 * decision changes are asked of `decide`, a few an attempt, and a walk to hundreds of attempts over
 * every rate a baseline leaves open stays quick. Decision for decision, it is the walk `decide` takes.
 */
function historyCurves(gate: Gate, history: Tally | null, chance: (passes: number, attempts: number) => number, limit: number, enough: (attempts: number, going: number) => boolean): Curves {
  const says = (s: number, n: number) => decide(s, n, gate, history);
  const min = gate.kind === 'baseline' ? gate.min : 1;
  const c: Curves = { pass: [0], fail: [0], going: [1] };
  let mass = new Float64Array([1]);
  // The counts of passes still going, lo to hi, and where the last attempt's decision changed.
  let lo = 0;
  let hi = 0;
  let failTo = -1;
  let passFrom = 0;
  let started = false;
  for (let n = 1; n <= limit; n++) {
    const next = new Float64Array(n + 1);
    for (let s = lo; s <= hi; s++) {
      const m = mass[s]!;
      if (m === 0) continue;
      const up = chance(s, n - 1);
      next[s + 1] = next[s + 1]! + m * up;
      next[s] = next[s]! + m * (1 - up);
    }
    // Before `min` it decides nothing; from there on it fails up to f passes and passes from p.
    let f = -1;
    let p = n + 1;
    if (n >= min) {
      if (!started) {
        p = 0;
        while (p <= n && says(p, n) !== 'pass') p++;
        while (f + 1 < p && says(f + 1, n) === 'fail') f++;
        started = true;
      } else {
        // An attempt more moves each count up by one or not at all: a failure more only makes a drop
        // likelier, and a pass more only less likely.
        p = says(passFrom, n) === 'pass' ? passFrom : passFrom + 1;
        f = failTo + 1 < p && says(failTo + 1, n) === 'fail' ? failTo + 1 : failTo;
      }
      passFrom = p;
      failTo = f;
    }
    let passed = 0;
    let failed = 0;
    let left = 0;
    const top = Math.min(hi + 1, n);
    for (let s = lo; s <= top; s++) {
      const m = next[s]!;
      if (s <= f) failed += m;
      else if (s >= p) passed += m;
      else left += m;
    }
    c.pass.push(c.pass[n - 1]! + passed);
    c.fail.push(c.fail[n - 1]! + failed);
    c.going.push(left);
    lo = Math.max(lo, f + 1);
    hi = Math.min(top, p - 1);
    mass = next;
    if (enough(n, left)) break;
    if (left < 1e-15 || lo > hi) {
      pad(c, n, limit);
      break;
    }
  }
  return c;
}

/** How a gate with these figures does on `walk`: its `max` (given, or the fewest from `floor` up that leave at most `inconclusive` going), and the chance it goes red there. */
function sized(gate: Gate, walk: Walk, o: { maxGiven: boolean; floor: number; inconclusive: number; mode: 'fail' | 'warn'; limit: number }): { max: number; red: number; going: number; fail: number } {
  const unbounded: Gate = { ...gate, max: o.limit };
  const given = Math.min(gate.max, o.limit);
  // The walk stops where the max it looks for is: the one given, or the first from `floor` on that leaves few enough going.
  const c = walk(unbounded, o.limit, (n, going) => (o.maxGiven ? n >= given : n >= o.floor && going <= o.inconclusive));
  let max = o.maxGiven ? given : o.floor;
  if (!o.maxGiven) while (max < o.limit && c.going[max]! > o.inconclusive) max++;
  const red = o.mode === 'fail' ? 1 - c.pass[max]! : c.fail[max]!;
  return { max: o.maxGiven ? gate.max : max, red: Math.max(0, red), going: c.going[max]!, fail: c.fail[max]! };
}

/** An SPRT gate's figures for its share `r`: the largest failRisk (two digits, rounded down) whose red rate at `good` is within it. */
function planSprt(g: SprtGate, r: number, o: { maxGiven: boolean; mode: 'fail' | 'warn' }): { gate: SprtGate; red: number; over?: string } {
  const inconclusive = o.mode === 'fail' ? Math.min(INCONCLUSIVE_AT_GOOD, r / 2) : INCONCLUSIVE_AT_GOOD;
  const floor = o.maxGiven ? g.max : Math.max(g.max, SPRT_DEFAULTS.max);
  const { failRisk: _own, ...figures } = g;
  const atGood: Walk = (gate, limit, enough) => curves((s, n) => decide(s, n, gate), g.good, limit, enough);
  const at = (failRisk: number) => {
    const gate: SprtGate = { ...figures, ...(failRisk < g.risk ? { failRisk } : {}) };
    const s = sized(gate, atGood, { maxGiven: o.maxGiven, floor, inconclusive, mode: o.mode, limit: GATE_MAX_ATTEMPTS });
    return { gate: { ...gate, max: s.max }, red: s.red, going: s.going };
  };
  const own = g.failRisk ?? g.risk;
  const first = at(own);
  if (first.red <= r) return { gate: first.gate, red: first.red };
  // The red rate rises with failRisk: bisect on its logarithm for the largest within the share.
  let lo = Math.log(1e-12);
  let hi = Math.log(own);
  if (at(Math.exp(lo)).red > r) return { ...first, over: overWhy(g, first, r, o) };
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (at(Math.exp(mid)).red <= r) lo = mid;
    else hi = mid;
  }
  let failRisk = roundDown(Math.exp(lo));
  let best = at(failRisk);
  for (let i = 0; i < 20 && best.red > r; i++) best = at((failRisk = roundDown(failRisk * 0.9)));
  return { gate: best.gate, red: best.red };
}

/** Why a gate whose `max` was set can't keep within its share, in words. */
function overWhy(g: Gate, first: { red: number; going: number }, r: number, o: { mode: 'fail' | 'warn' }): string {
  return o.mode === 'fail' && first.going > r
    ? `its max of ${g.max} leaves ${pct(first.going)} of attempts at its good rate inconclusive, more than its ${pct(r)} share of the suite's risk: raise its max, or leave it out to let the session size it`
    : `it goes red ${pct(first.red)} of the time at its good rate, more than its ${pct(r)} share of the suite's risk`;
}

const pct = (x: number) => `${+(x * 100).toPrecision(2)}%`;

/**
 * A gate against history for its share `r`: `risk` at most the share, halved until its red rate
 * is within it, averaged over every pass rate the agent's sessions leave open (`predictive`), each
 * decided against the baseline the gate has. A lower risk fails fewer, so when even a gate that
 * never fails is red too often (left undecided by its last attempt, as an agent well below a
 * baseline that came out lucky is), none will do: the plan says so, and by how much, and the gate
 * runs at its share. With no history, its baseline is its recording, one attempt that passed.
 */
function planHistory(g: BaselineGate, r: number, history: Tally | null, sessions: Tally | null | undefined, o: { maxGiven: boolean; mode: 'fail' | 'warn' }): { gate: BaselineGate; red: number; at: number; estimate: number; over?: string } {
  const known = history && history.attempts > 0 ? history : null;
  // What the agent's sessions show of it: those that went red too, else its baseline, else its recording.
  const seen = sessions && sessions.attempts > 0 ? sessions : known;
  const shown = seen ?? RECORDING_BASELINE;
  const estimate = shown.passes / shown.attempts;
  // The mean of the rates its sessions leave open, which `red` is averaged over.
  const at = (1 + shown.passes) / (2 + PLANNED_FAILURES + shown.attempts);
  const agent = predictive(seen);
  const walk: Walk = (gate, limit, enough) => historyCurves(gate, known, agent, limit, enough);
  const inconclusive = o.mode === 'fail' ? Math.min(INCONCLUSIVE_AT_GOOD, r / 2) : INCONCLUSIVE_AT_GOOD;
  const floor = o.maxGiven ? g.max : Math.max(g.max, BASELINE_DEFAULTS.max, g.min);
  const limit = Math.max(floor, HISTORY_SIZE_LIMIT);
  const size = (risk: number) => sized({ ...g, risk }, walk, { maxGiven: o.maxGiven, floor, inconclusive, mode: o.mode, limit });
  const plan = (risk: number, s: { max: number; red: number }) => ({ gate: { ...g, risk, max: s.max }, red: s.red, at, estimate });
  const own = Math.min(g.risk, roundDown(r));
  const first = size(own);
  if (first.red <= r) return plan(own, first);
  // At risk 0 it never fails: if that is red too often, so is every risk.
  if (first.fail > 0 && size(0).red <= r) {
    let risk = own;
    for (let i = 0; i < 12; i++) {
      risk = roundDown(risk / 2);
      const s = size(risk);
      if (s.red <= r) return plan(risk, s);
    }
  }
  const rates = seen ? `the pass rates its sessions leave open (${seen.passes} of their ${seen.attempts} attempts passed)` : 'the pass rates that leaves open';
  const over = known
    ? `it goes red ${pct(first.red)} of the time against its baseline (${known.passes} of ${known.attempts}) over ${rates}, more than its ${pct(r)} share of the suite's risk: too short a baseline, or one that came out too lucky, to tell a drop from chance at that risk; sessions that pass make it surer`
    : `it has no baseline yet, only its recording, one attempt that passed: against that it goes red ${pct(first.red)} of the time over ${rates}, more than its ${pct(r)} share of the suite's risk; sessions that pass make it a baseline`;
  return { ...plan(own, first), over };
}

/**
 * The attempts a gate runs on average at rate p, as `gateOdds` works them out: for a gate against
 * history, from its curves (`historyCurves`), as the chance it is still going after each attempt
 * before its last, summed. Asking `decide` for every tally a walk to hundreds of attempts meets
 * took seconds a golden.
 */
function attemptsAt(gate: Gate, p: number, history: Tally | null): number {
  if (gate.kind !== 'baseline' || gate.max < gate.min) return gateOdds(gate, p, history).attempts;
  const c = historyCurves(gate, history, () => p, gate.max, () => false);
  let attempts = 0;
  for (let n = 0; n < gate.max; n++) attempts += c.going[n]!;
  return attempts;
}

/**
 * The session's plan: each gated golden's gate with its share of `risk`, the chance each goes red for
 * nothing, and what the session costs on average and at most. Null with no gated golden.
 */
export function planSuite(goldens: readonly SuiteGolden[], o: { risk?: number; inconclusive?: 'fail' | 'warn' } = {}): SuitePlan | null {
  if (!goldens.length) return null;
  const risk = o.risk ?? SUITE_RISK;
  if (!(risk > 0 && risk < 0.5)) throw new RangeError('the suite risk must be above 0 and below 0.5');
  const mode = o.inconclusive ?? 'fail';
  const share = risk / goldens.length;
  // Goldens under one tests entry share their figures: each set of figures is planned once.
  const plans = new Map<string, { gate: Gate; red: number; at: number; estimate: number; over?: string }>();
  const planOf = (x: SuiteGolden, history: Tally | null): { gate: Gate; red: number; at: number; estimate: number; over?: string } => {
    const key = JSON.stringify([x.gate, x.maxGiven, x.gate.kind === 'baseline' ? [history, x.sessions] : null]);
    const known = plans.get(key);
    if (known) return known;
    const p = x.gate.kind === 'sprt' ? { ...planSprt(x.gate, share, { maxGiven: x.maxGiven, mode }), at: x.gate.good, estimate: x.gate.good } : planHistory(x.gate, share, history, x.sessions, { maxGiven: x.maxGiven, mode });
    plans.set(key, p);
    return p;
  };
  const planned = goldens.map((x): PlannedGolden => {
    const history = x.history && x.history.attempts > 0 ? x.history : null;
    const p = planOf(x, history);
    // What it costs is forecast at the rate its recent results show, else the one its gate or baseline does.
    const forecastAt = x.rate ?? p.estimate;
    const attempts = attemptsAt(p.gate, forecastAt, history);
    return {
      golden: x.golden,
      gate: p.gate,
      red: p.red,
      at: p.at,
      forecastAt,
      attempts,
      most: p.gate.max,
      cost: x.costPerAttempt === null || x.costPerAttempt === undefined ? null : attempts * x.costPerAttempt,
      ...(p.over ? { over: p.over } : {}),
    };
  });
  const priced = planned.filter((x) => x.cost !== null);
  return {
    risk,
    perGoldenRisk: share,
    method: 'bonferroni',
    goldens: goldens.length,
    inconclusive: mode,
    red: Math.min(1, planned.reduce((n, x) => n + x.red, 0)),
    planned,
    forecast: {
      attempts: planned.reduce((n, x) => n + x.attempts, 0),
      most: planned.reduce((n, x) => n + x.most, 0),
      cost: priced.length ? priced.reduce((n, x) => n + x.cost!, 0) : null,
      unpriced: planned.length - priced.length,
    },
  };
}
