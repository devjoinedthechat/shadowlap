import { resolve } from 'node:path';
import { CHAOS_PRESETS, OVERSIZE_CHARS, parsePresets, type ChaosPreset } from '../chaos.js';
import { CONFIG_FILE, readConfigFile } from '../config-file.js';
import { parseInjectionEntry } from '../injection.js';
import { isObject } from '../is-object.js';
import { recordingsOfRun, testsEntryFor } from '../run-checks.js';
import { parseGate, type Gate } from '../stats.js';
import type { StoreOf } from '../store.js';
import { parseTaskFields } from '../tasks.js';
import type { RunRecord } from '../types.js';
import type { TestEntry, TestSpec } from './grammar.js';
import { onlyKeys, parseExpect, parseExpectInto } from './parse.js';

/**
 * The tests entries in shadowlap.config.json: each recording's checks with what runs them (`fork`,
 * `repeat`, `passes`, a gate), its task, its error-path presets and its injection gate, and the
 * session's own settings beside them. These read the config and the injection templates from disk,
 * so they need Node, as parse.ts does not.
 */

function parseSpec(raw: unknown, where: string): TestSpec {
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  // `task` (where a model takes over, why, what it rewards) is read by `shadowlap tasks` (tasks.ts),
  // and `chaos` (the error-path presets) by `test --chaos` (parseChaosFields, below); a mistake in
  // either fails here too, as any other mistake under `tests` does.
  onlyKeys(raw, ['fork', 'repeat', 'passes', 'gate', 'expect', 'task', 'injection', 'chaos'], where);
  parseTaskFields(raw.task, `${where}.task`);
  parseChaosFields(raw.chaos, `${where}.chaos`);
  if (raw.fork !== undefined && typeof raw.fork !== 'boolean') throw new Error(`${where}.fork must be true or false`);
  // Statistical gating: the gate decides how many attempts run, so it stands in for repeat and passes.
  let gate: Gate | undefined;
  if (raw.gate !== undefined) {
    if (raw.repeat !== undefined || raw.passes !== undefined) throw new Error(`${where}: a gate decides how many attempts run and what passes; give the gate, or repeat and passes, not both`);
    if (raw.fork !== true) throw new Error(`${where}.gate needs "fork": true: only a golden that may fork runs live, where its attempts can come out differently`);
    gate = parseGate(raw.gate, `${where}.gate`);
  }
  const repeat = raw.repeat ?? 1;
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error(`${where}.repeat must be a whole number from 1 to 100`);
  const passes = raw.passes ?? repeat;
  if (typeof passes !== 'number' || !Number.isInteger(passes) || passes < 1 || passes > repeat) throw new Error(`${where}.passes must be a whole number from 1 to repeat (${repeat})`);
  const spec: TestSpec = { fork: raw.fork === true, repeat, passes, tools: [], ...(gate ? { gate } : {}), ...(gate && isObject(raw.gate) && raw.gate.max !== undefined ? { gateMaxGiven: true } : {}) };
  if (raw.expect !== undefined) parseExpectInto(spec, raw.expect, `${where}.expect`);
  // Injection tests (injection.ts in the engine): the gate `shadowlap test` and `shadowlap injection` read.
  if (raw.injection !== undefined) spec.injection = parseInjectionEntry(raw.injection, `${where}.injection`);
  return spec;
}

export function parseTests(raw: unknown): TestEntry[] {
  if (raw === undefined) return [];
  if (!isObject(raw)) throw new Error(`${CONFIG_FILE}: "tests" must map recording directories to their checks`);
  parseTestSettings(raw);
  return Object.entries(raw)
    .filter(([key]) => !(TEST_SETTINGS as readonly string[]).includes(key))
    .map(([recording, spec]) => ({ recording, spec: parseSpec(spec, `${CONFIG_FILE}: tests["${recording}"]`) }));
}

// ---- A test session's own settings under `tests` (gating.md): beside the recordings, never one ----

/** Keys under `tests` that set the session, not a recording's checks. */
export const TEST_SETTINGS = ['suiteRisk', 'baselineBranch'] as const;

export interface TestSettings {
  /** The most a healthy suite may go red for nothing, split across its gated goldens (suite.ts). */
  suiteRisk?: number;
  /** The branch a gate against history takes its baseline from, instead of the default branch. */
  baselineBranch?: string;
}

/** `suiteRisk` and `baselineBranch` under `tests`, checked. */
export function parseTestSettings(raw: unknown): TestSettings {
  if (!isObject(raw)) return {};
  const out: TestSettings = {};
  if (raw.suiteRisk !== undefined) {
    const v = raw.suiteRisk;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= 0.5) throw new Error(`${CONFIG_FILE}: tests.suiteRisk must be a number above 0 and below 0.5, such as 0.05: the most a healthy suite may go red for nothing`);
    out.suiteRisk = v;
  }
  if (raw.baselineBranch !== undefined) {
    const v = raw.baselineBranch;
    if (typeof v !== 'string' || !v.trim() || /\s/.test(v.trim())) throw new Error(`${CONFIG_FILE}: tests.baselineBranch must be a branch name, such as "main": the branch a gate against history takes its baseline from`);
    out.baselineBranch = v.trim();
  }
  return out;
}

/**
 * The entry for a recording directory (relative to the current folder, or absolute). An exact path
 * wins over a pattern; `*` matches within the last part only. The engine's `testsEntryFor` decides,
 * so the dashboard finds a run's checks the same way.
 */
export function specFor(entries: TestEntry[], recordingDir: string, configDir: string): TestSpec | null {
  return testsEntryFor(entries, resolve(recordingDir), configDir)?.spec ?? null;
}

/**
 * The checks a run is judged by when none are given, and the folder whose entry gives them: a
 * golden's (`golden`, the pack it was asked from), else those of the recording it comes from,
 * through the run and its ancestors (recordingsOfRun), the first an entry names. Folders are
 * relative to `configDir`, the folder shadowlap.config.json is in. Null when no entry names one.
 */
export function recordedChecks(entries: TestEntry[], store: StoreOf<'recording'>, run: RunRecord, configDir: string, golden: string | null = null): { spec: TestSpec; source: string } | null {
  for (const dir of golden ? [golden] : recordingsOfRun(store, run)) {
    const spec = specFor(entries, resolve(configDir, dir), configDir);
    if (spec) return { spec, source: dir };
  }
  return null;
}

// ---- A golden's error-path presets ----------------------------------------------------------------

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

/** How a preset's `expect` is read: `parseExpect` (parse.ts) unless a caller gives its own. */
export type ExpectParser = (raw: unknown, where: string) => TestSpec;

/** `"chaos"` in a tests entry, checked: false, or the presets' settings. Undefined is the defaults. */
export function parseChaosFields(raw: unknown, where: string, parse: ExpectParser = parseExpect): ChaosSpec | false {
  if (raw === undefined) return DEFAULT_CHAOS;
  if (raw === false) return false;
  if (!isObject(raw)) throw new Error(`${where} must be false, or an object such as { "presets": ["timeout", "429"] }`);
  for (const k of Object.keys(raw)) if (!['presets', 'expect', 'tool', 'gate', 'oversize', 'timeout'].includes(k)) throw new Error(`${where} has an unknown key "${k}" (expected "presets", "expect", "tool", "gate", "oversize", "timeout")`);
  let expect: TestSpec | null = null;
  if (raw.expect !== undefined) {
    if (!isObject(raw.expect)) throw new Error(`${where}.expect must be an object of checks, as a tests entry's expect is`);
    expect = parse(raw.expect, `${where}.expect`);
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
export function chaosFor(projectDir: string, key: string | null, parse: ExpectParser = parseExpect): ChaosSpec | false {
  if (key === null) return DEFAULT_CHAOS;
  const data = readConfigFile(projectDir).data;
  return chaosIn(isObject(data) ? data.tests : undefined, key, parse);
}

/** The `chaos` of tests entry `key` in the config's `tests` as written (a pooled read is handed it read): the defaults without an entry. */
export function chaosIn(tests: unknown, key: string | null, parse: ExpectParser = parseExpect): ChaosSpec | false {
  if (key === null) return DEFAULT_CHAOS;
  const entry = isObject(tests) ? tests[key] : undefined;
  return parseChaosFields(isObject(entry) ? entry.chaos : undefined, `tests["${key}"].chaos`, parse);
}
