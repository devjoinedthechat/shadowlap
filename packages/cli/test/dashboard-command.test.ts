import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `shadowlap dashboard` as a person starts it: a job started from the browser runs this CLI, which
 * reports the run it made over the events pipe; `--read-only` refuses it.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

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

beforeAll(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-dash-cmd-')));
  env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_AUTHOR: 'priya@example.com' };
  const rec = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, '-e', 'console.log("agent ran")'], { cwd, env, encoding: 'utf8' });
  runId = /recording run (\w{26})/.exec(rec.stderr + rec.stdout)![1]!;
});
afterAll(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('shadowlap dashboard', () => {
  it('runs a job through this CLI, which reports the run it made over the events pipe', async () => {
    const d = await dashboard([]);
    const api = (path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, 'content-type': 'application/json' } });
    try {
      const meta = (await (await api('meta')).json()) as { actions: boolean; readOnly: boolean; project: { name: string; path: string }; jobKinds: string[] };
      expect(meta).toMatchObject({ actions: true, readOnly: false, project: { name: basename(cwd), path: cwd }, jobKinds: ['action'] });
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
});
