import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, Store, loadApiRequest, toolDefinitions, type CallRecord } from '@shadowlap/engine';
import { packRecording } from './check-recordings.js';
import { toolsNamed, type NamedTool, type TestEntry } from './checks.js';
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
      if (tests.length) checks.push(...checkRules(cwd, tests));
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

/** The tools a run called, and those its model was offered in any request (empty when no request says). */
function toolsOfRun(store: Store, calls: readonly CallRecord[]): { called: Set<string>; offered: Set<string> } {
  const called = new Set(calls.filter((c) => c.kind === 'tool').map((c) => c.name));
  const offered = new Set<string>();
  for (const c of calls) {
    if (c.kind !== 'api' || !c.requestRef) continue;
    try {
      const body = loadApiRequest(store, c.requestRef);
      if (body && typeof body === 'object' && !Array.isArray(body)) for (const name of toolDefinitions(body as Record<string, unknown>).keys()) offered.add(name);
    } catch {
      // an unreadable request offers nothing we can name
    }
  }
  return { called, offered };
}

/** How many single-character edits turn one name into the other. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** The known name a misspelt one most likely meant: within a third of its length in edits, or null. */
export function closestName(name: string, known: Iterable<string>): string | null {
  let best: { name: string; d: number } | null = null;
  for (const k of known) {
    const d = editDistance(name.toLowerCase(), k.toLowerCase());
    if (d <= Math.max(1, Math.floor(name.length / 3)) && (!best || d < best.d)) best = { name: k, d };
  }
  return best?.name ?? null;
}

/** What a rule that names a tool no recording called does on those recordings, by what it names the tool for. */
const UNCALLED: Record<NamedTool['use'], string> = {
  count: 'so the check fails on every one of them',
  rule: 'so the rule has no call of it to check there',
  after: 'so every call the rule checks fails it',
  reference: 'so the value it reads is never there, and the rule fails wherever it reads it',
  condition: 'so the condition never holds there and the rule is not applicable',
};

/**
 * Rules under `tests` that name a tool none of their recordings called, checked against the packs
 * each entry applies to (read without touching the store). A tool the recordings never called and
 * never offered their model is most likely misspelt, or renamed since, and a check on it checks
 * nothing; one they offered but never called makes a rule that needs the call check nothing, or
 * always fail. A count that allows none ("never call delete_account") is what it says, so it is
 * reported only for a tool the recordings don't know. The home for later checks on checks.
 */
export function checkRules(cwd: string, entries: readonly TestEntry[]): Check[] {
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
  let named = 0;
  for (const e of entries) {
    const dirs = byKey.get(e.recording) ?? [];
    const names = toolsNamed(e.spec, `${CONFIG_FILE}: tests["${e.recording}"].expect`);
    if (!names.length) continue;
    if (!dirs.length) {
      out.push({ name: 'check rules', verdict: 'warn', detail: `tests["${e.recording}"] has checks but no recording: there is no pack ${e.recording.includes('*') ? 'that matches it' : 'there'}`, fix: `Pack a run there (shadowlap pack <run> ${e.recording.includes('*') ? e.recording.replace(/\*/g, 'name') : e.recording}), or remove the entry.` });
      continue;
    }
    const called = new Set<string>();
    const offered = new Set<string>();
    for (const dir of dirs) {
      try {
        const { run, store } = packRecording(resolve(cwd, dir));
        try {
          const t = toolsOfRun(store, store.getCalls(run.runId));
          t.called.forEach((x) => called.add(x));
          t.offered.forEach((x) => offered.add(x));
        } finally {
          store.close();
        }
      } catch {
        // a pack that can't be read: shadowlap test reports it
      }
    }
    const recordings = `${dirs.length === 1 ? dirs[0] : `the ${dirs.length} recordings of ${e.recording}`}`;
    const seen = new Set<string>();
    for (const n of names) {
      if (called.has(n.tool)) continue;
      const known = offered.has(n.tool);
      // A "never" count on a tool the agent has is the point; one on a tool nobody knows checks nothing.
      if (n.use === 'count' && n.zero && (known || !offered.size)) continue;
      if (seen.has(`${n.tool} ${n.at}`)) continue;
      seen.add(`${n.tool} ${n.at}`);
      named++;
      const calledList = [...called].sort();
      const meant = closestName(n.tool, new Set([...called, ...offered]));
      const theyCall = calledList.length ? `they call ${calledList.length > 8 ? `${calledList.slice(0, 8).join(', ')} and ${calledList.length - 8} more` : calledList.join(', ')}` : 'they call no tools';
      out.push(
        known
          ? { name: 'check rules', verdict: 'warn', detail: `${n.at} names ${n.tool}, which ${recordings} never called, ${UNCALLED[n.use]}`, fix: `Record a run that calls ${n.tool}, or try the rule on the runs it is meant for: shadowlap check --expect '<the rule>' <runs>.` }
          : { name: 'check rules', verdict: 'warn', detail: `${n.at} names ${n.tool}, which ${recordings} never called or offered to the model${offered.size ? '' : ' (no request there names its tools)'}`, fix: meant ? `Did you mean ${meant}? Otherwise check the name: ${theyCall}.` : `Check the name: ${theyCall}.` },
      );
    }
  }
  if (!named && !out.length) {
    const recordings = [...byKey.values()].reduce((sum, d) => sum + d.length, 0);
    if (recordings) out.push({ name: 'check rules', verdict: 'ok', detail: `every tool the checks name is called in their recordings (${recordings} recording${recordings === 1 ? '' : 's'})` });
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
