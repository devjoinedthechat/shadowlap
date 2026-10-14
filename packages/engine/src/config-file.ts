import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ClockMode } from './clock.js';
import { compilePattern, namedPatterns, parsePath } from './normalize.js';
import type { CallKind, Normalizer } from './types.js';

/**
 * shadowlap.config.json as a file several writers edit: the CLI (`normalize add`, `redact rm`,
 * `calibrate --write`) and the dashboard's Settings. An edit takes a lock next to the file, reads
 * it, checks it is still the version the editor saw when one is given, and replaces it with one
 * rename, so two writers can't clobber each other and a crash never leaves half a file. Keys the
 * edit doesn't touch keep their place and their values, unknown ones included, and the file keeps
 * its indentation and line endings.
 *
 * Rules are checked here, once, for every writer: what `shadowlap normalize add` refuses, the
 * dashboard refuses with the same words.
 */

export const CONFIG_FILE = 'shadowlap.config.json';

/** The two lists of rules in the file. */
export type RuleList = 'normalize' | 'redact';

/** The version of a project with no config file yet. */
export const NO_CONFIG = 'absent';

export interface ConfigFile {
  /** Where the project's config is, or would be. */
  path: string;
  exists: boolean;
  /** Changes whenever the file's bytes do: `absent`, or their SHA-256. An edit can require it. */
  version: string;
  /** The file's object, every key as written. */
  data: Record<string, unknown>;
  /** How the file is laid out, so an edit writes it back the same way. */
  format: { indent: string; eol: string };
}

/** The file is not a JSON object, so nothing can edit it until it is fixed. */
export class ConfigFileError extends Error {
  override readonly name = 'ConfigFileError';
}

/** The file changed since the version an edit was based on, or another edit holds the lock. */
export class ConfigConflictError extends Error {
  override readonly name = 'ConfigConflictError';
}

/** A rule, or a reference to one, that the CLI would refuse. */
export class RuleError extends Error {
  override readonly name = 'RuleError';
}

const DEFAULT_FORMAT = { indent: '  ', eol: '\n' };

export function configFilePath(cwd: string): string {
  return join(cwd, CONFIG_FILE);
}

function versionOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseConfig(path: string, bytes: Buffer): ConfigFile {
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new ConfigFileError(`${CONFIG_FILE}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ConfigFileError(`${CONFIG_FILE}: must hold a JSON object, such as { "normalize": [] }`);
  const indent = /\n([ \t]+)\S/.exec(text)?.[1] ?? DEFAULT_FORMAT.indent;
  return { path, exists: true, version: versionOf(bytes), data: data as Record<string, unknown>, format: { indent, eol: text.includes('\r\n') ? '\r\n' : '\n' } };
}

/** Reads the project's config. A missing file reads as empty; one that isn't a JSON object throws ConfigFileError. */
export function readConfigFile(cwd: string): ConfigFile {
  const path = configFilePath(cwd);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false, version: NO_CONFIG, data: {}, format: DEFAULT_FORMAT };
    throw err;
  }
  return parseConfig(path, bytes);
}

// ---- rules ----

/** Call kinds a rule can be scoped to, as each `add` command offers them. */
export const RULE_KINDS: Record<RuleList, readonly CallKind[]> = { normalize: ['api', 'tool', 'clock', 'random'], redact: ['api', 'tool'] };

/** What a rule replaces a match with when no replacement is given. */
export const DEFAULT_REPLACE: Record<RuleList, string> = { normalize: '<MASKED>', redact: '<REDACTED>' };

const ALL_KINDS: readonly CallKind[] = ['api', 'tool', 'clock', 'random'];
const LIMITS = { name: 200, path: 500, pattern: 1000, replace: 500 };
const NOUN: Record<RuleList, [string, string]> = { normalize: ['normalizer', 'normalizers'], redact: ['redaction rule', 'redaction rules'] };

/** `normalizer` or `redaction rule`, as messages and listings name them. */
export function ruleNoun(list: RuleList, plural = false): string {
  return NOUN[list][plural ? 1 : 0];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const FIELDS = ['kind', 'name', 'path', 'pattern', 'replace'] as const;

/**
 * The checks every rule passes, however it got there. `blankIsAbsent` reads an empty text field as
 * not given, as an empty form field means; in the file an empty path or pattern is a mistake.
 */
function checkShape(v: Record<string, unknown>, kinds: readonly CallKind[], blankIsAbsent: boolean): Normalizer {
  const pick = (x: unknown): unknown => (x === null || (blankIsAbsent && x === '') ? undefined : x);
  const kind = pick(v.kind);
  const name = pick(v.name);
  const path = pick(v.path);
  const pattern = pick(v.pattern);
  const replace = v.replace;
  if (kind !== undefined && (typeof kind !== 'string' || !(kinds as readonly string[]).includes(kind))) throw new RuleError(`kind must be one of ${kinds.join(', ')}`);
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new RuleError('name must be a tool name, or a call name such as "POST /v1/messages"');
  if (typeof name === 'string' && (name.length > LIMITS.name || /[\u0000-\u001f]/.test(name))) throw new RuleError(`name must be one line of at most ${LIMITS.name} characters`);
  if (path !== undefined) {
    if (typeof path !== 'string') throw new RuleError('path must be a JSONPath such as $.metadata.user_id');
    if (path.length > LIMITS.path) throw new RuleError(`path must be at most ${LIMITS.path} characters`);
    try {
      parsePath(path);
    } catch (err) {
      throw new RuleError(err instanceof Error ? err.message : String(err));
    }
  }
  if (pattern !== undefined) {
    if (typeof pattern !== 'string') throw new RuleError(`pattern must be ${namedPatterns().join(', ')} or a /regex/flags literal`);
    if (pattern.length > LIMITS.pattern) throw new RuleError(`pattern must be at most ${LIMITS.pattern} characters`);
    try {
      compilePattern(pattern);
    } catch (err) {
      throw new RuleError(err instanceof Error ? err.message : String(err));
    }
  }
  if (typeof replace !== 'string') throw new RuleError('replace must be text, such as <UUID>');
  if (replace.length > LIMITS.replace) throw new RuleError(`replace must be at most ${LIMITS.replace} characters`);
  return {
    ...(kind !== undefined ? { kind: kind as CallKind } : {}),
    ...(name !== undefined ? { name: name as string } : {}),
    ...(path !== undefined ? { path: path as string } : {}),
    ...(pattern !== undefined ? { pattern: pattern as string } : {}),
    replace,
  };
}

/** A rule from the file: checked, with keys this version doesn't know kept, so a newer config still loads. */
function checkStored(entry: unknown): Normalizer {
  if (!isObject(entry)) throw new RuleError('it is not an object');
  const extra = Object.fromEntries(Object.entries(entry).filter(([k]) => !(FIELDS as readonly string[]).includes(k)));
  return { ...extra, ...checkShape(entry, ALL_KINDS, false) } as Normalizer;
}

/**
 * A new rule as `shadowlap normalize add` and `shadowlap redact add` take it, checked and in its
 * stored shape. Accepted: a named pattern (uuid, ulid, iso-date, iso-datetime, number, email) or a
 * /regex/flags literal, with or without a path; a path with no pattern, which replaces the whole
 * value there; a scope by kind and by name (a tool name, or a call name such as
 * "POST /v1/messages"). Refused: a rule with neither a path nor a pattern, which would change
 * nothing; and for redaction, a replacement that the rule would rewrite again, or that puts the
 * matched text back, because a redacted pack replays with its rules applied a second time.
 */
export function validateRule(list: RuleList, input: unknown): Normalizer {
  if (!isObject(input)) throw new RuleError('a rule is an object with a path, a pattern or both, and what to replace them with');
  const unknown = Object.keys(input).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) throw new RuleError(`a rule has no field ${unknown[0]}: it takes kind, name, path, pattern and replace`);
  const rule = checkShape({ ...input, replace: input.replace ?? DEFAULT_REPLACE[list] }, RULE_KINDS[list], true);
  if (rule.path === undefined && rule.pattern === undefined) throw new RuleError('give a path, a pattern or both: a rule with neither would change nothing');
  if (rule.pattern !== undefined && compilePattern(rule.pattern).test('')) throw new RuleError(`${rule.pattern} matches an empty string, so it would put the replacement between every character`);
  if (list === 'redact' && rule.pattern !== undefined) {
    if (rule.replace.includes('$&')) throw new RuleError('the replacement puts the matched text back ($&), so nothing would be masked');
    const re = compilePattern(rule.pattern);
    if (rule.replace.replace(re, rule.replace) !== rule.replace) {
      throw new RuleError(`${rule.pattern} would rewrite its own replacement "${rule.replace}": a redacted pack replays with its rules applied a second time, so pick a replacement the pattern leaves as it is`);
    }
  }
  return rule;
}

/**
 * The rules of one list as the file holds them, checked the way every command that loads the
 * config checks them. A missing list is empty. Throws naming the rule as `ls` numbers it.
 */
export function parseRules(raw: unknown, list: RuleList): Normalizer[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RuleError(`${CONFIG_FILE}: ${list} must be a list of rules`);
  return raw.map((entry, i) => {
    try {
      return checkStored(entry);
    } catch (err) {
      throw new RuleError(`${CONFIG_FILE}: ${ruleNoun(list)} #${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** The rules of one list as written, one entry per position, each either checked or with why it fails. */
export function readRules(file: ConfigFile, list: RuleList): Array<{ rule: Normalizer; error: null } | { rule: unknown; error: string }> {
  const raw = file.data[list];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    try {
      return { rule: checkStored(entry), error: null };
    } catch (err) {
      return { rule: entry, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** One line for a rule, as listings and activity show it: `tool · send_email  $.args.to  email → <EMAIL>`. */
export function describeRule(rule: Normalizer): string {
  const scope = rule.kind ? `${rule.kind}${rule.name ? ` · ${rule.name}` : ''}` : rule.name ? rule.name : 'every call';
  return `${scope}  ${rule.path ?? 'any string'}  ${rule.pattern ?? 'whole value'} → ${rule.replace}`;
}

const sameRule = (a: unknown, b: Normalizer): boolean => isObject(a) && FIELDS.every((k) => (a[k] ?? undefined) === b[k]);

/**
 * The position (from 0) of the rule `which` names: its number as `ls` shows it (`2` or `#2`), or a
 * text that is the name, path or pattern of exactly one rule (`email`, `$.metadata.user_id`).
 */
export function findRule(list: RuleList, rules: readonly unknown[], which: string | number): number {
  const text = String(which).trim();
  if (/^#?\d+$/.test(text)) {
    const n = Number(text.replace(/^#/, ''));
    if (n >= 1 && n <= rules.length) return n - 1;
    throw new RuleError(rules.length ? `there is no ${ruleNoun(list)} #${n}: ${CONFIG_FILE} has ${rules.length} (shadowlap ${list} ls)` : `${CONFIG_FILE} has no ${ruleNoun(list, true)}`);
  }
  const hits: number[] = [];
  rules.forEach((r, i) => {
    if (isObject(r) && (r.name === text || r.path === text || r.pattern === text)) hits.push(i);
  });
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw new RuleError(`no ${ruleNoun(list)} has the name, path or pattern "${text}" (shadowlap ${list} ls numbers them)`);
  throw new RuleError(`"${text}" matches ${ruleNoun(list, true)} ${hits.map((i) => `#${i + 1}`).join(', ')}; remove one by its number`);
}

// ---- edits ----

export interface EditOptions {
  /**
   * The version the editor read. When the file is no longer that version the edit is refused with
   * ConfigConflictError, so a page showing an old list can't remove the wrong rule. Omit it to
   * edit the file as it is when the edit runs, as the CLI does.
   */
  expect?: string;
}

/** An activity event an edit leaves, for recordEvent(store, { ...event, actor }). */
export interface ConfigEvent {
  kind: 'normalizer.added' | 'normalizer.removed' | 'redaction.added' | 'redaction.removed' | 'clock.set';
  ref: string;
  data: Record<string, unknown>;
}

const EVENT_KINDS = {
  normalize: { added: 'normalizer.added', removed: 'normalizer.removed' },
  redact: { added: 'redaction.added', removed: 'redaction.removed' },
} as const;

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The file edits write to: the config itself, or what a symbolic link to it points at. */
function writeTarget(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/** Runs `fn` holding `<file>.lock`, which every Shadowlap writer takes; a lock left by a crash expires. */
function withLock<T>(target: string, fn: () => T): T {
  const lock = `${target}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // released between the two calls
      }
      if (Date.now() > deadline) throw new ConfigConflictError(`${CONFIG_FILE} is being edited by another command; try again`);
      pause(10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

function serialize(data: Record<string, unknown>, format: ConfigFile['format']): string {
  // JSON.stringify escapes newlines inside strings, so every newline here is the layout's own.
  return JSON.stringify(data, null, format.indent).replace(/\n/g, format.eol) + format.eol;
}

/** Writes `text` beside `target` and renames it over, keeping the file's permissions. */
function replaceFile(target: string, text: string, existed: boolean): void {
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const mode = existed ? statSync(target).mode & 0o777 : 0o644;
  const fd = openSync(tmp, 'wx', mode);
  try {
    if (existed) fchmodSync(fd, mode);
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Edits the project's config in one atomic step: `mutate` gets a copy of the file's object as it is
 * now (under the lock), changes it, and returns what it reports back. Returning without changing
 * anything writes nothing. Every key `mutate` leaves alone keeps its place and its value.
 */
export function editConfigFile<T>(cwd: string, options: EditOptions, mutate: (data: Record<string, unknown>, file: ConfigFile) => T): { file: ConfigFile; result: T; changed: boolean } {
  const path = configFilePath(cwd);
  const target = writeTarget(path);
  return withLock(target, () => {
    const current = readConfigFile(cwd);
    if (options.expect !== undefined && options.expect !== current.version) {
      throw new ConfigConflictError(`${CONFIG_FILE} changed since it was read; reload it and try again`);
    }
    const data = structuredClone(current.data);
    const result = mutate(data, current);
    const text = serialize(data, current.format);
    if (current.exists && text === serialize(current.data, current.format)) return { file: current, result, changed: false };
    replaceFile(target, text, current.exists);
    return { file: parseConfig(path, Buffer.from(text, 'utf8')), result, changed: true };
  });
}

function rulesIn(data: Record<string, unknown>, list: RuleList): unknown[] {
  const raw = data[list];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RuleError(`${CONFIG_FILE}: ${list} must be a list of rules; fix it before adding or removing one`);
  return raw;
}

export interface RuleAdded {
  /** The rule as stored. */
  rule: Normalizer;
  /** Its number in the list, from 1. */
  n: number;
  /** False when the same rule was already there, which leaves the file as it was. */
  added: boolean;
}

/**
 * Adds rules to the end of a list, each checked by validateRule; a rule already in the list is
 * left where it is. One write for all of them. Returns the file after the edit, each rule's number,
 * and one event per rule actually added.
 */
export function addRules(cwd: string, list: RuleList, inputs: readonly unknown[], options: EditOptions = {}): { file: ConfigFile; rules: RuleAdded[]; events: ConfigEvent[] } {
  const checked = inputs.map((input) => validateRule(list, input));
  const { file, result } = editConfigFile(cwd, options, (data) => {
    const rules = [...rulesIn(data, list)];
    const out: RuleAdded[] = [];
    for (const rule of checked) {
      const at = rules.findIndex((r) => sameRule(r, rule));
      if (at >= 0) {
        out.push({ rule, n: at + 1, added: false });
        continue;
      }
      rules.push(rule);
      out.push({ rule, n: rules.length, added: true });
    }
    if (out.some((r) => r.added)) data[list] = rules;
    return out;
  });
  const events = result.filter((r) => r.added).map((r): ConfigEvent => ({ kind: EVENT_KINDS[list].added, ref: CONFIG_FILE, data: { rule: r.rule, n: r.n } }));
  return { file, rules: result, events };
}

/** Adds one rule; see addRules. */
export function addRule(cwd: string, list: RuleList, input: unknown, options: EditOptions = {}): { file: ConfigFile; event: ConfigEvent | null } & RuleAdded {
  const { file, rules, events } = addRules(cwd, list, [input], options);
  return { file, ...rules[0]!, event: events[0] ?? null };
}

/** Removes the rule `which` names (see findRule). Returns it, the number it had, and the event. */
export function removeRule(cwd: string, list: RuleList, which: string | number, options: EditOptions = {}): { file: ConfigFile; rule: unknown; n: number; event: ConfigEvent } {
  const { file, result } = editConfigFile(cwd, options, (data) => {
    const rules = [...rulesIn(data, list)];
    const at = findRule(list, rules, which);
    const [rule] = rules.splice(at, 1);
    data[list] = rules;
    return { rule, n: at + 1 };
  });
  return { file, rule: result.rule, n: result.n, event: { kind: EVENT_KINDS[list].removed, ref: CONFIG_FILE, data: { rule: result.rule, n: result.n } } };
}

/** The clock the file sets: `auto` unless it says `exact`. `explicit` tells whether it says either. */
export function configClock(file: ConfigFile): { mode: ClockMode; explicit: boolean } {
  const raw = file.data.clock;
  return { mode: raw === 'exact' ? 'exact' : 'auto', explicit: raw === 'auto' || raw === 'exact' };
}

/** Sets `"clock"`: `auto` matches dates near each run's start across days, `exact` requires equality. */
export function setClock(cwd: string, mode: unknown, options: EditOptions = {}): { file: ConfigFile; clock: ClockMode; changed: boolean; event: ConfigEvent | null } {
  if (mode !== 'auto' && mode !== 'exact') throw new RuleError('clock must be "auto" or "exact"');
  let was: unknown;
  const { file, changed } = editConfigFile(cwd, options, (data) => {
    was = data.clock;
    data.clock = mode;
  });
  return { file, clock: mode, changed, event: changed ? { kind: 'clock.set', ref: CONFIG_FILE, data: { clock: mode, was: was === 'exact' || was === 'auto' ? was : null } } : null };
}
