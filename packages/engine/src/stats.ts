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
 *     agent at `bad` or below is passed at most `risk` of the time, and one at `good` or above
 *     failed at most `risk` of the time. When `max` attempts run out between the bounds, it is
 *     inconclusive: an honest answer, not a coin toss.
 *   - `baseline`, against the golden's own history: the pass rates now and in the last `window`
 *     sessions, each a Beta posterior under a uniform prior (a beta-binomial comparison), fail when
 *     P(now < baseline − drop) > 1 − risk. It decides once, after `min` attempts. Without history
 *     the baseline is a golden that always passes.
 * - `wilson`: the Wilson score interval, for display only. Checking an interval after every attempt
 *   and stopping when it clears a bar inflates the error rate ("peeking"); the per-attempt decision
 *   is the SPRT's, which is built for it.
 * - `passHatK`: the chance an agent passes all of k tries, from c passes in n, as C(c,k)/C(n,k) (the
 *   τ-bench estimator), which matters more than one success for an agent that runs unattended.
 *
 * Plus what the reports say: the one sentence (`passed: at least 90% with 95% confidence after 12
 * attempts`), the evidence path (the score after each attempt, against both bounds), and the exact
 * odds of each verdict for an agent with a given pass rate (`gateOdds`), which the docs' tables and
 * Settings' preview are made from.
 */

export interface SprtGate {
  kind: 'sprt';
  /** A pass rate the gate should pass: at or above it, it fails at most `risk` of the time. */
  good: number;
  /** A pass rate the gate should fail: at or below it, it passes at most `risk` of the time. */
  bad: number;
  /** The most a verdict may be wrong at `good` or `bad`, each way. */
  risk: number;
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

/** The figures `{}` stands for: pass at 90% or more, fail at 70% or less, at most 5% risk each, up to 40 attempts. */
export const SPRT_DEFAULTS: Readonly<Omit<SprtGate, 'kind'>> = Object.freeze({ good: 0.9, bad: 0.7, risk: 0.05, max: 40 });

/**
 * Blame's: a probe rescues the run when the re-asked call passes at least 60% of the time, and the
 * run is lost there when it passes at most 10%. That costs what 2 of 5 cost: two straight passes
 * rescue, four straight failures lose.
 */
export const BLAME_DEFAULTS: Readonly<Omit<SprtGate, 'kind'>> = Object.freeze({ good: 0.6, bad: 0.1, risk: 0.05, max: 10 });

/**
 * The figures `{ "baseline": "history" }` stands for. Five attempts fail an unchanged agent that
 * passes 95% of the time about 0.1% of the time against a history of its own; without history, they
 * make the gate the 4 of 5 it replaces (a 15-point drop from always passing fails at 3 of 5).
 */
export const BASELINE_DEFAULTS: Readonly<Omit<BaselineGate, 'kind'>> = Object.freeze({ drop: 0.15, risk: 0.05, window: 10, min: 5 });

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

function share(v: unknown, where: string, what: string, o: { below?: number } = {}): number {
  const below = o.below ?? 1;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= below) throw new Error(`${where} must be ${what}: a number between 0 and ${below}, such as ${below === 1 ? '0.9' : '0.05'}`);
  return v;
}

function whole(v: unknown, where: string, what: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw new Error(`${where} must be ${what}: a whole number from 1 to ${max}`);
  return v;
}

/**
 * A gate as written under `tests` in shadowlap.config.json, or given to `--gate`: `{ good, bad,
 * risk, max }` for the SPRT, `{ baseline: "history", drop, risk, window, min }` against the history.
 * Every figure is optional; `defaults` are the SPRT's when none are given (blame has its own).
 * `where` names the source in error messages, as the config's other errors do.
 */
export function parseGate(json: unknown, where: string, defaults: Partial<Omit<SprtGate, 'kind'>> = {}): Gate {
  if (!isObject(json)) throw new Error(`${where} must be an object, such as { "good": 0.9, "bad": 0.7, "risk": 0.05, "max": 40 } or { "baseline": "history" }`);
  if ('baseline' in json) {
    onlyKeys(json, ['baseline', 'drop', 'risk', 'window', 'min'], where);
    if (json.baseline !== 'history') throw new Error(`${where}.baseline must be "history": the golden's own past sessions are the baseline`);
    return {
      kind: 'baseline',
      drop: json.drop === undefined ? BASELINE_DEFAULTS.drop : share(json.drop, `${where}.drop`, 'the drop in pass rate that fails it'),
      risk: json.risk === undefined ? BASELINE_DEFAULTS.risk : share(json.risk, `${where}.risk`, 'the most a verdict may be wrong', { below: 0.5 }),
      window: json.window === undefined ? BASELINE_DEFAULTS.window : whole(json.window, `${where}.window`, 'how many past sessions make the baseline', GATE_MAX_ATTEMPTS),
      min: json.min === undefined ? BASELINE_DEFAULTS.min : whole(json.min, `${where}.min`, 'the attempts it runs before it decides', GATE_MAX_ATTEMPTS),
    };
  }
  onlyKeys(json, ['good', 'bad', 'risk', 'max'], where);
  const d = { ...SPRT_DEFAULTS, ...defaults };
  const gate: SprtGate = {
    kind: 'sprt',
    good: json.good === undefined ? d.good : share(json.good, `${where}.good`, 'the pass rate it passes'),
    bad: json.bad === undefined ? d.bad : share(json.bad, `${where}.bad`, 'the pass rate it fails'),
    risk: json.risk === undefined ? d.risk : share(json.risk, `${where}.risk`, 'the most a verdict may be wrong', { below: 0.5 }),
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
  /** It passes at or above this: ln((1−risk)/risk). */
  upper: number;
  /** It fails at or below this: the negative of `upper`. */
  lower: number;
}

export function sprtBounds(g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): SprtBounds {
  const upper = Math.log((1 - g.risk) / g.risk);
  return { pass: Math.log(g.good / g.bad), fail: Math.log((1 - g.good) / (1 - g.bad)), upper, lower: -upper };
}

/** The SPRT's step: the score after one more attempt. */
export function sprtStep(score: number, passed: boolean, g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): number {
  const b = sprtBounds(g);
  return score + (passed ? b.pass : b.fail);
}

/** The score after `passes` of `attempts`: order doesn't matter, only the counts. */
export function sprtScore(passes: number, attempts: number, g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): number {
  const b = sprtBounds(g);
  return passes * b.pass + (attempts - passes) * b.fail;
}

/** The fewest attempts an agent that always passes needs to pass the gate: 12 at 0.9, 0.7 and 0.05. */
export function attemptsToPass(g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): number {
  const b = sprtBounds(g);
  return Math.max(1, Math.ceil(b.upper / b.pass - EPS));
}

/** The fewest attempts an agent that always fails needs to fail it: 3 at 0.9, 0.7 and 0.05. */
export function attemptsToFail(g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): number {
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

/**
 * What a gate says after `attempts` attempts, `passes` of which passed. An SPRT gate passes or fails
 * as soon as its score crosses a bound, so a caller that asks after every attempt and stops at the
 * first answer that isn't `continue` runs exactly the test the gate states. A baseline gate
 * continues until `min` attempts, then passes or fails against `history` (none: a golden that always
 * passes).
 */
export function decide(passes: number, attempts: number, gate: Gate, history?: GateHistory | Tally | null): GateDecision {
  checkTally(passes, attempts);
  if (gate.kind === 'baseline') {
    if (attempts < gate.min) return 'continue';
    return dropProbability({ passes, attempts }, history && history.attempts > 0 ? history : null, gate.drop) > 1 - gate.risk ? 'fail' : 'pass';
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
  // ∫_0^top f_now(x) · P(baseline > x + drop) dx
  const lnB1 = lnBeta(a1, b1);
  const lnB2 = lnBeta(a2, b2);
  const h = top / SIMPSON_STEPS;
  let sum = 0;
  for (let i = 0; i <= SIMPSON_STEPS; i++) {
    const x = i * h;
    const w = i === 0 || i === SIMPSON_STEPS ? 1 : i % 2 ? 4 : 2;
    sum += w * densityBeta(x, a1, b1, lnB1) * (1 - incompleteBeta(x + drop, a2, b2, lnB2));
  }
  return Math.min(1, Math.max(0, (sum * h) / 3));
}

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
  /** Attempts it runs on average. */
  attempts: number;
}

/**
 * The exact odds of each verdict, and the attempts run on average, for an agent that passes `p` of
 * the time: a walk over every count of passes the gate can see, stopped where it decides. For a
 * baseline gate, `history` is the baseline (none: a golden that always passes).
 */
export function gateOdds(gate: Gate, p: number, history?: Tally | null): GateOdds {
  if (!(p >= 0 && p <= 1)) throw new RangeError('p must be between 0 and 1');
  const steps = gate.kind === 'sprt' ? gate.max : gate.min;
  let walking = new Map<number, number>([[0, 1]]);
  const out: GateOdds = { pass: 0, fail: 0, inconclusive: 0, attempts: 0 };
  for (let n = 1; n <= steps; n++) {
    const next = new Map<number, number>();
    for (const [s, mass] of walking) {
      for (const [passes, q] of [
        [s + 1, p],
        [s, 1 - p],
      ] as const) {
        if (q === 0) continue;
        const m = mass * q;
        const d = decide(passes, n, gate, history ?? null);
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

/** The same for a fixed count, `needed` of `of`, stopped as soon as it is settled. */
export function countOdds(of: number, needed: number, p: number): GateOdds {
  let walking = new Map<number, number>([[0, 1]]);
  const out: GateOdds = { pass: 0, fail: 0, inconclusive: 0, attempts: 0 };
  for (let n = 1; n <= of; n++) {
    const next = new Map<number, number>();
    for (const [s, mass] of walking) {
      for (const [passes, q] of [
        [s + 1, p],
        [s, 1 - p],
      ] as const) {
        if (q === 0) continue;
        const m = mass * q;
        const d = decideCount(passes, n, of, needed);
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

// ---- What the reports say ---------------------------------------------------------------------

/** A share as a percentage, as few digits as it needs: 0.9 is 90%, 0.875 is 87.5%. */
export function percent(x: number): string {
  return `${+(x * 100).toFixed(1)}%`;
}

/** A rate to two places: 0.7 is 0.70. */
const rate = (x: number) => x.toFixed(2);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A gate in one sentence: `pass at 90% or more, fail at 70% or less, at most 5% risk of the wrong verdict, up to 40 attempts`. */
export function describeGate(gate: Gate): string {
  if (gate.kind === 'sprt') return `pass at ${percent(gate.good)} or more, fail at ${percent(gate.bad)} or less, at most ${percent(gate.risk)} risk of the wrong verdict, up to ${plural(gate.max, 'attempt')}`;
  return `fail on a drop of ${+(gate.drop * 100).toFixed(1)} points or more from the pass rate of the last ${plural(gate.window, 'session')}, at ${percent(1 - gate.risk)} confidence, after ${plural(gate.min, 'attempt')}`;
}

/** The running score after each attempt, against both bounds: why the gate stopped where it did. */
export interface SprtEvidence extends SprtBounds {
  kind: 'sprt';
  /** The score after attempt 1, 2, …: each pass adds `pass`, each failure `fail`. */
  scores: number[];
}

/** What a baseline gate compared: the baseline, and the chance of a drop it found. */
export interface BaselineEvidence {
  kind: 'baseline';
  /** The history pooled, or null when there is none and the baseline is a golden that always passes. */
  history: GateHistory | null;
  /** The baseline's pass rate: its posterior mean, or 1 without history. */
  baseline: number;
  /** P(now < baseline − drop) once it decided, or null before `min` attempts. */
  probability: number | null;
  /** It fails above this: 1 − risk. */
  threshold: number;
}

/** A gate's verdict as every report keeps it: the CLI's, the JSON's, the store's and the dashboard's. */
export interface GateResult {
  gate: Gate;
  decision: GateDecision;
  passes: number;
  attempts: number;
  /** The Wilson interval of the pass rate at 1 − risk, for display. */
  interval: { lo: number; hi: number; confidence: number };
  /** pass^k for k = 1, 2, … up to the attempts run (at most 8). */
  passK: Array<{ k: number; value: number }>;
  evidence: SprtEvidence | BaselineEvidence;
  /** The first attempt replayed clean, so every attempt would come out the same: it settled the verdict alone. */
  clean: boolean;
  /** The one sentence: `passed: at least 90% with 95% confidence after 12 attempts`. */
  sentence: string;
}

/** The largest k a report lists pass^k for. */
const PASS_K_MAX = 8;
/** The k the one-line tally shows. */
export const PASS_K_SHOWN = 5;

/**
 * A gate's verdict on attempts that came out as `outcomes` (true for a pass), in order. `clean`: the
 * first attempt replayed clean, so it settled the verdict by itself. `decision` defaults to what the
 * gate says after the last attempt; a caller stopped early (a signal, a budget) passes `continue`.
 */
export function gateResult(gate: Gate, outcomes: readonly boolean[], o: { history?: GateHistory | null; clean?: boolean; decision?: GateDecision } = {}): GateResult {
  const attempts = outcomes.length;
  const passes = outcomes.filter(Boolean).length;
  const history = o.history && o.history.attempts > 0 ? o.history : null;
  const clean = !!o.clean && attempts > 0;
  const decision = o.decision ?? (clean ? (outcomes[0] ? 'pass' : 'fail') : decide(passes, attempts, gate, history));
  const confidence = 1 - gate.risk;
  const w = wilson(passes, attempts, confidence);
  const passK: GateResult['passK'] = [];
  for (let k = 1; k <= Math.min(attempts, PASS_K_MAX); k++) passK.push({ k, value: passHatK(passes, attempts, k)! });
  let evidence: GateResult['evidence'];
  if (gate.kind === 'sprt') {
    const b = sprtBounds(gate);
    let score = 0;
    evidence = { kind: 'sprt', ...b, scores: outcomes.map((x) => (score += x ? b.pass : b.fail)) };
  } else {
    evidence = {
      kind: 'baseline',
      history: history ? { passes: history.passes, attempts: history.attempts, sessions: 'sessions' in history ? history.sessions : 0 } : null,
      baseline: history ? (1 + history.passes) / (2 + history.attempts) : 1,
      probability: attempts >= gate.min || clean ? dropProbability({ passes, attempts }, history, gate.drop) : null,
      threshold: 1 - gate.risk,
    };
  }
  const result: GateResult = { gate, decision, passes, attempts, interval: { ...w, confidence }, passK, evidence, clean, sentence: '' };
  result.sentence = gateSentence(result);
  return result;
}

/** The verdict word a decision reads as: passed, failed, inconclusive; one still going reads as undecided. */
export function decisionWord(d: GateDecision): 'passed' | 'failed' | 'inconclusive' | 'undecided' {
  return d === 'pass' ? 'passed' : d === 'fail' ? 'failed' : d === 'inconclusive' ? 'inconclusive' : 'undecided';
}

/** The baseline in words: `0.94 over the last 10 sessions`, or that there is none yet. */
function baselineWords(e: BaselineEvidence): string {
  if (!e.history) return 'a golden that always passes, since it has no history yet';
  return `${rate(e.baseline)} over the last ${plural(e.history.sessions || 1, 'session')} (${e.history.passes} of ${e.history.attempts} attempts)`;
}

/**
 * The one sentence every report says: `passed: at least 90% with 95% confidence after 12 attempts`,
 * `failed: at most 70% with 95% confidence after 3 attempts`, `inconclusive: …`.
 */
export function gateSentence(r: Pick<GateResult, 'gate' | 'decision' | 'attempts' | 'clean' | 'evidence'>): string {
  const word = decisionWord(r.decision);
  const after = `after ${plural(r.attempts, 'attempt')}`;
  if (r.clean) return `${word}: a clean replay comes out the same every time, so its one attempt settles it`;
  const g = r.gate;
  const confidence = percent(1 - g.risk);
  if (g.kind === 'sprt') {
    if (r.decision === 'pass') return `passed: at least ${percent(g.good)} with ${confidence} confidence ${after}`;
    if (r.decision === 'fail') return `failed: at most ${percent(g.bad)} with ${confidence} confidence ${after}`;
    if (r.decision === 'inconclusive') return `inconclusive: neither at least ${percent(g.good)} nor at most ${percent(g.bad)} with ${confidence} confidence ${after}, the most the gate runs`;
    return `undecided ${after}: between ${percent(g.bad)} and ${percent(g.good)} so far`;
  }
  const e = r.evidence as BaselineEvidence;
  const points = `${+(g.drop * 100).toFixed(1)} points`;
  if (r.decision === 'pass') return `passed: no drop of ${points} or more from its baseline, ${baselineWords(e)}, with ${confidence} confidence ${after}`;
  if (r.decision === 'fail') return `failed: its pass rate dropped ${points} or more from its baseline, ${baselineWords(e)}, with ${confidence} confidence ${after}`;
  return `undecided ${after}: it decides after ${plural(g.min, 'attempt')}`;
}

/** The evidence in one line: `18 of 20 passed · pass rate ≥ 0.70 (95%, Wilson) · pass^5 0.55`. */
export function formatTally(r: Pick<GateResult, 'passes' | 'attempts' | 'interval' | 'passK'>): string {
  const parts = [`${r.passes} of ${r.attempts} passed`];
  if (r.attempts > 0) parts.push(`pass rate ≥ ${rate(r.interval.lo)} (${percent(r.interval.confidence)}, Wilson)`);
  const k = r.passK.find((x) => x.k === PASS_K_SHOWN);
  if (k) parts.push(`pass^${k.k} ${rate(k.value)}`);
  return parts.join(' · ');
}
