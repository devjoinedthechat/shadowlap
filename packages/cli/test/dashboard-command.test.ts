import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';

/**
 * `shadowlap dashboard` as a person starts it: a job started from the browser runs this CLI, which
 * reports the run it made over the events pipe; `--read-only` refuses it; stopping the dashboard,
 * however it is stopped, stops its jobs and the agents they started, and so does stopping the
 * terminal UI that opened one.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const EMBEDDED = fileURLToPath(new URL('./embedded-dashboard.mjs', import.meta.url));

let cwd: string;
let env: NodeJS.ProcessEnv;
let runId: string;

interface Started {
  child: ChildProcess;
  url: string;
  token: string;
  banner: string;
}

function dashboard(args: string[]): Promise<Started> {
  const child = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '--port', String(40_000 + Math.floor(Math.random() * 20_000)), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`no link printed: ${text}`)), 20_000);
    const on = (c: Buffer) => {
      text += c.toString();
      const m = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]+)/.exec(text);
      if (!m) return;
      clearTimeout(timer);
      resolve({ child, url: m[1]!, token: m[2]!, banner: text });
    };
    child.stderr!.on('data', on);
    child.stdout!.on('data', on);
  });
}

async function stop(d: Started): Promise<void> {
  d.child.kill('SIGTERM');
  await new Promise((r) => d.child.once('exit', r));
}

/** Agents the stop tests started, until they are seen gone. */
const agents = new Set<number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 200 && alive(pid); i++) await sleep(25);
  return !alive(pid);
}

/**
 * An agent that keeps running when it is replayed (the file `slow` is there), printing its process
 * id; with the file `stubborn` it ignores SIGTERM and says it got one in the file `got-term`.
 */
const SLEEPER = [
  "const fs = require('node:fs');",
  "if (fs.existsSync('slow')) {",
  "  if (fs.existsSync('stubborn')) process.on('SIGTERM', () => fs.writeFileSync('got-term', ''));",
  "  console.log('agent ' + process.pid);",
  '  setInterval(() => {}, 1000);',
  '}',
].join('\n');

beforeAll(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-dash-cmd-')));
  // The dashboard keeps its list of projects in SHADOWLAP_HOME: the test's own, never the real one.
  env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_AUTHOR: 'priya@example.com', SHADOWLAP_HOME: realpathSync(mkdtempSync(join(tmpdir(), 'sl-dash-cmd-home-'))) };
  const rec = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, '-e', 'console.log("agent ran")'], { cwd, env, encoding: 'utf8' });
  runId = /recording run (\w{26})/.exec(rec.stderr + rec.stdout)![1]!;
});
afterAll(() => {
  // Agents a failed test left behind.
  for (const pid of agents) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone, as it should be
    }
  }
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(env.SHADOWLAP_HOME!, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('shadowlap dashboard', () => {
  it('runs a job through this CLI, which reports the run it made over the events pipe', async () => {
    const d = await dashboard([]);
    const api = (path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, 'content-type': 'application/json' } });
    try {
      const meta = (await (await api('meta')).json()) as { actions: boolean; readOnly: boolean; project: { name: string; path: string }; jobKinds: string[] };
      // It serves the projects on this machine, opening on the folder it starts in, and can inspect and record there.
      expect(meta).toMatchObject({ actions: true, readOnly: false, project: { id: basename(cwd).toLowerCase(), name: basename(cwd), path: cwd }, jobKinds: expect.arrayContaining(['action', 'init', 'record']) });
      let job = (await (await api(`runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ key: 'r' }) })).json()) as { id: string; done: boolean; code: number | null; newRunId: string | null; links: Array<{ href: string }>; result: { exitCode?: number } | null; title: string };
      expect(job.title).toBe('Replaying');
      for (let i = 0; i < 400 && !job.done; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = (await (await api(`jobs/${job.id}`)).json()) as typeof job;
      }
      expect(job).toMatchObject({ done: true, code: 0, result: { exitCode: 0 } });
      expect(job.newRunId).toMatch(/^[0-9A-Z]{26}$/);
      expect(job.links).toEqual([{ label: `Open run ${job.newRunId!.slice(0, 10)}`, href: `#/run/${job.newRunId}` }]);
      const activity = (await (await api('activity')).json()) as { items: Array<{ runId?: string; actor?: string }> };
      expect(activity.items.find((i) => i.runId === job.newRunId)?.actor).toBe('priya@example.com');
    } finally {
      await stop(d);
    }
  });

  it('--read-only says so and refuses every change', async () => {
    const d = await dashboard(['--read-only']);
    try {
      expect(d.banner).toContain('(read-only)');
      const headers = { 'x-shadowlap-token': d.token, 'content-type': 'application/json' };
      const meta = (await (await fetch(`${d.url}/api/meta`, { headers })).json()) as { readOnly: boolean; actions: boolean };
      expect(meta).toMatchObject({ readOnly: true, actions: false });
      const refused = await fetch(`${d.url}/api/runs/${runId}/actions`, { method: 'POST', headers, body: JSON.stringify({ key: 'r' }) });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toContain('--read-only');
    } finally {
      await stop(d);
    }
  });

  it('--read-only never creates a store', () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'sl-dash-ro-empty-')));
    try {
      const r = spawnSync(process.execPath, [CLI, 'dashboard', '--read-only', '--no-open'], { cwd: empty, env, encoding: 'utf8', timeout: 20_000 });
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toMatch(/no store at .* never creates one/);
      expect(existsSync(join(empty, '.shadowlap'))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('stopping shadowlap dashboard', () => {
  let sleeperId: string;
  beforeAll(() => {
    const rec = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, '-e', SLEEPER], { cwd, env, encoding: 'utf8' });
    sleeperId = /recording run (\w{26})/.exec(rec.stderr + rec.stdout)![1]!;
  });
  afterEach(() => {
    for (const f of ['slow', 'stubborn', 'got-term']) rmSync(join(cwd, f), { force: true });
  });

  /** Replays the sleeper from the dashboard, and waits for its agent to be running. */
  async function replaying(d: Started): Promise<{ agent: number; runId: string }> {
    const api = (path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, 'content-type': 'application/json' } });
    writeFileSync(join(cwd, 'slow'), '');
    let job = (await (await api(`runs/${sleeperId}/actions`, { method: 'POST', body: JSON.stringify({ key: 'r' }) })).json()) as { id: string; lines: string[]; newRunId: string | null };
    for (let i = 0; i < 400; i++) {
      const pid = job.lines.map((l) => /^agent (\d+)$/.exec(l)?.[1]).find(Boolean);
      if (pid && job.newRunId) {
        agents.add(Number(pid));
        return { agent: Number(pid), runId: job.newRunId };
      }
      await sleep(50);
      job = (await (await api(`jobs/${job.id}`)).json()) as typeof job;
    }
    throw new Error(`the agent never started: ${job.lines.join('\n')}`);
  }

  function statusOf(runId: string): string | undefined {
    const store = Store.open(join(cwd, '.shadowlap', 'shadowlap.db'));
    try {
      return store.getRun(runId)?.status;
    } finally {
      store.close();
    }
  }

  it('stops its jobs and their agents when the terminal it runs in closes', async () => {
    const d = await dashboard([]);
    const { agent, runId } = await replaying(d);
    const exited = new Promise<number | null>((r) => d.child.once('exit', (code) => r(code)));
    d.child.kill('SIGHUP');
    expect(await exited).toBe(0);
    expect(await gone(agent), 'the agent was stopped with the dashboard').toBe(true);
    agents.delete(agent);
    expect(statusOf(runId), 'the replay was interrupted').toBe('crashed');
  });

  it('kills them at once when it is stopped again while it waits for an agent that ignores the signal', async () => {
    writeFileSync(join(cwd, 'stubborn'), '');
    const d = await dashboard([]);
    const { agent, runId } = await replaying(d);
    const exited = new Promise<number | null>((r) => d.child.once('exit', (code) => r(code)));
    d.child.kill('SIGINT');
    for (let i = 0; i < 200 && !existsSync(join(cwd, 'got-term')); i++) await sleep(25);
    expect(existsSync(join(cwd, 'got-term')), 'the agent got the stop, and ignored it').toBe(true);
    const again = Date.now();
    d.child.kill('SIGINT');
    expect(await exited).toBe(0);
    // Five seconds of grace were left: a second Ctrl-C does not wait for them.
    expect(Date.now() - again).toBeLessThan(4000);
    expect(await gone(agent), 'the agent was killed with the dashboard').toBe(true);
    agents.delete(agent);
    expect(statusOf(runId), 'the replay it left recording was marked as interrupted').toBe('crashed');
  });

  /** The dashboard `shadowlap ui` opens, started the way the terminal UI starts it (embedded-dashboard.mjs). */
  function embedded(): Promise<Started> {
    const child = spawn(process.execPath, [EMBEDDED, CLI, join(cwd, '.shadowlap', 'shadowlap.db')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`no address printed: ${text}`)), 20_000);
      child.stderr!.on('data', (c: Buffer) => (text += c.toString()));
      child.stdout!.on('data', (c: Buffer) => {
        text += c.toString();
        const m = /^(\{.*\})$/m.exec(text);
        if (!m) return;
        clearTimeout(timer);
        const { url, token } = JSON.parse(m[1]!) as { url: string; token: string };
        resolve({ child, url, token, banner: text });
      });
    });
  }

  it('the terminal UI\'s dashboard kills its jobs and their agents when the terminal closes, then ends as the hangup would have', async () => {
    const d = await embedded();
    const { agent, runId } = await replaying(d);
    const exited = new Promise<NodeJS.Signals | null>((r) => d.child.once('exit', (_code, signal) => r(signal)));
    d.child.kill('SIGHUP');
    expect(await exited).toBe('SIGHUP');
    expect(await gone(agent), 'the agent did not outlive the terminal').toBe(true);
    agents.delete(agent);
    expect(statusOf(runId), 'the replay it left recording was marked as interrupted').toBe('crashed');
  });

  it('the terminal UI\'s dashboard stops its jobs on a kill, giving them the time to end their runs', async () => {
    const d = await embedded();
    const { agent, runId } = await replaying(d);
    const exited = new Promise<NodeJS.Signals | null>((r) => d.child.once('exit', (_code, signal) => r(signal)));
    d.child.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    expect(await gone(agent), 'the agent was stopped with it').toBe(true);
    agents.delete(agent);
    expect(statusOf(runId), 'the replay ended as interrupted').toBe('crashed');
  });
});
