/**
 * The statistical gate `shadowlap injection --clean` decides "caused" with: Wald's sequential
 * probability ratio test, decided as attempts come in.
 *
 * A stand-in with the signatures of `Gate`, `parseGate`, `decide`, `attemptsToPass` and
 * `attemptsToFail` in `stats.ts`, which the statistical gating of goldens builds: once that module
 * is in, this file goes and its importers take the same names from `./stats.js`. Only the
 * sequential test is decided here; a baseline gate needs a golden's history, which --clean has none
 * of, and reads inconclusive.
 */

export interface SprtGate {
  kind: 'sprt';
  good: number;
  bad: number;
  risk: number;
  max: number;
}

export type Gate = SprtGate | { kind: 'baseline'; drop: number; risk: number; window: number; min: number };

export type GateDecision = 'pass' | 'fail' | 'continue' | 'inconclusive';

/** The figures `{}` stands for, as in stats.ts: pass at 90% or more, fail at 70% or less, at most 5% risk each, up to 40 attempts. */
export const SPRT_DEFAULTS: Readonly<Omit<SprtGate, 'kind'>> = Object.freeze({ good: 0.9, bad: 0.7, risk: 0.05, max: 40 });

const MAX_ATTEMPTS = 1000;
const EPS = 1e-9;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new Error(`${where} has an unknown key "${key}" (expected ${allowed.map((k) => `"${k}"`).join(', ')})`);
}

function share(v: unknown, where: string, what: string, below = 1): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= below) throw new Error(`${where} must be ${what}: a number between 0 and ${below}, such as ${below === 1 ? '0.9' : '0.05'}`);
  return v;
}

function whole(v: unknown, where: string, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_ATTEMPTS) throw new Error(`${where} must be ${what}: a whole number from 1 to ${MAX_ATTEMPTS}`);
  return v;
}

/** What a pass and a failure add to the score, and the bound either way. */
function bounds(g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): { pass: number; fail: number; upper: number } {
  return { pass: Math.log(g.good / g.bad), fail: Math.log((1 - g.good) / (1 - g.bad)), upper: Math.log((1 - g.risk) / g.risk) };
}

/** The fewest attempts that pass the gate when every one passes. */
export function attemptsToPass(g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): number {
  const b = bounds(g);
  return Math.max(1, Math.ceil(b.upper / b.pass - EPS));
}

/** The fewest attempts that fail the gate when every one fails. */
export function attemptsToFail(g: Pick<SprtGate, 'good' | 'bad' | 'risk'>): number {
  const b = bounds(g);
  return Math.max(1, Math.ceil(-b.upper / b.fail - EPS));
}

/**
 * A gate as written: `{ "good": 0.9, "bad": 0.7, "risk": 0.05, "max": 40 }` (pass if the rate is at
 * least `good`, fail if at most `bad`, each with at most `risk` of the wrong verdict, give up after
 * `max` attempts), or `{ "baseline": "history", "drop": 0.15, "risk": 0.05 }`. Every figure is
 * optional: `defaults` fill the sequential test's in (stats.ts's own when none are given).
 */
export function parseGate(json: unknown, where: string, defaults: Partial<Omit<SprtGate, 'kind'>> = {}): Gate {
  if (!isObject(json)) throw new Error(`${where} must be an object, such as { "good": 0.9, "bad": 0.7, "risk": 0.05, "max": 40 } or { "baseline": "history" }`);
  if ('baseline' in json) {
    onlyKeys(json, ['baseline', 'drop', 'risk', 'window', 'min'], where);
    if (json.baseline !== 'history') throw new Error(`${where}.baseline must be "history": the golden's own past sessions are the baseline`);
    return {
      kind: 'baseline',
      drop: json.drop === undefined ? 0.15 : share(json.drop, `${where}.drop`, 'the drop in pass rate that fails it'),
      risk: json.risk === undefined ? 0.05 : share(json.risk, `${where}.risk`, 'the most a verdict may be wrong', 0.5),
      window: json.window === undefined ? 10 : whole(json.window, `${where}.window`, 'how many past sessions make the baseline'),
      min: json.min === undefined ? 5 : whole(json.min, `${where}.min`, 'the attempts it runs before it decides'),
    };
  }
  onlyKeys(json, ['good', 'bad', 'risk', 'max'], where);
  const d = { ...SPRT_DEFAULTS, ...defaults };
  const gate: SprtGate = {
    kind: 'sprt',
    good: json.good === undefined ? d.good : share(json.good, `${where}.good`, 'the pass rate it passes'),
    bad: json.bad === undefined ? d.bad : share(json.bad, `${where}.bad`, 'the pass rate it fails'),
    risk: json.risk === undefined ? d.risk : share(json.risk, `${where}.risk`, 'the most a verdict may be wrong', 0.5),
    max: json.max === undefined ? d.max : whole(json.max, `${where}.max`, 'the most attempts it runs'),
  };
  if (gate.bad >= gate.good) throw new Error(`${where}: bad (${gate.bad}) must be below good (${gate.good}): the gate tells a pass rate of good from one of bad`);
  const needed = attemptsToPass(gate);
  if (needed > gate.max) throw new Error(`${where}: max (${gate.max}) is fewer than the ${needed} attempts an agent that always passes needs at these figures, so it could never pass: raise max, move good and bad further apart, or allow more risk`);
  return gate;
}

/**
 * Where the evidence stands after `attempts` with `passes`: each pass adds ln(good/bad), each
 * failure ln((1−good)/(1−bad)); `pass` at or above ln((1−risk)/risk), `fail` at or below its
 * negative, `inconclusive` once `max` attempts ran in between, else `continue`.
 */
export function decide(passes: number, attempts: number, gate: Gate, _history?: unknown): GateDecision {
  if (!Number.isInteger(passes) || !Number.isInteger(attempts) || passes < 0 || attempts < 0 || passes > attempts) throw new RangeError(`passes (${passes}) and attempts (${attempts}) must be whole numbers with 0 <= passes <= attempts`);
  if (gate.kind !== 'sprt') return attempts >= gate.min ? 'inconclusive' : 'continue';
  if (attempts === 0) return 'continue';
  const b = bounds(gate);
  const score = passes * b.pass + (attempts - passes) * b.fail;
  if (score >= b.upper - EPS) return 'pass';
  if (score <= -b.upper + EPS) return 'fail';
  return attempts >= gate.max ? 'inconclusive' : 'continue';
}
