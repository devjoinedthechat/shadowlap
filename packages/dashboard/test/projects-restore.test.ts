import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectHost, ProjectRegistry, Store, projectDbPath } from '@shadowlap/engine';
import { startDashboard, type ProjectConfig } from '../src/index.js';

/**
 * The Undo of removing a project (routes/project-restore.ts): the remove's answer says whether its
 * toast can offer one, and the project comes back at the place it left, the current project staying
 * current, with the store `--db` named for it read again.
 */

let closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closing) await close();
  closing = [];
});

async function world(o: { dbPath?: (root: string) => string } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-restore-')));
  const folder = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
    return dir;
  };
  const [support, research, triage] = ['support-agent', 'research-agent', 'triage-bot'].map(folder) as [string, string, string];
  const registry = new ProjectRegistry({ home: root, env: { SHADOWLAP_HOME: join(root, '.sl') }, actor: () => null });
  const loadConfig = (): ProjectConfig => ({ normalize: [], redact: [] });
  const dbPath = o.dbPath?.(root);
  const host = ProjectHost.open<ProjectConfig>(support, { registry, loadConfig, ...(dbPath ? { dbPath } : {}) });
  registry.add(research);
  registry.add(triage);
  const dash = await startDashboard({ projects: host, readOnly: false });
  closing.push(async () => {
    await dash.close();
    host.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const api = async <T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${dash.url}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const ids = async () => (await api<{ items: Array<{ id: string }> }>('projects')).body.items.map((p) => p.id);
  const current = async () => (await api<{ project: { id: string }; dbPath: string }>('meta')).body;
  return { support, research, triage, registry, api, ids, current, url: dash.url };
}

describe('Undo after removing a project', () => {
  it('puts it back at the place it left, with its confirmed commands, and leaves the current project current', async () => {
    const w = await world();
    w.registry.confirmCommand('research-agent', ['uv', 'run', 'agent.py'], { upstream: null });
    expect(await w.ids()).toEqual(['support-agent', 'research-agent', 'triage-bot']);
    const removed = await w.api('projects/research-agent/remove', {});
    expect(removed.body).toEqual({ removed: 'research-agent', current: 'support-agent', deleted: [], message: 'Removed research-agent · nothing on disk changed', undo: true });
    expect(await w.ids()).toEqual(['support-agent', 'triage-bot']);
    await w.api('projects/triage-bot/select', {});

    const back = await w.api('projects/research-agent/restore', {});
    expect(back).toEqual({ status: 200, body: { project: { id: 'research-agent', name: 'research-agent' }, current: 'triage-bot', message: 'research-agent is back on the dashboard' } });
    expect(await w.ids()).toEqual(['support-agent', 'research-agent', 'triage-bot']);
    expect((await w.current()).project.id).toBe('triage-bot');
    expect(w.registry.isConfirmed('research-agent', ['uv', 'run', 'agent.py'])).toBe(true);
    // A second press finds nothing to put back.
    expect(await w.api('projects/research-agent/restore', {})).toMatchObject({ status: 404, body: { error: 'There is no removed project research-agent to put back.' } });
  });

  it('offers none once the recordings are deleted or the folder is gone, and refuses one then', async () => {
    const w = await world();
    const gone = await w.api('projects/triage-bot/remove', { deleteRecordings: true, name: 'triage-bot' });
    expect(gone.body).toMatchObject({ message: 'Removed triage-bot and deleted its recordings', undo: false });
    expect((await w.api('projects/triage-bot/restore', {})).status).toBe(404);

    renameSync(w.research, `${w.research}-moved`);
    expect((await w.api('projects/research-agent/remove', {})).body).toMatchObject({ message: 'Removed research-agent · nothing on disk changed', undo: false });
    expect(await w.api('projects/research-agent/restore', {})).toMatchObject({ status: 400, body: { error: '~/research-agent isn’t on disk any more.' } });
    expect(await w.ids()).toEqual(['support-agent']);
  });

  it('is refused in the project list’s own words when a newer shadowlap wrote the list, ~ for the home folder as Remove’s answer writes it', async () => {
    const w = await world();
    expect((await w.api('projects/research-agent/remove', {})).body).toMatchObject({ undo: true });
    const list = readFileSync(w.registry.file, 'utf8');
    const newer = `${JSON.stringify({ ...(JSON.parse(list) as object), version: 2 }, null, 2)}\n`;
    writeFileSync(w.registry.file, newer);
    const refused = { status: 500, body: { error: '~/.sl/projects.json was written by a newer shadowlap. Upgrade shadowlap to change the project list.' } };
    expect(await w.api('projects/research-agent/restore', {})).toEqual(refused);
    expect(await w.api('projects/triage-bot/remove', {})).toEqual(refused);
    expect(readFileSync(w.registry.file, 'utf8')).toBe(newer);
    // A list this shadowlap can change again: the toast's Undo works.
    writeFileSync(w.registry.file, list);
    expect((await w.api('projects/research-agent/restore', {})).body).toMatchObject({ project: { id: 'research-agent' } });
  });

  it('needs the session token, as every route does', async () => {
    const w = await world();
    expect((await w.api('projects/research-agent/remove', {})).body).toMatchObject({ undo: true });
    for (const token of [null, 'wrong']) {
      const res = await fetch(`${w.url}/api/projects/research-agent/restore`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-shadowlap-token': token } : {}) }, body: '{}' });
      expect(res.status, `token ${token}`).toBe(401);
    }
    expect(await w.ids()).toEqual(['support-agent', 'triage-bot']);
  });

  it('reads the store --db named for the project again, not one in its folder', async () => {
    const w = await world({ dbPath: (root) => join(root, 'elsewhere', 'runs.db') });
    const custom = (await w.current()).dbPath;
    expect(custom).toMatch(/elsewhere[\\/]runs\.db$/);
    const store = Store.open(custom);
    store.close();
    expect((await w.api('projects/support-agent/remove', {})).body).toMatchObject({ current: 'research-agent', undo: true });
    expect((await w.api('projects/support-agent/restore', {})).body).toMatchObject({ current: 'research-agent' });
    await w.api('projects/support-agent/select', {});
    expect((await w.current()).dbPath).toBe(custom);
    expect(existsSync(projectDbPath(w.support))).toBe(false);
  });

  it('is no route on a dashboard that serves one store', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-restore-one-')));
    const store = Store.open(join(root, 'runs.db'));
    const dash = await startDashboard({ store, readOnly: false });
    closing.push(async () => {
      await dash.close();
      store.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    const res = await fetch(`${dash.url}/api/projects/x/restore`, { method: 'POST', headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });
});
