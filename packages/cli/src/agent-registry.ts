import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Which sidecar and run a process Shadowlap started belongs to, for a `shadowlap mcp` proxy started
 * further down that process's tree.
 *
 * The proxy learns its sidecar from SHADOWLAP_URL and SHADOWLAP_RUN_ID when it gets them. But MCP
 * clients start servers with a minimal environment (the official SDKs pass PATH, HOME and a few
 * more), so under `shadowlap test`, `blame`, `verify` or `replay --repeat` the proxy would find no
 * sidecar and forward every tool call, writes included. So whenever the CLI starts an agent, it
 * writes a small file named after the agent's process id, holding the sidecar's address and the
 * run, and removes it when the agent exits. The proxy walks up its own ancestors and takes the
 * nearest one's. Attempts running at once never collide: each agent has its own process id.
 *
 * The files live in `~/.shadowlap/agents` (the home folder is what clients pass on), or, when that
 * can't be written, in the project's `.shadowlap/agents`. They carry the sidecar's session token,
 * so the folder is owner-only, and a file is trusted only when it is the user's own, owner-only,
 * not a link, names the process it is filed under, and names that process's parent correctly.
 */

export interface SidecarTarget {
  url: string;
  runId: string;
}

/** What `shadowlap mcp` found: the run to record into, nothing (not under Shadowlap), or a reason it can't record. */
export type SidecarLookup = { kind: 'sidecar'; target: SidecarTarget; from: string } | { kind: 'unusable'; reason: string } | { kind: 'none' };

interface Registration {
  v: 1;
  /** The agent's process id: the file's name. */
  pid: number;
  /** The process that started it: the Shadowlap CLI. */
  parent: number;
  url: string;
  runId: string;
}

const FOLDER = join('.shadowlap', 'agents');

/** The sidecar only ever listens on loopback; anything else is not a Shadowlap sidecar. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

function safeHome(): string | null {
  try {
    return homedir() || null;
  } catch {
    return null;
  }
}

/** The folders a registration may be in, in the order they are tried: the home folder's, then the project's. */
export function registryDirs(cwd: string = process.cwd(), home: string | null = safeHome()): string[] {
  return [...(home ? [join(home, FOLDER)] : []), join(resolve(cwd), FOLDER)];
}

const ownUid = typeof process.getuid === 'function' ? process.getuid() : null;

/** Why a folder or file can't be trusted with a session token, or null. Ownership and modes are POSIX ideas; Windows keeps home folders private. */
function untrusted(st: Stats, what: string, kind: 'dir' | 'file'): string | null {
  if (st.isSymbolicLink()) return `${what} is a symbolic link`;
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) return `${what} is not a ${kind === 'dir' ? 'folder' : 'regular file'}`;
  if (ownUid !== null && st.uid !== ownUid) return `${what} belongs to another user`;
  if (ownUid !== null && (st.mode & 0o077) !== 0) return `${what} can be read by other users`;
  return null;
}

/** Makes the folder owner-only, creating it if need be; false when it can't be used. */
function prepareDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || (ownUid !== null && st.uid !== ownUid)) return false;
    if (ownUid !== null && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes files left by agents whose process is gone (a CLI that was killed can't clean up). */
function prune(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(name);
      if (m && !alive(Number(m[1]))) rmSync(join(dir, name), { force: true });
    }
  } catch {
    // best effort
  }
}

/**
 * Publishes the sidecar and run of an agent this process started, until the returned function is
 * called. Written to the first folder that can be used; false when none could.
 */
export function registerAgent(pid: number, target: SidecarTarget, o: { cwd?: string; home?: string | null } = {}): { unregister: () => void; file: string | null } {
  const body: Registration = { v: 1, pid, parent: process.pid, url: target.url, runId: target.runId };
  for (const dir of registryDirs(o.cwd, o.home === undefined ? safeHome() : o.home)) {
    if (!prepareDir(dir)) continue;
    prune(dir);
    const file = join(dir, `${pid}.json`);
    try {
      // Written fresh, so a link or a file left at that path is replaced, never followed.
      rmSync(file, { force: true });
      writeFileSync(file, JSON.stringify(body) + '\n', { mode: 0o600, flag: 'wx' });
    } catch {
      continue;
    }
    let done = false;
    return {
      file,
      unregister: () => {
        if (done) return;
        done = true;
        rmSync(file, { force: true });
      },
    };
  }
  return { file: null, unregister: () => {} };
}

/**
 * `spawn`, for an agent whose calls belong to `target`'s run: its sidecar is published under its
 * process id while it runs, for the MCP proxies its clients start.
 */
export function spawnAgent(command: string, args: readonly string[], options: SpawnOptions, target: SidecarTarget): ChildProcess {
  const child = spawn(command, args, options);
  if (child.pid !== undefined) {
    const { unregister } = registerAgent(child.pid, target, { cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd() });
    child.once('exit', unregister);
    child.once('error', unregister);
  }
  return child;
}

// ---------------------------------------------------------------------------------------------- the process tree

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** The command line, as far as the system shows it. */
  args: string | null;
}

/** Every process with its parent and command line, from `ps` (macOS and the BSDs) or PowerShell (Windows). */
function processTable(): Map<number, ProcessInfo> | null {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      if (r.status !== 0 || !r.stdout) return null;
      const table = new Map<number, ProcessInfo>();
      for (const line of r.stdout.split(/\r?\n/)) {
        const [pid, ppid, ...rest] = line.split('\t');
        if (pid && ppid && /^\d+$/.test(pid) && /^\d+$/.test(ppid)) table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), args: rest.join('\t') || null });
      }
      return table;
    }
    const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return null;
    const table = new Map<number, ProcessInfo>();
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] || null });
    }
    return table;
  } catch {
    return null;
  }
}

/** One process from Linux's /proc: its parent from `stat` (after the command name, which may hold anything), its command line from `cmdline`. */
function procInfo(pid: number): ProcessInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid)) return null;
    let args: string | null = null;
    try {
      args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') || null;
    } catch {
      // a process of another user, or one that just ended
    }
    return { pid, ppid, args };
  } catch {
    return null;
  }
}

/**
 * This process and its ancestors, nearest first, up to (not including) the system's first process.
 * Null when the system won't say beyond the parent.
 */
export function processAncestors(): ProcessInfo[] | null {
  const chain: ProcessInfo[] = [{ pid: process.pid, ppid: process.ppid, args: process.argv.join(' ') }];
  const linux = process.platform === 'linux' && existsSync('/proc/self/stat');
  const table = linux ? null : processTable();
  if (!linux && !table) return null;
  const lookup = (pid: number) => (linux ? procInfo(pid) : (table!.get(pid) ?? null));
  const seen = new Set([process.pid]);
  for (let pid = process.ppid; pid > 1 && !seen.has(pid) && chain.length < 64; ) {
    seen.add(pid);
    const info = lookup(pid);
    if (!info) break;
    chain.push(info);
    pid = info.ppid;
  }
  return chain;
}

/** The Shadowlap commands that start agents. */
const STARTS_AGENTS = new Set(['run', 'replay', 'test', 'blame', 'verify', 'calibrate', 'repair', 'fix', 'bisect', 'tasks']);

/**
 * Whether a command line is the Shadowlap CLI running a command that starts agents. Used only to
 * refuse writes when such an ancestor is seen but its sidecar can't be found.
 */
export function startsAgents(args: string | null): boolean {
  if (!args) return false;
  const tokens = args.split(/\s+/).filter(Boolean);
  const at = tokens.findIndex((t) => /(?:^|[\\/])shadowlap(?:\.[cm]?js|\.cmd|\.exe)?["']?$/i.test(t));
  if (at < 0) return false;
  for (let i = at + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--db') {
      i++;
      continue;
    }
    if (t.startsWith('-')) continue;
    return STARTS_AGENTS.has(t);
  }
  return false;
}

/** The project folders a registration may be in, for a proxy in `cwd`: the folder's own, and every folder above it. */
function projectDirs(cwd: string): string[] {
  const out: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    out.push(join(dir, FOLDER));
    if (dirname(dir) === dir) return out;
  }
}

/**
 * The nearest registration among `chain`, read from `dirs`: the run to record into, a reason it
 * can't be trusted, or null when no ancestor has one.
 */
export function findRegistration(chain: readonly ProcessInfo[], dirs: readonly string[], skip: (reason: string) => void = () => {}): SidecarLookup | null {
  for (let i = 0; i < chain.length; i++) {
    const pid = chain[i]!.pid;
    for (const dir of dirs) {
      const file = join(dir, `${pid}.json`);
      let st: Stats;
      try {
        st = lstatSync(file);
      } catch {
        continue;
      }
      let dirSt: Stats;
      try {
        dirSt = lstatSync(dir);
      } catch {
        continue;
      }
      const problem = untrusted(dirSt, dir, 'dir') ?? untrusted(st, file, 'file');
      if (problem) return { kind: 'unusable', reason: `${problem}, so the run it names can't be trusted` };
      let j: Partial<Registration>;
      try {
        j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Registration>;
      } catch {
        return { kind: 'unusable', reason: `${file} is unreadable` };
      }
      if (j.v !== 1 || j.pid !== pid || typeof j.parent !== 'number' || typeof j.url !== 'string' || typeof j.runId !== 'string' || !/^[\w.-]{1,100}$/.test(j.runId)) {
        return { kind: 'unusable', reason: `${file} is not a registration Shadowlap wrote` };
      }
      // A file outliving its agent, whose process id now belongs to an unrelated ancestor, is stale.
      const parent = chain[i + 1]?.pid;
      if (parent !== undefined && parent !== j.parent) {
        skip(`${file} names parent ${j.parent}, but process ${pid}'s parent is ${parent}: left over from an earlier run, ignoring it`);
        continue;
      }
      if (!isLoopbackUrl(j.url)) return { kind: 'unusable', reason: `${file} points at ${j.url}, which is not this machine` };
      return { kind: 'sidecar', target: { url: j.url.replace(/\/$/, ''), runId: j.runId }, from: file };
    }
  }
  return null;
}

/**
 * The run an MCP proxy started with a minimal environment belongs to: the registration of its
 * nearest Shadowlap-started ancestor. When an ancestor is a Shadowlap command that starts agents
 * but no registration turns up (not yet written, or written where this process can't see it), the
 * answer is `unusable`, so writes are refused rather than run unrecorded.
 */
export async function lookupRegistration(o: { cwd?: string; home?: string | null; chain?: ProcessInfo[] | null; skip?: (reason: string) => void; waitMs?: number } = {}): Promise<SidecarLookup> {
  const home = o.home === undefined ? safeHome() : o.home;
  const dirs = [...new Set([...(home ? [join(home, FOLDER)] : []), ...projectDirs(o.cwd ?? process.cwd())])];
  const chain = o.chain === undefined ? processAncestors() : o.chain;
  if (!chain) {
    // Only the parent is known: enough for a client that is the agent itself.
    return findRegistration([{ pid: process.pid, ppid: process.ppid, args: null }, { pid: process.ppid, ppid: -1, args: null }], dirs, o.skip) ?? { kind: 'none' };
  }
  const found = findRegistration(chain, dirs, o.skip);
  if (found) return found;
  const shadowlap = chain.slice(1).find((p) => startsAgents(p.args));
  if (!shadowlap) return { kind: 'none' };
  // The CLI writes the registration as soon as the agent has started; give it a moment.
  const deadline = Date.now() + (o.waitMs ?? 2000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const later = findRegistration(chain, dirs, o.skip);
    if (later) return later;
  }
  return { kind: 'unusable', reason: `this process was started under Shadowlap (process ${shadowlap.pid}), but no run is registered for it in ${dirs[0]}` };
}
