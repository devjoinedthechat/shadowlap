import { readFileSync } from 'node:fs';
import { InvalidArgumentError } from 'commander';
import { commandIsImported, hasRecordedCommand, messageOf, parseGate, type RunRecord, type SprtGate, type StoreOf } from '@shadowlap/engine';
import { parseExpect } from '../checks.js';
import { confirmImportedCommand, requireRun, withoutCommand } from '../shared.js';
import { shortId } from '../ui.js';

/** What blame, verify and repair are given, read: their numbers, request fields, checks and gates, the runs they name, and the commands they replay them with. */

export function parseCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('must be a whole number, 0 or more');
  return n;
}

export function parseUsd(value: string): number {
  const n = Number(value.replace(/^\$/, ''));
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be an amount in USD, such as 0.50');
  return n;
}

/** `--set temperature=1`: a request field for the probed call on; the value is JSON or a string. */
export function parseFields(specs: string[], model: string | undefined): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const spec of specs) {
    const m = /^([A-Za-z_][\w.]*)=([\s\S]*)$/.exec(spec);
    if (!m) throw new InvalidArgumentError(`--set expects <key>=<value>, such as temperature=1, got "${spec}"`);
    let value: unknown = m[2]!;
    try {
      value = JSON.parse(m[2]!);
    } catch {
      // a bare string
    }
    fields[m[1]!] = value;
  }
  if (model !== undefined) {
    if ('model' in fields) throw new InvalidArgumentError('--model and --set model=… both set the model; use one');
    fields.model = model;
  }
  return fields;
}

export function readExpect(raw: string): ReturnType<typeof parseExpect> {
  return readExpectJson(raw).spec;
}

/** `--expect` parsed, and its JSON as given: Fixes groups failures by it and shows it in commands. */
export function readExpectJson(raw: string): { spec: ReturnType<typeof parseExpect>; json: unknown } {
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8');
    } catch (err) {
      throw new InvalidArgumentError(`--expect: cannot read ${raw.slice(1)}: ${messageOf(err)}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidArgumentError(`--expect takes JSON or @file.json, such as '{"tools":{"send_email":0}}'`);
  }
  return { spec: parseExpect(parsed, '--expect'), json: parsed };
}

/** `--gate`: a gate between two pass rates, as JSON or @file.json; the figures left out are `defaults`. */
export function readGate(raw: string, defaults: Omit<SprtGate, 'kind'>): SprtGate {
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8');
    } catch (err) {
      throw new InvalidArgumentError(`--gate: cannot read ${raw.slice(1)}: ${messageOf(err)}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidArgumentError(`--gate takes JSON or @file.json, such as '{"good":${defaults.good},"bad":${defaults.bad},"risk":${defaults.risk},"max":${defaults.max}}'`);
  }
  let gate;
  try {
    gate = parseGate(parsed, '--gate', defaults);
  } catch (err) {
    throw new InvalidArgumentError(messageOf(err));
  }
  if (gate.kind !== 'sprt') throw new InvalidArgumentError('--gate takes a gate between two pass rates here ({ "good", "bad", "risk", "max" }); a gate against history belongs to a golden, under "tests" in shadowlap.config.json');
  return gate;
}

/**
 * What decides a run's or a probe's attempts: the gate (`--gate`, else the command's defaults), or a
 * fixed count when `--attempts` or `--passes` is given, as it was before gates (`passes` defaulting
 * from the attempts).
 */
export function attemptRule(flags: { attempts?: number | undefined; passes?: number | undefined; gate?: string | undefined }, o: { defaults: Omit<SprtGate, 'kind'>; passes: (attempts: number) => number }): { gate: SprtGate | null; attempts: number; needed: number } {
  const counted = flags.attempts !== undefined || flags.passes !== undefined;
  if (counted && flags.gate !== undefined) throw new InvalidArgumentError('give a gate (--gate) or a fixed count (--attempts, --passes), not both');
  if (!counted) {
    const gate: SprtGate = flags.gate !== undefined ? readGate(flags.gate, o.defaults) : { kind: 'sprt', ...o.defaults };
    return { gate, attempts: gate.max, needed: 0 };
  }
  const attempts = flags.attempts ?? 5;
  if (attempts > 100) throw new InvalidArgumentError('--attempts is at most 100');
  const needed = flags.passes ?? o.passes(attempts);
  if (needed > attempts) throw new InvalidArgumentError(`--passes (${needed}) can't be more than --attempts (${attempts})`);
  return { gate: null, attempts, needed };
}

/** `--margin`: a drop between 0 and 1, as a share (0.1 is 10 points). */
export function parseMargin(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) throw new InvalidArgumentError('must be a share between 0 and 1, such as 0.1 (a drop of 10 points)');
  return n;
}

/**
 * The runs `--fixes`, `--holdout` and `--keeps` name: run ids or unique prefixes, and `label:<name>`
 * for every run with that label.
 */
export function selectRuns(store: StoreOf<'recording'>, specs: readonly string[], flag: string): RunRecord[] {
  const out: RunRecord[] = [];
  for (const spec of specs) {
    if (spec.startsWith('label:')) {
      const label = spec.slice('label:'.length);
      const labelled = store.allRuns().filter((r) => r.meta?.labels?.includes(label));
      if (!labelled.length) throw new InvalidArgumentError(`${flag} ${spec}: no run has the label "${label}" (see shadowlap ls --label ${label})`);
      out.push(...labelled);
    } else {
      out.push(requireRun(store, spec));
    }
  }
  return out;
}

export function parsePercent(value: string): number {
  const n = Number(value.replace(/%$/, ''));
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError('must be a percentage, such as 25');
  return n / 100;
}

/** Runs to replay under their own recorded commands, or under the one after `--`; imported commands need consent. */
export async function targetsOf(runs: RunRecord[], command: string[], yes: boolean | undefined, verb: string): Promise<Array<{ parent: RunRecord; argv: string[]; commandFromImport: boolean }> | null> {
  const out: Array<{ parent: RunRecord; argv: string[]; commandFromImport: boolean }> = [];
  for (const run of runs) {
    if (!command.length && !hasRecordedCommand(run)) {
      throw new InvalidArgumentError(`${shortId(run.runId)} ${withoutCommand(run)} and has no command to re-run. Give yours after --:\n  shadowlap ${verb} … -- python agent.py`);
    }
    const argv = command.length ? command : run.command.argv;
    const commandFromImport = !command.length && commandIsImported(run);
    if (commandFromImport && !yes && !(await confirmImportedCommand(run, argv))) return null;
    out.push({ parent: run, argv, commandFromImport });
  }
  return out;
}
