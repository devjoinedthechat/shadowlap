import { existsSync, readdirSync, readFileSync, statSync, type Dirent, type Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FILE,
  DEFAULT_REPLACE,
  NO_COMMAND,
  REDACTION_EXPORTS,
  RULE_KINDS,
  calibrationTarget,
  configClock,
  namedPatterns,
  previewRedaction,
  readConfigFile,
  readRules,
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
  /** The command that removes it, as argv for a job: ['normalize', 'rm', '2']. */
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
   * streams each round and ends with a result event (the object `calibrate --json` prints); when it
   * proposed normalizers, "Add it (--write)" runs `writeArgv`, which replays again and adds them.
   */
  calibrate: { runId: string | null; source: 'setup' | 'newest' | null; label: string; command: string | null; argv: string[] | null; writeArgv: string[] | null };
}

export interface RedactionSettings {
  config: ConfigInfo;
  rules: RuleRow[];
  form: RuleForm;
  /** Every way a run's content leaves the machine, and which rules each applies (decision 6). */
  where: readonly RedactionExport[];
  /** Runs a preview can be made for: every run that has ended, newest first. */
  runs: Array<{ runId: string; label: string }>;
  preview: RedactionPreview | null;
  /** Why there is no preview: no run yet, a run still recording, or rules that can't be read. */
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
  /** The `shadowlap mcp` line in front of it: as the entry has it, or as it would be. */
  line: string;
  /** What the client's entry takes instead of its command and args; its environment and headers stay as they are. */
  entry: { command: string; args: string[] };
  /** Something that looked like a credential is shown as ••• in `target`, `line` and `entry`: copy it from the entry as it is. */
  hidden: boolean;
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
    /** The client config files looked at, and why one couldn't be read. */
    files: Array<{ path: string; found: boolean; error: string | null }>;
    /** The client configuration example from docs/mcp.md. */
    clientConfig: string | null;
  };
}

export interface ProjectSettings {
  name: string;
  folder: string;
  store: { path: string | null; bytes: number | null };
  /** Runs, not counting the attempts blame, verify and `replay --repeat` make. */
  runs: number;
  attempts: number;
  /** Runs still running: a recording, or a replay in progress. */
  running: number;
  address: string | null;
  /** Clean up old runs: the dry run first, then the run that deletes. */
  cleanup: { olderThanDays: number; dryRun: string[]; run: string[] };
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
      remove: [list, 'rm', String(i + 1)],
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
      ? { runId: target.run.runId, source: target.source, label: `Calibrate ${shortRun(target.run.runId)}`, command: `shadowlap calibrate ${shortRun(target.run.runId)}`, argv: ['calibrate', target.run.runId], writeArgv: ['calibrate', target.run.runId, '--write'] }
      : { runId: null, source: null, label: 'Record a run first', command: null, argv: null, writeArgv: null },
  };
}

// ---- Redaction ----

/** How many runs the preview's run picker lists. */
const PREVIEW_RUNS = 100;

/**
 * The Redaction tab. `runId` picks the run to preview; without one, the newest run that has ended.
 * The preview reads every stored request and response of that run, so a long run takes a while.
 */
export function redactionSettings(ctx: SettingsContext, options: { runId?: string | null } = {}): RedactionSettings {
  const { info, file } = loadConfigFile(ctx.cwd, 'redact');
  const rows = ruleRows(file, 'redact');
  const ended = ctx.store.listRuns(PREVIEW_RUNS * 2).filter((r) => r.status !== 'running');
  const runs = ended.slice(0, PREVIEW_RUNS).map((r) => ({ runId: r.runId, label: `${shortRun(r.runId)} · ${commandOf(r)}` }));
  let preview: RedactionPreview | null = null;
  let previewError: string | null = null;
  const runId = options.runId ?? ended[0]?.runId ?? null;
  const broken = rows.find((r) => r.error);
  if (!runId) previewError = 'Record a run first: the preview needs one to read.';
  else if (info.error) previewError = info.error;
  else if (broken) previewError = `redaction rule #${broken.n}: ${broken.error}`;
  else {
    try {
      const run = ctx.store.findRun(runId);
      if (!run) throw new Error(`no run matches ${runId}`);
      preview = previewRedaction(ctx.store, run.runId, rows.map((r) => r.rule!));
    } catch (err) {
      previewError = err instanceof Error ? err.message : String(err);
    }
  }
  return { config: info, rules: rows, form: form('redact'), where: REDACTION_EXPORTS, runs, preview, previewError };
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
const FOLDER_FILES = 200;

function mentionsIn(file: string): boolean {
  try {
    if (statSync(file).size > READ_LIMIT) return false;
    return MENTION.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function folderMentions(dir: string): boolean {
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < FOLDER_FILES) {
    const at = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(at, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && ++seen <= FOLDER_FILES && mentionsIn(full)) return true;
    }
  }
  return false;
}

/**
 * The Coding agents tab: which instruction files the project has and whether each mentions
 * Shadowlap yet, and the section to paste. Only a yes or no leaves each file, never its text.
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
    if (st.isDirectory()) return { path, agents, found: true, type: 'folder', mentions: folderMentions(full) };
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
  const usage = ctx.store.toolUsage();
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
  const servers = mcpServers(ctx.cwd);
  const doc = options.mcpDoc !== undefined ? options.mcpDoc : readShippedDoc('mcp.md');
  return {
    config: info,
    live: rows.filter((t) => t.effect !== 'write'),
    fenced: rows.filter((t) => t.effect === 'write'),
    http,
    mcp: { effects, servers: servers.servers, files: servers.files, clientConfig: doc === null ? null : mcpClientConfig(doc) },
  };
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

const SECRET_FLAG = /(token|key|secret|password|passwd|auth|credential|bearer)/i;
const SECRET_VALUE = /^(sk-|sk_|rk_|pk_live|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abpr]-|AKIA|ASIA|AIza|ya29\.|eyJ)/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HIDDEN = '•••';

/**
 * Arguments with anything that looks like a credential hidden: the value of a flag, a `NAME=value`
 * or a `Header: value` whose name says it is one, a URL's user, password and query values (as an
 * argument or a flag's value), and a token recognisable by its shape.
 */
export function hideSecrets(argv: readonly string[]): string[] {
  return argv.map((a, i) => {
    const prev = argv[i - 1];
    if (prev && /^--?[\w.-]+$/.test(prev) && SECRET_FLAG.test(prev) && !a.startsWith('-')) return HIDDEN;
    const assigned = /^(-{0,2}[A-Za-z_][\w.-]*)=(.+)$/.exec(a);
    if (assigned && SECRET_FLAG.test(assigned[1]!)) return `${assigned[1]}=${HIDDEN}`;
    if (assigned && URL_LIKE.test(assigned[2]!)) return `${assigned[1]}=${hideUrlSecrets(assigned[2]!)}`;
    if (URL_LIKE.test(a)) return hideUrlSecrets(a);
    const header = /^([\w-]+)\s*:\s*\S/.exec(a);
    if (header && SECRET_FLAG.test(header[1]!)) return `${header[1]}: ${HIDDEN}`;
    if (SECRET_VALUE.test(a) || /^Bearer\s/i.test(a)) return HIDDEN;
    return a;
  });
}

/** A URL without its user, password, query values or fragment. */
export function hideUrlSecrets(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password && !u.search && !u.hash) return url;
    const query = [...new Set(u.searchParams.keys())].map((k) => `${encodeURIComponent(k)}=${HIDDEN}`).join('&');
    return `${u.protocol}//${u.host}${u.pathname}${query ? `?${query}` : ''}${u.hash ? `#${HIDDEN}` : ''}`;
  } catch {
    return url;
  }
}

const quote = (a: string) => (/^[\w@%+=:,./•-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const commandLine = (argv: readonly string[]) => argv.map(quote).join(' ');

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

/** The MCP servers a project's client configs list, with how each would be recorded. */
export function mcpServers(cwd: string): { servers: McpServerRow[]; files: Array<{ path: string; found: boolean; error: string | null }> } {
  const servers: McpServerRow[] = [];
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
      if (command) {
        const shownArgs = hideSecrets(args);
        const via = proxied(command, args);
        if (via) {
          const target = via.transport === 'http' ? hideUrlSecrets(via.target[0] ?? '') : commandLine(hideSecrets(via.target));
          const hidden = shownArgs.some((a, i) => a !== args[i]) || (via.transport === 'http' && target !== via.target[0]);
          servers.push({ name, file: path, transport: via.transport, target, viaShadowlap: true, line: commandLine([command, ...shownArgs]), entry: { command, args: shownArgs }, hidden });
          continue;
        }
        const shown = hideSecrets([command, ...args]);
        servers.push({ name, file: path, transport: 'stdio', target: commandLine(shown), viaShadowlap: false, line: commandLine(['shadowlap', 'mcp', '--', ...shown]), entry: { command: 'shadowlap', args: ['mcp', '--', ...shown] }, hidden: shown.some((a, i) => a !== [command, ...args][i]) });
      } else if (url) {
        const shown = hideUrlSecrets(url);
        servers.push({ name, file: path, transport: 'http', target: shown, viaShadowlap: false, line: commandLine(['shadowlap', 'mcp', '--url', shown]), entry: { command: 'shadowlap', args: ['mcp', '--url', shown] }, hidden: shown !== url });
      }
    }
    return { path, found: true, error: null };
  });
  return { servers, files };
}

// ---- Project ----

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Clean up old runs looks this far back unless the page says otherwise. */
export const CLEANUP_DAYS = 30;

export function projectSettings(ctx: SettingsContext): ProjectSettings {
  const counts = ctx.store.runCounts();
  const dbPath = ctx.dbPath && ctx.dbPath !== ':memory:' ? ctx.dbPath : null;
  const days = String(CLEANUP_DAYS);
  return {
    name: ctx.name ?? basename(ctx.cwd),
    folder: ctx.cwd,
    store: { path: dbPath, bytes: dbPath ? fileBytes(dbPath) + fileBytes(`${dbPath}-wal`) : null },
    runs: counts.runs,
    attempts: counts.attempts,
    running: counts.running,
    address: ctx.address ?? null,
    cleanup: { olderThanDays: CLEANUP_DAYS, dryRun: ['gc', '--older-than', days, '--dry-run'], run: ['gc', '--older-than', days] },
  };
}
