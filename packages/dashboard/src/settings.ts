import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FILE,
  DEFAULT_REPLACE,
  NO_COMMAND,
  REDACTION_EXPORTS,
  RULE_KINDS,
  calibrationTarget,
  commandIsImported,
  configClock,
  hasRecordedCommand,
  namedPatterns,
  parseRules,
  readConfigFile,
  readRules,
  tildePath,
  type CallKind,
  type ClockMode,
  type ConfigFile,
  type Effect,
  type Normalizer,
  type RedactionExport,
  type RedactionPreview,
  type RuleList,
  type RunRecord,
  type Store,
} from '@shadowlap/engine';
import { ciStep, parseStoreUrl, type StoreLocation } from '@shadowlap/remote';
import { PREVIEW_LIMITS, PreviewError, previewApart, previewHere, type PreviewLimitsConfig } from './redaction-preview.js';
import { countRuns } from './runs-list.js';
import { teamStoreStatus, type TeamStoreInput, type TeamStoreStatus } from './team-store.js';

/**
 * The read model behind Settings: one plain function per tab (Matching, Redaction, Coding agents,
 * Tools, Project), store and project folder in, JSON out, no HTTP. Edits go through the engine's
 * config-file module (addRule, removeRule, setClock), which takes the `version` returned here so a
 * page showing an old list can't remove the wrong rule; jobs run the CLI for calibrate and gc.
 *
 * Settings is the one page a project with no runs can open, so nothing here needs a run, and a
 * config file that can't be read is reported on the page rather than failing it.
 */

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

export interface MatchingSettings {
  config: ConfigInfo;
  rules: RuleRow[];
  form: RuleForm;
  /** `explicit`: the file says auto or exact; `error`: it says something else, which loading the config refuses. */
  clock: { mode: ClockMode; explicit: boolean; error: string | null };
  /**
   * The button: "Calibrate <run>" with the job's argv, or "Record a run first" with none. The job
   * streams each round and ends with a result event (the object `calibrate --json` prints). When it
   * proposed normalizers, "Add it (--write)" adds exactly those, the ones the person just read,
   * without replaying again: addRules(cwd, 'normalize', proposedRules(result), { expect:
   * config.version }), which checks each as `normalize add` does; record each returned event with
   * the run id and `via: 'calibrate'`.
   */
  calibrate: { runId: string | null; source: 'setup' | 'newest' | null; label: string; command: string | null; argv: string[] | null };
}

export interface RedactionSettings {
  config: ConfigInfo;
  rules: RuleRow[];
  form: RuleForm;
  /** Every way a run's content leaves the machine, which rules each applies and what it does with the run's details (decision 6). */
  where: readonly RedactionExport[];
  /**
   * Runs a preview can be made for: every run but those still recording, newest first. The preview
   * itself is read apart (`GET /api/settings/redaction/preview`, redactionPreview), on a thread of its
   * own, so reading a long run never holds up the server.
   */
  runs: Array<{ runId: string; label: string }>;
  /** The run the tab previews first: the newest that has ended, or the one asked for. */
  previewRunId: string | null;
  /** Why there is no preview to run: no run yet, the run asked for is unknown or still recording, or rules that can't be read. */
  previewError: string | null;
}

export interface AgentFile {
  /** As the project has it, relative to its folder. */
  path: string;
  /** Who reads it. */
  agents: string;
  found: boolean;
  /** `.cursor/rules` can be a folder of rule files or one file. Null when not found. */
  type: 'file' | 'folder' | null;
  /** It, or a file in the folder, already mentions Shadowlap. */
  mentions: boolean;
}

export interface CodingAgentsSettings {
  files: AgentFile[];
  /** The section to paste, from docs/agents.md; null when the docs aren't installed with the dashboard. */
  section: string | null;
  source: string;
}

export interface ToolRow {
  name: string;
  /** The effect of its latest call; null when the tool declares none (it then runs live after a fork). */
  effect: Effect | null;
  /** Calls in every run of the store, the runs they are in, and the latest. */
  calls: number;
  runs: number;
  lastAt: number;
  /** It was recorded with another effect before: the declaration changed. */
  changed: boolean;
  /** Its effect comes from `mcp.effects` in the config. */
  mcp: boolean;
}

export interface HttpHostRow {
  /** A host under `http` in the config, or one the recordings called that the config no longer has. */
  host: string;
  effect: Effect | null;
  /** In the config now. */
  declared: boolean;
  /** Recorded calls to it, as tool calls named `METHOD host/path`. */
  calls: number;
  lastAt: number | null;
  error: string | null;
}

export interface McpServerRow {
  name: string;
  /** The project file that lists it. */
  file: string;
  transport: 'stdio' | 'http';
  /** The command line or URL, with anything that looks like a credential hidden. */
  target: string;
  /** Its entry already starts `shadowlap mcp`. */
  viaShadowlap: boolean;
  /**
   * The `shadowlap mcp` line in front of it: as the entry has it, or as it would be. A remote
   * server's headers become `--header "Name: ${VAR}"`, which `shadowlap mcp` fills in from its
   * environment, with VAR in `env`.
   */
  line: string;
  /** What the client's entry takes instead of its command and args. */
  entry: { command: string; args: string[] };
  /** Something that looked like a credential is shown as ••• in `target`, `line` and `entry`. */
  hidden: boolean;
  /**
   * The entry's environment as the client config to copy writes it: a value that is only a
   * reference (`${GITHUB_TOKEN}`) as it is, any other as `…`, never its text; and for a remote
   * server, a variable for each header's value.
   */
  env: Array<{ name: string; value: string }>;
  /** What a copy of its entry leaves out, to put back before the client starts it: `GITHUB_TOKEN`, `the ••• in its command`. */
  putBack: string[];
  /** How `shadowlap mcp` names the server in what it records: its transport, and its host or its command (with the package a runner such as npx starts). */
  recordedAs: { transport: 'stdio' | 'http'; server: string };
  /** What the recordings hold from it (McpRecordedServer), or null when nothing was recorded through it. */
  recorded: McpRecordedServer | null;
}

/** An MCP server recorded tool calls came through, by the name `shadowlap mcp` gave it (call meta `mcp`). */
export interface McpRecordedServer {
  transport: 'stdio' | 'http';
  server: string;
  /**
   * The tools it offers and how many of those are writes, from the latest call that listed them
   * (`listed`); without such a call, the tools called through it.
   */
  tools: number;
  writes: number;
  listed: boolean;
  calls: number;
  lastAt: number;
  /** A server in one of the project's client configs has this name. */
  inConfig: boolean;
}

/** One client config to copy. */
export interface ClientConfigBlock {
  /** The project file it stands for, or null for the docs' example. */
  file: string | null;
  text: string;
  /** Per server, each value the copy leaves out, to put back before the client starts it. */
  putBack: Array<{ server: string; values: string[] }>;
}

export interface ToolsSettings {
  config: ConfigInfo;
  /** Runs live after a fork: read and pure tools, and tools that declare no effect. */
  live: ToolRow[];
  /** Blocked or stubbed after a fork: write tools. */
  fenced: ToolRow[];
  http: HttpHostRow[];
  mcp: {
    /** `mcp.effects` in the config: effects by tool name, over the servers' annotations. */
    effects: Array<{ tool: string; effect: Effect | null; seen: boolean; error: string | null }>;
    servers: McpServerRow[];
    /** Every server the recordings came through, those no project client config lists included (a config outside the project). */
    recorded: McpRecordedServer[];
    /** The client config files looked at, and why one couldn't be read. */
    files: Array<{ path: string; found: boolean; error: string | null }>;
    /**
     * The client configs to copy: one per project file that lists servers, each server with
     * `shadowlap mcp` in front, credentials and environment values left out and named in `putBack`;
     * without any, the example in docs/mcp.md (`file` null), which shows both forms.
     */
    clientConfigs: ClientConfigBlock[];
    /** The forms (`stdio`, a command; `http`, a URL) no server in the blocks uses: the page shows a line for each. Empty for the docs' example. */
    otherForms: Array<'stdio' | 'http'>;
  };
}

export interface ProjectSettings {
  name: string;
  folder: string;
  /** The folder and the store's file as people read them: `~/support-agent/.shadowlap/shadowlap.db` inside the home folder. */
  shown: { folder: string; store: string | null };
  /**
   * The store's file, and its size as the database counts it (its pages, whatever the write-ahead
   * log holds), so it doesn't jump while the log waits for a checkpoint. `free` is what a vacuum
   * gives back.
   */
  store: { path: string | null; bytes: number; free: number };
  /** Runs, not counting the attempts blame, verify and `replay --repeat` make. */
  runs: number;
  attempts: number;
  /** Runs a process is recording now (a recording, or a replay in progress). While one is, a clean-up deletes runs but leaves their blobs for a later one. */
  running: number;
  /** Runs left `running` by a process that stopped without ending them: a clean-up marks them interrupted. */
  abandoned: number;
  address: string | null;
  /**
   * Clean up old runs: the dry run first, whose result event (the GcReport `gc --json` prints)
   * counts the runs (`count`), lists the first 100 and what they free, while the drawer shows what gc
   * prints; then "Delete N runs" (N is `count`) runs cleanupArgv(result), which deletes exactly those
   * runs or, if others match by then, nothing.
   */
  cleanup: { olderThanDays: number; dryRun: string[] };
}

// ---- the config ----

/** The config, and for a tab that edits one list of rules, whether that list can be edited. */
function loadConfigFile(cwd: string, list?: RuleList): { info: ConfigInfo; file: ConfigFile | null } {
  const path = join(cwd, CONFIG_FILE);
  try {
    const file = readConfigFile(cwd);
    const raw = list ? file.data[list] : undefined;
    const error = raw !== undefined && raw !== null && !Array.isArray(raw) ? `${CONFIG_FILE}: ${list} must be a list of rules` : null;
    return { info: { file: CONFIG_FILE, path: file.path, exists: file.exists, version: file.version, error }, file };
  } catch (err) {
    return { info: { file: CONFIG_FILE, path, exists: existsSync(path), version: null, error: err instanceof Error ? err.message : String(err) }, file: null };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function ruleRows(file: ConfigFile | null, list: RuleList): RuleRow[] {
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

const form = (list: RuleList): RuleForm => ({ kinds: RULE_KINDS[list], patterns: namedPatterns(), defaultReplace: DEFAULT_REPLACE[list] });

const shortRun = (runId: string) => runId.slice(0, 10);

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
const runLabel = (run: RunRecord) => `${shortRun(run.runId)} · ${shortCommand(commandOf(run))}`;

// ---- Matching ----

export function matchingSettings(ctx: SettingsContext): MatchingSettings {
  const { info, file } = loadConfigFile(ctx.cwd, 'normalize');
  const written = file?.data.clock;
  const clock = file ? configClock(file) : { mode: 'auto' as const, explicit: false };
  const target = calibrationTarget(ctx.store, { setupRunId: ctx.setupRunId ?? null });
  return {
    config: info,
    rules: ruleRows(file, 'normalize'),
    form: form('normalize'),
    clock: { ...clock, error: written === undefined || clock.explicit ? null : `${CONFIG_FILE}: clock must be "auto" or "exact"` },
    calibrate: target
      ? { runId: target.run.runId, source: target.source, label: `Calibrate ${shortRun(target.run.runId)}`, command: `shadowlap calibrate ${shortRun(target.run.runId)}`, argv: ['calibrate', target.run.runId] }
      : { runId: null, source: null, label: 'Record a run first', command: null, argv: null },
  };
}

/**
 * The rules a calibrate result proposed (its `normalizers`), as `addRules` takes them: each one's
 * kind, name, path, pattern and replace, without what else the result says about it (why it was
 * proposed). Anything that is not a rule is left out; addRules checks the rest.
 */
export function proposedRules(result: unknown): Array<Partial<Record<'kind' | 'name' | 'path' | 'pattern' | 'replace', unknown>>> {
  const list = isObject(result) && Array.isArray(result.normalizers) ? result.normalizers : [];
  return list.filter(isObject).map((n) => Object.fromEntries((['kind', 'name', 'path', 'pattern', 'replace'] as const).filter((k) => n[k] !== undefined).map((k) => [k, n[k]])));
}

// ---- Redaction ----

/** How many runs the preview's run picker lists. */
const PREVIEW_RUNS = 100;

/** A recording made here with `shadowlap run`: not a replay, an import, a pack or an attempt. What a copy most often carries. */
const madeHere = (r: RunRecord) => r.mode === 'record' && !r.meta?.imported && !(Array.isArray(r.meta?.covers) && r.meta.covers.length) && !r.meta?.repeat && !r.meta?.probe && !r.meta?.verify;

/**
 * The Redaction tab: the rules, where they apply, and the runs a preview can be made for. `runId`
 * picks the run to preview first; without one, the newest recording made here that has ended (what
 * a pack most often holds, rather than an import or a replay), else the newest run that has ended.
 * Nothing here reads a run's calls: the preview is read apart (redactionPreview).
 */
export function redactionSettings(ctx: SettingsContext, options: { runId?: string | null } = {}): RedactionSettings {
  const { info, file } = loadConfigFile(ctx.cwd, 'redact');
  const rows = ruleRows(file, 'redact');
  // Every run but those a process is still recording: one its process abandoned can be previewed.
  const recording = new Set(ctx.store.recordingRuns().live.map((r) => r.run.runId));
  const ended = ctx.store.listRuns(PREVIEW_RUNS * 2).filter((r) => !recording.has(r.runId));
  const listed = ended.slice(0, PREVIEW_RUNS);
  const runs = listed.map((r) => ({ runId: r.runId, label: runLabel(r) }));
  let previewRunId: string | null = (listed.find(madeHere) ?? listed[0])?.runId ?? null;
  let previewError: string | null = null;
  if (options.runId) {
    let run: RunRecord | null = null;
    try {
      run = ctx.store.findRun(options.runId);
    } catch (err) {
      previewError = err instanceof Error ? err.message : String(err);
    }
    if (!run) previewError ??= `no run matches ${options.runId}`;
    else if (recording.has(run.runId)) previewError = `${shortRun(run.runId)} is still recording; preview it once it has ended`;
    previewRunId = run && !previewError ? run.runId : null;
  }
  const broken = rows.find((r) => r.error);
  if (!previewError) {
    if (!previewRunId) previewError = 'Record a run first: the preview needs one to read.';
    else if (info.error) previewError = info.error;
    else if (broken) previewError = `redaction rule #${broken.n}: ${broken.error}`;
  }
  return { config: info, rules: rows, form: form('redact'), where: REDACTION_EXPORTS, runs, previewRunId, previewError };
}

// ---- Coding agents ----

/** The files coding agents read their project instructions from, and who reads each. */
const AGENT_FILES: Array<{ path: string; agents: string }> = [
  { path: 'CLAUDE.md', agents: 'Claude Code' },
  { path: 'AGENTS.md', agents: 'Codex, Cursor and others' },
  { path: '.cursor/rules', agents: 'Cursor' },
  { path: '.github/copilot-instructions.md', agents: 'GitHub Copilot' },
];

const MENTION = /shadowlap/i;
/** Enough to find a mention in any real instructions file without reading something huge. */
const READ_LIMIT = 1024 * 1024;
/** How much of a rules folder is looked through: real ones hold a handful of files. */
const FOLDER_FILES = 200;
const FOLDER_DIRS = 50;
const FOLDER_DEPTH = 4;
const FOLDER_MS = 250;

function mentionsIn(file: string): boolean {
  try {
    if (statSync(file).size > READ_LIMIT) return false;
    return MENTION.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** Whether any file in a rules folder mentions Shadowlap. Links inside it aren't followed, and the walk stops early on a folder far bigger than a rules folder. */
function folderMentions(dir: string): boolean {
  const stack: Array<[string, number]> = [[dir, 0]];
  const deadline = Date.now() + FOLDER_MS;
  let files = 0;
  let dirs = 0;
  while (stack.length && files < FOLDER_FILES && dirs < FOLDER_DIRS && Date.now() < deadline) {
    const [at, depth] = stack.pop()!;
    dirs++;
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(at, e.name);
      if (e.isDirectory()) {
        if (depth < FOLDER_DEPTH) stack.push([full, depth + 1]);
      } else if (e.isFile() && ++files <= FOLDER_FILES && mentionsIn(full)) return true;
    }
  }
  return false;
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * The Coding agents tab: which instruction files the project has and whether each mentions
 * Shadowlap yet, and the section to paste. Only a yes or no leaves each file, never its text. A
 * `.cursor/rules` folder that is a link to somewhere outside the project is not looked through.
 */
export function codingAgentsSettings(ctx: Pick<SettingsContext, 'cwd'>, options: { agentsDoc?: string | null } = {}): CodingAgentsSettings {
  const files = AGENT_FILES.map(({ path, agents }): AgentFile => {
    const full = join(ctx.cwd, path);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      return { path, agents, found: false, type: null, mentions: false };
    }
    if (st.isDirectory()) {
      let walk = true;
      try {
        walk = !lstatSync(full).isSymbolicLink() || inside(realpathSync(full), realpathSync(ctx.cwd));
      } catch {
        walk = false;
      }
      return { path, agents, found: true, type: 'folder', mentions: walk && folderMentions(full) };
    }
    return { path, agents, found: st.isFile(), type: st.isFile() ? 'file' : null, mentions: st.isFile() && mentionsIn(full) };
  });
  const doc = options.agentsDoc !== undefined ? options.agentsDoc : readShippedDoc('agents.md');
  return { files, section: doc === null ? null : agentsSection(doc), source: 'docs/agents.md' };
}

/** The fenced block under "Instructions to give it" in docs/agents.md: what to paste into CLAUDE.md. */
export function agentsSection(doc: string): string | null {
  const from = doc.indexOf('## Instructions to give it');
  return fencedBlock(from >= 0 ? doc.slice(from) : doc, 'md');
}

/** The fenced code blocks in `text` marked `lang`, in order, without their fences. */
function fencedBlocks(text: string, lang: string): string[] {
  const re = new RegExp('^```' + lang + '[ \\t]*\\r?\\n([\\s\\S]*?)^```[ \\t]*$', 'gm');
  return [...text.matchAll(re)].map((m) => m[1]!.replace(/\r?\n$/, ''));
}

function fencedBlock(text: string, lang: string): string | null {
  return fencedBlocks(text, lang)[0] ?? null;
}

/** The client configuration example in docs/mcp.md: its first JSON block that lists servers. */
export function mcpClientConfig(doc: string): string | null {
  return fencedBlocks(doc, 'json').find((block) => block.includes('"mcpServers"')) ?? null;
}

const MONOREPO = 'shadowlap-monorepo';

/**
 * A page of the docs, read when it is asked for so the page and the docs never disagree: from a copy
 * shipped in the dashboard's build (dist/docs/<name>), else from the repository it was built in.
 * Null when neither is there.
 */
export function readShippedDoc(name: string): string | null {
  const shipped = fileURLToPath(new URL(`./docs/${name}`, import.meta.url));
  if (existsSync(shipped)) return readFileSync(shipped, 'utf8');
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name === MONOREPO) return readFileSync(join(root, 'docs', name), 'utf8');
  } catch {
    // installed without the docs
  }
  return null;
}

// ---- Tools ----

/** `GET api.example.com/v1/items`: how a call to a host under `http` is recorded. */
const HTTP_CALL = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) ([a-z0-9.*-]+(?::\d{1,5})?)(\/\S*)?$/i;

/** A rule's host against a recorded one, as the sidecar matches them: `*.` is any subdomain, a port must agree. */
function hostMatches(rule: string, host: string): boolean {
  const [ruleName, rulePort] = rule.toLowerCase().split(':') as [string, string | undefined];
  const [hostName, hostPort] = host.toLowerCase().split(':') as [string, string | undefined];
  // A recorded name leaves out a default port.
  if (rulePort !== undefined && rulePort !== hostPort && !(hostPort === undefined && (rulePort === '443' || rulePort === '80'))) return false;
  return ruleName.startsWith('*.') ? hostName.endsWith(ruleName.slice(1)) : hostName === ruleName;
}

const EFFECTS: readonly Effect[] = ['pure', 'read', 'write'];
const effectOf = (v: unknown): Effect | null => (EFFECTS.includes(v as Effect) ? (v as Effect) : null);

/**
 * The Tools tab: every tool any run called, from one query across the store, by what happens to it
 * after a fork; the hosts under `http` and `mcp.effects` in the config; and the MCP servers the
 * project's client configs list, with the `shadowlap mcp` line that records each.
 */
export function toolsSettings(ctx: SettingsContext, options: { mcpDoc?: string | null } = {}): ToolsSettings {
  const { info, file } = loadConfigFile(ctx.cwd);
  const data = file?.data ?? {};
  const mcpEffects = isObject(data.mcp) && isObject(data.mcp.effects) ? data.mcp.effects : {};
  const httpRules = isObject(data.http) ? Object.entries(data.http) : [];

  // One row per tool: the effect of its latest call, and whether an earlier one differed.
  const { usage, mcp: mcpUsage } = toolReads(ctx.store);
  const tools = new Map<string, ToolRow>();
  const hostCalls = new Map<string, { calls: number; lastAt: number; effect: Effect | null }>();
  for (const u of usage) {
    const http = HTTP_CALL.exec(u.name);
    if (http) {
      const host = http[2]!.toLowerCase();
      const h = hostCalls.get(host) ?? { calls: 0, lastAt: 0, effect: u.effect };
      h.calls += u.calls;
      if (u.lastAt >= h.lastAt) {
        h.lastAt = u.lastAt;
        h.effect = u.effect;
      }
      hostCalls.set(host, h);
      continue;
    }
    const t = tools.get(u.name);
    if (!t) {
      tools.set(u.name, { name: u.name, effect: u.effect, calls: u.calls, runs: u.runs, lastAt: u.lastAt, changed: false, mcp: Object.hasOwn(mcpEffects, u.name) });
      continue;
    }
    t.changed ||= t.effect !== u.effect;
    if (u.lastAt >= t.lastAt) {
      t.effect = u.effect;
      t.lastAt = u.lastAt;
    }
    t.calls += u.calls;
    t.runs += u.runs;
  }
  const rows = [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));

  const http: HttpHostRow[] = httpRules.map(([host, effect]) => {
    const seen = [...hostCalls.entries()].filter(([h]) => hostMatches(host, h));
    for (const [h] of seen) hostCalls.delete(h);
    return {
      host,
      effect: effectOf(effect),
      declared: true,
      calls: seen.reduce((n, [, s]) => n + s.calls, 0),
      lastAt: seen.length ? Math.max(...seen.map(([, s]) => s.lastAt)) : null,
      error: effectOf(effect) ? null : `${host} must map to pure, read or write`,
    };
  });
  for (const [host, s] of hostCalls) http.push({ host, effect: s.effect, declared: false, calls: s.calls, lastAt: s.lastAt, error: null });

  const effects = Object.entries(mcpEffects).map(([tool, effect]) => ({ tool, effect: effectOf(effect), seen: tools.has(tool), error: effectOf(effect) ? null : `mcp.effects["${tool}"] must be pure, read or write` }));
  const found = mcpServers(ctx.cwd);
  const recorded = recordedMcpServers(mcpUsage);
  const recordedKey = (r: { transport: string; server: string }) => `${r.transport} ${r.server}`;
  const byName = new Map(recorded.map((r) => [recordedKey(r), r]));
  const servers = found.servers.map((row) => {
    const match = byName.get(recordedKey(row.recordedAs)) ?? null;
    if (match) match.inConfig = true;
    return { ...row, recorded: match };
  });
  const doc = options.mcpDoc !== undefined ? options.mcpDoc : readShippedDoc('mcp.md');
  return {
    config: info,
    live: rows.filter((t) => t.effect !== 'write'),
    fenced: rows.filter((t) => t.effect === 'write'),
    http,
    mcp: { effects, servers, recorded, files: found.files, ...clientConfigs(servers, doc === null ? null : mcpClientConfig(doc)) },
  };
}

/** What the Tools tab reads from the store: every tool across runs, and the MCP servers calls came through. */
interface ToolReads {
  key: string;
  usage: ReturnType<Store['toolUsage']>;
  mcp: ReturnType<Store['mcpServerUsage']>;
}

const toolReadCache = new WeakMap<Store, ToolReads>();

/**
 * The Tools tab's store reads, kept per store until its runs or calls change (`changeCounts`): each
 * scans every call in the store, on the server's thread, so a tab read again with nothing new (the
 * window back in focus, a second tab) costs nothing.
 */
export function toolReads(store: Store): ToolReads {
  const counts = store.changeCounts();
  const key = `${counts.runs ?? 0}:${counts.calls ?? 0}`;
  const kept = toolReadCache.get(store);
  if (kept && kept.key === key) return kept;
  const read: ToolReads = { key, usage: store.toolUsage(), mcp: store.mcpServerUsage() };
  toolReadCache.set(store, read);
  return read;
}

/** The MCP servers recorded calls came through, with their tools and writes (Store.mcpServerUsage). */
function recordedMcpServers(usage: ToolReads['mcp']): McpRecordedServer[] {
  return usage.flatMap((u): McpRecordedServer[] => {
    if (u.transport !== 'stdio' && u.transport !== 'http') return [];
    const called = new Map<string, boolean>();
    for (const c of u.called) called.set(c.name, (called.get(c.name) ?? false) || c.effect === 'write');
    const tools = u.tools ? u.tools.length : called.size;
    const writes = u.tools ? u.tools.filter((t) => t.effect === 'write').length : [...called.values()].filter(Boolean).length;
    return [{ transport: u.transport, server: u.server, tools, writes, listed: u.tools !== null, calls: u.calls, lastAt: u.lastAt, inConfig: false }];
  });
}

/** Package runners whose first argument names the server, when only flags without values come before it. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);
const RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet']);
const PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~-]+)?$/i;

/**
 * A local server's name as `shadowlap mcp` records it (call meta `mcp.server`): its command, and the
 * package a runner like npx starts; never its other arguments, which can hold secrets. Kept in step
 * with stdioServerName in the CLI's mcp.ts.
 */
export function stdioServerName(command: string, args: readonly string[]): string {
  const name = (command.split(/[\\/]/).pop() ?? command).replace(/\.(?:cmd|exe|bat)$/i, '');
  let out = name;
  if (RUNNERS.has(name)) {
    const first = args.find((a) => !RUNNER_FLAGS.has(a));
    if (first !== undefined && PACKAGE.test(first)) out = `${name} ${first}`;
  }
  return out.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
}

/** A remote server's name as `shadowlap mcp --url` records it: the URL's host (with a port it names). */
function httpServerName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// ---- MCP client configs ----

/** Where MCP clients keep a project's servers, and the key each uses for them. */
const MCP_FILES: Array<{ path: string; key: string }> = [
  { path: '.mcp.json', key: 'mcpServers' },
  { path: '.cursor/mcp.json', key: 'mcpServers' },
  { path: '.vscode/mcp.json', key: 'servers' },
];

/** Where the JSON string starting at `i` (a `"`) ends: the index just past its closing quote. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** JSON with comments and trailing commas, as VS Code writes its config files. Strings are left exactly as they are. */
export function parseJsonc(text: string): unknown {
  // Comments out, strings kept whole: a "//" inside a URL is not a comment.
  let plain = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '"') {
      const end = stringEnd(text, i);
      plain += text.slice(i, end);
      i = end;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      plain += ' ';
    } else {
      plain += c;
      i++;
    }
  }
  // A comma before a closing bracket goes, but only between tokens: "a, }" in a string stays.
  let out = '';
  for (let i = 0; i < plain.length; ) {
    const c = plain[i]!;
    if (c === '"') {
      const end = stringEnd(plain, i);
      out += plain.slice(i, end);
      i = end;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < plain.length && /\s/.test(plain[j]!)) j++;
      if (plain[j] === '}' || plain[j] === ']') {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

/** Names that say a value is a credential, anywhere in the name: `GITHUB_TOKEN`, `--client-secret`, `x-api-key`. */
const SECRET_WORDS = /(token|secret|passw(?:or)?d|credential|bearer|api[-_]?key|private[-_]?key|access[-_]?key|account[-_]?key|cookie|signature)/i;
/** ...or as one whole part of the name, where a substring would also catch `--path` or `--author`: `--pat`, `DB_PWD`, `--auth`, `--dsn`. */
const SECRET_PARTS = new Set(['key', 'pat', 'pwd', 'pass', 'auth', 'oauth', 'authorization', 'dsn', 'sig', 'sas', 'jwt']);
/** Tokens recognisable by their shape. */
const SECRET_VALUE = /^(sk-|sk_|rk_|pk_live|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|xox[abeprs]-|AKIA|ASIA|AIza|ya29\.|eyJ|hf_|npm_|pypi-|shpat_|SG\.|sq0atp-|dop_v1_|lin_api_)/;
/** A secret inside a connection string: `Server=db;Password=…;`, `AccountKey=…`. */
const CONNECTION_SECRET = /\b(password|pwd|passwd|secret|token|api[-_]?key|account[-_]?key|shared[-_]?access[-_]?key)=([^;&\s]+)/gi;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HIDDEN = '•••';

function secretName(name: string): boolean {
  const bare = name.replace(/^-+/, '');
  return SECRET_WORDS.test(bare) || bare.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).some((part) => SECRET_PARTS.has(part.toLowerCase()));
}

/**
 * A value that mixes letters and digits the way keys do: 8 characters or more, at least two of
 * each, and no path or spaces in it (`a1b2c3d4`, `xyzzy-plain-key-42`). A name with a version in it
 * (`server-v2`) has one digit; a port or a date has no letters.
 */
function mixedKey(text: string): boolean {
  return text.length >= 8 && /^[\w.~%+=-]+$/.test(text) && !/^[.~-]/.test(text) && (text.match(/\d/g)?.length ?? 0) >= 2 && (text.match(/[A-Za-z]/g)?.length ?? 0) >= 2;
}

/** A URL path segment that is a key rather than a name: a token's shape, letters and digits mixed as in a key, or a long run of them. */
function keyLike(segment: string): boolean {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // keep it as written
  }
  return SECRET_VALUE.test(text) || mixedKey(text) || (text.length >= 16 && /\d/.test(text) && /[A-Za-z]/.test(text) && /^[\w.~%+=-]+$/.test(text)) || (text.length >= 32 && /^[\w+/=-]+$/.test(text));
}

/** One argument, or a value inside one, with a credential in it hidden. */
function hideValue(text: string, depth = 0): string {
  const assigned = /^(-{0,2}[A-Za-z_][\w.-]*)=([\s\S]+)$/.exec(text);
  if (assigned && depth < 3) return secretName(assigned[1]!) ? `${assigned[1]}=${HIDDEN}` : `${assigned[1]}=${hideValue(assigned[2]!, depth + 1)}`;
  if (URL_LIKE.test(text)) return hideUrlSecrets(text);
  const header = /^([\w-]+)\s*:\s*\S/.exec(text);
  if (header && secretName(header[1]!)) return `${header[1]}: ${HIDDEN}`;
  if (SECRET_VALUE.test(text) || /^Bearer\s/i.test(text)) return HIDDEN;
  return text.replace(CONNECTION_SECRET, (_m, key: string) => `${key}=${HIDDEN}`);
}

/**
 * Arguments with anything that looks like a credential hidden: the value after a flag whose name
 * says it is one, a key-like value after a one-letter flag (`-k a1b2c3d4e5`), a `NAME=value` (also
 * inside a `--flag=value`, as in `--env=TOKEN=…`), a `Header: value`, a password in a connection
 * string, a URL's user, password, query values and key-like path segments, and a token
 * recognisable by its shape.
 */
export function hideSecrets(argv: readonly string[]): string[] {
  return argv.map((a, i) => {
    const prev = argv[i - 1];
    // The value of a secret flag, unless it is the next flag. A key may start with one dash.
    if (prev && /^--?[\w.-]+$/.test(prev) && secretName(prev) && !a.startsWith('--')) return HIDDEN;
    // A one-letter flag says nothing about its value (`-k`, `-t`): hide one shaped like a key.
    if (prev && /^-[A-Za-z]$/.test(prev) && mixedKey(a)) return HIDDEN;
    return hideValue(a);
  });
}

/**
 * A path segment shown as it is: a short lowercase word such as `mcp`, `sse`, `v1` or `github`.
 * Anything else (capitals, a long run of letters and digits, a token's shape) may be a key, as in
 * Zapier's MCP URLs, and is hidden.
 */
const plainSegment = (segment: string) => segment === '' || (/^[a-z0-9][a-z0-9._-]{0,23}$/.test(segment) && !keyLike(segment));

/**
 * A URL with its user and password shown as `•••@` (a place to put them back, never their text),
 * its query values and fragment hidden, and path segments that may be keys hidden.
 */
export function hideUrlSecrets(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((segment) => (plainSegment(segment) ? segment : HIDDEN))
      .join('/');
    if (!u.username && !u.password && !u.search && !u.hash && path === u.pathname) return url;
    const query = [...new Set(u.searchParams.keys())].map((k) => `${encodeURIComponent(k)}=${HIDDEN}`).join('&');
    return `${u.protocol}//${u.username || u.password ? `${HIDDEN}@` : ''}${u.host}${path}${query ? `?${query}` : ''}${u.hash ? `#${HIDDEN}` : ''}`;
  } catch {
    return url;
  }
}

/**
 * A remote server's URL without the user and password in it, which `shadowlap mcp --url` refuses:
 * they go in an `Authorization: Basic` header instead. `had` says there were some.
 */
function withoutCredentials(url: string): { url: string; had: boolean } {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return { url, had: false };
    // Cut from the URL as typed, so the rest stays exactly as it was.
    return { url: url.replace(USERINFO, '$1'), had: true };
  } catch {
    return { url, had: false };
  }
}

/** A URL's scheme and the user and password after it, as typed: `https://` and `bob:s3cret@`. */
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i;

/** Words in a host that say nothing about which server it is: what's left names its variable (`LINEAR_AUTH` for mcp.linear.app). */
const HOST_NOISE = new Set(['mcp', 'api', 'www', 'server', 'servers', 'app', 'com', 'net', 'org', 'io', 'dev', 'ai', 'co', 'cloud']);

/** The word a remote server's variables are named by: `linear` for https://mcp.linear.app/mcp, else `SERVER`. */
function hostWord(url: string): string {
  try {
    const labels = new URL(url).hostname.split('.').slice(0, -1);
    return labels.find((l) => /^[a-z][a-z0-9-]*$/i.test(l) && !HOST_NOISE.has(l.toLowerCase())) ?? 'server';
  } catch {
    return 'server';
  }
}

/** Hides only a URL's user and password, as `•••@`: what a copied entry carries in their place, leaving the rest as typed. */
function hideUrlCredentials(text: string): string {
  if (!URL_LIKE.test(text)) return text.replace(/(=)([a-z][a-z0-9+.-]*:\/\/[^\s]+)$/i, (_m, eq: string, url: string) => `${eq}${hideUrlCredentials(url)}`);
  try {
    const u = new URL(text);
    if (!u.username && !u.password) return text;
    return text.replace(USERINFO, `$1${HIDDEN}@`);
  } catch {
    return text;
  }
}

const quote = (a: string) => (/^[\w@%+=:,./•-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const commandLine = (argv: readonly string[]) => argv.map(quote).join(' ');

/**
 * A command line as a shell splits it into arguments: spaces separate them, '…' keeps everything,
 * "…" keeps all but \", \\, \$ and \`, and a backslash outside quotes keeps the next character.
 */
export function splitCommandLine(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Error('a quote is not closed');
      current += text.slice(i + 1, end);
      started = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && j + 1 < text.length && '"\\$`'.includes(text[j + 1]!)) j++;
        current += text[j];
      }
      if (j >= text.length) throw new Error('a quote is not closed');
      started = true;
      i = j;
    } else if (c === '\\' && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

/** The arguments after `mcp` when an entry starts `shadowlap mcp`, directly or through a package runner. */
function shadowlapMcpArgs(command: string, args: string[]): string[] | null {
  if (/(^|[\\/])shadowlap(\.cmd|\.exe)?$/i.test(command)) return args[0] === 'mcp' ? args.slice(1) : null;
  let runner: string[];
  if (/(^|[\\/])(npx|pnpx|bunx)(\.cmd|\.exe)?$/i.test(command)) runner = args;
  else if (/(^|[\\/])(pnpm|yarn|bun|npm)(\.cmd|\.exe)?$/i.test(command) && ['dlx', 'x', 'exec'].includes(args[0] ?? '')) runner = args.slice(1);
  else return null;
  // `npx -y shadowlap mcp …`, `pnpm dlx shadowlap@1.2.0 mcp …`, `npm exec -- shadowlap mcp …`
  const at = runner.findIndex((a) => /^shadowlap(@.*)?$/.test(a));
  if (at < 0 || runner[at + 1] !== 'mcp' || runner.slice(0, at).some((a) => !a.startsWith('-'))) return null;
  return runner.slice(at + 2);
}

/** `shadowlap mcp …` in a client entry: the server it stands in front of. */
function proxied(command: string, args: string[]): { transport: 'stdio' | 'http'; target: string[] } | null {
  const rest = shadowlapMcpArgs(command, args);
  if (!rest) return null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--url') return { transport: 'http', target: [rest[i + 1] ?? ''] };
    if (a.startsWith('--url=')) return { transport: 'http', target: [a.slice(6)] };
    if (a === '--') return { transport: 'stdio', target: rest.slice(i + 1) };
    if (a === '--effect') i++;
    else if (!a.startsWith('-')) return { transport: 'stdio', target: rest.slice(i) };
  }
  return { transport: 'stdio', target: [] };
}

/** How a server entry is recorded, from its command and arguments: the row without its name, file, environment, what to put back and what was recorded. */
type ServerRecording = Omit<McpServerRow, 'name' | 'file' | 'env' | 'putBack' | 'recorded'>;

function commandServer(command: string, args: string[]): ServerRecording {
  const shownArgs = hideSecrets(args);
  const via = proxied(command, args);
  if (via) {
    const target = via.transport === 'http' ? hideUrlSecrets(via.target[0] ?? '') : commandLine(hideSecrets(via.target));
    const hidden = shownArgs.some((a, i) => a !== args[i]) || (via.transport === 'http' && target !== via.target[0]);
    const recordedAs = via.transport === 'http' ? { transport: 'http' as const, server: httpServerName(via.target[0] ?? '') } : { transport: 'stdio' as const, server: via.target.length ? stdioServerName(via.target[0]!, via.target.slice(1)) : '' };
    return { transport: via.transport, target, viaShadowlap: true, line: commandLine([command, ...shownArgs]), entry: { command, args: shownArgs }, hidden, recordedAs };
  }
  const shown = hideSecrets([command, ...args]);
  return { transport: 'stdio', target: commandLine(shown), viaShadowlap: false, line: commandLine(['shadowlap', 'mcp', '--', ...shown]), entry: { command: 'shadowlap', args: ['mcp', '--', ...shown] }, hidden: shown.some((a, i) => a !== [command, ...args][i]), recordedAs: { transport: 'stdio', server: stdioServerName(command, args) } };
}

/** A remote server by its URL, with the `--header` flags `shadowlap mcp --url` sends (`Authorization: Bearer ${STRIPE_TOKEN}`). */
function urlServer(url: string, headers: readonly string[] = []): ServerRecording {
  const shown = hideUrlSecrets(url);
  const args = ['mcp', '--url', shown, ...headers.flatMap((h) => ['--header', h])];
  return { transport: 'http', target: shown, viaShadowlap: false, line: commandLine(['shadowlap', ...args]), entry: { command: 'shadowlap', args }, hidden: shown !== url, recordedAs: { transport: 'http', server: httpServerName(url) } };
}

/**
 * A remote server whose URL holds a user and password: `shadowlap mcp --url` refuses that, so the
 * URL goes without them and they become `Authorization: Basic ${<SERVER>_AUTH}`, a variable for the
 * person to set to their base64. Their text is never shown or copied. Null for a URL without them,
 * or one that already sends an Authorization header.
 */
function basicAuth(url: string, headers: readonly string[], word: string, taken: Set<string>): { url: string; header: string; env: string } | null {
  const bare = withoutCredentials(url);
  if (!bare.had || headers.some((h) => /^authorization\s*:/i.test(h))) return null;
  const base = `${envWord(word)}_AUTH`;
  let env = base;
  for (let i = 2; taken.has(env); i++) env = `${base}_${i}`;
  taken.add(env);
  return { url: bare.url, header: `Authorization: Basic \${${env}}`, env };
}

/** What stands in for a value the page never shows: an environment value to put back. */
const LEFT_OUT = '…';
/** A value that is only a reference the client, or `shadowlap mcp`, fills in from the environment (`${GITHUB_TOKEN}`, `${env:KEY}`): it holds no secret, so it is shown. */
const REFERENCE = /^\$\{[^}\s]+\}$/;
/** An Authorization header's scheme, kept in front of the variable that stands for its token. */
const SCHEME = /^(Bearer|Basic|Token|Bot)\s+(\S[\s\S]*)$/i;
const ENV_NAME = /^[A-Za-z_][\w.-]{0,99}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const envWord = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SERVER';

/** An entry's environment as a copy shows it: references as they are, any other value as `…`, to put back. */
function envOf(value: unknown): Array<{ name: string; value: string }> {
  if (!isObject(value)) return [];
  return Object.entries(value)
    .filter(([name]) => ENV_NAME.test(name))
    .map(([name, v]) => ({ name, value: typeof v === 'string' && REFERENCE.test(v.trim()) ? v.trim() : LEFT_OUT }));
}

/**
 * A remote server's headers as `shadowlap mcp --header` flags. A value that is a reference stays as
 * it is; any other becomes `${SERVER_HEADER}` (an Authorization header keeps its scheme:
 * `Bearer ${STRIPE_TOKEN}`), a variable added to the entry's environment for the person to set.
 * Only the scheme word is read from a value; its text never leaves here.
 */
function headerFlags(value: unknown, server: string, taken: Set<string>): Array<{ flag: string; env: string | null }> {
  if (!isObject(value)) return [];
  return Object.entries(value)
    .filter(([name]) => HEADER_NAME.test(name))
    .map(([name, v]) => {
      const text = typeof v === 'string' ? v.trim() : '';
      const scheme = SCHEME.exec(text);
      if (REFERENCE.test(text) || (scheme && REFERENCE.test(scheme[2]!.trim()))) return { flag: `${name}: ${text}`, env: null };
      const base = `${envWord(server)}_${scheme && /^authorization$/i.test(name) ? 'TOKEN' : envWord(name)}`;
      let env = base;
      for (let i = 2; taken.has(env); i++) env = `${base}_${i}`;
      taken.add(env);
      return { flag: `${name}: ${scheme ? `${scheme[1]} ` : ''}\${${env}}`, env };
    });
}

/**
 * The client configs to copy: one per project file that lists servers, in the order clients read
 * them, each written as docs/mcp.md writes one and under the key its file uses (`servers` for VS
 * Code), with what each copy leaves out to put back. Without a server, the docs' example. And the
 * forms no server in them uses, for the page to show beside them.
 */
export function clientConfigs(servers: ReadonlyArray<Pick<McpServerRow, 'name' | 'file' | 'transport' | 'entry' | 'env' | 'putBack'>>, docExample: string | null = null): { clientConfigs: ClientConfigBlock[]; otherForms: Array<'stdio' | 'http'> } {
  const q = (v: string) => JSON.stringify(v);
  const blocks = MCP_FILES.flatMap(({ path, key }): ClientConfigBlock[] => {
    const here = servers.filter((s) => s.file === path);
    if (!here.length) return [];
    const entries = here.map((s) => {
      const lines = [`    ${q(s.name)}: {`, `      "command": ${q(s.entry.command)},`, `      "args": [${s.entry.args.map(q).join(', ')}]${s.env.length ? ',' : ''}`];
      if (s.env.length) lines.push(`      "env": { ${s.env.map((e) => `${q(e.name)}: ${q(e.value)}`).join(', ')} }`);
      return [...lines, '    }'].join('\n');
    });
    const text = ['{', `  ${q(key)}: {`, entries.join(',\n'), '  }', '}'].join('\n');
    return [{ file: path, text, putBack: here.filter((s) => s.putBack.length).map((s) => ({ server: s.name, values: s.putBack })) }];
  });
  if (!blocks.length) return { clientConfigs: docExample === null ? [] : [{ file: null, text: docExample, putBack: [] }], otherForms: [] };
  const used = new Set(servers.filter((s) => blocks.some((b) => b.file === s.file)).map((s) => s.transport));
  return { clientConfigs: blocks, otherForms: (['stdio', 'http'] as const).filter((t) => !used.has(t)) };
}

/** What "Add a server…" shows for a URL with a user and password: the Basic header's variable, set in the entry's env. */
export interface ServerFor extends ServerRecording {
  /** The entry's environment: the variable a URL's user and password became, to set (value `…`). */
  env: Array<{ name: string; value: string }>;
  /** That variable's name, for the dialog to say how to set it; null without one. */
  basic: string | null;
}

/**
 * "Add a server…": the `shadowlap mcp` line and client entry for a command or a URL typed into the
 * dialog, with credentials hidden as the table hides them (`hidden` then asks the person to put
 * the real value back in their own entry). A URL's user and password become an `Authorization:
 * Basic` header whose value is a variable in the entry's env (`basic` names it), since `shadowlap
 * mcp --url` refuses them in the URL. Nothing is written. Throws with what to type instead.
 */
export function mcpServerFor(input: { command?: string | null; url?: string | null }): ServerFor {
  const url = input.url?.trim();
  if (url) {
    if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('an MCP server URL starts with http:// or https://, such as https://mcp.example.com/mcp');
    const basic = basicAuth(url, [], hostWord(url), new Set());
    if (!basic) return { ...urlServer(url), env: [], basic: null };
    return { ...urlServer(basic.url, [basic.header]), hidden: true, env: [{ name: basic.env, value: LEFT_OUT }], basic: basic.env };
  }
  const argv = splitCommandLine(input.command ?? '');
  if (!argv.length) throw new Error('type the command that starts the server, such as npx -y @modelcontextprotocol/server-filesystem .');
  return { ...commandServer(argv[0]!, argv.slice(1)), env: [], basic: null };
}

/**
 * The client entry for what "Add a server…" has, as the person typed it: what Copy the entry
 * copies. The line and entry the dialog shows hide credentials (mcpServerFor); the copy keeps what
 * was typed, since the person typed it and the dialog says so, except a URL's user and password,
 * which never go on the clipboard: a remote server's become its Basic header's variable, and one
 * in a command shows as `•••@`, to put back in your own entry.
 */
export function mcpEntryAsTyped(input: { command?: string | null; url?: string | null }): { command: string; args: string[] } {
  const url = input.url?.trim();
  if (url) return mcpServerFor({ url }).entry;
  const argv = splitCommandLine(input.command ?? '').map(hideUrlCredentials);
  if (!argv.length) throw new Error('type the command that starts the server, such as npx -y @modelcontextprotocol/server-filesystem .');
  if (shadowlapMcpArgs(argv[0]!, argv.slice(1))) return { command: argv[0]!, args: argv.slice(1) };
  return { command: 'shadowlap', args: ['mcp', '--', ...argv] };
}

/** The MCP servers a project's client configs list, with how each would be recorded. */
export function mcpServers(cwd: string): { servers: Array<Omit<McpServerRow, 'recorded'>>; files: Array<{ path: string; found: boolean; error: string | null }> } {
  const servers: Array<Omit<McpServerRow, 'recorded'>> = [];
  const files = MCP_FILES.map(({ path, key }) => {
    const full = join(cwd, path);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      return { path, found: false, error: null };
    }
    if (!st.isFile()) return { path, found: false, error: null };
    if (st.size > READ_LIMIT) return { path, found: true, error: `larger than ${READ_LIMIT / (1024 * 1024)} MB, so it was not read` };
    let parsed: unknown;
    try {
      parsed = parseJsonc(readFileSync(full, 'utf8'));
    } catch (err) {
      return { path, found: true, error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
    }
    const list = isObject(parsed) && isObject(parsed[key]) ? parsed[key] : {};
    for (const [name, entry] of Object.entries(list)) {
      if (!isObject(entry)) continue;
      const url = str(entry.url) ?? str(entry.serverUrl) ?? str(entry.httpUrl);
      const command = str(entry.command);
      const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
      const env = envOf(entry.env);
      const putBack = env.filter((e) => e.value === LEFT_OUT).map((e) => e.name);
      if (command) {
        const server = commandServer(command, args);
        if (server.hidden) putBack.push(`the ${HIDDEN} in its command`);
        servers.push({ name, file: path, ...server, env, putBack });
      } else if (url) {
        const taken = new Set(env.map((e) => e.name));
        const headers = headerFlags(entry.headers, name, taken);
        // A user and password in the URL become a Basic header: `shadowlap mcp --url` refuses them there.
        const basic = basicAuth(url, headers.map((h) => h.flag), name, taken);
        if (basic) headers.push({ flag: basic.header, env: basic.env });
        const server = urlServer(basic?.url ?? url, headers.map((h) => h.flag));
        for (const h of headers) {
          if (!h.env) continue;
          env.push({ name: h.env, value: LEFT_OUT });
          putBack.push(h.env === basic?.env ? `${h.env} (the base64 of its URL’s user:password, for its Authorization header)` : `${h.env} (its ${h.flag.slice(0, h.flag.indexOf(':'))} header)`);
        }
        if (basic) server.hidden = true;
        if (server.target.includes(HIDDEN)) putBack.push(`the ${HIDDEN} in its URL`);
        servers.push({ name, file: path, ...server, env, putBack });
      }
    }
    return { path, found: true, error: null };
  });
  return { servers, files };
}

// ---- Project ----

/** Clean up old runs looks this far back unless the page says otherwise. */
export const CLEANUP_DAYS = 30;

export function projectSettings(ctx: SettingsContext): ProjectSettings {
  // Counted as the Runs page and the status bar count them.
  const counts = countRuns(ctx.store);
  const recording = ctx.store.recordingRuns();
  const dbPath = ctx.dbPath && ctx.dbPath !== ':memory:' ? ctx.dbPath : null;
  const size = ctx.store.size();
  return {
    name: ctx.name ?? basename(ctx.cwd),
    folder: ctx.cwd,
    shown: { folder: shownPath(ctx.cwd), store: dbPath ? shownPath(dbPath) : null },
    store: { path: dbPath, bytes: size.bytes, free: size.free },
    runs: counts.runs,
    attempts: counts.attempts,
    running: recording.live.length,
    abandoned: recording.abandoned.length,
    address: ctx.address ?? null,
    cleanup: { olderThanDays: CLEANUP_DAYS, dryRun: ['gc', '--older-than', String(CLEANUP_DAYS), '--dry-run'] },
  };
}

/**
 * The job behind "Delete N runs", from the dry run's result: the same cutoff (and --keep), and its
 * `expect`, which names the runs the dialog promised, so gc deletes exactly those or refuses and
 * deletes nothing when they changed (a run crossed the line meanwhile, or another was deleted).
 */
export function cleanupArgv(dryRun: { cutoff: number | null; keep: number | null; expect: string }): string[] {
  if (dryRun.cutoff === null && dryRun.keep === null) throw new Error('the dry run picked no runs: give it --older-than or --keep');
  if (!/^\d+-[0-9a-f]{16}$/.test(dryRun.expect)) throw new Error('the dry run says no "expect": run it again with this version of Shadowlap');
  return ['gc', ...(dryRun.cutoff !== null ? ['--before', String(dryRun.cutoff)] : []), ...(dryRun.keep !== null ? ['--keep', String(dryRun.keep)] : []), '--expect', dryRun.expect];
}

/** A path inside the home folder as `~/…` (reached by its own path or its real one); any other as it is. */
export function shownPath(path: string, home: string = homedir()): string {
  let real: string | null = null;
  try {
    real = realpathSync(home);
  } catch {
    // a home folder that can't be resolved: compare as given
  }
  for (const base of new Set([home, ...(real ? [real] : [])])) {
    const shown = tildePath(path, base);
    if (shown !== path) return shown;
  }
  return path;
}

// ---- refusals ----

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
function findRun(store: Store, ref: string): RunRecord {
  if (!RUN_REF.test(ref)) throw new SettingsRefusal(400, 'name a run by its id or a unique prefix of it');
  let run: RunRecord | null;
  try {
    run = store.findRun(ref);
  } catch (err) {
    throw new SettingsRefusal(400, err instanceof Error ? err.message : String(err));
  }
  if (!run) throw new SettingsRefusal(404, `no run matches ${ref}`);
  return run;
}

// ---- Calibrate ----

/**
 * Why `calibrate` can't take this run, in the words the dashboard shows; null when it can. It takes
 * what the Calibrate button offers: a finished recording made here, whose command it runs again
 * offline. A replay or a fork is calibrated through the recording it came from; an import runs
 * someone else's command, or none.
 */
export function notCalibratable(store: Store, run: RunRecord): string | null {
  const id = shortRun(run.runId);
  if (run.mode !== 'record') return `${id} is a replay; calibrate the recording it came from${run.parentRunId ? ` (${shortRun(run.parentRunId)})` : ''}`;
  if (store.recordingRuns().live.some((r) => r.run.runId === run.runId)) return `${id} is still recording; calibrate it once it has ended`;
  if (run.status !== 'completed' && run.status !== 'failed') return `${id} did not finish (${run.status}); calibrate a recording that ran to its end`;
  if (!hasRecordedCommand(run) || commandIsImported(run)) return `${id} was imported, so there is no command recorded here to run again`;
  return null;
}

/** The run a calibrate job takes: the one named, checked, or the one the button offers. */
export function calibrateRun(ctx: Pick<SettingsContext, 'store' | 'setupRunId'>, runRef: string | null | undefined): RunRecord {
  if (runRef) {
    const run = findRun(ctx.store, runRef);
    const why = notCalibratable(ctx.store, run);
    if (why) throw new SettingsRefusal(409, why);
    return run;
  }
  const target = calibrationTarget(ctx.store, { setupRunId: ctx.setupRunId ?? null });
  if (!target) throw new SettingsRefusal(409, 'Record a run first: calibrate replays a finished recording made here');
  return target.run;
}

// ---- the redaction preview, in the dashboard ----

export interface RedactionPreviewView {
  run: { runId: string; label: string };
  /**
   * What `redact preview <run> --json` prints: per rule, a count and up to two samples; the run's
   * details apart. `partial` says how far a long run was read before a limit stopped it.
   */
  preview: RedactionPreview;
  /** The command that previews the whole run in a terminal. */
  command: string;
}

/**
 * What the project's redaction rules would mask in one run, exactly as pack applies them (path
 * rules included). The rules are the file's, as the table lists them, numbered the same way. The
 * run is read apart, on a thread of its own and within limits (redaction-preview.ts), so the server
 * answers everything else meanwhile; a store with no file is read here, within the same limits.
 * Refused for a run still recording (409), a run that isn't there (404), rules that can't be read
 * (422), a rule that takes too long on one call (422), and while other previews are read or another
 * command holds the store (503).
 */
export async function redactionPreview(ctx: Pick<SettingsContext, 'store' | 'cwd' | 'dbPath'>, runRef: string, options: { signal?: AbortSignal; limits?: PreviewLimitsConfig } = {}): Promise<RedactionPreviewView> {
  const run = findRun(ctx.store, runRef);
  if (ctx.store.recordingRuns().live.some((r) => r.run.runId === run.runId)) throw new SettingsRefusal(409, `${shortRun(run.runId)} is still recording; preview it once it has ended`);
  let rules: Normalizer[];
  try {
    rules = parseRules(readConfigFile(ctx.cwd).data.redact, 'redact');
  } catch (err) {
    throw new SettingsRefusal(422, err instanceof Error ? err.message : String(err));
  }
  const limits = options.limits ?? PREVIEW_LIMITS;
  let preview: RedactionPreview;
  try {
    preview = ctx.dbPath && ctx.dbPath !== ':memory:' ? await previewApart({ dbPath: ctx.dbPath, runId: run.runId, rules }, { limits, ...(options.signal ? { signal: options.signal } : {}) }) : previewHere(ctx.store, run.runId, rules, limits);
  } catch (err) {
    if (err instanceof PreviewError) throw new SettingsRefusal(err.status, err.message);
    throw new SettingsRefusal(422, err instanceof Error ? err.message : String(err));
  }
  return { run: { runId: run.runId, label: runLabel(run) }, preview, command: `shadowlap redact preview ${shortRun(run.runId)}` };
}

// ---- Store ----

export interface StoreSettings {
  /** The config, for the version an edit (Push from CI) sends back. */
  config: ConfigInfo;
  /** `store` as shadowlap.config.json has it; null when it names none ("No store yet"). */
  configured: string | null;
  /** Why the configured store can't be used: not a bucket URL, or a config that can't be read. */
  error: string | null;
  /** The bucket, the last sync, runs in the store and only here, the last check, your access, Push from CI. */
  status: TeamStoreStatus | null;
  /** "Copy CI step": the GitHub Actions step `shadowlap store ci --provider github` prints. */
  ciStep: { file: string; text: string; oidc: boolean } | null;
}

/**
 * Settings → Store, the team store: what `shadowlap store show` says, offline. Push and pull are
 * jobs; Push from CI is a config edit. Nothing here reaches the bucket.
 */
export function storeSettings(ctx: Pick<SettingsContext, 'store' | 'cwd'>, input: TeamStoreInput): StoreSettings {
  const { info } = loadConfigFile(ctx.cwd);
  const configured = input.store;
  if (!configured) return { config: info, configured: null, error: info.error, status: null, ciStep: null };
  let loc: StoreLocation;
  try {
    loc = parseStoreUrl(configured);
  } catch (err) {
    return { config: info, configured, error: `${CONFIG_FILE} names a store that can't be used: ${err instanceof Error ? err.message : String(err)}`, status: null, ciStep: null };
  }
  const step = ciStep('github', loc);
  return { config: info, configured, error: info.error, status: teamStoreStatus(ctx.store, input), ciStep: { file: step.file, text: step.text, oidc: step.oidc } };
}
