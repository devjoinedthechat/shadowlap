import { CHAOS_PRESETS, OVERSIZE_CHARS, isObject, parseGate, parsePresets, readConfigFile, type ChaosPreset, type Gate } from '@shadowlap/engine';
import type { TestSpec } from './checks.js';

/**
 * A golden's error-path presets, as `"chaos"` in its `tests` entry says them: which presets
 * `test --chaos` runs on it (default all six), the tool the tool presets hit (default the first
 * one that reads the world), what an error path must do besides the agent exiting 0 (`expect`, the
 * grammar of the entry's own: its checks describe the path the recording took, which an error path
 * needn't take; without it, the upper bounds the entry's own expect sets on write tools), the gate
 * each preset is decided by (default the golden's `repeat` and `passes`), how long an oversized
 * result grows, and how long an attempt may run. `"chaos": false` leaves the golden out of
 * `test --chaos`. Read beside `tests` as `task` is: the golden's checks don't need it.
 */

export interface ChaosSpec {
  presets: ChaosPreset[];
  /** What every attempt must do besides exiting 0, parsed; null for the write limits of the golden's own expect. */
  expect: TestSpec | null;
  /** That `expect` as written, for the report. */
  expectRaw: Record<string, unknown> | null;
  /** Where `expect` came from when not from the tests entry: `--expect` on `replay --chaos`. */
  expectFrom?: '--expect';
  /** The tool whose first call the tool presets hit; null for the first that reads the world. */
  tool: string | null;
  /** The gate each preset's attempts are decided by; null for the golden's repeat and passes. */
  gate: Gate | null;
  /** Characters an oversized result grows to. */
  oversize: number;
  /** Seconds an attempt may run before it is stopped and fails: an error path can hang (an agent that retries a 429 for ever). */
  timeout: number;
}

/** How long an attempt may run by default, in seconds. */
export const CHAOS_TIMEOUT = 300;

export const DEFAULT_CHAOS: ChaosSpec = { presets: [...CHAOS_PRESETS], expect: null, expectRaw: null, tool: null, gate: null, oversize: OVERSIZE_CHARS, timeout: CHAOS_TIMEOUT };

/** checks.ts `parseExpect`, passed in: the checks module reads this one to check a tests entry. */
export type ExpectParser = (raw: unknown, where: string) => TestSpec;

/** `"chaos"` in a tests entry, checked: false, or the presets' settings. Undefined is the defaults. */
export function parseChaosFields(raw: unknown, where: string, parseExpect: ExpectParser): ChaosSpec | false {
  if (raw === undefined) return DEFAULT_CHAOS;
  if (raw === false) return false;
  if (!isObject(raw)) throw new Error(`${where} must be false, or an object such as { "presets": ["timeout", "429"] }`);
  for (const k of Object.keys(raw)) if (!['presets', 'expect', 'tool', 'gate', 'oversize', 'timeout'].includes(k)) throw new Error(`${where} has an unknown key "${k}" (expected "presets", "expect", "tool", "gate", "oversize", "timeout")`);
  let expect: TestSpec | null = null;
  if (raw.expect !== undefined) {
    if (!isObject(raw.expect)) throw new Error(`${where}.expect must be an object of checks, as a tests entry's expect is`);
    expect = parseExpect(raw.expect, `${where}.expect`);
  }
  let presets = DEFAULT_CHAOS.presets;
  if (raw.presets !== undefined) {
    if (!Array.isArray(raw.presets) || !raw.presets.every((p) => typeof p === 'string')) throw new Error(`${where}.presets must be a list of presets: ${CHAOS_PRESETS.join(', ')}`);
    presets = parsePresets(raw.presets, `${where}.presets`);
  }
  if (raw.tool !== undefined && (typeof raw.tool !== 'string' || !raw.tool.trim())) throw new Error(`${where}.tool must be the name of a tool`);
  let gate: Gate | null = null;
  if (raw.gate !== undefined) {
    gate = parseGate(raw.gate, `${where}.gate`);
    if (gate.kind !== 'sprt') throw new Error(`${where}.gate: a baseline gate compares a golden with its own history, which an error-path preset doesn't have; give { "good", "bad", "risk", "max" }`);
  }
  let oversize = OVERSIZE_CHARS;
  if (raw.oversize !== undefined) {
    if (typeof raw.oversize !== 'number' || !Number.isInteger(raw.oversize) || raw.oversize < 1_000 || raw.oversize > 50_000_000) throw new Error(`${where}.oversize must be a whole number of characters from 1000 to 50000000`);
    oversize = raw.oversize;
  }
  let timeout = CHAOS_TIMEOUT;
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== 'number' || !Number.isInteger(raw.timeout) || raw.timeout < 1 || raw.timeout > 86_400) throw new Error(`${where}.timeout must be a whole number of seconds from 1 to 86400`);
    timeout = raw.timeout;
  }
  return { presets, expect, expectRaw: expect ? (raw.expect as Record<string, unknown>) : null, tool: typeof raw.tool === 'string' ? raw.tool.trim() : null, gate, oversize, timeout };
}

/**
 * The `chaos` of the config's tests entry `key` (as `testsKeyFor` picks it), read from the project's
 * config as every command reads it: the defaults without an entry. A config that can't be read
 * throws, as it does for the tests entry itself; it never stands for the defaults.
 */
export function chaosFor(projectDir: string, key: string | null, parseExpect: ExpectParser): ChaosSpec | false {
  if (key === null) return DEFAULT_CHAOS;
  const data = readConfigFile(projectDir).data;
  const tests = isObject(data) && isObject(data.tests) ? data.tests : {};
  const entry = tests[key];
  return parseChaosFields(isObject(entry) ? entry.chaos : undefined, `tests["${key}"].chaos`, parseExpect);
}
