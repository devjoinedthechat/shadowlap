/**
 * The gate contract, as narrow as the error-path presets need it: `Gate`, `parseGate` and `decide`
 * with the signatures `packages/engine/src/stats.ts` exports (a sequential probability ratio test,
 * or a gate against a golden's history). Only the sequential test is decided here: the presets have
 * no history to compare with, and their config refuses a baseline gate. Where the engine's
 * `stats.ts` exists, it replaces this file.
 */

export type Gate = { kind: 'sprt'; good: number; bad: number; risk: number; max: number } | { kind: 'baseline'; drop: number; risk: number; window: number; min: number };

export type GateDecision = 'pass' | 'fail' | 'continue' | 'inconclusive';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function rate(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= 1) throw new Error(`${at} must be a number between 0 and 1, such as 0.9`);
  return v;
}

function whole(v: unknown, at: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${at} must be a whole number from ${min} to ${max}`);
  return v;
}

/** A gate as the config writes it: `{ good, bad, risk, max }`, or `{ baseline: "history", drop, risk, window?, min? }`. */
export function parseGate(json: unknown, where: string): Gate {
  if (!isObject(json)) throw new Error(`${where} must be an object such as { "good": 0.9, "bad": 0.7, "risk": 0.05, "max": 20 }`);
  if (json.baseline !== undefined) {
    for (const k of Object.keys(json)) if (!['baseline', 'drop', 'risk', 'window', 'min'].includes(k)) throw new Error(`${where} has an unknown key "${k}" (expected "baseline", "drop", "risk", "window", "min")`);
    if (json.baseline !== 'history') throw new Error(`${where}.baseline must be "history"`);
    return { kind: 'baseline', drop: rate(json.drop, `${where}.drop`), risk: rate(json.risk, `${where}.risk`), window: json.window === undefined ? 10 : whole(json.window, `${where}.window`, 1, 1000), min: json.min === undefined ? 1 : whole(json.min, `${where}.min`, 1, 1000) };
  }
  for (const k of Object.keys(json)) if (!['good', 'bad', 'risk', 'max'].includes(k)) throw new Error(`${where} has an unknown key "${k}" (expected "good", "bad", "risk", "max")`);
  const good = rate(json.good, `${where}.good`);
  const bad = rate(json.bad, `${where}.bad`);
  if (bad >= good) throw new Error(`${where}: bad (${bad}) must be below good (${good})`);
  const risk = rate(json.risk, `${where}.risk`);
  if (risk >= 0.5) throw new Error(`${where}.risk must be below 0.5`);
  return { kind: 'sprt', good, bad, risk, max: whole(json.max, `${where}.max`, 1, 1000) };
}

/**
 * Wald's sequential probability ratio test, after each attempt: each pass adds ln(good/bad), each
 * failure ln((1−good)/(1−bad)); the gate passes above ln((1−risk)/risk), fails below its negative,
 * and is inconclusive when `max` attempts run out in between. A baseline gate is not decided here.
 */
export function decide(passes: number, attempts: number, gate: Gate, _history?: unknown): GateDecision {
  if (gate.kind !== 'sprt') return 'inconclusive';
  const score = passes * Math.log(gate.good / gate.bad) + (attempts - passes) * Math.log((1 - gate.good) / (1 - gate.bad));
  const bound = Math.log((1 - gate.risk) / gate.risk);
  if (score >= bound) return 'pass';
  if (score <= -bound) return 'fail';
  return attempts >= gate.max ? 'inconclusive' : 'continue';
}
