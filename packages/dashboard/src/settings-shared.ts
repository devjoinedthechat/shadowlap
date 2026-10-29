import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, DEFAULT_REPLACE, NO_COMMAND, RULE_KINDS, isObject, messageOf, namedPatterns, readConfigFile, readRules, type CallKind, type ConfigFile, type Normalizer, type RuleList, type RunRecord, type Store, type StoreOf } from '@shadowlap/engine';

/** What Settings' tabs share: what each is given, the config file as a tab reads it, a rule as a row, and a run as the pickers name it. */

export interface SettingsContext {
  store: Store;
  /** The project folder: where shadowlap.config.json and the coding agents' files are. */
  cwd: string;
  /** The store's file, for the Project tab; null for a store in memory. */
  dbPath?: string | null;
  /** Where the dashboard listens, such as 127.0.0.1:4777. */
  address?: string | null;
  /** The run the project's setup recorded, from the projects registry; calibrate takes it first. */
  setupRunId?: string | null;
  /** The project's name; the folder's name when not given. */
  name?: string | null;
}

/** The config file as the page shows it, and the version an edit must send back. */
export interface ConfigInfo {
  file: string;
  path: string;
  exists: boolean;
  version: string | null;
  /** Why the file can't be read; edits are refused until it is fixed. */
  error: string | null;
}

/** One rule in a Matching or Redaction table. */
export interface RuleRow {
  /** Its number, from 1: what `shadowlap normalize rm` and `redact rm` take. */
  n: number;
  /** The rule as stored; null when the entry is broken (see `error`). */
  rule: Normalizer | null;
  /** `every call`, `api`, `tool · send_email`. */
  scope: string;
  /** Null shows as "any string": the pattern applies to every string. */
  path: string | null;
  /** Null shows as "whole value": the value at the path is replaced. */
  pattern: string | null;
  patternType: 'named' | 'regex' | 'whole';
  replace: string | null;
  /** Why the entry can't be used, in the words loading the config would fail with. */
  error: string | null;
  /**
   * The command that removes it, as argv for a job: ['normalize', 'rm', '2', '--expect', <version>].
   * It names the file's version this row was read from, so a page showing an old list can't remove
   * the wrong rule. A server can call removeRule(cwd, list, n, { expect }) instead.
   */
  remove: string[];
}

/** What the Add dialog offers: the same choices the CLI's `add` takes. */
export interface RuleForm {
  kinds: readonly CallKind[];
  patterns: string[];
  defaultReplace: string;
}

/** The config, and for a tab that edits one list of rules, whether that list can be edited. */
export function loadConfigFile(cwd: string, list?: RuleList): { info: ConfigInfo; file: ConfigFile | null } {
  const path = join(cwd, CONFIG_FILE);
  try {
    const file = readConfigFile(cwd);
    const raw = list ? file.data[list] : undefined;
    const error = raw !== undefined && raw !== null && !Array.isArray(raw) ? `${CONFIG_FILE}: ${list!} must be a list of rules` : null;
    return { info: { file: CONFIG_FILE, path: file.path, exists: file.exists, version: file.version, error }, file };
  } catch (err) {
    return { info: { file: CONFIG_FILE, path, exists: existsSync(path), version: null, error: messageOf(err) }, file: null };
  }
}

/** Why shadowlap.config.json in `cwd` can't be read, in the words Settings' tabs say it (`ConfigInfo.error`); null when it reads. */
export function configFileError(cwd: string): string | null {
  return loadConfigFile(cwd).info.error;
}

export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function ruleRows(file: ConfigFile | null, list: RuleList): RuleRow[] {
  if (!file) return [];
  return readRules(file, list).map((entry, i): RuleRow => {
    const raw = isObject(entry.rule) ? entry.rule : {};
    const kind = str(raw.kind);
    const name = str(raw.name);
    const pattern = str(raw.pattern);
    return {
      n: i + 1,
      rule: entry.error === null ? entry.rule : null,
      scope: kind ? `${kind}${name ? ` · ${name}` : ''}` : name ?? 'every call',
      path: str(raw.path),
      pattern,
      patternType: pattern === null ? 'whole' : pattern.startsWith('/') ? 'regex' : 'named',
      replace: str(raw.replace),
      error: entry.error,
      remove: [list, 'rm', String(i + 1), '--expect', file.version],
    };
  });
}

export const form = (list: RuleList): RuleForm => ({ kinds: RULE_KINDS[list], patterns: namedPatterns(), defaultReplace: DEFAULT_REPLACE[list] });

export const shortRun = (runId: string) => runId.slice(0, 10);

function commandOf(run: RunRecord): string {
  const argv = run.command.argv;
  if (argv.length === 1 && argv[0] === NO_COMMAND) return run.meta?.imported?.from ?? 'a capture';
  return argv.join(' ');
}

/** How long a run's label in a picker gets: its id and enough of its command to tell it apart. */
const LABEL_COMMAND = 60;

/**
 * A command line short enough for a picker: an absolute path keeps its last two parts
 * (`node …/dist/main.js`), and the whole is cut at LABEL_COMMAND characters.
 */
export function shortCommand(command: string): string {
  const short = command
    .split(' ')
    .map((a) => {
      const parts = a.split(/[\\/]/).filter(Boolean);
      return /^(\/|~\/|[A-Za-z]:\\)/.test(a) && parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : a;
    })
    .join(' ');
  return short.length > LABEL_COMMAND ? `${short.slice(0, LABEL_COMMAND - 1)}…` : short;
}

/** A run as a picker lists it: `01K5CQ4N7G · python refund_agent.py`. */
export const runLabel = (run: RunRecord) => `${shortRun(run.runId)} · ${shortCommand(commandOf(run))}`;

/** Enough to find a mention in any real instructions file without reading something huge. */
export const READ_LIMIT = 1024 * 1024;

/**
 * Why Settings can't do what was asked, with the HTTP status the route answers with: 404 for a run
 * that isn't there, 409 for one still recording, 422 for rules that can't be read.
 */
export class SettingsRefusal extends Error {
  override readonly name = 'SettingsRefusal';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RUN_REF = /^[0-9A-Za-z]{1,26}$/;

/** The run an id or a unique prefix names, or a refusal that says why there is none. */
export function findRun(store: StoreOf<'recording'>, ref: string): RunRecord {
  if (!RUN_REF.test(ref)) throw new SettingsRefusal(400, 'name a run by its id or a unique prefix of it');
  let run: RunRecord | null;
  try {
    run = store.findRun(ref);
  } catch (err) {
    throw new SettingsRefusal(400, messageOf(err));
  }
  if (!run) throw new SettingsRefusal(404, `no run matches ${ref}`);
  return run;
}
