import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_PLACEHOLDER, JUDGE_REQUEST_VERSION, SCHEMA_VERSION, Store, isObject, type StoreOf, judgeTarget, loadApiRequest, maskLocation, quoteArgv, retirementOf, toolDefinitions, type CallRecord, type JudgeProvider, type RunRecord } from '@shadowlap/engine';
// Whether a process runs, as every command asks it (liveness.ts): a pid of 0 or below is none.
import { processAlive as alive } from '@shadowlap/engine';
import { packRecording } from './check-recordings.js';
import { closestName, evaluateChecks, JUDGE_KEYS, judgeChecksOf, pathsNamed, storedCalls, storedCheckInput, toolsNamed, unreadPaths, type JudgeCheck, type JudgeVerdict, type NamedPath, type NamedTool, type RecordedCalls, type TestEntry } from './checks.js';
import { CONFIG_FILE, configPath as configFile, defaultDbPath, loadConfig, loadTests, upstreamOverrides } from './config.js';
import { expandRecordings, testsKeyFor } from './goldens.js';
import { cannotJudge, heldVerdict, liveJudge } from './judge.js';

/**
 * `shadowlap doctor`: the environment, the store and the configuration, checked the way support
 * would check them. Every check is a fact with a verdict; problems say what to do.
 */
export type Verdict = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  verdict: Verdict;
  detail: string;
  fix?: string;
}

export interface DoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
  version: string;
  /** Node version to check (tests). */
  nodeVersion?: string;
  /** The guard directory (tests). */
  guardDir?: string;
  /** Runs `<command> --version` for python3 and python, null for one that isn't there (tests stub it). */
  python?: (command: string) => string | null;
  /** Opens an in-memory database with a full-text index, as every store has; why it can't, or null (tests stub it). */
  sqlite?: () => string | null;
}

/** The first Node 22 whose built-in SQLite has full-text search (FTS5), which every store uses; Node 24 and later have it too, Node 23 never. */
const MIN_NODE = [22, 16] as const;

/** Why this Node's built-in SQLite can't hold a store, or null: no `node:sqlite`, or no full-text search in it. */
function defaultSqlite(): string | null {
  let db: { exec(sql: string): void; close(): void };
  try {
    const { DatabaseSync } = (globalThis as { process: { getBuiltinModule?: (id: string) => unknown } }).process.getBuiltinModule?.('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    db = new DatabaseSync(':memory:');
  } catch (err) {
    return `node:sqlite unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(text)');
    return null;
  } catch (err) {
    return `built-in SQLite has no full-text search: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    db.close();
  }
}

function parseVersion(v: string): [number, number, number] {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function defaultPython(command: string): string | null {
  try {
    return execFileSync(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * The python line: which names start Python here, since an agent's command names one. Where only
 * python3 does (macOS, most Linux distributions), `python agent.py` fails, so it says so.
 */
export function pythonCheck(probe: (command: string) => string | null): { found: boolean; detail: string } {
  const three = probe('python3');
  const plain = probe('python');
  const usable = '(Python SDK and guard usable)';
  if (three && plain) return { found: true, detail: three === plain ? `${three} on PATH as python3 and python ${usable}` : `${three} as python3 and ${plain} as python on PATH ${usable}` };
  if (three) return { found: true, detail: `${three} on PATH as python3 ${usable}; there is no python, so start agents with python3 agent.py` };
  if (plain) return { found: true, detail: `${plain} on PATH as python ${usable}; there is no python3, so start agents with python agent.py` };
  return { found: false, detail: 'no python3 or python on PATH' };
}

/**
 * A URL as doctor's report names it, none of its secrets in a report someone may paste into an issue:
 * the password in its user info and a credential in its query (maskLocation), and a sidecar's
 * session token (`/t/<token>` on a loopback address).
 */
export function shownUrl(url: string): string {
  return maskLocation(url).replace(/^(https?:\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?\/t\/)[^/?#]+/i, `$1${CREDENTIAL_PLACEHOLDER}`);
}

export function runDoctor(options: DoctorOptions): Check[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const checks: Check[] = [];
  const push = (name: string, verdict: Verdict, detail: string, fix?: string) => checks.push({ name, verdict, detail, ...(fix ? { fix } : {}) });

  // Runtime
  const nodeVersion = options.nodeVersion ?? process.version;
  const [maj, min] = parseVersion(nodeVersion);
  const nodeOk = (maj === MIN_NODE[0] && min >= MIN_NODE[1]) || maj >= 24;
  const needs = `Node ${MIN_NODE.join('.')} or later (not 23)`;
  push('node', nodeOk ? 'ok' : 'fail', `${nodeVersion} (shadowlap ${options.version})`, nodeOk ? undefined : `Shadowlap needs ${needs}, whose built-in SQLite has full-text search; install a current Node LTS.`);
  const sqliteWhy = (options.sqlite ?? defaultSqlite)();
  const sqliteOk = sqliteWhy === null;
  // A Node in range whose SQLite has no full-text search (or none at all) is a build without it,
  // which another version of Node wouldn't mend: an official build has it.
  const noSqlite = sqliteWhy?.startsWith('node:sqlite unavailable') ?? false;
  const lacks = noSqlite ? 'this Node has no built-in SQLite' : "this Node's SQLite has no full-text search, which the store's index needs";
  const mend = nodeOk ? 'Use an official Node build' : `Use ${needs}`;
  const sqliteFix = nodeOk ? `${noSqlite ? 'This Node was built without its SQLite' : "This Node build's SQLite has no full-text search"}, which every store needs: use an official Node build.` : `Use ${needs}: every store has a full-text index.`;
  push('sqlite', sqliteOk ? 'ok' : 'fail', sqliteWhy ?? 'built-in SQLite with full-text search', sqliteOk ? undefined : sqliteFix);

  // Guard files and Python
  const guardDir = options.guardDir ?? fileURLToPath(new URL('../guard/', import.meta.url));
  const guardFiles = ['node-guard.mjs', 'sitecustomize.py'].filter((f) => !existsSync(join(guardDir, f)));
  push('network guard', guardFiles.length ? 'fail' : 'ok', guardFiles.length ? `missing ${guardFiles.join(', ')} in ${guardDir}` : `preloads present in ${guardDir}`, guardFiles.length ? 'Reinstall the shadowlap package; the guard directory ships with it.' : undefined);
  const py = pythonCheck(options.python ?? defaultPython);
  push('python', py.found ? 'ok' : 'warn', py.detail, py.found ? undefined : 'Only needed for Python agents; the Python SDK requires Python ≥ 3.9.');
  const guardMode = env.SHADOWLAP_GUARD;
  if (guardMode) push('SHADOWLAP_GUARD', 'warn', `set to "${guardMode}" in this shell`, 'This is set by shadowlap run for the agent process; unset it in your own shell so it does not leak into unrelated commands.');

  // Store
  const dbPath = options.dbPath ?? defaultDbPath(cwd);
  if (!existsSync(dbPath)) {
    push('store', 'ok', `${dbPath} (not created yet; the first shadowlap run creates it)`);
  } else if (!sqliteOk) {
    // Its index is what this Node can't open, not the file: never call it damaged.
    push('store', 'warn', `${dbPath}: not read: ${lacks}`, `${mend}, then run shadowlap doctor again.`);
  } else {
    try {
      const store = Store.open(dbPath);
      const runs = store.allRuns();
      // Runs a process is recording are fine; one whose process stopped without ending it is not.
      const abandoned = store.recordingRuns().abandoned.map((a) => a.run);
      // The version in the file, not the one this build was compiled with.
      const schema = store.schemaVersion();
      store.close();
      const size = statSync(dbPath).size + (statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0);
      push('store', 'ok', `${dbPath}: ${runs.length} run${runs.length === 1 ? '' : 's'}, ${bytes(size)}, schema v${schema}${schema === SCHEMA_VERSION ? '' : ` (this build writes v${SCHEMA_VERSION})`}`);
      if (abandoned.length) push('runs still marked running', 'warn', abandoned.map((r) => r.runId.slice(0, 10)).join(', '), 'Their recording process stopped without ending them (killed, or out of memory). shadowlap gc marks them interrupted; shadowlap rm <run> removes one.');
      if (size > 512 * 1024 * 1024) push('store size', 'warn', `${bytes(size)}`, 'shadowlap gc --older-than 30 deletes old runs and compacts the file.');
      const preload = preloadCheck(runs);
      if (preload) checks.push(preload);
    } catch (err) {
      push('store', 'fail', `${dbPath}: ${err instanceof Error ? err.message : String(err)}`, 'The file is not a Shadowlap store or is damaged; move it aside and record again, or point --db elsewhere.');
    }
    const ignore = join(resolve(dbPath, '..'), '.gitignore');
    if (!existsSync(ignore)) push('store .gitignore', 'warn', `${ignore} missing`, 'Recordings hold prompts and tool I/O; keep the store directory out of git (shadowlap creates this file when it makes the directory).');
  }

  // Active run
  const active = join(cwd, '.shadowlap', 'active.json');
  if (existsSync(active)) {
    try {
      const j = JSON.parse(readFileSync(active, 'utf8')) as { runId?: unknown; pid?: unknown; url?: unknown };
      // Read as shadowlap mcp reads it: without its run, its process or the sidecar's address, it is no use.
      if (typeof j.runId !== 'string' || typeof j.pid !== 'number' || typeof j.url !== 'string') push('active run', 'warn', `${active} is incomplete`, 'Delete it.');
      else {
        const stale = !alive(j.pid);
        push('active run', stale ? 'warn' : 'ok', stale ? `${active} points at run ${j.runId.slice(0, 10)} from a process that is gone` : `run ${j.runId.slice(0, 10)} at ${shownUrl(j.url)} (pid ${j.pid})`, stale ? 'Delete .shadowlap/active.json; shadowlap mcp would otherwise try that sidecar first.' : undefined);
      }
    } catch {
      push('active run', 'warn', `${active} is unreadable`, 'Delete it.');
    }
  }

  // A repair that died with a candidate still applied
  const journal = join(cwd, '.shadowlap', 'repair-journal.json');
  if (existsSync(journal)) {
    let files = 'a file';
    try {
      const j = JSON.parse(readFileSync(journal, 'utf8')) as { files?: Array<{ path?: string }>; pid?: number };
      if (typeof j.pid === 'number' && alive(j.pid)) files = '';
      else files = (j.files ?? []).map((f) => f.path ?? '?').join(', ') || files;
    } catch {
      // an unreadable journal still means an edit may be in place
    }
    if (files) push('repair', 'warn', `an interrupted shadowlap repair may have left a candidate's edit in ${files}`, 'Run shadowlap repair again to restore it first, or check the file and delete .shadowlap/repair-journal.json.');
  }

  // Configuration
  const configPath = configFile(cwd);
  if (!existsSync(configPath)) {
    push('config', 'ok', `no ${CONFIG_FILE} in ${cwd} (defaults)`);
  } else {
    try {
      const c = loadConfig(cwd);
      const parts = [`${c.normalize.length} normalizer${c.normalize.length === 1 ? '' : 's'}`, `${c.redact.length} redaction rule${c.redact.length === 1 ? '' : 's'}`];
      if (c.prices) parts.push(`${Object.keys(c.prices).length} price override${Object.keys(c.prices).length === 1 ? '' : 's'}`);
      if (c.mcp) parts.push(`${Object.keys(c.mcp.effects).length} MCP effect${Object.keys(c.mcp.effects).length === 1 ? '' : 's'}`);
      // Injection tests: the tools marked untrusted (or trusted again), where shadowlap injection plants.
      if (c.tools) parts.push(`${Object.keys(c.tools).length} trust mark${Object.keys(c.tools).length === 1 ? '' : 's'}`);
      const tests = loadTests(cwd);
      if (tests.length) parts.push(`checks for ${tests.length} recording${tests.length === 1 ? '' : 's'}`);
      const gates = tests.filter((t) => t.spec.injection).length;
      if (gates) parts.push(`${gates} injection gate${gates === 1 ? '' : 's'}`);
      push('config', 'ok', `${configPath}: ${parts.join(', ')}`);
      if (tests.length) {
        // Each pack the entries apply to is read once, for the rules and the judge checks alike:
        // reading one unpacks it into a store of its own and checks every blob's hash.
        const packs = readTestPacks(cwd, tests);
        try {
          // What goes wrong reading the packs says nothing about the config, which parsed.
          try {
            checks.push(...checkRules(cwd, tests, dbPath, packs));
          } catch (err) {
            push('check rules', 'warn', `the tools the checks name could not be held against their recordings: ${err instanceof Error ? err.message : String(err)}`);
          }
          checks.push(...judgeRetirements(tests));
          checks.push(...judgeKeys(tests, env));
          try {
            checks.push(...judgeVerdicts(cwd, tests, env, packs));
          } catch (err) {
            push('judge verdicts', 'warn', `the goldens' recorded judge verdicts could not be read: ${err instanceof Error ? err.message : String(err)}`);
          }
        } finally {
          closePacks(packs);
        }
      }
    } catch (err) {
      push('config', 'fail', `${configPath}: ${err instanceof Error ? err.message : String(err)}`, 'Fix the JSON; shadowlap normalize ls / redact ls print what is loaded.');
    }
  }

  // Environment that changes routing
  const upstreams = Object.entries(env).filter(([k, v]) => k.startsWith('SHADOWLAP_UPSTREAM_') && v);
  if (upstreams.length) push('upstream overrides', 'ok', upstreams.map(([k, v]) => `${k}=${shownUrl(v!)}`).join(' '));
  const baseUrls = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'].filter((k) => env[k]);
  if (baseUrls.length && !env.SHADOWLAP_URL) push('provider base URLs', 'warn', baseUrls.map((k) => `${k}=${shownUrl(env[k]!)}`).join(' '), 'shadowlap run points the agent at its sidecar and forwards these providers\' calls to the URLs set here (SHADOWLAP_UPSTREAM_<PROVIDER> takes precedence). Check they are what you expect.');
  if (env.SHADOWLAP_URL) push('SHADOWLAP_URL', 'warn', `${shownUrl(env.SHADOWLAP_URL)} (run ${env.SHADOWLAP_RUN_ID ?? '?'})`, 'Set by shadowlap run for the agent; SDK calls made from this shell would go to that sidecar.');
  const offTelemetry = env.SHADOWLAP_TELEMETRY === '0' || env.DO_NOT_TRACK === '1';
  push('telemetry', 'ok', offTelemetry ? 'off (SHADOWLAP_TELEMETRY=0 or DO_NOT_TRACK=1)' : env.SHADOWLAP_TELEMETRY_URL ? `on, anonymous counts only → ${shownUrl(env.SHADOWLAP_TELEMETRY_URL)}; SHADOWLAP_TELEMETRY=0 turns it off` : 'off: no collector configured (SHADOWLAP_TELEMETRY_URL), so nothing is sent');
  if (/node-(guard|preload)\.mjs/.test(env.NODE_OPTIONS ?? '')) push('NODE_OPTIONS', 'warn', 'contains the Shadowlap preload', 'That is the agent process configuration leaking into your shell; unset NODE_OPTIONS.');
  if ((env.PYTHONPATH ?? '').split(delimiter).some((p) => p.endsWith('guard'))) push('PYTHONPATH', 'warn', 'contains the Shadowlap guard directory', 'Unset it outside agent processes.');

  return checks;
}

/** How Shadowlap's preloads reach an agent, and what keeps them out: the fix for a run none loaded in. */
export const PRELOAD_FIX =
  "Shadowlap loads its network guard into Node agents through NODE_OPTIONS (--import, Node 18.18 or later) and into Python agents through a sitecustomize on PYTHONPATH. Start the agent with the environment shadowlap gives it: not through env -i, sudo or docker exec, without a script that sets NODE_OPTIONS or PYTHONPATH anew, and without python -I, -E or -S. opentelemetry-instrument's own sitecustomize comes first and loads no other: instrument in code instead. An agent on another runtime (Go, Rust, Java, Bun, Deno) gets no guard: wrap what it does to the world as tools, and test it with --guard warn.";

/** What to do about processes the guard can't watch: the Claude Code CLI loads no preload, whatever the environment. */
export const UNGUARDED_FIX =
  "The Claude Code CLI the Claude Agent SDK runs is a native program that loads no Shadowlap preload, so the network guard can't watch a connection it makes itself, and its fence names what it can still reach. Close each (disallow WebFetch, keep MCP servers to the query's own with strictMcpConfig, reach a remote one through shadowlap mcp, which records and fences its calls), accept the CLI alone with \"guard\": { \"accept\": [\"claude-code\"] } in shadowlap.config.json, or test with --guard warn to accept every connection the guard can't watch. A Node or Python process whose guard could not start says so on its standard error.";

/**
 * Whether the preloads loaded in the newest run that says (`RunMeta.preloads`): the processes they
 * loaded in, or, for a run that made calls with none, why, and how to get them in. Null when no run
 * says, as runs made before the preloads said hello don't.
 */
export function preloadCheck(runs: readonly RunRecord[]): Check | null {
  const last = runs.find((r) => r.meta?.preloads && r.status !== 'running');
  const preloads = last?.meta?.preloads;
  if (!last || !preloads) return null;
  const id = last.runId.slice(0, 10);
  if (preloads.missing) return { name: 'preload', verdict: 'warn', detail: `run ${id} (${quoteArgv(last.command.argv)}): ${preloads.missing}`, fix: PRELOAD_FIX };
  // A process that runs with no guard, the Claude Code CLI the Claude Agent SDK runs among them: nothing watched its connections.
  if (preloads.unguarded) return { name: 'preload', verdict: 'warn', detail: `run ${id} (${quoteArgv(last.command.argv)}): ${preloads.unguarded}`, fix: UNGUARDED_FIX };
  const runtime = (r: string) => (r === 'node' ? 'Node' : r === 'python' ? 'Python' : r === 'claude-code' ? 'Claude Code' : r);
  const loaded = Object.entries(preloads.hellos).map(([r, n]) => `${n} ${runtime(r)} process${n === 1 ? '' : 'es'}`);
  return loaded.length ? { name: 'preload', verdict: 'ok', detail: `loaded in run ${id}'s ${loaded.join(' and ')}` } : null;
}

/** The tools a run's model was offered: in any of its requests, or in its first that names them (empty when none says). */
function offeredTools(store: StoreOf<'recording'>, calls: readonly CallRecord[], everyRequest: boolean): Set<string> {
  const offered = new Set<string>();
  for (const c of calls) {
    if (c.kind !== 'api' || !c.requestRef) continue;
    try {
      const body = loadApiRequest(store, c.requestRef);
      if (isObject(body)) for (const name of toolDefinitions(body).keys()) offered.add(name);
    } catch {
      // an unreadable request offers nothing we can name
    }
    if (!everyRequest && offered.size) break;
  }
  return offered;
}

/** What a rule that names a tool no recording knows does, by what it names the tool for. */
const UNKNOWN: Record<NamedTool['use'], string> = {
  count: 'so the count is of calls that never happen',
  rule: 'so the rule has no call to check',
  after: 'so every call the rule checks fails it',
  reference: 'so the value it reads is never there, and the rule fails wherever it reads it',
  condition: 'so the condition never holds and the rule is never applied',
};

/** What a rule that reads a value no recorded call has does, by what it reads it for. */
const UNREAD: Record<NamedPath['use'], string> = {
  rule: 'so the rule fails on every call it checks',
  reference: 'so a rule that reads it fails, or a condition that reads it is inconclusive',
  condition: 'so whether the condition held can\'t be told, and its checks read inconclusive',
};

/** How many of the store's runs, newest first, the rules are held against beside the packs. */
export const STORE_RUNS = 200;

/** A recording the rules are held against: its calls, how to read them, and the tools its model was offered. */
interface Held {
  calls: CallRecord[];
  input: RecordedCalls['input'];
  offered: Set<string>;
}

/**
 * The judge checks whose model retires, by the table that ships with Shadowlap. A judge asked a
 * model its provider has shut down gets no verdict, so its checks read not judged wherever a replay
 * forks or a golden is packed; and the retirement notices on recordings leave a judge's calls out,
 * since they are no model the agent uses, so this is where it is said.
 */
export function judgeRetirements(entries: readonly TestEntry[], now = Date.now()): Check[] {
  const out: Check[] = [];
  for (const e of entries) {
    for (const j of judgeChecksOf(e.spec)) {
      const target = judgeTarget(j.model);
      const n = target ? retirementOf(target.provider, target.model, { now }) : null;
      if (!n) continue;
      const instead = n.replacements.length ? `, such as ${n.replacements.join(' or ')}` : '';
      out.push({ name: 'judge model', verdict: 'warn', detail: `judge "${j.name}" in tests["${e.recording}"]: ${n.text}`, fix: `Give it another model${instead}, then record its verdicts again: shadowlap test ${e.recording} --update. Source: ${n.source}` });
    }
  }
  return out;
}

/**
 * The packs each entry under `tests` applies to, by the entry's key: a pack an entry's pattern
 * matches belongs to the entry `shadowlap test` reads its checks from (the most specific).
 */
function packsByEntry(cwd: string, entries: readonly TestEntry[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const e of entries) {
    let dirs: string[] = [];
    try {
      dirs = expandRecordings([e.recording], cwd).dirs.filter((d) => existsSync(join(resolve(cwd, d), 'run.json')));
    } catch {
      // a wildcard where the reader takes none: loadTests would have said so
    }
    for (const d of dirs) {
      const key = testsKeyFor(entries, resolve(cwd, d), cwd);
      if (key === null) continue;
      const list = byKey.get(key) ?? [];
      if (!list.includes(d)) list.push(d);
      byKey.set(key, list);
    }
  }
  return byKey;
}

/** The packs the entries under `tests` apply to, each read once, for every check that holds the config against them. */
export interface TestPacks {
  /** The packs each entry applies to, by the entry's key (packsByEntry). */
  byKey: Map<string, string[]>;
  /**
   * Each pack that could be read, by its directory: its run, in a store of its own in memory. A
   * pack that can't be read is left out: shadowlap test reports it.
   */
  read: Map<string, { run: RunRecord; store: Store }>;
}

/** Reads every pack the entries apply to, once each. The caller closes them (closePacks). */
export function readTestPacks(cwd: string, entries: readonly TestEntry[]): TestPacks {
  const packs: TestPacks = { byKey: packsByEntry(cwd, entries), read: new Map() };
  for (const dir of new Set([...packs.byKey.values()].flat())) {
    try {
      packs.read.set(dir, packRecording(resolve(cwd, dir)));
    } catch {
      // a pack that can't be read: shadowlap test reports it
    }
  }
  return packs;
}

export function closePacks(packs: TestPacks): void {
  for (const { store } of packs.read.values()) store.close();
}

/** `fn` over the packs: those given, or read here and closed after. */
function withPacks<T>(cwd: string, entries: readonly TestEntry[], given: TestPacks | undefined, fn: (packs: TestPacks) => T): T {
  if (given) return fn(given);
  const packs = readTestPacks(cwd, entries);
  try {
    return fn(packs);
  } finally {
    closePacks(packs);
  }
}

/** `a`, `a and b`, `a, b and c`. */
function inWords(list: readonly string[]): string {
  return list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)!}`;
}

/** Check names as a sentence names them: `"a"`, `"a" and "b"`. */
const quotedList = (list: readonly string[]) => inWords(list.map((n) => `"${n}"`));

/** The variables a provider's key is read from, as a fix names them: `ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)`. */
const keyNames = (provider: JudgeProvider) => `${JUDGE_KEYS[provider][0]!}${JUDGE_KEYS[provider].length > 1 ? ` (or ${JUDGE_KEYS[provider].slice(1).join(' or ')})` : ''}`;

/** Whether a judge can be asked live from this environment: a key for its provider, or an upstream set for it. */
function askable(provider: JudgeProvider, env: NodeJS.ProcessEnv): boolean {
  return !('why' in liveJudge(provider, upstreamOverrides(env), env));
}

/**
 * The judge checks no judge can be asked for from this environment: no key for the provider of
 * their model and no upstream set for it (SHADOWLAP_UPSTREAM_<PROVIDER>, or the SDK base URL a run
 * would use). Packing, `test --update`, a golden that forks, and blame, verify, repair and tasks
 * score ask a judge live where the recording holds no verdict for the very request; without a way
 * to ask, each such check reads not judged (inconclusive), as every check does offline. One warning
 * per provider, naming its checks.
 */
export function judgeKeys(entries: readonly TestEntry[], env: NodeJS.ProcessEnv): Check[] {
  const byProvider = new Map<JudgeProvider, string[]>();
  for (const e of entries) {
    for (const j of judgeChecksOf(e.spec)) {
      const target = judgeTarget(j.model);
      if (!target || askable(target.provider, env)) continue;
      const list = byProvider.get(target.provider) ?? [];
      list.push(`judge "${j.name}" in tests["${e.recording}"]`);
      byProvider.set(target.provider, list);
    }
  }
  return [...byProvider].map(([provider, checks]) => {
    const shown = checks.length > 3 ? `${checks.slice(0, 3).join(', ')} and ${checks.length - 3} more` : inWords(checks);
    return {
      name: 'judge key',
      verdict: 'warn' as const,
      detail: `no key for ${provider} in this environment (${JUDGE_KEYS[provider].join(' or ')}), so ${shown} can't be asked live: packing, test --update, a golden that forks, blame, verify, repair and tasks score read ${checks.length === 1 ? 'it' : 'each'} not judged (inconclusive) wherever its verdict isn't recorded, as a test offline does`,
      fix: `Set ${keyNames(provider)} where judges are asked, or SHADOWLAP_UPSTREAM_${provider.toUpperCase()} to a server that answers for ${provider}. A clean replay of a golden that holds the verdict needs no key.`,
    };
  });
}

/**
 * The judge checks of a golden that a clean replay of it would want a verdict for and not find: each
 * one that applies to the recording, read as `shadowlap test` reads a clean replay's checks, from
 * the recorded calls with the verdicts the recording holds. A judge under a `when` whose condition
 * never held there is not applicable, and asks for no verdict (`test --update` records none for
 * it); one whose condition can't be told is inconclusive whatever a judge would say, and `check
 * rules` names the value it can't read. A verdict given to an older form of the judge's request
 * answers none, since a replay sends the request as it is now: `older` names those.
 */
function wantedVerdicts(store: Store, calls: CallRecord[], entry: TestEntry, judges: readonly JudgeCheck[]): { none: JudgeCheck[]; older: JudgeCheck[] } {
  const verdicts = new Map<string, JudgeVerdict>();
  const older = new Set<string>();
  for (const j of judges) {
    const held = heldVerdict(store, calls, j);
    if (!held) continue;
    if ((calls.find((c) => c.callNo === held.callNo)?.meta.judge?.v ?? 1) === JUDGE_REQUEST_VERSION) verdicts.set(j.name, held);
    else older.add(j.name);
  }
  // A judge check that applies and has no verdict is inconclusive with its judge's outcome; under a
  // `when` that never held, or couldn't be told, its result carries none. What the agent printed
  // decides no condition, and no judge result here.
  const results = evaluateChecks(entry.spec, storedCheckInput(store, calls, ''), { judgeVerdicts: verdicts });
  const wanting = new Set(results.flatMap((r) => (r.judge && r.status === 'inconclusive' ? [r.judge.name] : [])));
  return { none: judges.filter((j) => wanting.has(j.name) && !older.has(j.name)), older: judges.filter((j) => wanting.has(j.name) && older.has(j.name)) };
}

/**
 * Goldens that hold no recorded verdict for a judge check that applies to them. `shadowlap test` runs
 * offline, so a clean replay is judged only from its recording: each such check reads not judged
 * (inconclusive) and fails the run unless inconclusive verdicts warn. A judge under a `when` whose
 * condition never held in the golden is not applicable there and needs none (wantedVerdicts). A
 * verdict given to an older form of the judge's request counts as none, since a replay sends the
 * request as it is now. One warning per golden, naming the checks, with the command that records
 * them; a golden whose run did not complete is never judged, and says so instead.
 */
export function judgeVerdicts(cwd: string, entries: readonly TestEntry[], env: NodeJS.ProcessEnv, packs?: TestPacks): Check[] {
  return withPacks(cwd, entries, packs, ({ byKey, read }) => {
    const out: Check[] = [];
    for (const [key, dirs] of byKey) {
      const entry = entries.find((e) => e.recording === key);
      const judges = entry ? judgeChecksOf(entry.spec) : [];
      if (!entry || !judges.length) continue;
      for (const dir of dirs) {
        const pack = read.get(dir);
        if (!pack) continue; // a pack that can't be read: shadowlap test reports it
        const { run, store } = pack;
        const { none, older } = wantedVerdicts(store, store.getCalls(run.runId), entry, judges);
        if (!none.length && !older.length) continue;
        const missing = [...none, ...older];
        const parts = [none.length ? `no recorded verdict for judge${none.length === 1 ? '' : 's'} ${quotedList(none.map((j) => j.name))}` : '', older.length ? `${none.length ? 'and only ' : 'only '}a verdict given to an older form of the judge's request for ${quotedList(older.map((j) => j.name))}, which a replay no longer sends` : ''].filter(Boolean);
        const cannot = cannotJudge(run);
        if (cannot) {
          out.push({ name: 'judge verdicts', verdict: 'warn', detail: `${dir} holds ${parts.join(' ')}, and ${cannot}`, fix: `Pack a run of it that completed, then record the verdicts: shadowlap test ${quoteArgv([dir])} --update.` });
          continue;
        }
        // The keys --update needs, for the judges it would ask.
        const providers = [...new Set(missing.map((j) => judgeTarget(j.model)?.provider).filter((x): x is JudgeProvider => !!x && !askable(x, env)))];
        out.push({
          name: 'judge verdicts',
          verdict: 'warn',
          detail: `${dir} holds ${parts.join(' ')}, so a test of it, which runs offline, reads ${missing.length === 1 ? 'it' : 'them'} not judged (inconclusive) and fails unless --inconclusive warn`,
          fix: `Record ${missing.length === 1 ? 'it' : 'them'}${providers.length ? ` with ${providers.map(keyNames).join(' and ')} set` : ''}: shadowlap test ${quoteArgv([dir])} --update asks the judge live once and keeps its call in the golden.`,
        });
      }
    }
    return out;
  });
}

/**
 * Rules under `tests` held against every recording there is: the packs the entries apply to
 * (`packs`, or read here) and the store's newest runs, read without changing either. A tool a rule
 * names that no recording called or offered its model is most likely misspelt, or renamed since, and
 * a rule on it checks nothing; one the agent has but no recording called yet is left alone (a rule
 * that guards against a call, on a golden that never makes it, is what it should be). A value a rule
 * reads that no recorded call of its tool has (a misspelt `result.totl`) fails the rule, or leaves a
 * condition undecided. An entry with checks and no pack is named too. The home for later checks on
 * checks.
 */
export function checkRules(cwd: string, entries: readonly TestEntry[], dbPath?: string, packs?: TestPacks): Check[] {
  return withPacks(cwd, entries, packs, (p) => rulesAgainst(entries, p, dbPath));
}

function rulesAgainst(entries: readonly TestEntry[], { byKey, read }: TestPacks, dbPath: string | undefined): Check[] {
  const out: Check[] = [];
  const stores: Store[] = [];
  try {
    const held: Held[] = [];
    const hold = (store: StoreOf<'recording'>, calls: CallRecord[], everyRequest: boolean) => held.push({ calls, input: storedCalls(store), offered: offeredTools(store, calls, everyRequest) });
    // The packs are read already (readTestPacks); a pack that can't be read is not among them.
    for (const { run, store } of read.values()) hold(store, store.getCalls(run.runId), true);
    const packsRead = read.size;
    let runsRead = 0;
    if (dbPath && existsSync(dbPath)) {
      const store = Store.open(dbPath);
      stores.push(store);
      const runs = store.allRuns().filter((r) => r.status !== 'running').sort((a, b) => b.startedAt - a.startedAt).slice(0, STORE_RUNS);
      // A run's first model request names the tools its model has; reading every request of hundreds of runs would make doctor slow.
      for (const r of runs) hold(store, store.getCalls(r.runId), false);
      runsRead = runs.length;
    }
    const called = new Set(held.flatMap((h) => h.calls.filter((c) => c.kind === 'tool').map((c) => c.name)));
    const offered = new Set(held.flatMap((h) => [...h.offered]));
    const where = [packsRead ? `${packsRead} pack${packsRead === 1 ? '' : 's'}` : '', runsRead ? `${runsRead} run${runsRead === 1 ? '' : 's'} in the store` : ''].filter(Boolean).join(' and ') || 'no recordings';
    const calledList = [...called].sort();
    const theyCall = calledList.length ? `the recordings call ${calledList.length > 8 ? `${calledList.slice(0, 8).join(', ')} and ${calledList.length - 8} more` : calledList.join(', ')}` : 'the recordings call no tools';
    for (const e of entries) {
      const names = toolsNamed(e.spec, `${CONFIG_FILE}: tests["${e.recording}"].expect`);
      if (!names.length) continue;
      if (!(byKey.get(e.recording) ?? []).length) {
        out.push({ name: 'check rules', verdict: 'warn', detail: `tests["${e.recording}"] has checks but no recording: there is no pack ${e.recording.includes('*') ? 'that matches it' : 'there'}`, fix: `Pack a run there (shadowlap pack <run> ${e.recording.includes('*') ? e.recording.replace(/\*/g, 'name') : e.recording}), or remove the entry.` });
      }
      if (!held.length) continue;
      const seen = new Set<string>();
      for (const n of names) {
        if (called.has(n.tool) || offered.has(n.tool)) continue;
        // A "never" count on a tool nobody can tell is unknown, when no request names its tools.
        if (n.use === 'count' && n.zero && !offered.size) continue;
        if (seen.has(`${n.tool} ${n.at}`)) continue;
        seen.add(`${n.tool} ${n.at}`);
        const meant = closestName(n.tool, new Set([...called, ...offered]));
        out.push({ name: 'check rules', verdict: 'warn', detail: `${n.at} names ${n.tool}, which no recording called or offered to its model (${where}), ${UNKNOWN[n.use]}`, fix: meant ? `Did you mean ${meant}? Otherwise check the name: ${theyCall}.` : `Check the name: ${theyCall}.` });
      }
      for (const u of unreadPaths(pathsNamed(e.spec), held)) {
        const last = u.path.at(-1);
        const meant = last?.type === 'key' ? closestName(last.key, u.keys) : null;
        const has = u.keys.length ? `they have ${u.keys.length > 8 ? `${u.keys.slice(0, 8).join(', ')} and ${u.keys.length - 8} more` : u.keys.join(', ')} there` : `they have nothing there`;
        out.push({ name: 'check rules', verdict: 'warn', detail: `${u.at} reads ${u.text} from ${u.tool}, which none of its ${u.calls} recorded call${u.calls === 1 ? '' : 's'} has, ${UNREAD[u.use]}`, fix: `${meant ? `Did you mean ${meant}? ` : ''}Check the path: ${has}.` });
      }
    }
    if (!out.length && held.length) out.push({ name: 'check rules', verdict: 'ok', detail: `every tool and value the checks name is in the recordings (${where})` });
  } finally {
    for (const s of stores) s.close();
  }
  return out;
}

export function formatDoctor(checks: Check[], p: { green: (s: string) => string; yellow: (s: string) => string; red: (s: string) => string; dim: (s: string) => string }): string {
  const mark = { ok: p.green('✓'), warn: p.yellow('!'), fail: p.red('✗') };
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => `${mark[c.verdict]} ${c.name.padEnd(width)}  ${c.detail}${c.fix ? `\n  ${' '.repeat(width)}  ${p.dim(c.fix)}` : ''}`);
  const fails = checks.filter((c) => c.verdict === 'fail').length;
  const warns = checks.filter((c) => c.verdict === 'warn').length;
  lines.push('', fails ? p.red(`${fails} problem${fails === 1 ? '' : 's'}`) + (warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '') : warns ? p.yellow(`${warns} warning${warns === 1 ? '' : 's'}, nothing blocking`) : p.green('everything looks fine'));
  return lines.join('\n');
}
