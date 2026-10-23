import { BASELINE_DEFAULTS, GATE_MAX_ATTEMPTS, SPRT_DEFAULTS, decide, gateOdds, type BaselineGate, type Gate, type GateDecision, type SprtGate, type Tally } from './stats.js';

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
 * as its `risk`, and its red rate is worked out at the pass rate its baseline shows.
 */

/** The most a healthy suite goes red for nothing, by default: `--suite-risk`, `tests.suiteRisk`. */
export const SUITE_RISK = 0.05;

/** A gate's inconclusive share at its `good` rate, when the session sizes its `max`: at most this, or half the golden's share when that is less. */
export const INCONCLUSIVE_AT_GOOD = 0.01;

/** The most attempts a sized gate against history runs: its odds are worked out attempt by attempt, and past this a history gate is the wrong tool. */
const HISTORY_SIZE_LIMIT = 400;

/** A gated golden as the session finds it, before its gate takes its share. */
export interface SuiteGolden {
  golden: string;
  gate: Gate;
  /** The config or `--max-attempts` set the gate's `max`: the session never changes it. */
  maxGiven: boolean;
  /** A gate against history: its baseline (null or none: its recording). */
  history?: Tally | null;
  /** Its pass rate as its recent results show it, for the forecast; null for one with none. */
  rate?: number | null;
  /** USD an attempt costs, from its recent results or its recording; null when no price is known. */
  costPerAttempt?: number | null;
}

/** A gated golden's gate as it runs this session, with what it costs and risks. */
export interface PlannedGolden {
  golden: string;
  gate: Gate;
  /** The chance it goes red for nothing, exactly: at its gate's `good` rate (an SPRT), at its baseline's rate (history). */
  red: number;
  /** The pass rate `red` is worked out at. */
  at: number;
  /** The pass rate the forecast is worked out at: its recent results', else `at`. */
  forecastAt: number;
  /** Attempts it runs on average at `forecastAt`, and the most it can. */
  attempts: number;
  most: number;
  /** USD those attempts cost on average, or null with no price. */
  cost: number | null;
  /** Why its share could not be met, when it could not: a `max` the config set that leaves too many inconclusive. */
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

/** After each attempt n (index n), the chance a rule has passed, failed, and is still going: one walk to `limit`. */
function curves(rule: (passes: number, attempts: number) => GateDecision, p: number, limit: number): { pass: number[]; fail: number[]; going: number[] } {
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
    if (left < 1e-15) {
      for (let k = n + 1; k <= limit; k++) {
        pass.push(pass[n]!);
        fail.push(fail[n]!);
        going.push(0);
      }
      break;
    }
  }
  return { pass, fail, going };
}

/** How a gate with these figures does at rate p: its `max` (given, or the fewest from `floor` up that leave at most `inconclusive` going), and the chance it goes red there. */
function sized(gate: Gate, p: number, o: { maxGiven: boolean; floor: number; inconclusive: number; mode: 'fail' | 'warn'; history: Tally | null; limit: number }): { max: number; red: number; going: number } {
  const unbounded: Gate = { ...gate, max: o.limit };
  const c = curves((s, n) => decide(s, n, unbounded, o.history), p, o.limit);
  let max = o.maxGiven ? Math.min(gate.max, o.limit) : o.floor;
  if (!o.maxGiven) while (max < o.limit && c.going[max]! > o.inconclusive) max++;
  const red = o.mode === 'fail' ? 1 - c.pass[max]! : c.fail[max]!;
  return { max: o.maxGiven ? gate.max : max, red: Math.max(0, red), going: c.going[max]! };
}

/** An SPRT gate's figures for its share `r`: the largest failRisk (two digits, rounded down) whose red rate at `good` is within it. */
function planSprt(g: SprtGate, r: number, o: { maxGiven: boolean; mode: 'fail' | 'warn' }): { gate: SprtGate; red: number; over?: string } {
  const inconclusive = o.mode === 'fail' ? Math.min(INCONCLUSIVE_AT_GOOD, r / 2) : INCONCLUSIVE_AT_GOOD;
  const floor = o.maxGiven ? g.max : Math.max(g.max, SPRT_DEFAULTS.max);
  const { failRisk: _own, ...figures } = g;
  const at = (failRisk: number) => {
    const gate: SprtGate = { ...figures, ...(failRisk < g.risk ? { failRisk } : {}) };
    const s = sized(gate, g.good, { maxGiven: o.maxGiven, floor, inconclusive, mode: o.mode, history: null, limit: GATE_MAX_ATTEMPTS });
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

/** A gate against history for its share `r`: `risk` at most the share, halved until its red rate at its baseline's rate is within it. */
function planHistory(g: BaselineGate, r: number, history: Tally | null, o: { maxGiven: boolean; mode: 'fail' | 'warn' }): { gate: BaselineGate; red: number; at: number; over?: string } {
  const at = history && history.attempts > 0 ? history.passes / history.attempts : 1;
  const inconclusive = o.mode === 'fail' ? Math.min(INCONCLUSIVE_AT_GOOD, r / 2) : INCONCLUSIVE_AT_GOOD;
  const floor = o.maxGiven ? g.max : Math.max(g.max, BASELINE_DEFAULTS.max, g.min);
  let risk = Math.min(g.risk, roundDown(r));
  let last: { gate: BaselineGate; red: number } | null = null;
  for (let i = 0; i < 12; i++) {
    const gate: BaselineGate = { ...g, risk };
    const s = sized(gate, at, { maxGiven: o.maxGiven, floor, inconclusive, mode: o.mode, history, limit: Math.max(floor, HISTORY_SIZE_LIMIT) });
    last = { gate: { ...gate, max: s.max }, red: s.red };
    if (s.red <= r) return { ...last, at };
    risk = roundDown(risk / 2);
  }
  return { ...last!, at, over: `it goes red ${pct(last!.red)} of the time at the pass rate its baseline shows (${pct(at)}), more than its ${pct(r)} share of the suite's risk` };
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
  const plans = new Map<string, { gate: Gate; red: number; at: number; over?: string }>();
  const planOf = (x: SuiteGolden, history: Tally | null): { gate: Gate; red: number; at: number; over?: string } => {
    const key = JSON.stringify([x.gate, x.maxGiven, x.gate.kind === 'baseline' ? history : null]);
    const known = plans.get(key);
    if (known) return known;
    const p = x.gate.kind === 'sprt' ? { ...planSprt(x.gate, share, { maxGiven: x.maxGiven, mode }), at: x.gate.good } : planHistory(x.gate, share, history, { maxGiven: x.maxGiven, mode });
    plans.set(key, p);
    return p;
  };
  const planned = goldens.map((x): PlannedGolden => {
    const history = x.history && x.history.attempts > 0 ? x.history : null;
    const p = planOf(x, history);
    const forecastAt = x.rate ?? p.at;
    const odds = gateOdds(p.gate, forecastAt, history);
    return {
      golden: x.golden,
      gate: p.gate,
      red: p.red,
      at: p.at,
      forecastAt,
      attempts: odds.attempts,
      most: p.gate.max,
      cost: x.costPerAttempt === null || x.costPerAttempt === undefined ? null : odds.attempts * x.costPerAttempt,
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
