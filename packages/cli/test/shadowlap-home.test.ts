import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { lookupDirs, registerAgent, registeredRuns, safeHome } from '../src/agent-registry.js';
import { liveProxies, registerProxy } from '../src/mcp-proxies.js';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from './fake-mcp-http-server.js';

/**
 * Shadowlap keeps every file of this machine's in one folder, SHADOWLAP_HOME, else ~/.shadowlap: the
 * dashboard's project list, the agents a command registers while they run (agent-registry.ts), and
 * the `mcp --listen` proxies registered while they serve (mcp-proxies.ts). So processes that share
 * an environment find each other's files, and a run given a home of its own, as the test suites
 * are, writes nothing in the real one.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const MCP_AGENT = fileURLToPath(new URL('./mcp-client-agent.mjs', import.meta.url));

const dirs: string[] = [];
const fresh = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

describe("Shadowlap's home folder", () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is SHADOWLAP_HOME when it is an absolute path or one from the home folder, and ~/.shadowlap otherwise', () => {
    const own = fresh('sl-home-abs-');
    expect(safeHome({ SHADOWLAP_HOME: own })).toBe(own);
    expect(safeHome({ SHADOWLAP_HOME: '~/sl-elsewhere' })).toBe(join(homedir(), 'sl-elsewhere'));
    // A relative one would name another folder in every directory a command runs in: ignored, as for the project list.
    expect(safeHome({ SHADOWLAP_HOME: 'sl-relative' })).toBe(join(homedir(), '.shadowlap'));
    expect(safeHome({})).toBe(join(homedir(), '.shadowlap'));
  });

  it('holds the agents a command registers and the proxies started on their own, where a process given the same one finds them', () => {
    const own = fresh('sl-home-own-');
    const project = fresh('sl-home-project-');
    vi.stubEnv('SHADOWLAP_HOME', own);
    // This process plays the command and the agent it started, both running.
    const agent = registerAgent(process.pid, { url: 'http://127.0.0.1:5000/t/abc', runId: '01HOME' }, { cwd: project });
    const proxy = registerProxy({ host: '127.0.0.1', port: 8931 });
    try {
      expect(agent.file).toBe(join(own, 'agents', `${process.pid}.json`));
      expect(proxy.file).toBe(join(own, 'mcp', `${process.pid}.json`));
      expect(lookupDirs(project, undefined)[0]).toEqual({ dir: join(own, 'agents'), strict: true });
      expect(registeredRuns({ cwd: project }).map((r) => r.target.runId)).toEqual(['01HOME']);
      expect(liveProxies()).toEqual(['127.0.0.1:8931', 'localhost:8931']);
      // A process given another home finds neither.
      vi.stubEnv('SHADOWLAP_HOME', fresh('sl-home-other-'));
      expect(registeredRuns({ cwd: project })).toEqual([]);
      expect(liveProxies()).toEqual([]);
    } finally {
      agent.unregister();
      proxy.unregister();
    }
    expect(readdirSync(join(own, 'agents'))).toEqual([]);
    expect(readdirSync(join(own, 'mcp'))).toEqual([]);
    expect(existsSync(join(project, '.shadowlap'))).toBe(false);
  });
});

describe('commands and proxies given the same SHADOWLAP_HOME', () => {
  let server: FakeMcpHttpServer;
  /** HOME (USERPROFILE on Windows): where Shadowlap's files would go without SHADOWLAP_HOME. */
  let home: string;
  let own: string;
  let cwd: string;
  let listener: ChildProcess | null = null;

  beforeAll(async () => {
    server = await startFakeMcpHttpServer();
    home = fresh('sl-home-user-');
    own = fresh('sl-home-shared-');
    cwd = fresh('sl-home-cwd-');
  });
  afterAll(async () => {
    listener?.kill('SIGKILL');
    await server.close();
  });

  /** What every process here runs with: a home folder of the test's own, and `slHome` as SHADOWLAP_HOME. */
  const env = (slHome: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, USERPROFILE: home, SHADOWLAP_HOME: slHome, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_URL: undefined, SHADOWLAP_RUN_ID: undefined, ...extra });

  function shadowlap(args: string[], e: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], { cwd, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out }));
    });
  }

  it('lets the agents of a command reach a proxy started on its own', async () => {
    const started = spawn(process.execPath, [CLI, 'mcp', '--url', server.url, '--listen', '127.0.0.1:0'], { cwd, env: env(own), stdio: ['ignore', 'ignore', 'pipe'] });
    listener = started;
    let said = '';
    const port = await new Promise<string>((resolve, reject) => {
      started.stderr.on('data', (chunk: Buffer) => {
        said += chunk.toString();
        const m = /serving \S+ at http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(said);
        if (m) resolve(m[1]);
      });
      started.once('exit', (code) => reject(new Error(`exited ${code}: ${said}`)));
    });
    expect(readdirSync(join(own, 'mcp'))).toEqual([`${started.pid}.json`]);

    const AGENT = 'console.log("proxies: " + (process.env.SHADOWLAP_MCP_PROXIES || "none"))';
    const shared = await shadowlap(['run', '--', process.execPath, '-e', AGENT], env(own));
    expect(shared.code, shared.out).toBe(0);
    expect(shared.out).toContain(`proxies: 127.0.0.1:${port},localhost:${port}`);
    // A command given another home doesn't see it.
    const apart = await shadowlap(['run', '--', process.execPath, '-e', AGENT], env(fresh('sl-home-apart-')));
    expect(apart.code, apart.out).toBe(0);
    expect(apart.out).toContain('proxies: none');

    const code = new Promise<number | null>((resolve) => started.once('exit', resolve));
    started.kill('SIGTERM');
    await code;
    listener = null;
    expect(readdirSync(join(own, 'mcp'))).toEqual([]);
    expect(existsSync(join(home, '.shadowlap'))).toBe(false);
  }, 60_000);

  it("finds an agent's run from the proxy its MCP client starts with a minimal environment, when the client passes SHADOWLAP_HOME on", async () => {
    const passed = await shadowlap(['run', '--', process.execPath, MCP_AGENT, CLI, server.url], env(own, { MCP_AGENT_PASS: 'SHADOWLAP_HOME' }));
    expect(passed.code, passed.out).toBe(0);
    expect(passed.out).toMatch(/send_note -> send_note:\{"to":"billing"\}:\d+/);

    // A client that passes on only the minimal environment leaves the proxy to look in the home
    // folder's .shadowlap: it refuses the write, and says what to pass on.
    const before = server.calls.length;
    const stripped = await shadowlap(['run', '--', process.execPath, MCP_AGENT, CLI, server.url], env(own));
    expect(stripped.out).toMatch(/send_note -> refused: shadowlap: send_note was not sent/);
    expect(stripped.out).toContain(`no run is registered for it in ${join(home, '.shadowlap', 'agents')}; if Shadowlap runs with SHADOWLAP_HOME set, pass it on to this server too`);
    expect(server.calls.slice(before).map((c) => c.name)).toEqual(['read_note']);

    // Each agent's registration went when the agent did, and nothing went in the home folder.
    expect(readdirSync(join(own, 'agents'))).toEqual([]);
    expect(existsSync(join(home, '.shadowlap'))).toBe(false);
  }, 60_000);
});
