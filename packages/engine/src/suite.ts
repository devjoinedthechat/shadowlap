import { BASELINE_DEFAULTS, GATE_MAX_ATTEMPTS, RECORDING_BASELINE, SPRT_DEFAULTS, decide, dropProbability, gateOdds, type BaselineGate, type Gate, type GateDecision, type SprtGate, type Tally } from './stats.js';

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
 * as its `risk`, its red rate worked out over every pass rate the golden's record leaves open, those
 * sessions that went red included (`predictive`): no single rate will do, as a baseline that came
 * out lucky makes the gate fail an agent that is as it was, and a short one comes out lucky often.
 * Its `max` grows until that rate is within the share, and a pass past 40, however its max got
 * there, is held to the record too (`BaselineGate.widened`), so attempts added let a drop through by
 * luck all but never. Last sessions below the ones before them beyond chance read as a drop
 * (`drop`); with fewer sessions than its record reads, a gate over its share has too few yet
 * (`early`), and with none its baseline is its recording, one attempt that passed. A seeded loop of
 * sessions, each planned, decided and pooled as `shadowlap test` does from a golden's first session
 * on, holds the plan to that at 90% down to 50% (gate-history-budget.test.ts), and a regression to
 * being caught about as often as at the gate's own max (gate-history-regression.test.ts).
 */

/** The most a healthy suite goes red for nothing, by default: `--suite-risk`, `tests.suiteRisk`. */
export const SUITE_RISK = 0.05;

/** A gate's inconclusive share at its `good` rate, when the session sizes its `max`: at most this, or half the golden's share when that is less. */
export const INCONCLUSIVE_AT_GOOD = 0.01;

/** The most attempts a sized gate against history runs: its odds are worked out attempt by attempt, and past this a history gate is the wrong tool. */
const HISTORY_SIZE_LIMIT = 400;

/**
 * How likely a golden's last sessions may be below the sessions of its record before them before
 * its gate gets no more than its own `max`: past this they may be a drop, and a pass past that max
 * is held to those earlier sessions, as the record that holds them is too low a bar.
 */
export const DECLINE_AT = 0.8;

/**
 * How likely a golden's last sessions sit below the sessions of its record before them before its
 * inconclusive counts though its history is short (`SuiteGolden.inconclusive`): a decline that more
 * history would not explain away, 99 to 1, or a drop. Not `DECLINE_AT`: at 4 to 1 a healthy agent's
 * sessions sit that far below often enough that a suite of 20 at 80% went red for nothing in 2.3% of
 * its 11th to 20th sessions, over 400 histories, nearly three times what it does at 99 to 1, as
 * docs/gating.md gives it from engine/test/gating-figures.json, which is worked out at this value.
 */
export const COUNTS_AT = 0.99;

/** How many windows of a golden's last sessions a plan reads for what its agent passes (`record`): 30 by default, so a session the agent's luck went one way weighs little. */
export const RECORD_WINDOWS = 3;

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
 * plan that says within holds on average for every agent from 50% up, and one that says over says
 * at least about as much as it goes red (gate-history-budget.test.ts).
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
   * baseline, whatever they came to (null or none: none yet). Whether they sit below the sessions
   * of its record before them beyond chance tells a drop (`drop`).
   */
  sessions?: Tally | null;
  /**
   * A gate against history: the same over its last `RECORD_WINDOWS` windows of sessions, and how
   * many sessions that is (absent: `sessions`). What its agent passes is worked out from these: a
   * baseline leaves out the sessions that went red, so after one that came out lucky it overstates
   * the agent, and the gate fails it more often; these don't, and its red rate is worked out over
   * the pass rates they leave open (`predictive`), and a pass past its gate's own max is held to
   * them (`BaselineGate.widened`). Every attempt, not each session's first `min` as a baseline
   * takes them: with no session left out for what it came to, where one stopped tells nothing of the
   * agent's rate that its attempts don't. A caller that gives none has its last `window` sessions
   * taken for it, else its baseline: a shorter record, which holds the gate to more.
   */
  record?: (Tally & { sessions?: number }) | null;
  /**
   * What its inconclusive does, when not what the session's does (`planSuite`'s `inconclusive`): a gate
   * against history whose record holds fewer sessions than it reads only warns by default, its history
   * too short to tell a drop from chance. Its chance of going red is then of failing alone. A gate
   * against history is still sized as the session's are, so it runs the attempts that would settle it,
   * and the sessions they pass keep its baseline learning; an SPRT gate, with no baseline to keep, is
   * sized for what its own inconclusive does. One whose inconclusive only warns where the session's
   * counts counts it all the same once its last sessions sit below the sessions before them, 99 to 1
   * likely (`COUNTS_AT`, a decline) or beyond chance at its share (a drop), which more history would
   * not explain away (`PlannedGolden.counts`).
   */
  inconclusive?: 'fail' | 'warn';
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
  /** The pass rate the forecast is worked out at: an SPRT's recent results', else its `good` rate; for a gate against history, the mean of the rates its last sessions leave open, the forecast averaged over them. */
  forecastAt: number;
  /** Attempts it runs on average at `forecastAt`, and the most it can. */
  attempts: number;
  most: number;
  /** USD those attempts cost on average, or null with no price. */
  cost: number | null;
  /** Why its share could not be met, when it could not: a `max` the config set that leaves too many inconclusive, or a gate against history whose baseline came out too lucky, or is too short, to tell a drop from chance at its share. */
  over?: string;
  /** A gate against history with too few sessions yet to keep within its share, and why: what it goes red, about, over the rates they leave open. */
  early?: string;
  /** A gate against history whose last sessions sit below the sessions before them beyond chance: what they show. It runs as its baseline asks, at its share and its max. */
  drop?: string;
  /** What its inconclusive does this session, when not what the session's does (`SuiteGolden.inconclusive`), and `red` counts it so. */
  inconclusive?: 'fail' | 'warn';
  /**
   * A golden whose inconclusive would only warn, its history short, that counts it as the session does:
   * its last sessions sit below the sessions before them, a decline or a drop. What they show.
   */
  counts?: string;
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
      } else if (gate.kind === 'baseline' && gate.widened && n === gate.widened.from + 1) {
        // Past a widened gate's own max, a pass asks more of its attempts: the count it passes from
        // may rise by more than one here, never fall, and moves by one at most again after it.
        p = passFrom;
        while (p <= n && says(p, n) !== 'pass') p++;
        f = failTo + 1 < p && says(failTo + 1, n) === 'fail' ? failTo + 1 : failTo;
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

/** What a session's plan makes of a golden's gate. */
interface Plan {
  gate: Gate;
  red: number;
  at: number;
  estimate: number;
  /** A gate against history's: the attempts it runs on average, and the rate that is worked out at, for the agent as its last sessions show it. */
  forecast?: { attempts: number; at: number };
  over?: string;
  early?: string;
  drop?: string;
  inconclusive?: 'fail' | 'warn';
  counts?: string;
}

/**
 * A gate against history for its share `r`, at the share as its `risk`. Its red rate is worked out
 * exactly over every pass rate its record leaves open (`predictive`), each decided against the
 * baseline the gate has, and its `max` is raised from its own until at most 1% of attempts (or half
 * the share, when that is less) end undecided and its red rate is within the share, or as far as
 * `HISTORY_SIZE_LIMIT` when none is. More attempts pass more agents that are as they were, and the
 * pass rule (a drop no likelier than not) would pass more that dropped too: so past the most attempts
 * a gate against history runs by default, however its `max` gets there (this plan, its config,
 * `--max-attempts`, Run more attempts), a pass also needs its attempts to make a drop from the
 * golden's record at most the gate's own risk likely (`BaselineGate.widened`), which an agent that
 * dropped, below its record by the drop, all but never does by luck; and its red rate is worked out
 * under that rule. A gate gets no more than its own `max` with no baseline its sessions made
 * (against its recording, an agent that passes much less often than that one attempt suggests can't
 * pass however long it runs), nor once its last sessions sit below the sessions of its record before
 * them (`DECLINE_AT`), every attempt of each against every attempt of the others, and a pass past
 * that max is then held to the agent before them. Below them beyond chance, at its share, the plan
 * reads a drop (`drop`), works its red rate out for the agent before it, and says so. With fewer
 * sessions behind it than its record reads (`RECORD_WINDOWS` windows), a gate over its share is
 * `early`: too few to tell. With no session at all, its baseline is its recording, one attempt that
 * passed.
 */
function planHistory(g: BaselineGate, r: number, x: { history: Tally | null; sessions: Tally | null; record: (Tally & { sessions?: number }) | null }, o: { maxGiven: boolean; mode: 'fail' | 'warn'; sizing?: 'fail' | 'warn' }): Plan {
  const known = x.history && x.history.attempts > 0 ? x.history : null;
  const recent = x.sessions && x.sessions.attempts > 0 ? x.sessions : null;
  // Its record: absent, its last window of sessions, else its baseline (an API caller that gives neither).
  const record = x.record && x.record.attempts > 0 ? x.record : (recent ?? known);
  // The agent before what its last sessions show: the sessions of its record before them.
  const older = record && recent && record.attempts > recent.attempts ? { passes: record.passes - recent.passes, attempts: record.attempts - recent.attempts } : null;
  // How likely its last sessions sit below the sessions before them, like with like: every attempt of
  // each, whatever it came to, and none in both. Past DECLINE_AT, no more attempts; beyond chance at its
  // share, a drop. Against its baseline instead, which takes only sessions that passed, the first `min`
  // attempts of each, a healthy agent that fails often looked dropped well past its share.
  const below = older && recent ? dropProbability(recent, older, 0) : 0;
  const dropped = below > 1 - r;
  const declining = below > DECLINE_AT;
  // Sized as the session counts an inconclusive (`sizing`), so one whose own inconclusive only warns
  // still runs the attempts that would settle it; its chance of going red is counted as its own is,
  // unless its last sessions sit below the sessions before them, 99 to 1 likely (`COUNTS_AT`) or beyond
  // chance at its share: a decline or a drop is no shortage of history, and then its inconclusive
  // counts as the session's does.
  const sizing = o.sizing ?? o.mode;
  const mode = o.mode === 'warn' && sizing === 'fail' && (dropped || below > COUNTS_AT) ? sizing : o.mode;
  const seen = dropped ? (older ?? known) : declining ? (older ?? record ?? known) : (record ?? known);
  const shown = seen ?? RECORDING_BASELINE;
  const estimate = shown.passes / shown.attempts;
  // The mean of the rates its record leaves open, which `red` is averaged over.
  const at = (1 + shown.passes) / (2 + PLANNED_FAILURES + shown.attempts);
  const floor = o.maxGiven ? g.max : Math.max(g.max, BASELINE_DEFAULTS.max, g.min);
  // More attempts only against a baseline its sessions made, for a record that gives them something to be sized for.
  const widen = !o.maxGiven && known !== null && record !== null && !declining;
  const limit = widen ? Math.max(floor, HISTORY_SIZE_LIMIT) : floor;
  const risk = Math.min(g.risk, roundDown(r));
  const gate: BaselineGate = { kind: 'baseline', drop: g.drop, risk, window: g.window, min: g.min, max: g.max };
  // Past the most attempts a gate against history runs by default, a pass also holds against the
  // golden's record, at the gate's own risk, however its max comes past them (this plan, its config,
  // --max-attempts, Run more attempts): every attempt of its last sessions, or of those before its
  // last `window` when these sit below them, the agent before what they show.
  const from = Math.max(BASELINE_DEFAULTS.max, g.min);
  const kept = record === x.record ? x.record?.sessions : undefined;
  const reference = (dropped || declining) && older ? { ...older, ...(kept !== undefined ? { sessions: kept - Math.min(kept, g.window) } : {}) } : record ? { passes: record.passes, attempts: record.attempts, ...(kept !== undefined ? { sessions: kept } : {}) } : null;
  const bound = reference ? { from, record: reference, ...((dropped || declining) && older ? { before: g.window } : {}), risk: g.risk } : null;
  const inconclusive = sizing === 'fail' ? Math.min(INCONCLUSIVE_AT_GOOD, r / 2) : INCONCLUSIVE_AT_GOOD;
  const c = historyCurves({ ...gate, max: limit, ...(bound ? { widened: bound } : {}) }, known, predictive(seen), limit, () => false);
  const redAt = (m: number, as: 'fail' | 'warn') => Math.max(0, as === 'fail' ? 1 - c.pass[m]! : c.fail[m]!);
  // The fewest attempts from its own max that leave few enough undecided and keep within the share; else every attempt it may.
  let max = limit;
  for (let m = floor; m <= limit; m++) {
    if (c.going[m]! <= inconclusive && redAt(m, sizing) <= r) {
      max = m;
      break;
    }
  }
  const red = redAt(max, mode);
  const planned: BaselineGate = { ...gate, max, ...(bound ? { widened: bound } : {}) };
  // What it costs, for the agent as its last sessions show it: a drop runs on longer than the agent before it.
  const now = recent ?? record ?? known;
  const shownNow = now ?? RECORDING_BASELINE;
  const forecast = historyCurves(planned, known, predictive(now), max, () => false);
  let attempts = 0;
  for (let n = 0; n < max; n++) attempts += forecast.going[n]!;
  const plan: Plan = { gate: planned, red, at, estimate, forecast: { attempts, at: (1 + shownNow.passes) / (2 + PLANNED_FAILURES + shownNow.attempts) } };
  // How many sessions its record holds, when known (none: its recording alone).
  const sessions = record ? (x.record?.sessions ?? null) : 0;
  if (mode !== sizing) plan.inconclusive = mode;
  if (mode !== o.mode && recent && older) plan.counts = countsWhy(recent, older, { sessions, window: g.window, share: r, dropped });
  if (dropped && recent && older) {
    plan.drop = dropWhy(recent, older, { sessions, window: g.window, share: r, max });
    return plan;
  }
  if (red <= r) return plan;
  const share = `where its share of the suite's risk is ${pct(r)}`;
  const against = known ? `against its baseline (${known.passes} of ${known.attempts})` : 'against its recording';
  const rates = ratesWhy(seen, { older: seen === older, baselineOnly: seen === known && !x.record && !recent, sessions, window: g.window });
  // Under --inconclusive warn, or for a golden whose inconclusive only warns, its chance is of failing.
  const goes = mode === 'fail' ? 'goes red' : 'fails';
  // A gate on two fixed rates needs no history at all: worth knowing while there is little.
  const fixed = 'or give it a gate on fixed rates, "good" and "bad", which needs no history';
  if (!known && !x.record && !recent) plan.early = `no baseline yet, only its recording, one attempt that passed: against that it ${goes} about ${pct(red)} of the time, ${rates}, ${share}; sessions that pass make it a baseline, ${fixed}`;
  else if (sessions !== null && sessions < RECORD_WINDOWS * g.window) plan.early = `only ${sessions === 1 ? 'one session' : `${sessions} sessions`} yet: ${against} it ${goes} about ${pct(red)} of the time, ${rates}, ${share}; sessions that pass make it surer, ${fixed}`;
  else plan.over = `${against} it ${goes} about ${pct(red)} of the time, ${rates}, ${share}: a baseline that came out lucky, or too short a one, to tell a drop from chance at that share`;
  return plan;
}

/** Its last `window` sessions and the sessions of its record before them, in words: how many of each, when known. */
function lastAndBefore(sessions: number | null, window: number): { last: number; before: number } | null {
  if (sessions === null) return null;
  const last = Math.min(sessions, window);
  return { last, before: sessions - last };
}

/**
 * Why a golden whose inconclusive would only warn, its history short, counts it all the same: its last
 * sessions sit below the sessions before them, every attempt of each, 99 to 1 likely or more (a
 * decline, `COUNTS_AT`) or beyond chance at its share (a drop), which more history would not explain away.
 */
function countsWhy(recent: Tally, older: Tally, o: { sessions: number | null; window: number; share: number; dropped: boolean }): string {
  const n = lastAndBefore(o.sessions, o.window);
  const last = !n ? 'its last sessions sit' : n.last === 1 ? 'its last session sits' : `its last ${n.last} sessions sit`;
  const before = !n ? 'the sessions before them' : `the ${n.before === 1 ? 'one' : n.before} before ${n.last === 1 ? 'it' : 'them'}`;
  const odds = Math.round(COUNTS_AT / (1 - COUNTS_AT));
  return `${last} below ${before}, ${recent.passes} of ${recent.attempts} attempts against ${older.passes} of ${older.attempts}, ${o.dropped ? `beyond chance at its ${pct(o.share)} share: a drop` : `${odds} to 1 likely or more: a decline`}`;
}

/** What a drop the plan reads shows: its last sessions against the sessions before them, and how it runs. */
function dropWhy(recent: Tally, older: Tally, o: { sessions: number | null; window: number; share: number; max: number }): string {
  const n = lastAndBefore(o.sessions, o.window);
  const last = !n ? 'last sessions' : `last ${n.last} session${n.last === 1 ? '' : 's'}`;
  const earlier = !n ? 'the sessions before them' : `the ${n.before === 1 ? 'session' : `${n.before} sessions`} before them`;
  return `its ${last} passed ${recent.passes} of ${recent.attempts} attempts, below ${earlier}, ${older.passes} of ${older.attempts}, beyond chance at its ${pct(o.share)} share: a drop; it runs as its baseline asks, at its share, up to its ${o.max} attempts`;
}

/**
 * Over which pass rates a gate against history's chance is averaged, in words: whose attempts they come
 * from (the sessions before its last ones when those sit below them, else its record, else its
 * baseline) and how many of them passed.
 */
function ratesWhy(seen: Tally | null, from: { older: boolean; baselineOnly: boolean; sessions: number | null; window: number }): string {
  if (!seen) return 'averaged over the pass rates that leaves open (more for an agent that fails more often)';
  const n = lastAndBefore(from.sessions, from.window);
  const sessions = from.sessions;
  const older = n?.before ? `the ${n.before === 1 ? 'session' : `${n.before} sessions`} before its last ${n.last} leave${n.before === 1 ? 's' : ''}` : 'its sessions before its last ones leave';
  const whose = from.older ? older : from.baselineOnly ? 'its baseline leaves' : sessions ? `its last ${sessions === 1 ? 'session leaves' : `${sessions} sessions leave`}` : 'its sessions leave';
  return `averaged over the pass rates ${whose} open (${seen.passes} of ${seen.attempts} attempts passed)`;
}

/** The attempts an SPRT gate runs on average at rate p, as `gateOdds` works them out. */
function attemptsAt(gate: Gate, p: number, history: Tally | null): number {
  return gateOdds(gate, p, history).attempts;
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
  const plans = new Map<string, Plan>();
  const planOf = (x: SuiteGolden, history: Tally | null): Plan => {
    // A golden whose inconclusive does otherwise than the session's (its history short): its chance is counted as it does.
    const own = x.inconclusive ?? mode;
    const key = JSON.stringify([x.gate, x.maxGiven, own, x.gate.kind === 'baseline' ? [history, x.sessions ?? null, x.record ?? null] : null]);
    const known = plans.get(key);
    if (known) return known;
    const p = x.gate.kind === 'sprt' ? { ...planSprt(x.gate, share, { maxGiven: x.maxGiven, mode: own }), at: x.gate.good, estimate: x.gate.good, ...(own !== mode ? { inconclusive: own } : {}) } : planHistory(x.gate, share, { history, sessions: x.sessions ?? null, record: x.record ?? null }, { maxGiven: x.maxGiven, mode: own, sizing: mode });
    plans.set(key, p);
    return p;
  };
  const planned = goldens.map((x): PlannedGolden => {
    const history = x.history && x.history.attempts > 0 ? x.history : null;
    const p = planOf(x, history);
    // What a gate against history costs is forecast for the agent its last sessions show; an SPRT's, at the rate its recent results show, else its `good` rate.
    const forecastAt = p.forecast?.at ?? x.rate ?? p.estimate;
    const attempts = p.forecast?.attempts ?? attemptsAt(p.gate, forecastAt, history);
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
      ...(p.early ? { early: p.early } : {}),
      ...(p.drop ? { drop: p.drop } : {}),
      ...(p.inconclusive ? { inconclusive: p.inconclusive } : {}),
      ...(p.counts ? { counts: p.counts } : {}),
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
