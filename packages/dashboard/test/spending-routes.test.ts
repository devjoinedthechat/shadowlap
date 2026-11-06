import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectHost, ProjectRegistry, releaseLock, SPENDING_REFUSED, Store, takeLock, USER_SETTINGS_FILE } from '@shadowlap/engine';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDashboard, type Dashboard, type GoldenSource, type JobView, type ProjectConfig, type SpawnCli } from '../src/index.js';

/**
 * Spending over HTTP: the person's own threshold on this machine, kept under SHADOWLAP_HOME and never
 * in shadowlap.config.json, the same whichever project is open. A change answers what it was, for an
 * Undo; one it can't keep is refused in the words that say why.
 */

let home: string;
let project: string;
let store: Store;
let dash: Dashboard;
const env = { ...process.env };
const CONFIG = '{\n  "normalize": [],\n  "tests": { "goldens/refund": { "mode": "fork" } }\n}\n';

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sl-spending-home-')));
  process.env.SHADOWLAP_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = env;
});

beforeEach(async () => {
  rmSync(join(home, USER_SETTINGS_FILE), { force: true });
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-spending-routes-')));
  writeFileSync(join(project, 'shadowlap.config.json'), CONFIG);
  store = Store.open(':memory:');
  dash = await startDashboard({ store, readOnly: false, project: { path: project } });
});
afterEach(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

type Answer = { status: number; body: Record<string, unknown> };
async function api(d: Dashboard, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null } = {}): Promise<Answer> {
  const res = await fetch(`${d.url}/api/${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.token === null ? {} : { 'x-shadowlap-token': init.token ?? d.token }), 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const put = (askAbove: unknown, d: Dashboard = dash, headers: Record<string, string> = {}) => api(d, 'user/spending', { method: 'PUT', body: { askAbove }, headers });
const kept = () => JSON.parse(readFileSync(join(home, USER_SETTINGS_FILE), 'utf8')) as { version: number; spending: { askAbove: unknown } };

describe('Spending', () => {
  it('asks above $0.50 until someone changes it, and needs the session token', async () => {
    expect(await api(dash, 'user/spending')).toEqual({ status: 200, body: { askAbove: 0.5, set: false, problems: [] } });
    expect((await api(dash, 'user/spending', { token: null })).status).toBe(401);
    expect((await api(dash, 'user/spending', { method: 'PUT', body: { askAbove: 2 }, token: null })).status).toBe(401);
    expect((await api(dash, 'user/spending', { method: 'PUT', body: { askAbove: 2 }, token: 'wrong' })).status).toBe(401);
  });

  it('keeps a threshold under SHADOWLAP_HOME, never in the project, and says what it was for an Undo', async () => {
    expect(await put(2)).toEqual({ status: 200, body: { askAbove: 2, set: true, was: 0.5, problems: [] } });
    expect(kept()).toMatchObject({ version: 1, spending: { askAbove: 2 } });
    expect(await put(0)).toEqual({ status: 200, body: { askAbove: 0, set: true, was: 2, problems: [] } });
    // Never ask is null, kept as null: not the Always ask a 0 would be.
    expect(await put(null)).toEqual({ status: 200, body: { askAbove: null, set: true, was: 0, problems: [] } });
    expect(kept().spending.askAbove).toBeNull();
    expect(await api(dash, 'user/spending')).toEqual({ status: 200, body: { askAbove: null, set: true, problems: [] } });
    // Undo writes back what it was.
    expect((await put(0)).body).toMatchObject({ askAbove: 0, was: null });
    expect(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')).toBe(CONFIG);
    // The project's settings carry no Spending.
    const settings = await api(dash, 'settings/project');
    expect(settings.status).toBe(200);
    expect(JSON.stringify(settings.body)).not.toMatch(/"(spending|askAbove)":/i);
    // Nor does the answer say where the file is.
    expect(JSON.stringify((await api(dash, 'user/spending')).body)).not.toContain(home);
  });

  it('refuses an amount that is no threshold, with what to type, and keeps the one it had', async () => {
    await put(2);
    for (const askAbove of [1.005, -1, 'lots', '0.50', true, { usd: 1 }, undefined]) {
      expect(await put(askAbove), JSON.stringify(askAbove)).toEqual({ status: 400, body: { error: SPENDING_REFUSED } });
    }
    expect((await api(dash, 'user/spending', { method: 'PUT', body: {} })).status).toBe(400);
    expect(kept().spending.askAbove).toBe(2);
  });

  it('refuses a change it would lose something of, or one another process holds the file for, saying why', async () => {
    // A newer Shadowlap's file is read, never written over.
    writeFileSync(join(home, USER_SETTINGS_FILE), JSON.stringify({ version: 99, spending: { askAbove: 2 }, theirs: true }));
    const newer = await put(1);
    expect(newer.status).toBe(409);
    expect(newer.body.error).toContain('was written by a newer Shadowlap');
    expect(kept()).toEqual({ version: 99, spending: { askAbove: 2 }, theirs: true });
    // A file that is no settings: fix or remove it.
    writeFileSync(join(home, USER_SETTINGS_FILE), 'not json');
    const broken = await put(1);
    expect(broken.status).toBe(409);
    expect(broken.body.error).toContain('fix or remove it');
    expect(await api(dash, 'user/spending')).toMatchObject({ status: 200, body: { askAbove: 0.5, set: false, problems: [expect.stringContaining('isn’t valid JSON')] } });
    // Another process writing it: the request waits a moment, then says so, rather than hold the server.
    rmSync(join(home, USER_SETTINGS_FILE));
    const held = takeLock(join(home, `${USER_SETTINGS_FILE}.lock`), { wait: 0, busy: () => new Error('held') });
    try {
      const started = Date.now();
      const busy = await put(1);
      expect(busy.status).toBe(409);
      expect(busy.body.error).toContain('is held by another Shadowlap process');
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      releaseLock(held);
    }
    expect((await put(1)).status).toBe(200);
  });

  it('is refused on a read-only dashboard, which still says it', async () => {
    const readOnly = await startDashboard({ store, readOnly: true, project: { path: project } });
    try {
      expect((await put(2, readOnly)).status).toBe(403);
      expect(await api(readOnly, 'user/spending')).toEqual({ status: 200, body: { askAbove: 0.5, set: false, problems: [] } });
    } finally {
      await readOnly.close();
    }
  });
});

describe('Spending, with several projects', () => {
  it('is the same whichever project is current, and a page still showing another changes it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-spending-projects-')));
    const folder = (name: string) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{}');
      return dir;
    };
    const support = folder('support-agent');
    const triage = folder('triage-bot');
    const registry = new ProjectRegistry({ home: root, env: { SHADOWLAP_HOME: home }, actor: () => null });
    const loadConfig = (): ProjectConfig => ({ normalize: [], redact: [] });
    const host = ProjectHost.open<ProjectConfig>(support, { registry, loadConfig });
    registry.add(triage);
    const several = await startDashboard({ projects: host, readOnly: false });
    try {
      expect((await put(2, several)).body).toMatchObject({ askAbove: 2, was: 0.5 });
      expect((await api(several, 'projects/triage-bot/select', { method: 'POST' })).status).toBe(200);
      expect((await api(several, 'user/spending')).body).toMatchObject({ askAbove: 2, set: true });
      // A page still showing support-agent: Spending is nobody's project, so it changes all the same.
      expect((await put(0, several, { 'x-shadowlap-project': 'support-agent' })).body).toMatchObject({ askAbove: 0, was: 2 });
      expect((await api(several, 'projects/support-agent/select', { method: 'POST' })).status).toBe(200);
      expect((await api(several, 'user/spending')).body).toMatchObject({ askAbove: 0, set: true });
    } finally {
      await several.close();
      host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Spending is no budget', () => {
  const FAKE = fileURLToPath(new URL('./fake-tests-cli.mjs', import.meta.url));
  const GOLDEN: GoldenSource = { path: 'goldens/refund', runId: 'GOLDEN_REFUND', packedAt: Date.UTC(2026, 10, 1), mode: 'fork', repeat: 1, passes: 1, checks: [] };

  it('reaches no job’s arguments at any setting: a job starts with what it was asked and its estimate, never a --budget of the threshold', async () => {
    const spawned: string[][] = [];
    const spawnCli: SpawnCli = (args, options) => {
      spawned.push(args);
      return spawn(process.execPath, [FAKE, ...args], { ...(options?.cwd ? { cwd: options.cwd } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
    };
    const d = await startDashboard({ store, spawnCli, readOnly: false, project: { path: project }, goldens: () => [GOLDEN] });
    try {
      for (const askAbove of [0, 0.5, 2, null]) {
        expect((await put(askAbove, d)).status).toBe(200);
        // The server asks the same question at every setting: the page answers it by Spending.
        const asked = await api(d, 'jobs', { method: 'POST', body: { kind: 'test', golden: GOLDEN.path } });
        expect(asked.status).toBe(409);
        const res = await api(d, 'jobs', { method: 'POST', body: { kind: 'test', golden: GOLDEN.path, yes: asked.body.confirm, estimate: { usd: 0.3, ceiling: false } } });
        expect(res.status).toBe(202);
        const job = res.body as unknown as JobView;
        expect(job.args).toEqual(['test', GOLDEN.path]);
        expect(job.estimate).toEqual({ usd: 0.3, ceiling: false });
        for (let i = 0; i < 400 && !(await api(d, `jobs/${job.id}`)).body.done; i++) await new Promise((r) => setTimeout(r, 25));
      }
      expect(spawned.flat()).not.toContain('--budget');
    } finally {
      await d.close();
    }
  });
});
