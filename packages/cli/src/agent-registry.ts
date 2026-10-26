import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { withLockFile } from '@shadowlap/engine';
import { startCommand } from './start-command.js';

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
 *
 * A file is written, removed, and removed as left over (its agent's process is gone) only under the
 * folder's `.lock`, the engine's lock file. A process id is given again once its process ends, so a
 * file found left over can be replaced by a new agent's before it is removed, and an agent that
 * exited can have its id, and its file name, taken by another agent before its own exit is handled.
 * Under the lock, what is removed is what was judged: a left-over file is judged and removed in one
 * hold, and an exit removes the file only while it is still the one written for that agent.
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

/** How long a command waits for another changing the same folder: each holds the lock for a few file operations. */
const LOCK_WAIT_MS = 2_000;

/** Runs `fn` holding the folder's lock (see the header). */
function underLock(dir: string, fn: () => void): void {
  const lock = join(dir, '.lock');
  withLockFile(lock, { wait: LOCK_WAIT_MS, mode: 0o600, busy: () => new Error(`${dir} is being changed by another Shadowlap command (if none is running, delete ${lock})`) }, fn);
}

/** Removes files left by agents whose process is gone (a CLI that was killed can't clean up). Called holding the folder's lock. */
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

const readOr = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Publishes the sidecar and run of an agent this process started, until the returned function is
 * called. Written to the first folder that can be used; false when none could.
 */
export function registerAgent(pid: number, target: SidecarTarget, o: { cwd?: string; home?: string | null } = {}): { unregister: () => void; file: string | null } {
  const body: Registration = { v: 1, pid, parent: process.pid, url: target.url, runId: target.runId };
  const text = JSON.stringify(body) + '\n';
  for (const dir of registryDirs(o.cwd, o.home === undefined ? safeHome() : o.home)) {
    if (!prepareDir(dir)) continue;
    const file = join(dir, `${pid}.json`);
    try {
      underLock(dir, () => {
        prune(dir);
        // Written fresh, so a link or a file left at that path is replaced, never followed.
        rmSync(file, { force: true });
        writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
      });
    } catch {
      continue;
    }
    let done = false;
    return {
      file,
      unregister: () => {
        if (done) return;
        done = true;
        try {
          // Only while it is the file written for this agent: its process id may be another agent's by now.
          underLock(dir, () => {
            if (readOr(file) === text) rmSync(file, { force: true });
          });
        } catch {
          // the folder kept busy: the next registration here removes it, its agent being gone
        }
      },
    };
  }
  return { file: null, unregister: () => {} };
}

/**
 * `spawn`, for an agent whose calls belong to `target`'s run: its sidecar is published under its
 * process id while it runs, for the MCP proxies its clients start. A batch file (`npm start` on
 * Windows) runs through cmd.exe, which is then the process registered: the agent is below it.
 */
export function spawnAgent(command: string, args: readonly string[], options: SpawnOptions, target: SidecarTarget): ChildProcess {
  const start = startCommand(command, args, options);
  const child = spawn(start.command, start.args, start.options);
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

/**
 * What PowerShell runs to list the processes on Windows: WMI's Win32_Process through .NET, one line
 * per process. It uses no cmdlet, so PowerShell never searches its module path for one: the first
 * use of a cmdlet such as Get-CimInstance makes it read every module installed, which on a machine
 * with many (a CI runner has each cloud's SDK) took about 20 seconds per proxy.
 */
export const WINDOWS_PROCESS_TABLE = [
  "$PSModuleAutoLoadingPreference = 'None'",
  "[void][Reflection.Assembly]::LoadWithPartialName('System.Management')",
  "$q = [Management.ManagementObjectSearcher]::new('SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process')",
  'foreach ($p in $q.Get()) { [Console]::Out.WriteLine("$($p.ProcessId)`t$($p.ParentProcessId)`t$($p.CommandLine)") }',
].join('; ');

/** PowerShell's arguments for a script, passed encoded, so no quoting rule of the command line can change it. */
export function powershellArgs(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/**
 * The first thing a command said on stderr, for a log line. PowerShell started with
 * -EncodedCommand writes its errors as CLIXML, so the first error's text is read out of that.
 */
export function firstError(stderr: string): string {
  const text = stderr.trim();
  if (!text.startsWith('#< CLIXML')) return text.split(/\r?\n/)[0] ?? '';
  const m = /<S S="Error">([\s\S]*?)<\/S>/.exec(text);
  if (!m) return '';
  return m[1]!
    .replace(/_x001B_\[[0-9;]*m/g, '')
    .replace(/_x([0-9A-F]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
    .split(/\r?\n/)[0]!;
}

/**
 * Every process with its parent and command line, from `ps` (macOS and the BSDs) or PowerShell
 * (Windows). Null when the system won't say, and `note` is told why.
 */
function processTable(note?: (why: string) => void): Map<number, ProcessInfo> | null {
  const failed = (cmd: string, r: SpawnSyncReturns<string>) => {
    const said = firstError(r.stderr ?? '');
    note?.(`${cmd} ${r.error ? `didn't start (${r.error.message})` : r.status === 0 ? 'printed nothing' : `exited ${r.status ?? r.signal!}`}${said ? `: ${said}` : ''}`);
    return null;
  };
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', powershellArgs(WINDOWS_PROCESS_TABLE), { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      if (r.status !== 0 || !r.stdout) return failed('powershell.exe', r);
      const table = new Map<number, ProcessInfo>();
      for (const line of r.stdout.split(/\r?\n/)) {
        const [pid, ppid, ...rest] = line.split('\t');
        if (pid && ppid && /^\d+$/.test(pid) && /^\d+$/.test(ppid)) table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), args: rest.join('\t') || null });
      }
      return table;
    }
    const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return failed('ps', r);
    const table = new Map<number, ProcessInfo>();
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] || null });
    }
    return table;
  } catch (err) {
    note?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** The parent process id in a Linux `/proc/<pid>/stat` line: the second field after the command name, which may hold spaces and parentheses itself. */
export function parentFromProcStat(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
}

/** One process from Linux's /proc: its parent from `stat`, its command line from `cmdline`. */
function procInfo(pid: number): ProcessInfo | null {
  try {
    const ppid = parentFromProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (ppid === null) return null;
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
 * Null when the system won't say beyond the parent, and then `note` is told why: on Windows that is
 * PowerShell failing, which a proxy's log should name.
 */
export function processAncestors(note?: (why: string) => void): ProcessInfo[] | null {
  const chain: ProcessInfo[] = [{ pid: process.pid, ppid: process.ppid, args: process.argv.join(' ') }];
  const linux = process.platform === 'linux' && existsSync('/proc/self/stat');
  const table = linux ? null : processTable(note && ((why) => note(`the process tree could not be read (${why}), so only this process's parent is looked up for its run`)));
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

/**
 * A process and its ancestors, nearest first, up to (not including) the system's first process: the
 * chain a registration is looked up along. Null when the system won't say (`note` is told why), or
 * when the process is gone.
 */
export function ancestorsOf(pid: number, note?: (why: string) => void): ProcessInfo[] | null {
  const linux = process.platform === 'linux' && existsSync('/proc/self/stat');
  const table = linux ? null : processTable(note && ((why) => note(`the process tree could not be read (${why})`)));
  if (!linux && !table) return null;
  const lookup = (p: number) => (linux ? procInfo(p) : (table!.get(p) ?? null));
  const first = lookup(pid);
  if (!first) return null;
  const chain: ProcessInfo[] = [first];
  const seen = new Set([pid]);
  for (let at = first.ppid; at > 1 && !seen.has(at) && chain.length < 64; ) {
    seen.add(at);
    const info = lookup(at);
    if (!info) break;
    chain.push(info);
    at = info.ppid;
  }
  return chain;
}

/** A TCP address's port, as `lsof` and `netstat` write one: `127.0.0.1:54321`, `[::1]:54321`. */
const portOf = (address: string): number => Number(address.slice(address.lastIndexOf(':') + 1));

/** Linux: the socket's inode in /proc/net/tcp and tcp6, then the process holding it, from the links in /proc/<pid>/fd. */
function procPeer(port: number, serverPort: number): number | null {
  let inode: string | null = null;
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(table, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      // local address, remote address, state (01: established), …, inode
      if (f.length > 9 && f[3] === '01' && Number.parseInt(f[1]!.split(':')[1]!, 16) === port && Number.parseInt(f[2]!.split(':')[1]!, 16) === serverPort) inode = f[9]!;
    }
    if (inode) break;
  }
  if (!inode || inode === '0') return null;
  const target = `socket:[${inode}]`;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${name}/fd`);
    } catch {
      continue; // another user's, or gone
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${name}/fd/${fd}`) === target) return Number(name);
      } catch {
        // closed meanwhile
      }
    }
  }
  return null;
}

/** macOS and the BSDs: `lsof`, for the process whose end of the connection has port `port` and leads to `serverPort`. */
function lsofPeer(port: number, serverPort: number, note?: (why: string) => void): number | null {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpn'], { encoding: 'utf8', timeout: 10_000 });
  if (r.error || !r.stdout) {
    if (r.error) note?.(`lsof didn't start (${r.error.message})`);
    return null;
  }
  let pid: number | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null && pid !== process.pid) {
      const [local, remote] = line.slice(1).split('->');
      if (local && remote && portOf(local) === port && portOf(remote) === serverPort) return pid;
    }
  }
  return null;
}

/** Windows: `netstat -ano`, whose last column is the process id. */
function netstatPeer(port: number, serverPort: number): number | null {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 5 && f[0] === 'TCP' && f[3] === 'ESTABLISHED' && portOf(f[1]!) === port && portOf(f[2]!) === serverPort) return Number(f[4]);
  }
  return null;
}

/**
 * The process at the other end of a TCP connection this process accepted on its loopback: the one
 * whose socket has port `port` and is connected to `serverPort`, this process's. From /proc on
 * Linux, `lsof` on macOS, `netstat` on Windows. Null when the system won't say (`note` is told why).
 */
export function peerProcess(port: number, serverPort: number, note?: (why: string) => void): number | null {
  try {
    if (process.platform === 'linux' && existsSync('/proc/net/tcp')) return procPeer(port, serverPort);
    if (process.platform === 'win32') return netstatPeer(port, serverPort);
    return lsofPeer(port, serverPort, note);
  } catch (err) {
    note?.(`which process connected could not be read (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
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
 * A folder registrations are read from. `strict` for the home folder's, which no repository can
 * put a file in: a file there that can't be trusted means something is wrong, and the proxy fails
 * closed. A project's folder is one a cloned repository could carry, so a file there that can't be
 * trusted is only skipped.
 */
export interface RegistryDir {
  dir: string;
  strict: boolean;
}

/**
 * The nearest registration among `chain`, read from `dirs`: the run to record into, a reason it
 * can't be trusted, or null when no ancestor has one.
 */
export function findRegistration(chain: readonly ProcessInfo[], dirs: readonly RegistryDir[], skip: (reason: string) => void = () => {}): SidecarLookup | null {
  for (let i = 0; i < chain.length; i++) {
    const pid = chain[i]!.pid;
    for (const { dir, strict } of dirs) {
      const file = join(dir, `${pid}.json`);
      let st: Stats;
      let dirSt: Stats;
      try {
        st = lstatSync(file);
        dirSt = lstatSync(dir);
      } catch {
        continue;
      }
      const refuse = (reason: string): SidecarLookup | null => {
        if (strict) return { kind: 'unusable', reason };
        skip(`${reason}; ignoring it`);
        return null;
      };
      const problem = untrusted(dirSt, dir, 'dir') ?? untrusted(st, file, 'file');
      let j: Partial<Registration> | null = null;
      if (!problem) {
        try {
          j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Registration>;
        } catch {
          // reported below
        }
      }
      const why = problem
        ? `${problem}, so the run it names can't be trusted`
        : !j || j.v !== 1 || j.pid !== pid || typeof j.parent !== 'number' || typeof j.url !== 'string' || typeof j.runId !== 'string' || !/^[\w.-]{1,100}$/.test(j.runId)
          ? `${file} is not a registration Shadowlap wrote`
          : null;
      if (why || !j) {
        const answer = refuse(why ?? `${file} is unreadable`);
        if (answer) return answer;
        continue;
      }
      // A file outliving its agent, whose process id now belongs to an unrelated ancestor, is stale.
      const parent = chain[i + 1]?.pid;
      if (parent !== undefined && parent !== j.parent) {
        skip(`${file} names parent ${j.parent!}, but process ${pid}'s parent is ${parent}: left over from an earlier run, ignoring it`);
        continue;
      }
      // Where the chain stops, the parent can't be compared: the Shadowlap command that wrote the
      // file must at least still be running, or the file outlived it.
      if (parent === undefined && !alive(j.parent!)) {
        skip(`${file} was written by process ${j.parent!}, which has ended: left over from an earlier run, ignoring it`);
        continue;
      }
      if (!isLoopbackUrl(j.url!)) {
        const answer = refuse(`${file} points at ${j.url!}, which is not this machine`);
        if (answer) return answer;
        continue;
      }
      return { kind: 'sidecar', target: { url: j.url!.replace(/\/$/, ''), runId: j.runId! }, from: file };
    }
  }
  return null;
}

/** The folders a proxy reads registrations from: the home folder's (strict), then the project's and every folder above it. */
export function lookupDirs(cwd: string | undefined, home: string | null | undefined): RegistryDir[] {
  const h = home === undefined ? safeHome() : home;
  const own = h ? join(h, FOLDER) : null;
  return [...(own ? [{ dir: own, strict: true }] : []), ...projectDirs(cwd ?? process.cwd()).filter((d) => d !== own).map((dir) => ({ dir, strict: false }))];
}

/** This process and its parent: all that is known without reading the process tree. */
function parentChain(): ProcessInfo[] {
  return [
    { pid: process.pid, ppid: process.ppid, args: null },
    { pid: process.ppid, ppid: -1, args: null },
  ];
}

/**
 * The registration of the process that started this one, found without reading the process tree:
 * the usual case, where the MCP client that starts the proxy is the agent itself. On Windows the
 * tree takes PowerShell, which can take seconds on a busy machine, so a proxy looks here first.
 * Null when its parent has none, and the tree decides.
 */
export function parentRegistration(o: { cwd?: string; home?: string | null; skip?: (reason: string) => void } = {}): SidecarLookup | null {
  return findRegistration(parentChain(), lookupDirs(o.cwd, o.home), o.skip);
}

/**
 * The run an MCP proxy started with a minimal environment belongs to: the registration of its
 * nearest Shadowlap-started ancestor. When an ancestor is a Shadowlap command that starts agents
 * but no registration turns up (not yet written, or written where this process can't see it), the
 * answer is `unusable`, so writes are refused rather than run unrecorded.
 */
export async function lookupRegistration(o: { cwd?: string; home?: string | null; chain?: ProcessInfo[] | null; skip?: (reason: string) => void; waitMs?: number } = {}): Promise<SidecarLookup> {
  const dirs = lookupDirs(o.cwd, o.home);
  const chain = o.chain === undefined ? processAncestors(o.skip) : o.chain;
  if (!chain) {
    // Only the parent is known: enough for a client that is the agent itself.
    return findRegistration(parentChain(), dirs, o.skip) ?? { kind: 'none' };
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
  return { kind: 'unusable', reason: `this process was started under Shadowlap (process ${shadowlap.pid}), but no run is registered for it in ${dirs[0]!.dir}` };
}

/**
 * The runs whose agents are running now, as their registrations name them: each agent alive, with
 * the Shadowlap command that started it, in the folders a proxy in `cwd` reads (lookupDirs). A file
 * that can't be trusted is skipped, as `findRegistration` skips one in a project's folder.
 */
export function registeredRuns(o: { cwd?: string; home?: string | null; skip?: (reason: string) => void } = {}): Array<{ target: SidecarTarget; pid: number; from: string }> {
  const out: Array<{ target: SidecarTarget; pid: number; from: string }> = [];
  for (const { dir } of lookupDirs(o.cwd, o.home)) {
    let names: string[];
    try {
      const dirSt = lstatSync(dir);
      if (untrusted(dirSt, dir, 'dir')) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^(\d+)\.json$/.exec(name);
      if (!m) continue;
      const file = join(dir, name);
      try {
        if (untrusted(lstatSync(file), file, 'file')) continue;
        const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Registration>;
        if (j.v !== 1 || j.pid !== Number(m[1]) || typeof j.parent !== 'number' || typeof j.url !== 'string' || typeof j.runId !== 'string' || !isLoopbackUrl(j.url)) continue;
        if (!alive(j.pid) || !alive(j.parent)) continue;
        out.push({ target: { url: j.url.replace(/\/$/, ''), runId: j.runId }, pid: j.pid, from: file });
      } catch {
        o.skip?.(`${file} is unreadable; ignoring it`);
      }
    }
  }
  return out;
}
