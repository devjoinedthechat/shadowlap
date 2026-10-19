/**
 * The statistical gate `shadowlap injection --clean` decides "caused" with: Wald's sequential
 * probability ratio test, decided as attempts come in.
 *
 * A stand-in with the signatures of `Gate`, `parseGate` and `decide` in `stats.ts`, which the
 * statistical gating of goldens builds: once that module is in, this file goes and its importers take
 * the same names from `./stats.js`. Only the sequential test is decided here; a baseline gate needs
 * a golden's history, which --clean has none of, and reads inconclusive.
 */

export type Gate = { kind: 'sprt'; good: number; bad: number; risk: number; max: number } | { kind: 'baseline'; drop: number; risk: number; window: number; min: number };

export type GateDecision = 'pass' | 'fail' | 'continue' | 'inconclusive';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function share(v: unknown, key: string, where: string, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= 1) throw new Error(`${where}.${key} must be a number between 0 and 1, such as 0.05`);
  return v;
}

function whole(v: unknown, key: string, where: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1000) throw new Error(`${where}.${key} must be a whole number from 1 to 1000`);
  return v;
}

/**
 * A gate as the config writes it: `{ "good": 0.9, "bad": 0.7, "risk": 0.05, "max": 20 }` (pass if
 * the rate is at least `good`, fail if at most `bad`, each with at most `risk` of the wrong verdict,
 * give up after `max` attempts), or `{ "baseline": "history", "drop": 0.15, "risk": 0.05 }`.
 */
export function parseGate(json: unknown, where: string): Gate {
  if (!isObject(json)) throw new Error(`${where} must be an object, such as { "good": 0.9, "bad": 0.7, "risk": 0.05, "max": 20 }`);
  if (json.baseline !== undefined) {
    for (const k of Object.keys(json)) if (!['baseline', 'drop', 'risk', 'window', 'min'].includes(k)) throw new Error(`${where} has an unknown key "${k}" (expected "baseline", "drop", "risk", "window", "min")`);
    if (json.baseline !== 'history') throw new Error(`${where}.baseline must be "history"`);
    return { kind: 'baseline', drop: share(json.drop, 'drop', where, 0.15), risk: share(json.risk, 'risk', where, 0.05), window: whole(json.window, 'window', where, 10), min: whole(json.min, 'min', where, 1) };
  }
  for (const k of Object.keys(json)) if (!['good', 'bad', 'risk', 'max'].includes(k)) throw new Error(`${where} has an unknown key "${k}" (expected "good", "bad", "risk", "max")`);
  const good = share(json.good, 'good', where);
  const bad = share(json.bad, 'bad', where);
  if (bad >= good) throw new Error(`${where}: bad (${bad}) must be below good (${good})`);
  return { kind: 'sprt', good, bad, risk: share(json.risk, 'risk', where, 0.05), max: whole(json.max, 'max', where, 20) };
}

/**
 * Where the evidence stands after `attempts` with `passes`: each pass adds ln(good/bad), each
 * failure ln((1−good)/(1−bad)); `pass` at or above ln((1−risk)/risk), `fail` at or below its
 * negative, `inconclusive` once `max` attempts ran in between, else `continue`.
 */
export function decide(passes: number, attempts: number, gate: Gate, _history?: unknown): GateDecision {
  if (gate.kind !== 'sprt') return attempts >= gate.min ? 'inconclusive' : 'continue';
  const score = passes * Math.log(gate.good / gate.bad) + (attempts - passes) * Math.log((1 - gate.good) / (1 - gate.bad));
  const bound = Math.log((1 - gate.risk) / gate.risk);
  if (score >= bound - 1e-12) return 'pass';
  if (score <= -bound + 1e-12) return 'fail';
  return attempts >= gate.max ? 'inconclusive' : 'continue';
}
