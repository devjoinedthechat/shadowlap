/**
 * The gate contract, as narrow as the error-path presets need it: `Gate`, `parseGate` and `decide`
 * with the signatures, defaults and checks of the engine's `stats.ts`. Only the sequential test is
 * decided here: the presets have no history to compare with, and their config refuses a baseline
 * gate. Where the engine's `stats.ts` exists, it replaces this file.
 */

export interface SprtGate {
  kind: 'sprt';
  /** A pass rate the gate should pass: at or above it, it fails at most about `risk` of the time. */
  good: number;
  /** A pass rate the gate should fail: at or below it, it passes at most about `risk` of the time. */
  bad: number;
  /** The most a verdict may be wrong at `good` or `bad`, each way. */
  risk: number;
  /** The most attempts it runs; between the bounds then, it is inconclusive. */
  max: number;
}

export interface BaselineGate {
  kind: 'baseline';
  drop: number;
  risk: number;
  window: number;
  min: number;
}

export type Gate = SprtGate | BaselineGate;

export type GateDecision = 'pass' | 'fail' | 'continue' | 'inconclusive';

/** The figures `{}` stands for: pass at 90% or more, fail at 70% or less, at most 5% risk each, up to 40 attempts. */
export const SPRT_DEFAULTS: Readonly<Omit<SprtGate, 'kind'>> = Object.freeze({ good: 0.9, bad: 0.7, risk: 0.05, max: 40 });

/** The figures `{ "baseline": "history" }` stands for. */
export const BASELINE_DEFAULTS: Readonly<Omit<BaselineGate, 'kind'>> = Object.freeze({ drop: 0.15, risk: 0.05, window: 10, min: 5 });

/** The most attempts a gate may run. */
export const GATE_MAX_ATTEMPTS = 1000;

/** A bound crossed by less than this still counts: the scores are sums of logarithms. */
const EPS = 1e-9;

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
 * A gate as written in shadowlap.config.json: `{ good, bad, risk, max }` for the sequential test,
 * `{ baseline: "history", drop, risk, window, min }` against the history. Every figure is optional;
 * `defaults` are the sequential test's when none are given. A `max` too small for an agent that
 * always passes to reach the pass bound is refused: such a gate could never pass.
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

/** What each pass and each failure adds to the score, and the bounds it passes and fails at. */
function sprtBounds(g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): { pass: number; fail: number; upper: number; lower: number } {
  const upper = Math.log((1 - g.risk) / g.risk);
  return { pass: Math.log(g.good / g.bad), fail: Math.log((1 - g.good) / (1 - g.bad)), upper, lower: -upper };
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

/**
 * Wald's sequential probability ratio test, after each attempt: each pass adds ln(good/bad), each
 * failure ln((1−good)/(1−bad)); the gate passes once the score reaches ln((1−risk)/risk), fails once
 * it falls to minus that, and is inconclusive when `max` attempts run out in between. A caller that
 * asks after every attempt and stops at the first answer that isn't `continue` runs exactly the
 * test the gate states. A baseline gate is not decided here: it continues until `min` attempts, then
 * says inconclusive.
 */
export function decide(passes: number, attempts: number, gate: Gate, _history?: unknown): GateDecision {
  if (!Number.isInteger(passes) || !Number.isInteger(attempts) || passes < 0 || attempts < 0 || passes > attempts) throw new RangeError(`passes (${passes}) and attempts (${attempts}) must be whole numbers with 0 <= passes <= attempts`);
  if (gate.kind === 'baseline') return attempts < gate.min ? 'continue' : 'inconclusive';
  if (attempts === 0) return 'continue';
  const b = sprtBounds(gate);
  const score = passes * b.pass + (attempts - passes) * b.fail;
  if (score >= b.upper - EPS) return 'pass';
  if (score <= b.lower + EPS) return 'fail';
  return attempts >= gate.max ? 'inconclusive' : 'continue';
}
