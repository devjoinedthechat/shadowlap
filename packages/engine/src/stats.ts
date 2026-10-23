/**
 * Verdicts on runs that vary. A clean replay comes out the same every time; a fork does not, since
 * everything after it runs live. So a forked golden, a verify attempt or a blame probe is a sample,
 * and a fixed count of passes (4 of 5) can't tell agents apart: an agent that passes 70% of the time
 * clears 4 of 5 about half the time, and one that passes 95% of the time fails it 2.3% of the time.
 * A gate states its error rates instead, and decides as attempts come in. Pure functions:
 *
 * - `decide(passes, attempts, gate, history?)`: after each attempt, `pass`, `fail`, `continue` or
 *   `inconclusive`, under one of two gates:
 *   - `sprt`, Wald's sequential probability ratio test between a pass rate of `good` and one of
 *     `bad`: each pass adds ln(good/bad) to a score and each failure ln((1−good)/(1−bad)); the gate
 *     passes once the score reaches ln((1−risk)/risk) and fails once it falls to minus that, so an
 *     agent at `bad` or below is passed, and one at `good` or above failed, at most about `risk` of
 *     the time (Wald's bound is risk / (1 − risk)). Between the two rates nothing is promised: an
 *     agent that passes 80% of the time passes a gate between 90% and 70% about 38% of the time. So
 *     a verdict says what the gate tells apart, never that the agent passes at some rate. When `max`
 *     attempts run out between the bounds, it is inconclusive: an honest answer, not a coin toss.
 *   - `baseline`, against the golden's own history: the pass rates now and in the last `window`
 *     sessions, each a Beta posterior under a uniform prior (a beta-binomial comparison). From `min`
 *     attempts on, after each one, it fails when P(now < baseline − drop) > 1 − risk, passes once
 *     that chance is 1/2 or less (no drop shows), and otherwise runs another attempt, up to `max`.
 *     Without history the baseline is the golden's recording: the one attempt it was packed from,
 *     which passed.
 * - `gateInterval`: the pass rate's interval at 1 − risk, exact under the gate's own stopping rule
 *   (the stagewise ordering of where it can stop, Siegmund's), so that a bound shown beside a verdict
 *   covers the true rate as often as it says, every look counted. A fixed count's is Clopper–Pearson
 *   (`clopperPearson`), and attempts a gate did not stop on by its own rule (cut short, carried over
 *   from another session) get a confidence sequence (`confidenceSequence`), valid however they stopped.
 *   `wilson` stays for display elsewhere: checking it after every attempt inflates its error ("peeking").
 * - `passHatK`: the chance an agent passes all of k tries, from c passes in n, as C(c,k)/C(n,k) (the
 *   τ-bench estimator), which matters more than one success for an agent that runs unattended.
 *
 * Plus what the reports say: the verdict line (`passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells
 * 90%+ from 70%- at <= 5% risk, up to 80 attempts`: the verdict word, the tally, the bound and the
 * rule), the evidence path (the score after each attempt, against both bounds), and the exact odds of
 * each verdict for an agent with a given pass rate (`gateOdds`), which the docs' tables and Settings'
 * preview are made from.
 */

export interface SprtGate {
  kind: 'sprt';
  /** A pass rate the gate should pass: at or above it, it fails at most about `failRisk` (else `risk`) of the time. */
  good: number;
  /** A pass rate the gate should fail: at or below it, it passes at most about `risk` of the time. */
  bad: number;
  /** The most a pass may be wrong, at `bad`; and a failure, at `good`, unless `failRisk` says otherwise. */
  risk: number;
  /**
   * The most a failure may be wrong at `good`, when it is lower than `risk`: `shadowlap test` sets it
   * to a golden's share of the suite's risk (suite.ts), so a healthy suite goes red at most that
   * often. Absent: `risk`, each way.
   */
  failRisk?: number;
  /** The most attempts it runs; between the bounds then, it is inconclusive. */
  max: number;
}

export interface BaselineGate {
  kind: 'baseline';
  /** The drop in pass rate, from the golden's history, that fails it: 0.15 is 15 points. */
  drop: number;
  /** It fails when the chance its pass rate dropped by `drop` or more is above 1 − risk. */
  risk: number;
  /** How many of the golden's last sessions make the baseline, so an old one can't hide a slow decline. */
  window: number;
  /** Attempts it runs before it decides. */
  min: number;
  /** The most attempts it runs: with a drop still likelier than not but short of 1 − risk then, it is inconclusive. */
  max: number;
}

export type Gate = SprtGate | BaselineGate;

/** What a gate says after an attempt. */
export type GateDecision = 'pass' | 'fail' | 'continue' | 'inconclusive';

/** Passes out of attempts. */
export interface Tally {
  passes: number;
  attempts: number;
}

/** A golden's attempts in its past sessions, pooled: the baseline a `baseline` gate compares with. */
export interface GateHistory extends Tally {
  /** How many sessions they came from. */
  sessions: number;
}

/**
 * The figures `{}` stands for: tell a pass rate of 90% or more from one of 70% or less, at most 5%
 * risk each way, up to 80 attempts. An agent that always passes is accepted after 12 and one that passes 95% of the time
 * after 16.6 on average whatever the limit; 80 leaves almost none of the latter inconclusive, where
 * 40 left 0.75% of them so (with 100 forked goldens in CI, a red run 60% of the time) and 20 a fifth.
 */
export const SPRT_DEFAULTS: Readonly<Omit<SprtGate, 'kind'>> = Object.freeze({ good: 0.9, bad: 0.7, risk: 0.05, max: 80 });

/**
 * Blame's: a probe tells a re-asked call that passes 60% of the time or more (a rescue) from one
 * that passes 10% or less (the run is lost there). Two straight passes rescue and four straight
 * failures lose, what 2 of 5 cost; up to 20 attempts settle the calls in between, which 10 left
 * inconclusive about a quarter of the time.
 */
export const BLAME_DEFAULTS: Readonly<Omit<SprtGate, 'kind'>> = Object.freeze({ good: 0.6, bad: 0.1, risk: 0.05, max: 20 });

/**
 * The figures `{ "baseline": "history" }` stands for: fail once a 15-point drop is 95% likely,
 * deciding from 5 attempts on, up to 40. Against a history of 47 of 50, an unchanged agent that
 * passes 95% of the time passes after 5.7 attempts on average and fails 0.1% of the time; one now
 * at 60% fails 74% of the time.
 */
export const BASELINE_DEFAULTS: Readonly<Omit<BaselineGate, 'kind'>> = Object.freeze({ drop: 0.15, risk: 0.05, window: 10, min: 5, max: 40 });

/** A history gate passes once P(now < baseline − drop) is at most this: a drop is no likelier than not. */
export const BASELINE_PASS_AT = 0.5;

/**
 * A golden's baseline before it has any history: its recording, the one attempt it was packed from,
 * which passed. It says little, so the gate passes all but a golden that fails most attempts.
 */
export const RECORDING_BASELINE: Readonly<Tally> = Object.freeze({ passes: 1, attempts: 1 });

/** The most attempts a gate may run, as `repeat` allows at most 100 under `tests`, ten times over. */
export const GATE_MAX_ATTEMPTS = 1000;

/** A bound crossed by less than this still counts: the scores are sums of logarithms. */
const EPS = 1e-9;

// ---- Parsing ----------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`${where} has an unknown key "${key}" (expected ${allowed.map((k) => `"${k}"`).join(', ')})`);
  }
}

function share(v: unknown, where: string, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= 1) throw new Error(`${where} must be a number between 0 and 1, such as 0.9: ${what}`);
  return v;
}

/** A risk: above 0 and below 0.5, where a gate's two verdicts would overlap. */
function riskOf(v: unknown, where: string): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0.5) throw new Error(`${where} must be below 0.5: the most a verdict may be wrong, such as 0.05`);
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${where} must be a number between 0 and 0.5, such as 0.05: the most a verdict may be wrong`);
  return v;
}

function whole(v: unknown, where: string, what: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw new Error(`${where} must be a whole number from 1 to ${max}: ${what}`);
  return v;
}

/**
 * A gate as written under `tests` in shadowlap.config.json, or given to `--gate`: `{ good, bad,
 * risk, max }` for the SPRT, `{ baseline: "history", drop, risk, window, min, max }` against the
 * history. Every figure is optional; `defaults` are the SPRT's when none are given (blame has its
 * own). `where` names the source in error messages, as the config's other errors do. A gate that
 * could never pass is refused: an SPRT whose `max` is below the attempts an agent that always passes
 * needs, a history gate whose `max` is below its `min`.
 */
export function parseGate(json: unknown, where: string, defaults: Partial<Omit<SprtGate, 'kind'>> = {}): Gate {
  if (!isObject(json)) throw new Error(`${where} must be an object, such as { "good": 0.9, "bad": 0.7, "risk": 0.05, "max": 80 } or { "baseline": "history" }`);
  if ('baseline' in json) {
    onlyKeys(json, ['baseline', 'drop', 'risk', 'window', 'min', 'max'], where);
    if (json.baseline !== 'history') throw new Error(`${where}.baseline must be "history": the golden's own past sessions are the baseline`);
    const gate: BaselineGate = {
      kind: 'baseline',
      drop: json.drop === undefined ? BASELINE_DEFAULTS.drop : share(json.drop, `${where}.drop`, 'the drop in pass rate that fails it'),
      risk: json.risk === undefined ? BASELINE_DEFAULTS.risk : riskOf(json.risk, `${where}.risk`),
      window: json.window === undefined ? BASELINE_DEFAULTS.window : whole(json.window, `${where}.window`, 'how many past sessions make the baseline', GATE_MAX_ATTEMPTS),
      min: json.min === undefined ? BASELINE_DEFAULTS.min : whole(json.min, `${where}.min`, 'the attempts it runs before it decides', GATE_MAX_ATTEMPTS),
      max: 0,
    };
    // A max left out stays above a min given: the default's room past it, at least.
    gate.max = json.max === undefined ? Math.max(BASELINE_DEFAULTS.max, gate.min) : whole(json.max, `${where}.max`, 'the most attempts it runs', GATE_MAX_ATTEMPTS);
    if (gate.max < gate.min) throw new Error(`${where}: max (${gate.max}) is fewer than min (${gate.min}), the attempts it runs before it decides: raise max, or lower min`);
    return gate;
  }
  onlyKeys(json, ['good', 'bad', 'risk', 'max'], where);
  const d = { ...SPRT_DEFAULTS, ...defaults };
  const gate: SprtGate = {
    kind: 'sprt',
    good: json.good === undefined ? d.good : share(json.good, `${where}.good`, 'the pass rate it passes at'),
    bad: json.bad === undefined ? d.bad : share(json.bad, `${where}.bad`, 'the pass rate it fails at'),
    risk: json.risk === undefined ? d.risk : riskOf(json.risk, `${where}.risk`),
    max: json.max === undefined ? d.max : whole(json.max, `${where}.max`, 'the most attempts it runs', GATE_MAX_ATTEMPTS),
  };
  if (gate.bad >= gate.good) throw new Error(`${where}: bad (${gate.bad}) must be below good (${gate.good}): the gate tells a pass rate of good from one of bad`);
  const needed = attemptsToPass(gate);
  if (needed > gate.max) throw new Error(`${where}: max (${gate.max}) is fewer than the ${needed} attempts an agent that always passes needs at these figures, so it could never pass: raise max, move good and bad further apart, or allow more risk`);
  return gate;
}

// ---- The SPRT ---------------------------------------------------------------------------------

/** What each pass and each failure adds to the SPRT's score, and the bounds it passes and fails at. */
export interface SprtBounds {
  /** Added for each pass: ln(good/bad), above 0. */
  pass: number;
  /** Added for each failure: ln((1−good)/(1−bad)), below 0. */
  fail: number;
  /** It passes at or above this: ln((1−failRisk)/risk), ln((1−risk)/risk) with one risk each way. */
  upper: number;
  /** It fails at or below this: ln(failRisk/(1−risk)), the negative of `upper` with one risk each way. */
  lower: number;
}

/** The figures an SPRT's score and bounds are made of. */
export type SprtFigures = Pick<SprtGate, 'good' | 'bad' | 'risk'> & { failRisk?: number | undefined };

/** Wald's bounds with a pass wrong at most α = risk of the time at `bad`, and a failure β = failRisk at `good`. */
export function sprtBounds(g: SprtFigures): SprtBounds {
  const a = g.risk;
  const b = g.failRisk ?? g.risk;
  const upper = Math.log((1 - b) / a);
  return { pass: Math.log(g.good / g.bad), fail: Math.log((1 - g.good) / (1 - g.bad)), upper, lower: b === a ? -upper : Math.log(b / (1 - a)) };
}

/** The SPRT's step: the score after one more attempt. */
export function sprtStep(score: number, passed: boolean, g: SprtFigures): number {
  const b = sprtBounds(g);
  return score + (passed ? b.pass : b.fail);
}

/** The score after `passes` of `attempts`: order doesn't matter, only the counts. */
export function sprtScore(passes: number, attempts: number, g: SprtFigures): number {
  const b = sprtBounds(g);
  return passes * b.pass + (attempts - passes) * b.fail;
}

/** The fewest attempts an agent that always passes needs to pass the gate: 12 at 0.9, 0.7 and 0.05. */
export function attemptsToPass(g: SprtFigures): number {
  const b = sprtBounds(g);
  return Math.max(1, Math.ceil(b.upper / b.pass - EPS));
}

/** The fewest attempts an agent that always fails needs to fail it: 3 at 0.9, 0.7 and 0.05. */
export function attemptsToFail(g: SprtFigures): number {
  const b = sprtBounds(g);
  return Math.max(1, Math.ceil(b.lower / b.fail - EPS));
}

/** How many passes make up for one failure: about 4.4 at 0.9 and 0.7. */
export function passesPerFailure(g: Pick<SprtGate, 'good' | 'bad'>): number {
  return Math.log((1 - g.bad) / (1 - g.good)) / Math.log(g.good / g.bad);
}

function checkTally(passes: number, attempts: number): void {
  if (!Number.isInteger(passes) || !Number.isInteger(attempts) || passes < 0 || attempts < 0 || passes > attempts) throw new RangeError(`passes (${passes}) and attempts (${attempts}) must be whole numbers with 0 <= passes <= attempts`);
}

// ---- Deciding ---------------------------------------------------------------------------------

/** The baseline a history gate compares with: the history pooled, or without any, the golden's recording. */
export function baselineOf(history: Tally | null | undefined): Tally {
  return history && history.attempts > 0 ? history : RECORDING_BASELINE;
}

/**
 * What a gate says after `attempts` attempts, `passes` of which passed. An SPRT gate passes or fails
 * as soon as its score crosses a bound, so a caller that asks after every attempt and stops at the
 * first answer that isn't `continue` runs exactly the test the gate states. A baseline gate
 * continues until `min` attempts, then after each one fails when a drop from `history` (none: the
 * golden's recording) is likelier than 1 − risk, passes once it is no likelier than not, and is
 * inconclusive when `max` attempts leave it in between.
 */
export function decide(passes: number, attempts: number, gate: Gate, history?: GateHistory | Tally | null): GateDecision {
  checkTally(passes, attempts);
  if (gate.kind === 'baseline') {
    if (attempts < gate.min) return 'continue';
    const q = dropProbability({ passes, attempts }, baselineOf(history), gate.drop);
    if (q > 1 - gate.risk) return 'fail';
    if (q <= BASELINE_PASS_AT) return 'pass';
    return attempts >= gate.max ? 'inconclusive' : 'continue';
  }
  if (attempts === 0) return 'continue';
  const b = sprtBounds(gate);
  const score = sprtScore(passes, attempts, gate);
  if (score >= b.upper - EPS) return 'pass';
  if (score <= b.lower + EPS) return 'fail';
  return attempts >= gate.max ? 'inconclusive' : 'continue';
}

/**
 * The fixed count every gate replaced, as the same kind of decision: pass at `needed` passes, fail
 * once the attempts left can't reach it, else continue. Never inconclusive: it states no risk.
 */
export function decideCount(passes: number, attempts: number, of: number, needed: number): GateDecision {
  checkTally(passes, attempts);
  if (passes >= needed) return 'pass';
  if (passes + (of - attempts) < needed) return 'fail';
  return attempts >= of ? 'fail' : 'continue';
}

// ---- Distributions ----------------------------------------------------------------------------

/** ln Γ(x) for x > 0 (Lanczos, g = 7): good to about 15 digits. */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const z = x - 1;
  let a = c[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The continued fraction of the incomplete beta function (modified Lentz). */
function betaFraction(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** ln B(a, b), the Beta function's logarithm. */
const lnBeta = (a: number, b: number) => lnGamma(a) + lnGamma(b) - lnGamma(a + b);

/** I_x(a, b) with ln B(a, b) given, for a caller that evaluates one distribution at many points. */
function incompleteBeta(x: number, a: number, b: number, lnB: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnB);
  // The fraction converges fast on the side of the mean it is evaluated from.
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

/** The density with ln B(a, b) given. */
function densityBeta(x: number, a: number, b: number, lnB: number): number {
  if (x < 0 || x > 1) return 0;
  if (x === 0) return a < 1 ? Infinity : a === 1 ? Math.exp(-lnB) : 0;
  if (x === 1) return b < 1 ? Infinity : b === 1 ? Math.exp(-lnB) : 0;
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lnB);
}

/** The Beta(a, b) distribution's CDF at x: the regularized incomplete beta function I_x(a, b). */
export function betaCdf(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0)) throw new RangeError('a Beta distribution needs a > 0 and b > 0');
  return incompleteBeta(x, a, b, lnBeta(a, b));
}

/** The Beta(a, b) density at x. */
export function betaPdf(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0)) throw new RangeError('a Beta distribution needs a > 0 and b > 0');
  return densityBeta(x, a, b, lnBeta(a, b));
}

/** Simpson intervals over the pass rate now: the posterior's density is smooth, the baseline's CDF a smooth step. */
const SIMPSON_STEPS = 4000;

/**
 * What one baseline contributes at each Simpson node, P(baseline > x + drop), kept for the baselines
 * used last: a gate asks for the same baseline after every attempt, and the odds and bounds walk
 * every tally against it. The values are the ones the sum would compute, so caching changes nothing.
 */
const baselineFactors = new Map<string, Float64Array>();
const BASELINE_FACTORS_KEPT = 64;

function baselineFactor(a2: number, b2: number, drop: number, h: number): Float64Array {
  const key = `${a2}/${b2}/${drop}`;
  let f = baselineFactors.get(key);
  if (f) return f;
  const lnB2 = lnBeta(a2, b2);
  f = new Float64Array(SIMPSON_STEPS + 1);
  for (let i = 0; i <= SIMPSON_STEPS; i++) f[i] = 1 - incompleteBeta(i * h + drop, a2, b2, lnB2);
  if (baselineFactors.size >= BASELINE_FACTORS_KEPT) baselineFactors.delete(baselineFactors.keys().next().value!);
  baselineFactors.set(key, f);
  return f;
}

/**
 * P(now < baseline − drop): the chance a golden's pass rate now is below its baseline's by `drop`
 * or more. Each rate is a Beta posterior under a uniform prior (Beta(1 + passes, 1 + failures));
 * with no baseline given, the baseline is 1, a golden that always passes. Integrated exactly enough
 * (composite Simpson over the rate now) for the 1 − risk it is compared with.
 */
export function dropProbability(now: Tally, baseline: Tally | null, drop: number): number {
  checkTally(now.passes, now.attempts);
  const a1 = 1 + now.passes;
  const b1 = 1 + now.attempts - now.passes;
  const top = 1 - drop;
  if (top <= 0) return 0;
  if (!baseline) return betaCdf(top, a1, b1);
  checkTally(baseline.passes, baseline.attempts);
  const a2 = 1 + baseline.passes;
  const b2 = 1 + baseline.attempts - baseline.passes;
  // The odds and the bounds of a gate against history ask for the same few hundred tallies again and again.
  const key = `${a1}/${b1}/${a2}/${b2}/${drop}`;
  const known = drops.get(key);
  if (known !== undefined) return known;
  // ∫_0^top f_now(x) · P(baseline > x + drop) dx
  const lnB1 = lnBeta(a1, b1);
  const h = top / SIMPSON_STEPS;
  const above = baselineFactor(a2, b2, drop, h);
  let sum = 0;
  for (let i = 0; i <= SIMPSON_STEPS; i++) {
    const x = i * h;
    const w = i === 0 || i === SIMPSON_STEPS ? 1 : i % 2 ? 4 : 2;
    sum += w * densityBeta(x, a1, b1, lnB1) * above[i]!;
  }
  const q = Math.min(1, Math.max(0, (sum * h) / 3));
  if (drops.size >= DROPS_KEPT) drops.clear();
  drops.set(key, q);
  return q;
}

/** dropProbability's answers already worked out: it is pure, so they are the same every time. */
const drops = new Map<string, number>();
const DROPS_KEPT = 200_000;

/** The standard normal quantile, z with Φ(z) = p (Acklam's rational approximation: relative error below 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('a quantile needs 0 < p < 1');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const tail = (q: number) => (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  if (p < low) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - low) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/**
 * The Wilson score interval for a pass rate, two-sided at `confidence`: where the rate lies, from
 * `passes` of `n`, with the right width near 0 and 1, where the normal approximation's is wrong.
 * For display only; with no attempts it is the whole range.
 */
export function wilson(passes: number, n: number, confidence = 0.95): { lo: number; hi: number } {
  checkTally(passes, n);
  if (!(confidence > 0 && confidence < 1)) throw new RangeError('confidence must be between 0 and 1');
  if (n === 0) return { lo: 0, hi: 1 };
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: passes === 0 ? 0 : Math.max(0, center - half), hi: passes === n ? 1 : Math.min(1, center + half) };
}

/**
 * pass^k: the chance an agent passes all of k tries, from c passes in n attempts, as C(c,k)/C(n,k),
 * the unbiased estimator τ-bench uses. Null when it can't be estimated: fewer attempts than k.
 */
export function passHatK(c: number, n: number, k: number): number | null {
  checkTally(c, n);
  if (!Number.isInteger(k) || k < 0) throw new RangeError(`k (${k}) must be a whole number, 0 or more`);
  if (k > n || n === 0) return null;
  let v = 1;
  for (let i = 0; i < k; i++) v *= (c - i) / (n - i);
  return Math.max(0, v);
}

/** P(X ≥ k) for X ~ Binomial(n, p): the chance an agent that passes `p` of the time clears k of n. */
export function binomialTail(n: number, k: number, p: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0) throw new RangeError('n and k must be whole numbers');
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let sum = 0;
  for (let j = k; j <= n; j++) sum += Math.exp(lnGamma(n + 1) - lnGamma(j + 1) - lnGamma(n - j + 1) + j * Math.log(p) + (n - j) * Math.log(1 - p));
  return Math.min(1, sum);
}

// ---- The odds of each verdict -----------------------------------------------------------------

/** How a gate comes out for an agent that passes a given share of the time, exactly. */
export interface GateOdds {
  pass: number;
  fail: number;
  inconclusive: number;
  /** Attempts it runs on average, counting from the first (a start given included). */
  attempts: number;
}

/** The most attempts a gate runs. */
export const gateLimit = (gate: Gate): number => gate.max;

/** A gate's decisions, worked out once per tally: they don't depend on the agent's pass rate. */
function decider(gate: Gate, history: Tally | null): (passes: number, attempts: number) => GateDecision {
  const memo = new Map<number, GateDecision>();
  return (passes, attempts) => {
    const key = attempts * (GATE_MAX_ATTEMPTS + 1) + passes;
    let d = memo.get(key);
    if (d === undefined) {
      d = decide(passes, attempts, gate, history);
      memo.set(key, d);
    }
    return d;
  };
}

/** A walk over every count of passes a rule can see, from `from` on, stopped where it decides. */
function walk(rule: (passes: number, attempts: number) => GateDecision, limit: number, p: number, from: Tally = { passes: 0, attempts: 0 }): GateOdds {
  if (!(p >= 0 && p <= 1)) throw new RangeError('p must be between 0 and 1');
  checkTally(from.passes, from.attempts);
  let walking = new Map<number, number>([[from.passes, 1]]);
  const out: GateOdds = { pass: 0, fail: 0, inconclusive: 0, attempts: 0 };
  for (let n = from.attempts + 1; n <= limit; n++) {
    const next = new Map<number, number>();
    for (const [s, mass] of walking) {
      for (const [passes, q] of [
        [s + 1, p],
        [s, 1 - p],
      ] as const) {
        if (q === 0) continue;
        const m = mass * q;
        const d = rule(passes, n);
        if (d === 'continue') next.set(passes, (next.get(passes) ?? 0) + m);
        else {
          out[d] += m;
          out.attempts += m * n;
        }
      }
    }
    walking = next;
  }
  return out;
}

/**
 * The exact odds of each verdict, and the attempts run on average, for an agent that passes `p` of
 * the time: a walk over every count of passes the gate can see, stopped where it decides, so every
 * look the gate takes is counted. For a baseline gate, `history` is the baseline (none: the golden's
 * recording). `from`: a tally already seen, as when more attempts continue an inconclusive verdict
 * under a raised limit; `attempts` then counts those too.
 */
export function gateOdds(gate: Gate, p: number, history?: Tally | null, from?: Tally): GateOdds {
  return walk(decider(gate, history ?? null), gateLimit(gate), p, from);
}

/** `gateOdds` at several pass rates at once, each decision worked out once for them all. */
export function gateOddsAt(gate: Gate, rates: readonly number[], history?: Tally | null): Array<GateOdds & { rate: number }> {
  const rule = decider(gate, history ?? null);
  return rates.map((rate) => ({ rate, ...walk(rule, gateLimit(gate), rate) }));
}

/** The same for a fixed count, `needed` of `of`, stopped as soon as it is settled. */
export function countOdds(of: number, needed: number, p: number): GateOdds {
  return walk((passes, attempts) => decideCount(passes, attempts, of, needed), of, p);
}

/**
 * How often a CI run goes red for nothing: the chance at least one of `goldens` goldens, each
 * failing `fail` and ending inconclusive `inconclusive` of the time, fails the run. Under
 * `--inconclusive fail`, the default, an inconclusive golden fails it too; under `warn`, it doesn't.
 */
export function runsRed(odds: Pick<GateOdds, 'fail' | 'inconclusive'>, goldens: number, mode: 'fail' | 'warn' = 'fail'): number {
  const red = odds.fail + (mode === 'fail' ? odds.inconclusive : 0);
  return 1 - (1 - Math.min(1, red)) ** goldens;
}

// ---- Bounds that hold however the gate stopped ------------------------------------------------
//
// A gate stops as soon as its evidence suffices, so its tally is no fixed-count sample: 12 of 12 is
// where it stops for every agent that passes its first 12 attempts, whatever that agent's rate. An
// interval computed from the tally as if its count had been fixed (Wilson's, or Clopper–Pearson's)
// misses the true rate more often than it says. These count every way the gate could have stopped.

/**
 * How a bound was worked out: `stagewise`, exact under the gate's own stopping rule (Siegmund's
 * ordering of where it can stop); `clopper-pearson`, a fixed count's; `confidence-sequence`, valid
 * however the attempts stopped (a gate cut short, attempts carried over from another session).
 */
export type BoundMethod = 'stagewise' | 'clopper-pearson' | 'confidence-sequence';

/** A pass rate's two-sided interval at `confidence`: each end is wrong at most (1 − confidence)/2 of the time. */
export interface RateInterval {
  lo: number;
  hi: number;
  confidence: number;
  method: BoundMethod;
}

/**
 * The end, or the ends, of a rate's interval that bear on a verdict, as every report carries it: `lo`
 * for a pass, `hi` for a failure, both otherwise. Whichever is shown, it is wrong at most 1 −
 * confidence of the time, since each end alone is wrong at most half that.
 */
export interface RateBound {
  lo?: number;
  hi?: number;
  confidence: number;
  method: BoundMethod;
}

/** Where a gate stopped by its own rule: the tally, and what it decided there. */
export interface GateStop {
  passes: number;
  attempts: number;
  decision: 'pass' | 'fail' | 'inconclusive';
}

type Rule = (passes: number, attempts: number) => GateDecision;

/** Halvings of [0, 1] a bound's bisection takes: its end is within 2^-42 of the exact one, on the safe side. */
const HALVINGS = 42;

/** The lowest p in [0, 1] at which a nondecreasing `f` exceeds `level`, from below: never above the exact one. */
function firstAbove(f: (p: number) => number, level: number): number {
  if (f(0) > level) return 0;
  let a = 0;
  let b = 1;
  for (let i = 0; i < HALVINGS; i++) {
    const m = (a + b) / 2;
    if (f(m) > level) b = m;
    else a = m;
  }
  return a;
}

/** The highest p in [0, 1] at which a nonincreasing `f` exceeds `level`, from above: never below the exact one. */
function lastAbove(f: (p: number) => number, level: number): number {
  if (f(1) > level) return 1;
  let a = 0;
  let b = 1;
  for (let i = 0; i < HALVINGS; i++) {
    const m = (a + b) / 2;
    if (f(m) > level) a = m;
    else b = m;
  }
  return b;
}

/**
 * The chances, at pass rate p, that a rule stops higher than `t` and lower than `t` in the stagewise
 * order: a pass ranks higher the sooner it came, a failure lower the sooner it came, and stops after
 * the same attempt rank by their passes. Only the attempts up to t's are walked: whatever stops later
 * ranks below a pass at t, and above a failure at t.
 */
function stagewiseTails(rule: Rule, t: GateStop, p: number): { above: number; below: number } {
  let walking = new Map<number, number>([[0, 1]]);
  let above = 0;
  let below = 0;
  for (let n = 1; n <= t.attempts; n++) {
    const next = new Map<number, number>();
    for (const [s, mass] of walking) {
      for (const [passes, q] of [
        [s + 1, p],
        [s, 1 - p],
      ] as const) {
        if (q === 0) continue;
        const m = mass * q;
        const d = rule(passes, n);
        if (d === 'continue') next.set(passes, (next.get(passes) ?? 0) + m);
        else if (n < t.attempts) {
          // A gate is inconclusive only at its limit, which t's attempt doesn't come after.
          if (d === 'pass') above += m;
          else below += m;
        } else if (passes > t.passes) above += m;
        else if (passes < t.passes) below += m;
      }
    }
    walking = next;
  }
  let going = 0;
  for (const m of walking.values()) going += m;
  if (t.decision === 'pass') below += going;
  else if (t.decision === 'fail') above += going;
  return { above, below };
}

/**
 * A pass rate's two-sided interval at `confidence`, exact under a rule that stopped at `t`: the low
 * end is the lowest rate at which stopping as high as t or higher has more than (1 − confidence)/2
 * chance, the high end the highest at which stopping as low or lower has. Both chances move one way
 * with the rate (an agent that passes more often stops no lower, attempt by attempt), so each end is
 * a bisection, and each is wrong at most (1 − confidence)/2 of the time, over every way the rule can stop.
 */
export function stagewiseInterval(rule: Rule, t: GateStop, confidence: number): { lo: number; hi: number } {
  const tail = (1 - confidence) / 2;
  const memo = new Map<number, { above: number; below: number }>();
  const tails = (p: number) => {
    let x = memo.get(p);
    if (!x) {
      x = stagewiseTails(rule, t, p);
      memo.set(p, x);
    }
    return x;
  };
  return { lo: firstAbove((p) => 1 - tails(p).below, tail), hi: lastAbove((p) => 1 - tails(p).above, tail) };
}

/** P(X ≤ k) for X ~ Binomial(n, p), summed from the nearer end. */
function binomialAtMost(n: number, k: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  return Math.max(0, Math.min(1, 1 - binomialTail(n, k + 1, p)));
}

/**
 * The Clopper–Pearson interval for `passes` of a fixed `n`, two-sided at `confidence`: each end is
 * wrong at most (1 − confidence)/2 of the time, at every rate. It holds for a fixed count stopped as
 * soon as it is settled too (decideCount): the end that bears on the verdict is then exactly the
 * stagewise one, and the other end is wider than it.
 */
export function clopperPearson(passes: number, n: number, confidence = 0.95): { lo: number; hi: number } {
  checkTally(passes, n);
  if (!(confidence > 0 && confidence < 1)) throw new RangeError('confidence must be between 0 and 1');
  if (n === 0) return { lo: 0, hi: 1 };
  const tail = (1 - confidence) / 2;
  const lo = passes === 0 ? 0 : firstAbove((p) => binomialTail(n, passes, p), tail);
  const hi = passes === n ? 1 : lastAbove((p) => binomialAtMost(n, passes, p), tail);
  return { lo, hi };
}

/**
 * A confidence sequence for the pass rate: the rates p at which (n + 1)·C(n, k)·p^k·(1 − p)^(n−k)
 * is above 1 − confidence, the uniform mixture of likelihood ratios that Ville's inequality bounds.
 * It covers the true rate at every attempt at once, at least `confidence` of the time, so it holds
 * however the attempts stopped: cut short by a signal or a budget, or carried over from another
 * session. Wider than the stagewise interval, which needs the gate to have stopped by its own rule.
 */
export function confidenceSequence(passes: number, n: number, confidence = 0.95): { lo: number; hi: number } {
  checkTally(passes, n);
  if (!(confidence > 0 && confidence < 1)) throw new RangeError('confidence must be between 0 and 1');
  if (n === 0) return { lo: 0, hi: 1 };
  const k = passes;
  const base = Math.log(n + 1) + lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) - Math.log(1 - confidence);
  const inside = (p: number) => (p <= 0 ? (k === 0 ? Infinity : -Infinity) : p >= 1 ? (k === n ? Infinity : -Infinity) : base + k * Math.log(p) + (n - k) * Math.log(1 - p));
  const mode = k / n;
  // Inside rises up to the mode and falls after it: one bisection on each side.
  let lo = 0;
  if (k > 0) {
    let a = 0;
    let b = mode;
    for (let i = 0; i < HALVINGS; i++) {
      const m = (a + b) / 2;
      if (inside(m) > 0) b = m;
      else a = m;
    }
    lo = a;
  }
  let hi = 1;
  if (k < n) {
    let a = mode;
    let b = 1;
    for (let i = 0; i < HALVINGS; i++) {
      const m = (a + b) / 2;
      if (inside(m) > 0) a = m;
      else b = m;
    }
    hi = b;
  }
  return { lo, hi };
}

/** Where a rule first decides over attempts that came out as `outcomes`, or null when it never did. */
function firstStop(rule: Rule, outcomes: readonly boolean[]): GateStop | null {
  let passes = 0;
  for (let i = 0; i < outcomes.length; i++) {
    if (outcomes[i]) passes++;
    const d = rule(passes, i + 1);
    if (d !== 'continue') return { passes, attempts: i + 1, decision: d };
  }
  return null;
}

/** Whether a rule can stop at `t` at all: some path of attempts reaches it without stopping before. */
function reachable(rule: Rule, t: GateStop): boolean {
  if (rule(t.passes, t.attempts) !== t.decision) return false;
  let walking = new Set<number>([0]);
  for (let n = 1; n < t.attempts; n++) {
    const next = new Set<number>();
    for (const s of walking) for (const passes of [s, s + 1]) if (rule(passes, n) === 'continue') next.add(passes);
    walking = next;
  }
  return walking.has(t.passes) || walking.has(t.passes - 1);
}

/**
 * A gate's interval for the pass rate, at 1 − risk, on attempts that came out as `outcomes`: exact
 * under the gate's own stopping rule when the gate stopped on them by that rule, with `decision`
 * there (stagewise); otherwise a confidence sequence, valid wherever they stopped: a gate cut short
 * (`continue`), attempts `carried` over from another session, a verdict frozen before every attempt
 * had ended, a `clean` replay that settled it alone. For a gate against history, `history` is its
 * baseline (none: the golden's recording), which its rule depends on.
 */
export function gateInterval(gate: Gate, outcomes: readonly boolean[], o: { decision?: GateDecision | undefined; history?: Tally | null | undefined; carried?: number | undefined; clean?: boolean | undefined } = {}): RateInterval {
  const confidence = 1 - gate.risk;
  const passes = outcomes.filter(Boolean).length;
  if (!o.carried && !o.clean && outcomes.length > 0) {
    const rule = decider(gate, o.history ?? null);
    const stop = firstStop(rule, outcomes);
    if (stop && stop.attempts === outcomes.length && (o.decision === undefined || o.decision === stop.decision)) {
      return { ...stagewiseInterval(rule, stop, confidence), confidence, method: 'stagewise' };
    }
  }
  return { ...confidenceSequence(passes, outcomes.length, confidence), confidence, method: 'confidence-sequence' };
}

/**
 * The same from a tally alone, for a report that kept only the counts: stagewise when the gate's rule
 * can stop at `passes` of `attempts` with `decision` (an SPRT's stop depends on the counts alone),
 * otherwise a confidence sequence.
 */
export function tallyInterval(gate: Gate, tally: Tally, decision: GateDecision, history?: Tally | null): RateInterval {
  checkTally(tally.passes, tally.attempts);
  const confidence = 1 - gate.risk;
  const rule = decider(gate, history ?? null);
  const stop: GateStop | null = decision === 'continue' ? null : { passes: tally.passes, attempts: tally.attempts, decision };
  if (stop && tally.attempts > 0 && reachable(rule, stop)) return { ...stagewiseInterval(rule, stop, confidence), confidence, method: 'stagewise' };
  return { ...confidenceSequence(tally.passes, tally.attempts, confidence), confidence, method: 'confidence-sequence' };
}

/** A fixed count's interval, `passes` of `attempts` at `confidence`: Clopper–Pearson. */
export function countInterval(tally: Tally, confidence: number): RateInterval {
  return { ...clopperPearson(tally.passes, tally.attempts, confidence), confidence, method: 'clopper-pearson' };
}

/** The ends of an interval that bear on a decision: the low end for a pass, the high end for a failure, both otherwise. */
export function boundOf(i: RateInterval, decision: GateDecision | undefined): RateBound {
  const at = { confidence: i.confidence, method: i.method };
  if (decision === undefined || decision === 'pass') return { lo: i.lo, ...at };
  if (decision === 'fail') return { hi: i.hi, ...at };
  return { lo: i.lo, hi: i.hi, ...at };
}

// ---- What the reports say ---------------------------------------------------------------------
//
// A gate's verdict states the test and shows the tally, never a claimed rate. An SPRT gate bounds its
// error only at its two rates: an agent between them gets either verdict, so "passed" can't mean
// "passes at least 90% of the time". Every report says the verdict word, the tally, the bound and
// the rule, the rule stated once: `passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from
// 70%- at <= 5% risk, up to 80 attempts`. The bound is the end of the gate's interval that bears on
// the verdict, rounded away from the rate it bounds, so it never says more than was worked out.

/** A share as a percentage, as few digits as it needs: 0.9 is 90%, 0.875 is 87.5%. */
export function percent(x: number): string {
  return `${+(x * 100).toFixed(1)}%`;
}

/**
 * A risk as a percentage: as `percent` from 1% up, and to two significant digits below it, rounded
 * up so it never reads as less than it is: 0.0005 is 0.05%, 0.000437 is 0.044%.
 */
export function riskPercent(x: number): string {
  const v = x * 100;
  if (!(v > 0) || v >= 1) return percent(x);
  const places = 1 - Math.floor(Math.log10(v));
  const scale = 10 ** places;
  return `${+(Math.ceil(+(v * scale).toPrecision(12)) / scale).toFixed(places)}%`;
}

/** A rate to two places: 0.7 is 0.70. */
const rate = (x: number) => x.toFixed(2);
/** A bound's end to two places, rounded away from the rate it bounds: a low end down, a high end up. */
const lowEnd = (x: number) => (Math.floor(x * 100) / 100).toFixed(2);
const highEnd = (x: number) => (Math.ceil(x * 100) / 100).toFixed(2);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A gate's rate as its rule names it: 0.9 is `90%+`, 90% or more; 0.7, below, is `70%-`, 70% or less. */
export const atLeast = (x: number): string => `${percent(x)}+`;
export const atMost = (x: number): string => `${percent(x)}-`;

/** Points of a drop: 0.15 is `15`. */
const points = (drop: number) => `${+(drop * 100).toFixed(1)}`;

/** An SPRT gate's risks in words: `5% risk`, or with a lower risk for a failure, `5% risk to pass and <= 0.05% to fail`. */
function risks(g: SprtFigures): string {
  const fail = g.failRisk ?? g.risk;
  return fail === g.risk ? `${percent(g.risk)} risk` : `${percent(g.risk)} risk to pass and <= ${riskPercent(fail)} to fail`;
}

/**
 * A gate's rule in one line, what its verdicts are decided by: `tells 90%+ from 70%- at <= 5% risk,
 * up to 80 attempts` (an agent at 90% or more passes, and one at 70% or less fails, each verdict
 * wrong at most 5% of the time; between the two nothing is promised); with its suite's share of the
 * risk for a failure, `tells 90%+ from 70%- at <= 5% risk to pass and <= 0.05% to fail, up to 190
 * attempts`; for history `fails a drop of 15+ points from its last 10 sessions once 95% likely, from
 * 5 attempts up to 40`.
 */
export function describeGate(gate: Gate): string {
  if (gate.kind === 'sprt') return `tells ${atLeast(gate.good)} from ${atMost(gate.bad)} at <= ${risks(gate)}, up to ${plural(gate.max, 'attempt')}`;
  const sure = 1 - gate.risk;
  // A share of a suite's risk can be finer than a tenth of a point: 99.95% likely.
  const likely = gate.risk >= 0.01 ? percent(sure) : `${+(sure * 100).toFixed(Math.min(6, 2 - Math.floor(Math.log10(gate.risk * 100))))}%`;
  return `fails a drop of ${points(gate.drop)}+ points from its last ${plural(gate.window, 'session')} once ${likely} likely, from ${plural(gate.min, 'attempt')} up to ${gate.max}`;
}

/**
 * The bound that bears on a verdict, at its confidence: `rate >= 0.73 (95%)` for a pass, `rate <=
 * 0.53 (95%)` for a failure, both ends otherwise (`rate 0.21 to 0.94 (95%)`): the end, or ends, of
 * the gate's interval (`gateInterval`), each rounded away from the rate it bounds. Whichever is shown
 * is wrong at most 1 − confidence of the time, over every way the gate can end. Null with no attempts.
 */
export function rateBound(r: Pick<GateResult, 'attempts' | 'interval'> & { decision?: GateDecision | undefined }): string | null {
  if (r.attempts === 0) return null;
  const at = `(${percent(r.interval.confidence)})`;
  if (r.decision === undefined || r.decision === 'pass') return `rate >= ${lowEnd(r.interval.lo)} ${at}`;
  if (r.decision === 'fail') return `rate <= ${highEnd(r.interval.hi)} ${at}`;
  return `rate ${lowEnd(r.interval.lo)} to ${highEnd(r.interval.hi)} ${at}`;
}

/**
 * The name the bound had when it was Wilson's: it prints `rateBound`, from whatever interval it is
 * given. A gate result's interval is exact under its gate's stopping (`gateInterval`).
 * @deprecated use `rateBound`.
 */
export const wilsonBound = rateBound;

/** The running score after each attempt, against both bounds: why the gate stopped where it did. */
export interface SprtEvidence extends SprtBounds {
  kind: 'sprt';
  /** The score after attempt 1, 2, …: each pass adds `pass`, each failure `fail`. */
  scores: number[];
}

/** What a baseline gate compared: the baseline, and the chance of a drop after each attempt. */
export interface BaselineEvidence {
  kind: 'baseline';
  /** The history pooled, or null when there is none and the baseline is the golden's recording (one attempt, which passed). */
  history: GateHistory | null;
  /** The baseline's pass rate as pooled (passes over attempts); without history, the recording's, 1. The decision weighs its whole posterior. */
  baseline: number;
  /** P(now < baseline − drop) after the last attempt, or null before `min` attempts. */
  probability: number | null;
  /** The same after each attempt, null before `min`: the evidence line, between `passAt` and `threshold`. */
  probabilities: Array<number | null>;
  /** It fails above this: 1 − risk. */
  threshold: number;
  /** It passes at or below this: 1/2, a drop no likelier than not. */
  passAt: number;
}

/** What a gate made of its attempts. */
export interface GateOutcome {
  decision: GateDecision;
  passes: number;
  attempts: number;
  /** Each attempt in order: true for one that passed. */
  outcomes: boolean[];
  /**
   * The pass rate's two-sided interval at 1 − risk (`gateInterval`): exact under the gate's own
   * stopping rule, or for attempts it didn't stop on by that rule, a confidence sequence. A result
   * kept before had the Wilson interval here, for display only.
   */
  interval: { lo: number; hi: number; confidence: number };
  /** The end, or ends, of `interval` that bear on the verdict, and how it was worked out: what the verdict line shows. Absent for a clean replay, and on results kept before. */
  bound?: RateBound;
  /** Attempts the provider was unavailable for (`unavailable.ts`): retried, never counted in `outcomes`. Absent when there were none. */
  unavailable?: number;
  /** pass^k for k = 1, 2, … up to the attempts run (at most 8). */
  passK: Array<{ k: number; value: number }>;
  evidence: SprtEvidence | BaselineEvidence;
  /** The first attempt replayed clean, so every attempt would come out the same: it settled the verdict alone. */
  clean: boolean;
  /** Attempts carried over from an earlier session this one continued: the first `carried` of `outcomes`. Absent when none were. */
  carried?: number;
  /** The verdict line, rule included: `passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. */
  sentence: string;
}

/**
 * A gate's verdict as every report keeps it (the CLI's, the JSON's, the store's and the
 * dashboard's): the gate's own figures, then what it made of its attempts.
 */
export type GateResult = Gate & GateOutcome;

/** The gate a result was decided by, without what it made of the attempts. */
export function gateOf(r: Gate): Gate {
  if (r.kind === 'sprt') return { kind: 'sprt', good: r.good, bad: r.bad, risk: r.risk, ...(r.failRisk !== undefined && r.failRisk !== r.risk ? { failRisk: r.failRisk } : {}), max: r.max };
  return { kind: 'baseline', drop: r.drop, risk: r.risk, window: r.window, min: r.min, max: r.max };
}

/** The largest k a report lists pass^k for. */
const PASS_K_MAX = 8;
/** The k the one-line tally shows. */
export const PASS_K_SHOWN = 5;

/**
 * A gate's verdict on attempts that came out as `outcomes` (true for a pass), in order. `clean`: the
 * first attempt replayed clean, so it settled the verdict by itself. `decision` defaults to what the
 * gate says after the last attempt; a caller stopped early (a signal, a budget) passes `continue`,
 * and one whose decision came before attempts still running had ended passes the decision it froze.
 * `carried`: how many of the outcomes came from an earlier session this one continued.
 * `unavailable`: attempts the provider was unavailable for, which `outcomes` leaves out.
 *
 * Its interval is exact under the gate's own stopping rule when the gate stopped on these outcomes by
 * that rule (`gateInterval`); a clean replay's, a cut-short gate's and a continued one's is a
 * confidence sequence, which holds however the attempts stopped.
 */
export function gateResult(gate: Gate, outcomes: readonly boolean[], o: { history?: GateHistory | null; clean?: boolean; decision?: GateDecision; carried?: number; unavailable?: number } = {}): GateResult {
  const attempts = outcomes.length;
  const passes = outcomes.filter(Boolean).length;
  const history = o.history && o.history.attempts > 0 ? o.history : null;
  const clean = !!o.clean && attempts > 0;
  const decision = o.decision ?? (clean ? (outcomes[0] ? 'pass' : 'fail') : decide(passes, attempts, gate, history));
  const carried = o.carried && o.carried > 0 ? Math.min(o.carried, attempts) : 0;
  const exact = gateInterval(gate, outcomes, { decision, history, carried, clean });
  const interval = { lo: exact.lo, hi: exact.hi, confidence: exact.confidence };
  const passK: GateResult['passK'] = [];
  for (let k = 1; k <= Math.min(attempts, PASS_K_MAX); k++) passK.push({ k, value: passHatK(passes, attempts, k)! });
  let evidence: GateResult['evidence'];
  if (gate.kind === 'sprt') {
    const b = sprtBounds(gate);
    let score = 0;
    evidence = { kind: 'sprt', ...b, scores: outcomes.map((x) => (score += x ? b.pass : b.fail)) };
  } else {
    const base = baselineOf(history);
    let seen = 0;
    const probabilities = outcomes.map((x, i) => {
      if (x) seen++;
      return i + 1 >= gate.min || (clean && i === 0) ? dropProbability({ passes: seen, attempts: i + 1 }, base, gate.drop) : null;
    });
    evidence = {
      kind: 'baseline',
      history: history ? { passes: history.passes, attempts: history.attempts, sessions: 'sessions' in history ? history.sessions : 0 } : null,
      baseline: base.passes / base.attempts,
      probability: probabilities.at(-1) ?? null,
      probabilities,
      threshold: 1 - gate.risk,
      passAt: BASELINE_PASS_AT,
    };
  }
  const unavailable = o.unavailable && o.unavailable > 0 ? o.unavailable : 0;
  return {
    ...gateOf(gate),
    decision,
    passes,
    attempts,
    outcomes: [...outcomes],
    interval,
    ...(clean || !attempts ? {} : { bound: boundOf(exact, decision) }),
    ...(unavailable ? { unavailable } : {}),
    passK,
    evidence,
    clean,
    ...(carried ? { carried } : {}),
    sentence: gateSentence(gate, { decision, passes, attempts, interval, clean, evidence, ...(carried ? { carried } : {}) }),
  };
}

/** The verdict word a decision reads as: passed, failed, inconclusive; one still going reads as undecided. */
export function decisionWord(d: GateDecision): 'passed' | 'failed' | 'inconclusive' | 'undecided' {
  return d === 'pass' ? 'passed' : d === 'fail' ? 'failed' : d === 'inconclusive' ? 'inconclusive' : 'undecided';
}

/** The baseline in words: `against 0.94 over the last 10 sessions (47 of 50)`, or the recording when there is no history yet. */
function baselineWords(e: BaselineEvidence): string {
  if (!e.history) return 'against its recording (no history yet)';
  const over = e.history.sessions > 1 ? `the last ${e.history.sessions} sessions` : 'its last session';
  return `against ${rate(e.baseline)} over ${over} (${e.history.passes} of ${e.history.attempts})`;
}

/**
 * A gate's verdict without its rule, for a report that states the rule once above its lines: the
 * verdict word, the tally and the bound, `passed · 12 of 12 · rate >= 0.73 (95%)`; against history,
 * the baseline after them. A clean replay's one attempt has no rate to show: it is the same every time.
 */
export function verdictLine(r: Pick<GateOutcome, 'decision' | 'passes' | 'attempts' | 'interval' | 'clean' | 'evidence'> & { carried?: number | undefined }): string {
  const tally = `${r.passes} of ${r.attempts}${r.carried ? ` (${r.carried} carried over)` : ''}`;
  if (r.clean) return `${decisionWord(r.decision)} · ${tally} · a clean replay, the same every time`;
  const parts = [decisionWord(r.decision), tally, rateBound(r)];
  if (r.evidence.kind === 'baseline') parts.push(baselineWords(r.evidence));
  return parts.filter(Boolean).join(' · ');
}

/**
 * The verdict line every report says, the rule stated once after the evidence: `passed · 12 of 12 ·
 * rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`, `failed · 0 of
 * 3 · rate <= 0.53 (95%) · gate: …`, `inconclusive · 14 of 20 · rate 0.48 to 0.86 (95%) · gate: …`;
 * against history, `passed · 5 of 5 · rate >= 0.47 (95%) · against 0.94 over the last 10 sessions
 * (47 of 50) · gate: fails a drop of 15+ points …`. A clean replay is settled by its one attempt.
 */
export function gateSentence(g: Gate, r: Pick<GateOutcome, 'decision' | 'passes' | 'attempts' | 'interval' | 'clean' | 'evidence'> & { carried?: number | undefined }): string {
  if (r.clean) return `${verdictLine(r)}, so its one attempt settles it`;
  return `${verdictLine(r)} · gate: ${describeGate(g)}`;
}

/** pass^k as the tally shows it, `pass^5 0.55`: null for a clean replay, and before k attempts. */
export function formatPassK(r: Pick<GateResult, 'passK'> & { clean?: boolean }): string | null {
  const k = r.clean ? undefined : r.passK.find((x) => x.k === PASS_K_SHOWN);
  return k ? `pass^${k.k} ${rate(k.value)}` : null;
}

/**
 * The evidence in one line: `18 of 20 passed · rate >= 0.68 (95%) · pass^5 0.55`. The interval's end
 * that bears on the verdict: the low end for a pass, the high end for a failure, both otherwise. A
 * clean replay's one attempt has no rate to estimate: it is the same every time.
 */
export function formatTally(r: Pick<GateResult, 'passes' | 'attempts' | 'interval' | 'passK'> & { decision?: GateDecision; clean?: boolean }): string {
  const parts = [`${r.passes} of ${r.attempts} passed`];
  if (r.clean) parts.push('a clean replay, the same every time');
  else {
    const bound = rateBound(r);
    if (bound) parts.push(bound);
  }
  const k = formatPassK(r);
  if (k) parts.push(k);
  return parts.join(' · ');
}
