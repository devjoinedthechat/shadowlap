import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  CONFIG_FILE,
  RuleError,
  TEST_SETTINGS,
  agentOfArgv,
  agentOfRun,
  checkLabels,
  editConfigFile,
  editRelaysConfig,
  hasRecordedCommand,
  isObject,
  messageOf,
  packHeadRun,
  parseExpect,
  parseTests,
  readConfigFile,
  readRules,
  testsEntryFor,
  type ConfigEvent,
  type ConfigFile,
  type StoreOf,
} from '@shadowlap/engine';
import { modeOf, type GoldenSource } from './tests.js';

/**
 * The check builder's side of shadowlap.config.json (routes/checks.ts): the goldens of an agent with
 * their tests entries as written, read with what an edit of the file would change about it, and one
 * golden's entry written back, keeping every other key and its place.
 *
 * A write names the version of the file it was read from, as Settings' edits do, so a page showing
 * an old entry can't overwrite a newer one: a file changed on disk since is refused. Beside the
 * version, the read gives a short print of each top-level key and each entry under `tests`, which
 * the write sends back, so the refusal names what changed (`"prices" added`). The entry is checked
 * as `shadowlap test` checks the file, the whole of `tests` with it, and refused in its words.
 */

/** The keys of a golden's entry a write sets: its checks. Every other key keeps its value and its place. */
export const ENTRY_KEYS = ['expect'] as const;

/** A short print of each top-level key's value and each entry's under `tests`, as a read saw them: a write sends them back. */
export interface ConfigPrints {
  keys: Record<string, string>;
  tests: Record<string, string>;
}

/** A golden of the agent, with its entry under `tests` as written. */
export interface GoldenEntry {
  /** The pack folder relative to the project: `goldens/refund-flow`. */
  path: string;
  /** The key under `tests` that holds its checks, as spelled; null when none does. */
  key: string | null;
  /** That key is a pattern (`goldens/refund-*`), which other goldens may follow too. */
  pattern: boolean;
  /** How `shadowlap test` runs it: `replay`, `fork`, `fork ×3`, `fork · gate`, with why. */
  mode: { label: string; hint: string };
  /** The recording it replays, or null when its pack can't be read. */
  runId: string | null;
  /** Whether the store holds that recording; else only its pack does. */
  inStore: boolean;
  /** Its entry as the file holds it (a pattern's, for a pattern key); null without one. */
  entry: unknown;
  /** Why its pack can't be read, when it can't. */
  error: string | null;
}

/** What the builder reads of the config: `GET /api/checks/goldens`. */
export interface ChecksConfig {
  /** The version of the file a write names: `absent`, or its SHA-256. */
  version: string;
  exists: boolean;
  /** The indent the file is laid out with, which a write keeps. */
  indent: string;
  /** The keys under `tests` in the file's order, goldens and the session's own settings alike. */
  order: string[];
  read: ConfigPrints;
  /** A write would lay out anew lines outside the golden's entry, as the file is laid out otherwise than a write writes it. */
  relaid: boolean;
  /** The agent the check is for, by the words of its command (`node agent.mjs`); null for a run with no command. */
  agent: string | null;
  goldens: GoldenEntry[];
  /** The project's redaction rules, which a judge's material has applied. */
  redactions: number;
  /** The models the project's judges use, first seen first. */
  judges: string[];
}

const print = (v: unknown): string =>
  createHash('sha1')
    .update(JSON.stringify(v) ?? 'undefined')
    .digest('base64url')
    .slice(0, 12);

/** Each top-level key's print and each entry's under `tests`. A `tests` that is no object prints as a key. */
export function configPrints(data: Record<string, unknown>): ConfigPrints {
  const keys = Object.fromEntries(Object.entries(data).filter(([k, v]) => k !== 'tests' || !isObject(v)).map(([k, v]) => [k, print(v)]));
  const tests = isObject(data.tests) ? Object.fromEntries(Object.entries(data.tests).map(([k, v]) => [k, print(v)])) : {};
  return { keys, tests };
}

/** What changed between two reads, by name: `"prices" added`, `tests["goldens/refund"] changed`, in the newer read's order. */
export function changedSince(was: ConfigPrints, now: ConfigPrints): string[] {
  const diff = (a: Record<string, string>, b: Record<string, string>, name: (k: string) => string) => [
    ...Object.keys(b).flatMap((k) => (!(k in a) ? [`${name(k)} added`] : a[k] !== b[k] ? [`${name(k)} changed`] : [])),
    ...Object.keys(a)
      .filter((k) => !(k in b))
      .map((k) => `${name(k)} removed`),
  ];
  return [...diff(was.keys, now.keys, (k) => JSON.stringify(k)), ...diff(was.tests, now.tests, (k) => `tests[${JSON.stringify(k)}]`)];
}

/** Prints as a request sends them back, checked for their shape; null for anything else, whose refusal then names nothing. */
export function printsOf(raw: unknown): ConfigPrints | null {
  const strings = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === 'string');
  return isObject(raw) && strings(raw.keys) && strings(raw.tests) ? { keys: raw.keys, tests: raw.tests } : null;
}

/** The refusal of a write to a file that changed since the page read it, naming what changed when the page sent what it read. */
export function changedWords(read: ConfigPrints | null, file: ConfigFile): string {
  const names = read ? changedSince(read, configPrints(file.data)) : [];
  return `${CONFIG_FILE} changed on disk since this page read it${names.length ? `: ${names.join(', ')}` : ''}. It shows your change against the file as it is now; nothing was changed.`;
}

/** The keys under `tests` that name recordings: every key but the session's own settings. */
const entryKeys = (tests: unknown): string[] => (isObject(tests) ? Object.keys(tests).filter((k) => !(TEST_SETTINGS as readonly string[]).includes(k)) : []);

/** The key under `tests` that holds a golden's checks, as `shadowlap test` finds it: an exact key, else a pattern. */
function keyFor(tests: unknown, golden: string, dir: string): string | null {
  return testsEntryFor(entryKeys(tests).map((recording) => ({ recording })), resolve(dir, golden), dir)?.recording ?? null;
}

/**
 * The agent a golden's recording ran: its run's in the store, else its pack's command, read from its
 * run.json without bringing the pack in. Null for a capture's, or a pack that can't be read.
 */
export function goldenAgent(store: StoreOf<'recording'>, g: Pick<GoldenSource, 'path' | 'runId'>, dir: string): string | null {
  const run = g.runId ? store.getRun(g.runId) : null;
  if (run) return agentOfRun(store, run);
  const head = packHeadRun(resolve(dir, g.path));
  return head && hasRecordedCommand({ command: { argv: head.argv } }) ? agentOfArgv(head.argv) : null;
}

/** The goldens of `agent`: those whose recording it ran. A run with no agent has none; a golden asked by its path has itself at least. */
export function agentGoldens(store: StoreOf<'recording'>, goldens: readonly GoldenSource[], dir: string, agent: string | null, golden: string | null = null): GoldenSource[] {
  return goldens.filter((g) => g.path === golden || (agent !== null && goldenAgent(store, g, dir) === agent));
}

/** The builder's read of the config, for `agent`'s goldens. Throws ConfigFileError for a file that isn't a JSON object. */
export function checksConfig(store: StoreOf<'recording'>, dir: string, goldens: readonly GoldenSource[], agent: string | null): ChecksConfig {
  const file = readConfigFile(dir);
  const tests = file.data.tests;
  const redactions = readRules(file, 'redact').filter((r) => r.error === null).length;
  return {
    version: file.version,
    exists: file.exists,
    indent: file.format.indent,
    order: isObject(tests) ? Object.keys(tests) : [],
    read: configPrints(file.data),
    relaid: editRelaysConfig(dir),
    agent,
    goldens: goldens.map((g) => {
      const key = keyFor(tests, g.path, dir);
      const entry = key !== null && isObject(tests) ? tests[key] : undefined;
      return {
        path: g.path,
        key,
        pattern: key?.includes('*') ?? false,
        mode: modeOf(g),
        runId: g.runId,
        inStore: g.runId !== null && store.getRun(g.runId) !== null,
        entry: entry ?? null,
        error: g.error ?? null,
      };
    }),
    redactions,
    judges: [...new Set(goldens.flatMap((g) => g.judges ?? []))],
  };
}

/** A golden's entry as a write sets it: the keys it names, `null` taking one out. */
export type EntryEdit = Partial<Record<(typeof ENTRY_KEYS)[number], unknown>>;

/** What a write of a golden's entry did: the key it wrote, the file's version after, the checks' labels it added and removed. */
export interface TestsWritten {
  key: string;
  version: string;
  added: string[];
  removed: string[];
  changed: boolean;
  event: ConfigEvent | null;
}

/** The labels of an entry's checks, or none for an entry that has no checks or none that can be read. */
function labelsOf(entry: unknown): string[] {
  if (!isObject(entry) || entry.expect === undefined) return [];
  try {
    return checkLabels(parseExpect(entry.expect, 'expect'));
  } catch {
    return [];
  }
}

/** What `a` holds that `b` doesn't, a label held twice counted twice. */
function without(a: readonly string[], b: readonly string[]): string[] {
  const left = [...b];
  return a.filter((x) => {
    const at = left.indexOf(x);
    if (at < 0) return true;
    left.splice(at, 1);
    return false;
  });
}

/**
 * Writes `edit` into `golden`'s entry under `tests`: the exact key that holds it, as spelled. With no
 * entry, it adds `tests["<golden>"]`; with a pattern's, an exact entry for the golden with the
 * pattern's other keys, since an exact key wins and the pattern stays for its other goldens. The
 * whole of `tests` is checked as `shadowlap test` checks it, and refused with its words (RuleError);
 * `expect` is the version the page read (ConfigConflictError when the file is no longer that).
 */
export function writeTestsEntry(dir: string, golden: string, edit: EntryEdit, o: { expect: string; wait?: number }): TestsWritten {
  const { file, result, changed } = editConfigFile(dir, o, (data) => {
    if (data.tests === undefined) data.tests = {};
    const tests = data.tests;
    if (!isObject(tests)) {
      checkTests(tests);
      throw new RuleError(`${CONFIG_FILE}: "tests" must be an object`);
    }
    const found = keyFor(tests, golden, dir);
    const key = found !== null && !found.includes('*') ? found : golden;
    const was: unknown = found !== null ? tests[found] : undefined;
    const next: Record<string, unknown> = isObject(was) ? structuredClone(was) : {};
    for (const k of ENTRY_KEYS) {
      if (!(k in edit)) continue;
      if (edit[k] === null) delete next[k];
      else next[k] = edit[k];
    }
    tests[key] = next;
    checkTests(tests);
    return { key, added: without(labelsOf(next), labelsOf(was)), removed: without(labelsOf(was), labelsOf(next)) };
  });
  const event: ConfigEvent | null = changed ? { kind: 'checks.changed', ref: golden, data: { key: result.key, added: result.added, removed: result.removed } } : null;
  return { ...result, version: file.version, changed, event };
}

/** `tests` checked as `shadowlap test` checks it, refused with its words. */
function checkTests(tests: unknown): void {
  try {
    parseTests(tests);
  } catch (err) {
    throw new RuleError(messageOf(err));
  }
}
