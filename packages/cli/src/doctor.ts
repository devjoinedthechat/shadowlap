import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, Store, judgeTarget, loadApiRequest, retirementOf, toolDefinitions, type CallRecord } from '@shadowlap/engine';
import { packRecording } from './check-recordings.js';
import { closestName, judgeChecksOf, pathsNamed, storedCalls, toolsNamed, unreadPaths, type NamedPath, type NamedTool, type RecordedCalls, type TestEntry } from './checks.js';
import { CONFIG_FILE, configPath as configFile, defaultDbPath, loadConfig, loadTests } from './config.js';
import { expandRecordings, testsKeyFor } from './goldens.js';

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
}

const MIN_NODE = [22, 13] as const;

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function runDoctor(options: DoctorOptions): Check[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const checks: Check[] = [];
  const push = (name: string, verdict: Verdict, detail: string, fix?: string) => checks.push({ name, verdict, detail, ...(fix ? { fix } : {}) });

  // Runtime
  const nodeVersion = options.nodeVersion ?? process.version;
  const [maj, min] = parseVersion(nodeVersion);
  const nodeOk = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  push('node', nodeOk ? 'ok' : 'fail', `${nodeVersion} (shadowlap ${options.version})`, nodeOk ? undefined : `Shadowlap needs Node ≥ ${MIN_NODE.join('.')} for the built-in SQLite; install a current Node LTS.`);
  let sqlite = 'built-in SQLite available';
  let sqliteOk = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = (globalThis as { process: { getBuiltinModule?: (id: string) => unknown } }).process.getBuiltinModule?.('node:sqlite') as { DatabaseSync: new (p: string) => { close(): void } };
    new DatabaseSync(':memory:').close();
  } catch (err) {
    sqlite = `node:sqlite unavailable: ${err instanceof Error ? err.message : String(err)}`;
    sqliteOk = false;
  }
  push('sqlite', sqliteOk ? 'ok' : 'fail', sqlite, sqliteOk ? undefined : 'Use Node ≥ 22.13, or a build of Node with node:sqlite enabled.');

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
      const j = JSON.parse(readFileSync(active, 'utf8')) as { runId?: string; pid?: number; url?: string };
      const stale = typeof j.pid === 'number' && !alive(j.pid);
      push('active run', stale ? 'warn' : 'ok', stale ? `${active} points at run ${j.runId?.slice(0, 10)} from a process that is gone` : `run ${j.runId?.slice(0, 10)} at ${j.url} (pid ${j.pid})`, stale ? 'Delete .shadowlap/active.json; shadowlap mcp would otherwise try that sidecar first.' : undefined);
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
      const tests = loadTests(cwd);
      if (tests.length) parts.push(`checks for ${tests.length} recording${tests.length === 1 ? '' : 's'}`);
      push('config', 'ok', `${configPath}: ${parts.join(', ')}`);
      if (tests.length) {
        // What goes wrong reading the packs says nothing about the config, which parsed.
        try {
          checks.push(...checkRules(cwd, tests, dbPath));
        } catch (err) {
          push('check rules', 'warn', `the tools the checks name could not be held against their recordings: ${err instanceof Error ? err.message : String(err)}`);
        }
        checks.push(...judgeRetirements(tests));
      }
    } catch (err) {
      push('config', 'fail', `${configPath}: ${err instanceof Error ? err.message : String(err)}`, 'Fix the JSON; shadowlap normalize ls / redact ls print what is loaded.');
    }
  }

  // Environment that changes routing
  const upstreams = Object.entries(env).filter(([k, v]) => k.startsWith('SHADOWLAP_UPSTREAM_') && v);
  if (upstreams.length) push('upstream overrides', 'ok', upstreams.map(([k, v]) => `${k}=${v}`).join(' '));
  const baseUrls = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'].filter((k) => env[k]);
  if (baseUrls.length && !env.SHADOWLAP_URL) push('provider base URLs', 'warn', baseUrls.map((k) => `${k}=${env[k]}`).join(' '), 'shadowlap run points the agent at its sidecar and forwards these providers\' calls to the URLs set here (SHADOWLAP_UPSTREAM_<PROVIDER> takes precedence). Check they are what you expect.');
  if (env.SHADOWLAP_URL) push('SHADOWLAP_URL', 'warn', `${env.SHADOWLAP_URL} (run ${env.SHADOWLAP_RUN_ID ?? '?'})`, 'Set by shadowlap run for the agent; SDK calls made from this shell would go to that sidecar.');
  const offTelemetry = env.SHADOWLAP_TELEMETRY === '0' || env.DO_NOT_TRACK === '1';
  push('telemetry', 'ok', offTelemetry ? 'off (SHADOWLAP_TELEMETRY=0 or DO_NOT_TRACK=1)' : env.SHADOWLAP_TELEMETRY_URL ? `on, anonymous counts only → ${env.SHADOWLAP_TELEMETRY_URL}; SHADOWLAP_TELEMETRY=0 turns it off` : 'off: no collector configured (SHADOWLAP_TELEMETRY_URL), so nothing is sent');
  if (/node-(guard|preload)\.mjs/.test(env.NODE_OPTIONS ?? '')) push('NODE_OPTIONS', 'warn', 'contains the Shadowlap preload', 'That is the agent process configuration leaking into your shell; unset NODE_OPTIONS.');
  if ((env.PYTHONPATH ?? '').split(delimiter).some((p) => p.endsWith('guard'))) push('PYTHONPATH', 'warn', 'contains the Shadowlap guard directory', 'Unset it outside agent processes.');

  return checks;
}

/** The tools a run's model was offered: in any of its requests, or in its first that names them (empty when none says). */
function offeredTools(store: Store, calls: readonly CallRecord[], everyRequest: boolean): Set<string> {
  const offered = new Set<string>();
  for (const c of calls) {
    if (c.kind !== 'api' || !c.requestRef) continue;
    try {
      const body = loadApiRequest(store, c.requestRef);
      if (body && typeof body === 'object' && !Array.isArray(body)) for (const name of toolDefinitions(body as Record<string, unknown>).keys()) offered.add(name);
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
 * Rules under `tests` held against every recording there is: the packs the entries apply to and the
 * store's newest runs, read without changing either. A tool a rule names that no recording called
 * or offered its model is most likely misspelt, or renamed since, and a rule on it checks nothing;
 * one the agent has but no recording called yet is left alone (a rule that guards against a call,
 * on a golden that never makes it, is what it should be). A value a rule reads that no recorded call
 * of its tool has (a misspelt `result.totl`) fails the rule, or leaves a condition undecided. An
 * entry with checks and no pack is named too. The home for later checks on checks.
 */
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

export function checkRules(cwd: string, entries: readonly TestEntry[], dbPath?: string): Check[] {
  const out: Check[] = [];
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
  const stores: Store[] = [];
  try {
    const held: Held[] = [];
    const hold = (store: Store, calls: CallRecord[], everyRequest: boolean) => held.push({ calls, input: storedCalls(store), offered: offeredTools(store, calls, everyRequest) });
    const packs = [...new Set([...byKey.values()].flat())];
    let packsRead = 0;
    for (const dir of packs) {
      try {
        const { run, store } = packRecording(resolve(cwd, dir));
        stores.push(store);
        hold(store, store.getCalls(run.runId), true);
        packsRead++;
      } catch {
        // a pack that can't be read: shadowlap test reports it
      }
    }
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
