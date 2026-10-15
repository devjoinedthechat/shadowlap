import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRegistration, lookupRegistration, processAncestors, registerAgent, registryDirs, startsAgents, type ProcessInfo } from '../src/agent-registry.js';
import { isLoopbackHost } from '../src/loopback.js';

/**
 * The registry that lets `shadowlap mcp`, started by an MCP client with a minimal environment, find
 * the run of the agent Shadowlap started: one file per agent, named by its process id.
 */
const posix = process.platform !== 'win32';
let home: string;
let project: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sl-reg-home-')));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-reg-project-')));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** A process tree: a proxy, the agent Shadowlap started (pid 4242), and the CLI that started it. */
const tree = (agentParent = process.pid): ProcessInfo[] => [
  { pid: 7001, ppid: 4242, args: 'node shadowlap.js mcp --url https://mcp.example.com/mcp' },
  { pid: 4242, ppid: agentParent, args: 'python agent.py' },
  { pid: agentParent, ppid: 1, args: 'node /opt/shadowlap/bin/shadowlap.js test goldens/notes' },
];

describe('the agent registry', () => {
  it('writes an owner-only file per agent under the home folder, and removes it when asked', () => {
    const { file, unregister } = registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' }, { cwd: project, home });
    expect(file).toBe(join(home, '.shadowlap', 'agents', '4242.json'));
    expect(JSON.parse(readFileSync(file!, 'utf8'))).toEqual({ v: 1, pid: 4242, parent: process.pid, url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' });
    if (posix) {
      expect(statSync(file!).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, '.shadowlap', 'agents')).mode & 0o777).toBe(0o700);
    }
    unregister();
    expect(existsSync(file!)).toBe(false);
  });

  it("falls back to the project's folder when the home folder can't be used, and prunes files of agents that are gone", () => {
    writeFileSync(join(home, '.shadowlap'), 'not a folder');
    const dead = join(project, '.shadowlap', 'agents', `${2 ** 22 - 7}.json`);
    mkdirSync(join(project, '.shadowlap', 'agents'), { recursive: true, mode: 0o700 });
    writeFileSync(dead, '{}', { mode: 0o600 });
    const { file, unregister } = registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' }, { cwd: project, home });
    expect(file).toBe(join(project, '.shadowlap', 'agents', '4242.json'));
    expect(existsSync(dead)).toBe(false);
    unregister();
    expect(registryDirs(project, null)).toEqual([join(project, '.shadowlap', 'agents')]);
  });

  it('finds the nearest registered ancestor, and checks that it is the one Shadowlap started', () => {
    registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' }, { cwd: project, home });
    const dirs = [join(home, '.shadowlap', 'agents')];
    expect(findRegistration(tree(), dirs)).toEqual({ kind: 'sidecar', target: { url: 'http://127.0.0.1:5000/t/abc', runId: '01RUN' }, from: join(dirs[0]!, '4242.json') });
    // A process id reused by a process another one started: the file is stale.
    const skipped: string[] = [];
    expect(findRegistration(tree(process.pid + 1), dirs, (r) => skipped.push(r))).toBeNull();
    expect(skipped.join()).toMatch(/left over from an earlier run/);
  });

  it('distrusts a file that is not owner-only, is a link, or points away from this machine', () => {
    const dir = join(home, '.shadowlap', 'agents');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, '4242.json');
    const write = (body: unknown, mode = 0o600) => {
      rmSync(file, { force: true });
      writeFileSync(file, JSON.stringify(body), { mode });
      chmodSync(file, mode);
    };
    write({ v: 1, pid: 4242, parent: process.pid, url: 'https://collector.example/t/x', runId: 'r' });
    expect(findRegistration(tree(), [dir])).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('not this machine') });
    write({ v: 1, pid: 4243, parent: process.pid, url: 'http://127.0.0.1:1/t/x', runId: 'r' });
    expect(findRegistration(tree(), [dir])).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('not a registration Shadowlap wrote') });
    if (posix) {
      write({ v: 1, pid: 4242, parent: process.pid, url: 'http://127.0.0.1:1/t/x', runId: 'r' }, 0o644);
      expect(findRegistration(tree(), [dir])).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('can be read by other users') });
      rmSync(file);
      const elsewhere = join(home, 'elsewhere.json');
      writeFileSync(elsewhere, JSON.stringify({ v: 1, pid: 4242, parent: process.pid, url: 'http://127.0.0.1:1/t/x', runId: 'r' }), { mode: 0o600 });
      symlinkSync(elsewhere, file);
      expect(findRegistration(tree(), [dir])).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('symbolic link') });
    }
  });

  it('refuses rather than passes through when a Shadowlap command is an ancestor but no run turns up', async () => {
    const chain = tree();
    expect(await lookupRegistration({ cwd: project, home, chain, waitMs: 150 })).toMatchObject({ kind: 'unusable', reason: expect.stringContaining('no run is registered for it') });
    // Under anything else, the proxy is simply not under Shadowlap.
    const plain = chain.map((p) => ({ ...p, args: 'python agent.py' }));
    expect(await lookupRegistration({ cwd: project, home, chain: plain, waitMs: 150 })).toEqual({ kind: 'none' });
    // A registration that appears while it waits is taken: the CLI writes it as soon as the agent starts.
    setTimeout(() => registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01LATE' }, { cwd: project, home }), 50);
    expect(await lookupRegistration({ cwd: project, home, chain, waitMs: 2000 })).toMatchObject({ kind: 'sidecar', target: { runId: '01LATE' } });
  });

  it("looks in the project's folder and every folder above the proxy's", async () => {
    registerAgent(4242, { url: 'http://127.0.0.1:5000/t/abc', runId: '01PROJ' }, { cwd: project, home: null });
    const nested = join(project, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(await lookupRegistration({ cwd: nested, home, chain: tree(), waitMs: 0 })).toMatchObject({ kind: 'sidecar', target: { runId: '01PROJ' } });
  });

  it('reads this process and its ancestors from the system', () => {
    const chain = processAncestors();
    if (!chain) return; // a system that won't say
    expect(chain[0]).toMatchObject({ pid: process.pid, ppid: process.ppid });
    expect(chain[1]?.pid).toBe(process.ppid);
  });

  it('knows a Shadowlap command that starts agents by its command line', () => {
    expect(startsAgents('node /opt/shadowlap/packages/cli/bin/shadowlap.js --db /x/store.db replay 01ABC --repeat 2')).toBe(true);
    expect(startsAgents('shadowlap -v test goldens/*')).toBe(true);
    expect(startsAgents('/usr/local/bin/shadowlap blame 01ABC --expect {}')).toBe(true);
    expect(startsAgents('node /opt/shadowlap/bin/shadowlap.js mcp --url https://x/run')).toBe(false);
    expect(startsAgents('shadowlap ui')).toBe(false);
    expect(startsAgents('python agent.py run test')).toBe(false);
    expect(startsAgents(null)).toBe(false);
  });

  it('knows this machine by name and address', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '127.255.0.1', '[::1]', '::1', '[::ffff:7f00:1]', 'LOCALHOST']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['10.0.0.1', '128.0.0.1', '127.0.0.256', 'example.com', 'localhost.example.com', '[::2]', '[::ffff:a00:1]']) expect(isLoopbackHost(host), host).toBe(false);
  });
});
