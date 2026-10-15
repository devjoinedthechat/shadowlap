import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Store } from '@shadowlap/engine';

/**
 * Settings as a person uses it from `shadowlap dashboard`: Calibrate runs this CLI and "Add it
 * (--write)" adds what it proposed; Clean up old runs is a dry run, then deletes exactly those runs;
 * the redaction preview counts what a rule added from the page would mask. The real commands, so
 * the result shapes the routes read are the ones the CLI sends.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./volatile-agent.mjs', import.meta.url));

let mock: MockServer;
let cwd: string;
let home: string;
let env: NodeJS.ProcessEnv;
let runId: string;
let dash: { child: ChildProcess; url: string; token: string };

interface Job {
  id: string;
  args: string[];
  done: boolean;
  code: number | null;
  lines: string[];
  result: Record<string, unknown> | null;
}

const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' } });
const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });

async function finished(started: Job): Promise<Job> {
  let job = started;
  for (let i = 0; i < 600 && !job.done; i++) {
    await new Promise((r) => setTimeout(r, 50));
    job = (await (await api(`jobs/${job.id}`)).json()) as Job;
  }
  expect(job.done, job.lines.join('\n')).toBe(true);
  return job;
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('triaged')]) }) });
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-settings-dash-')));
  home = mkdtempSync(join(tmpdir(), 'sl-settings-home-'));
  env = { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_AUTHOR: 'dana@example.com', SHADOWLAP_HOME: home };
  // Not spawnSync: the mock answers from this process, which must keep running meanwhile.
  const rec = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, 'run', '--', process.execPath, AGENT], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
  expect(rec.code, rec.out).toBe(0);
  runId = /recording run (\w{26})/.exec(rec.out)![1]!;
  // Two runs from two months ago, for Clean up old runs to find.
  const store = Store.open(join(cwd, '.shadowlap', 'shadowlap.db'));
  for (let i = 0; i < 2; i++) {
    const at = Date.now() - 60 * 86_400_000 + i;
    const old = store.createRun({ mode: 'record', command: { argv: ['node', 'old.mjs'], cwd }, startedAt: at });
    store.endRun(old.runId, 'completed', at + 1);
  }
  store.close();
  const child = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '--port', String(40_000 + Math.floor(Math.random() * 20_000))], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  dash = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no link printed: ${out}`)), 20_000);
    const on = (c: Buffer) => {
      out += c.toString();
      const m = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]+)/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      resolve({ child, url: m[1]!, token: m[2]! });
    };
    child.stderr.on('data', on);
    child.stdout.on('data', on);
  });
});

afterAll(async () => {
  if (dash) {
    dash.child.kill('SIGTERM');
    await new Promise((r) => dash.child.once('exit', r));
  }
  await mock?.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(home, { recursive: true, force: true });
});

describe('Settings from shadowlap dashboard', () => {
  it('calibrates the newest recording and adds exactly the normalizers it proposed', async () => {
    const matching = (await (await api('settings/matching')).json()) as { calibrate: { runId: string; label: string } };
    expect(matching.calibrate).toMatchObject({ runId, label: `Calibrate ${runId.slice(0, 10)}` });
    const job = await finished((await (await post('jobs', { kind: 'calibrate' })).json()) as Job);
    expect(job.args).toEqual(['calibrate', runId]);
    expect(job.code, job.lines.join('\n')).toBe(0);
    expect(job.lines.join('\n')).toMatch(/round 1 {2}diverged at call 1/);
    expect(job.result).toMatchObject({ runId, written: false });
    expect(job.result!.normalizers).toHaveLength(3);

    const write = await post('settings/calibrate/write', { jobId: job.id });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ added: [1, 2, 3], already: [] });
    const config = JSON.parse(readFileSync(join(cwd, 'shadowlap.config.json'), 'utf8')) as { normalize: Array<{ path: string }> };
    expect(config.normalize.map((n) => n.path)).toEqual(['$.metadata.user_id', '$.system', '$.args.path']);
    const activity = (await (await api('activity')).json()) as { items: unknown[] };
    expect(JSON.stringify(activity.items)).toContain('$.metadata.user_id');

    // With them, the recording replays clean: calibrate has nothing more to add.
    const again = await finished((await (await post('jobs', { kind: 'calibrate', runId })).json()) as Job);
    expect(again.lines.join('\n')).toMatch(/Nothing to add/);
    expect(again.result).toMatchObject({ clean: true, normalizers: [] });
  });

  it('cleans up old runs: the dry run, then exactly the runs it listed', async () => {
    const dry = await finished((await (await post('jobs', { kind: 'gc' })).json()) as Job);
    expect(dry.args).toEqual(['gc', '--older-than', '30', '--dry-run']);
    expect(dry.lines.join('\n')).toMatch(/dry run: would delete 2 runs/);
    expect(dry.result).toMatchObject({ dryRun: true, count: 2 });
    const deleted = await finished((await (await post('jobs', { kind: 'gc', confirm: dry.id })).json()) as Job);
    expect(deleted.args.slice(0, 2)).toEqual(['gc', '--before']);
    expect(deleted.code, deleted.lines.join('\n')).toBe(0);
    expect(deleted.result).toMatchObject({ dryRun: false, count: 2 });
    const project = (await (await api('settings/project')).json()) as { runs: number };
    expect(project.runs).toBe(1);
  });

  it('previews what a redaction rule added from the page would mask', async () => {
    const before = (await (await api('settings/redaction')).json()) as { config: { version: string }; previewRunId: string };
    expect(before.previewRunId).toBe(runId);
    const added = await post('settings/rules/redact', { rule: { pattern: '/triage[d]?/', replace: '<WORK>' }, expect: before.config.version });
    expect(added.status).toBe(200);
    const view = (await (await api(`settings/redaction/preview?run=${runId}`)).json()) as { preview: { total: number; rules: Array<{ count: number; samples: Array<{ before: string; after: string }> }> } };
    expect(view.preview.total).toBeGreaterThanOrEqual(2);
    expect(view.preview.rules[0]!.samples[0]!.after).toContain('<WORK>');
  });
});
