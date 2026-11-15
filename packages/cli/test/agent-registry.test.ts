import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCommands, findRegistration, firstError, lookupRegistration, parentFromProcStat, parentRegistration, powershellArgs, processAncestors, registerAgent, registryDirs, startsAgents, WINDOWS_PROCESS_TABLE, type ProcessInfo } from '../src/agent-registry.js';
import { findSidecar } from '../src/mcp.js';
import { isLoopbackHost } from '../src/loopback.js';

/**
 * The registry that lets `shadowlap mcp`, started by an MCP client with a minimal environment, find
 * the run of the agent shadowlap started: one file per agent, named by its process id.
 */
const posix = process.platform !== 'win32';
/** shadowlap's home folder, as the registry takes it (`~/.shadowlap`, or SHADOWLAP_HOME): the test's own. */
let home: string;
let project: string;
const children: ChildProcessWithoutNullStreams[] = [];

/** The CLI's own command tree, as main() builds it, and the commands in it that start agents. */
let program: Command;
let commands: ReadonlySet<string>;
beforeAll(async () => {
  // main() builds the program and hands it to parseAsync; keep it instead of running it.
  const spy = vi.spyOn(Command.prototype, 'parseAsync').mockImplementation(async function (this: Command) {
    program = this;
    return this;
  });
  try {
    const { main } = await import('../src/index.js');
    await main(['node', 'shadowlap']);
  } finally {
    spy.mockRestore();
  }
  commands = agentCommands(program);
}, 120_000);

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sl-reg-home-')));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-reg-project-')));
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** A process running `code` as a module, which can import the built registry. */
const REGISTRY = new URL('../dist/agent-registry.js', import.meta.url).href;
function start(code: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}
const said = (child: ChildProcessWithoutNullStreams, line: string) =>
  new Promise<void>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()).includes(`${line}\n`) && resolve());
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('exit', (c) => reject(new Error(`exited with ${c} before saying ${line}: ${err}`)));
  });
const exited = (child: ChildProcessWithoutNullStreams) => new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('exit', (c) => resolve(c))));

/** A process tree: a proxy, the agent shadowlap started (pid 4242), and the CLI that started it. */
const tree = (agentParent = process.pid): ProcessInfo[] => [
  { pid: 7001, ppid: 4242, args: 'node shadowlap.js mcp --url https://mcp.example.com/mcp' },
  { pid: 4242, ppid: agentParent, args: 'python agent.py' },
  { pid: agentParent, ppid: 1, args: 'node /opt/shadowlap/bin/shadowlap.js test goldens/notes' },
];

describe('the agent registry', () => {
  it("writes an owner-only file per agent in shadowlap's home folder, and removes it when asked", () => {
    const { file, unregister } = registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' }, { cwd: project, home });
    expect(file).toBe(join(home, 'agents', '4242.json'));
    expect(JSON.parse(readFileSync(file!, 'utf8'))).toEqual({ v: 1, pid: 4242, parent: process.pid, url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' });
    if (posix) {
      expect(statSync(file!).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'agents')).mode & 0o777).toBe(0o700);
    }
    unregister();
    expect(existsSync(file!)).toBe(false);
  });

  it("falls back to the project's folder when shadowlap's home folder can't be used, and prunes files of agents that are gone", () => {
    writeFileSync(join(home, 'agents'), 'not a folder');
    const dead = join(project, '.shadowlap', 'agents', `${2 ** 22 - 7}.json`);
    mkdirSync(join(project, '.shadowlap', 'agents'), { recursive: true, mode: 0o700 });
    writeFileSync(dead, '{}', { mode: 0o600 });
    const { file, unregister } = registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' }, { cwd: project, home });
    expect(file).toBe(join(project, '.shadowlap', 'agents', '4242.json'));
    expect(existsSync(dead)).toBe(false);
    unregister();
    expect(registryDirs(project, null)).toEqual([join(project, '.shadowlap', 'agents')]);
  });

  it('removes on exit only the file written for that agent, not one written since for an agent given its process id', () => {
    const first = registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01FIRST' }, { cwd: project, home });
    // The agent exited, and another command started an agent that got the same process id before the first one's exit was handled.
    const second = registerAgent(4242, { url: 'http://127.0.0.1:5001/t/def', runId: '01SECOND' }, { cwd: project, home });
    first.unregister();
    expect(JSON.parse(readFileSync(second.file!, 'utf8'))).toMatchObject({ runId: '01SECOND' });
    second.unregister();
    // Neither file, nor the folder's lock, is left.
    expect(readdirSync(join(home, 'agents'))).toEqual([]);
  });

  it('never prunes a file written after it found the one there left over', async () => {
    // An agent's process ended and its file was left. No process has its id, as above: past macOS's
    // ids, at the very top of Linux's, and no multiple of four, as Windows's are.
    const gone = 2 ** 22 - 7;
    const left = join(home, 'agents', `${gone}.json`);
    mkdirSync(join(home, 'agents'), { recursive: true, mode: 0o700 });
    writeFileSync(left, '{}', { mode: 0o600 });
    // A command registers an agent, and stops right before it removes the file it has just judged left over.
    const pruning = start(`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const realRm = fs.rmSync, realRead = fs.readSync, one = Buffer.alloc(1), nap = new Int32Array(new SharedArrayBuffer(4));
      fs.rmSync = function (path, ...rest) {
        if (path === ${JSON.stringify(left)}) {
          fs.writeSync(1, 'removing\\n');
          for (;;) {
            try { if (realRead(0, one, 0, 1, null) === 1) break; } catch (err) { if (err.code !== 'EAGAIN') throw err; }
            Atomics.wait(nap, 0, 0, 5);
          }
        }
        return realRm.call(this, path, ...rest);
      };
      syncBuiltinESMExports();
      const { registerAgent } = await import(${JSON.stringify(REGISTRY)});
      registerAgent(process.pid, { url: 'http://127.0.0.1:5000/t/abc', runId: '01PRUNING' }, { cwd: ${JSON.stringify(project)}, home: ${JSON.stringify(home)} });`);
    await said(pruning, 'removing');
    // Meanwhile another command registers an agent that was given that process id.
    const registering = start(`
      const { registerAgent } = await import(${JSON.stringify(REGISTRY)});
      process.stdout.write('registering\\n');
      registerAgent(${gone}, { url: 'http://127.0.0.1:5001/t/def', runId: '01NEW' }, { cwd: ${JSON.stringify(project)}, home: ${JSON.stringify(home)} });`);
    await said(registering, 'registering');
    // It waits for the first command, or (were the folder not locked) is done at once.
    await Promise.race([exited(registering), new Promise((resolve) => setTimeout(resolve, 500))]);
    pruning.stdin.write('g');
    expect(await exited(pruning)).toBe(0);
    expect(await exited(registering)).toBe(0);
    expect(JSON.parse(readFileSync(left, 'utf8'))).toMatchObject({ pid: gone, runId: '01NEW' });
  });

  it('finds the nearest registered ancestor, and checks that it is the one shadowlap started', () => {
    registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' }, { cwd: project, home });
    const dirs = [{ dir: join(home, 'agents'), strict: true }];
    expect(findRegistration(tree(), dirs)).toEqual({ kind: 'sidecar', target: { url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' }, from: join(dirs[0].dir, '4242.json') });
    // A process id reused by a process another one started: the file is stale.
    const skipped: string[] = [];
    expect(findRegistration(tree(process.pid + 1), dirs, (r) => skipped.push(r))).toBeNull();
    expect(skipped.join()).toMatch(/left over from an earlier run/);
  });

  it('distrusts a file that is not owner-only, is a link, or points away from this machine', () => {
    const dir = join(home, 'agents');
    const strict = [{ dir, strict: true }];
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, '4242.json');
    const write = (body: unknown, mode = 0o600) => {
      rmSync(file, { force: true });
      writeFileSync(file, JSON.stringify(body), { mode });
      chmodSync(file, mode);
    };
    write({ v: 1, pid: 4242, parent: process.pid, url: 'https://collector.example/t/x', runId: 'r' });
    expect(findRegistration(tree(), strict)).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('not this machine') });
    write({ v: 1, pid: 4243, parent: process.pid, url: 'http://127.0.0.1:1/t/x', runId: 'r' });
    expect(findRegistration(tree(), strict)).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('not a registration shadowlap wrote') });
    if (posix) {
      write({ v: 1, pid: 4242, parent: process.pid, url: 'http://127.0.0.1:1/t/x', runId: 'r' }, 0o644);
      expect(findRegistration(tree(), strict)).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('can be read by other users') });
      rmSync(file);
      const elsewhere = join(home, 'elsewhere.json');
      writeFileSync(elsewhere, JSON.stringify({ v: 1, pid: 4242, parent: process.pid, url: 'http://127.0.0.1:1/t/x', runId: 'r' }), { mode: 0o600 });
      symlinkSync(elsewhere, file);
      expect(findRegistration(tree(), strict)).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('symbolic link') });
    }
  });

  it("only skips a file it can't trust in a project's folder, which a cloned repository could carry", () => {
    // As git checks it out: readable by everyone, in a folder readable by everyone.
    const dir = join(project, '.shadowlap', 'agents');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, '4242.json'), JSON.stringify({ v: 1, pid: 4242, parent: process.pid, url: 'http://127.0.0.1:9/t/planted', runId: 'r' }), { mode: 0o644 });
    const skipped: string[] = [];
    if (posix) {
      expect(findRegistration(tree(), [{ dir, strict: false }], (r) => skipped.push(r))).toBeNull();
      expect(skipped.join()).toMatch(/can be read by other users.*ignoring it/);
    }
    chmodSync(dir, 0o700);
    chmodSync(join(dir, '4242.json'), 0o600);
    writeFileSync(join(dir, '4242.json'), JSON.stringify({ v: 1, pid: 4242, parent: process.pid, url: 'https://collector.example/t/x', runId: 'r' }));
    expect(findRegistration(tree(), [{ dir, strict: false }], (r) => skipped.push(r))).toBeNull();
    expect(skipped.at(-1)).toMatch(/not this machine; ignoring it/);
  });

  it('refuses rather than passes through when a shadowlap command is an ancestor but no run turns up', async () => {
    const chain = tree();
    expect(await lookupRegistration({ agentCommands: commands, cwd: project, home, chain, waitMs: 150 })).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('no run is registered for it') });
    // Under anything else, the proxy is simply not under shadowlap.
    const plain = chain.map((p) => ({ ...p, args: 'python agent.py' }));
    expect(await lookupRegistration({ agentCommands: commands, cwd: project, home, chain: plain, waitMs: 150 })).toEqual({ kind: 'none' });
    // A registration that appears while it waits is taken: the CLI writes it as soon as the agent starts.
    setTimeout(() => registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01LATE' }, { cwd: project, home }), 50);
    expect(await lookupRegistration({ agentCommands: commands, cwd: project, home, chain, waitMs: 2000 })).toMatchObject({ kind: 'sidecar', target: { runId: '01LATE' } });
  });

  it('finds the parent agent without the process tree, and only while the command that registered it runs', () => {
    // This test process plays the proxy: its parent is the agent, and the "CLI" that registered it is this process.
    registerAgent(process.ppid, { url: 'http://127.0.0.1:5000/t/abc', runId: '01PARENT' }, { cwd: project, home });
    expect(parentRegistration({ cwd: project, home })).toMatchObject({ kind: 'sidecar', target: { runId: '01PARENT' } });
    // A file left by a CLI that was killed: its writer is gone, so the file is stale even where the parent can't be compared.
    const file = join(home, 'agents', `${process.ppid}.json`);
    rmSync(file);
    writeFileSync(file, JSON.stringify({ v: 1, pid: process.ppid, parent: 2 ** 22 - 7, url: 'http://127.0.0.1:5000/t/abc', runId: '01STALE' }), { mode: 0o600 });
    const skipped: string[] = [];
    expect(parentRegistration({ cwd: project, home, skip: (r) => skipped.push(r) })).toBeNull();
    expect(skipped.join()).toMatch(/which has ended: left over from an earlier run/);
  });

  it('looks for the parent first on Windows, where the process tree takes PowerShell', async () => {
    registerAgent(process.ppid, { url: 'http://127.0.0.1:5000/t/abc', runId: '01WIN' }, { cwd: project, home });
    const found = await findSidecar({}, project, () => {}, { agentCommands: commands, home, platform: 'win32', waitMs: 0 });
    expect(found).toEqual({ kind: 'sidecar', target: { url: 'http://127.0.0.1:5000/t/abc', runId: '01WIN' }, from: join(home, 'agents', `${process.ppid}.json`) });
  });

  it('lists processes on Windows without a cmdlet, so PowerShell never reads its modules to find one', () => {
    const args = powershellArgs(WINDOWS_PROCESS_TABLE);
    expect(args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    // -EncodedCommand is the script in UTF-16LE, base64: no quoting rule of a command line touches it.
    expect(Buffer.from(args.at(-1)!, 'base64').toString('utf16le')).toBe(WINDOWS_PROCESS_TABLE);
    expect(WINDOWS_PROCESS_TABLE).toContain("$PSModuleAutoLoadingPreference = 'None'");
    // Every command is a .NET call or the language's own: no Verb-Noun cmdlet, and no pipeline into one.
    expect(WINDOWS_PROCESS_TABLE).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
    expect(WINDOWS_PROCESS_TABLE).not.toContain('|');
    expect(WINDOWS_PROCESS_TABLE).toContain('FROM Win32_Process');
    // Started that way, PowerShell writes its errors as CLIXML: a proxy's log still names the error.
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">_x001B_[31;1mMethodInvocationException: _x001B_[31;1mException calling ".ctor" with "1" argument(s): "Access &amp; more denied"_x001B_[0m_x000A_</S><S S="Error">second_x000A_</S></Objs>';
    expect(firstError(clixml)).toBe('MethodInvocationException: Exception calling ".ctor" with "1" argument(s): "Access & more denied"');
    expect(firstError('ps: illegal option\nusage: ps')).toBe('ps: illegal option');
  });

  it("looks in the project's folder and every folder above the proxy's", async () => {
    registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01PROJ' }, { cwd: project, home: null });
    const nested = join(project, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(await lookupRegistration({ agentCommands: commands, cwd: nested, home, chain: tree(), waitMs: 0 })).toMatchObject({ kind: 'sidecar', target: { runId: '01PROJ' } });
  });

  it('reads this process and its ancestors from the system', () => {
    const chain = processAncestors();
    if (!chain) return; // a system that won't say
    expect(chain[0]).toMatchObject({ pid: process.pid, ppid: process.ppid });
    // Its own words as they are, apart: one may hold a space.
    expect(chain[0].args).toEqual(process.argv);
    expect(chain[1]?.pid).toBe(process.ppid);
  });

  // Linux reads /proc, with no command to fail; elsewhere ps, or PowerShell on Windows, lists them.
  it.skipIf(process.platform === 'linux')("says why when the system won't list its processes", () => {
    const path = process.env.PATH;
    const notes: string[] = [];
    process.env.PATH = '';
    try {
      expect(processAncestors((why) => notes.push(why))).toBeNull();
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    // The command that lists them can't be found: a proxy's log names it.
    expect(notes).toEqual([expect.stringMatching(/^the process tree could not be read \((ps|powershell\.exe) didn't start \(.*ENOENT.*\)\), so only this process's parent is looked up for its run$/)]);
  });

  it("reads a process's parent from Linux's /proc, whatever its name holds", () => {
    expect(parentFromProcStat('4242 (python3) S 4100 4242 4100 34816 4242 4194304 1032 0 0 0')).toBe(4100);
    expect(parentFromProcStat('4242 (my (odd) agent) S) R 977 4242 977 0 -1 4194560')).toBe(977);
    expect(parentFromProcStat('garbage')).toBeNull();
  });

  it('knows a shadowlap command that starts agents by its command line', () => {
    expect(startsAgents('node /opt/shadowlap/packages/cli/bin/shadowlap.js --db /x/store.db replay 01ABC --repeat 2', commands)).toBe(true);
    expect(startsAgents('shadowlap -v test goldens/*', commands)).toBe(true);
    expect(startsAgents('/usr/local/bin/shadowlap blame 01ABC --expect {}', commands)).toBe(true);
    for (const line of ['shadowlap injection goldens/notes --clean 9', 'shadowlap decisions --model claude-x -- python agent.py', 'shadowlap migrate --to claude-x', 'shadowlap coverage --pack 3', 'shadowlap tasks score goldens/notes']) expect(startsAgents(line, commands), line).toBe(true);
    expect(startsAgents('node /opt/shadowlap/bin/shadowlap.js mcp --url https://x/run', commands)).toBe(false);
    expect(startsAgents('shadowlap ui', commands)).toBe(false);
    expect(startsAgents('python agent.py run test', commands)).toBe(false);
    expect(startsAgents(null, commands)).toBe(false);
  });

  it('knows one whose --db path holds a space, whether the system gives its words apart or joined', () => {
    // Apart, as Linux's /proc and this process's own argv give them: each word whole.
    const store = '/Users/maya/Library/Application Support/shadowlap/store.db';
    expect(startsAgents(['node', '/opt/shadowlap/bin/shadowlap.js', '--db', store, 'run', '--', 'node', 'agent.js'], commands)).toBe(true);
    expect(startsAgents(['node', '/opt/shadowlap/bin/shadowlap.js', `--db=${store}`, 'test', 'goldens/*'], commands)).toBe(true);
    expect(startsAgents(['node', '/opt/shadowlap/bin/shadowlap.js', '--db', store, 'ls', '--label', 'run'], commands)).toBe(false);
    // Joined, as ps prints them on macOS, and as Windows keeps a command line, its quotes and all.
    expect(startsAgents(`node /opt/shadowlap/bin/shadowlap.js --db ${store} run -- node agent.js`, commands)).toBe(true);
    expect(startsAgents(`/usr/local/bin/shadowlap --db=${store} test goldens/*`, commands)).toBe(true);
    expect(startsAgents('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\maya\\AppData\\Roaming\\npm\\node_modules\\shadowlap\\bin\\shadowlap.js" --db "C:\\Users\\maya\\My Documents\\store.db" replay 01ABC', commands)).toBe(true);
    // An agent's own command after `--` is the agent's, not shadowlap's.
    expect(startsAgents(`shadowlap --db ${store} ui -- run`, commands)).toBe(false);
  });

  it('takes every command of the CLI that runs an agent, and only those, from the command tree: each that decides its guard', () => {
    // Walked whole: a command takes --guard, the guard its agents run under, or a subcommand of it does.
    const walk = (c: Command, path: string[]): Array<{ path: string[]; guard: boolean }> =>
      c.commands.flatMap((sub) => [{ path: [...path, sub.name()], guard: sub.options.some((o) => o.long === '--guard') }, ...walk(sub, [...path, sub.name()])]);
    const all = walk(program, []);
    expect(all.length).toBeGreaterThan(60);
    const starting = new Set(all.filter((x) => x.guard).map((x) => x.path[0]));
    for (const { path } of all) expect(startsAgents(`node /opt/shadowlap/bin/shadowlap.js ${path.join(' ')} x`, commands), path.join(' ')).toBe(starting.has(path[0]));
    expect([...starting].sort()).toEqual(['bisect', 'blame', 'calibrate', 'coverage', 'decisions', 'injection', 'migrate', 'repair', 'replay', 'run', 'tasks', 'test', 'verify']);
  });

  it('knows this machine by name and address', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '127.255.0.1', '[::1]', '::1', '[::ffff:7f00:1]', 'LOCALHOST']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['10.0.0.1', '128.0.0.1', '127.0.0.256', 'example.com', 'localhost.example.com', '[::2]', '[::ffff:a00:1]']) expect(isLoopbackHost(host), host).toBe(false);
  });
});
