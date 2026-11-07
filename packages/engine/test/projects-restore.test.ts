import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/index.js';
import { ProjectHost, ProjectRegistry, projectDbPath } from '../src/projects/index.js';

/**
 * The Undo of removing a project: the registry puts it back at the place it left, with what the list
 * remembered of it, and the host reads the store `--db` named for it again, the current project
 * staying current.
 */

const dirs: string[] = [];
/** A temporary folder by its real path, the way the project list keeps folders. */
function tempDir(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function world() {
  const home = tempDir('sl-restore-home-');
  const shadowlapDir = join(home, '.sl');
  const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: shadowlapDir }, actor: () => 'dana@example.com' });
  const agent = (name: string) => {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
    return dir;
  };
  const ids = () => registry.list().map((p) => p.id);
  return { home, shadowlapDir, registry, agent, ids };
}

function events(db: string, kind: string) {
  const store = Store.open(db);
  try {
    return store.listEvents({ kinds: [kind] });
  } finally {
    store.close();
  }
}

describe('ProjectRegistry.restore', () => {
  it('lists the project at the place it left, with its setup and confirmed commands, and says it was added back', () => {
    const w = world();
    for (const name of ['alpha', 'support-agent', 'triage-bot']) w.registry.add(w.agent(name));
    w.registry.confirmCommand('support-agent', ['node', 'agent.mjs'], { upstream: 'http://127.0.0.1:11434' });
    const before = w.registry.get('support-agent')!;
    w.registry.remove('support-agent');
    expect(w.ids()).toEqual(['alpha', 'triage-bot']);
    // The file remembers where it was.
    const file = JSON.parse(readFileSync(join(w.shadowlapDir, 'projects.json'), 'utf8')) as { removed: Array<{ id: string; place: number }> };
    expect(file.removed.find((r) => r.id === 'support-agent')?.place).toBe(1);

    const back = w.registry.restore('support-agent');
    expect(back).toMatchObject({ again: true, project: { id: 'support-agent' } });
    expect(w.ids()).toEqual(['alpha', 'support-agent', 'triage-bot']);
    expect(w.registry.get('support-agent')).toEqual({ ...before, addedAt: expect.any(Number) });
    expect(w.registry.isConfirmed('support-agent', ['node', 'agent.mjs'], { upstream: 'http://127.0.0.1:11434' })).toBe(true);
    expect(events(projectDbPath(before.path), 'project.added').map((e) => e.data)).toContainEqual({ path: '~/support-agent', name: 'support-agent', again: true });

    // The last one comes back last, and one whose place is past the list's end too.
    w.registry.remove('triage-bot');
    w.registry.remove('alpha');
    w.registry.restore('triage-bot');
    expect(w.ids()).toEqual(['support-agent', 'triage-bot']);
    w.registry.restore('alpha');
    expect(w.ids()).toEqual(['alpha', 'support-agent', 'triage-bot']);
  });

  it('refuses a project put back already, one removed with its recordings, and one whose folder is gone', () => {
    const w = world();
    const support = w.agent('support-agent');
    for (const name of ['alpha', 'triage-bot']) w.registry.add(w.agent(name));
    w.registry.add(support);
    w.registry.remove('alpha');
    w.registry.restore('alpha');
    expect(() => w.registry.restore('alpha')).toThrow(expect.objectContaining({ code: 'not-found', message: 'There is no removed project alpha to put back.' }));

    w.registry.remove('triage-bot', { deleteRecordings: true, typedName: 'triage-bot' });
    expect(() => w.registry.restore('triage-bot')).toThrow(expect.objectContaining({ code: 'not-found' }));

    w.registry.remove('support-agent');
    renameSync(support, `${support}-moved`);
    expect(() => w.registry.restore('support-agent')).toThrow(expect.objectContaining({ code: 'folder', message: '~/support-agent isn’t on disk any more.' }));
    // The list still remembers it: with the folder back, the Undo works.
    renameSync(`${support}-moved`, support);
    expect(w.registry.restore('support-agent').project.id).toBe('support-agent');
  });
});

describe('ProjectHost.restore', () => {
  it('reads the store --db named for the project again, never the folder’s, and leaves the current project current', async () => {
    const w = world();
    const support = w.agent('support-agent');
    const custom = join(tempDir('sl-restore-db-'), 'runs.db');
    const host = ProjectHost.open(support, { registry: w.registry, loadConfig: () => ({}), dbPath: custom });
    w.registry.add(w.agent('triage-bot'));
    expect((await host.remove('support-agent')).current).toBe('triage-bot');

    const back = host.restore('support-agent');
    expect(back).toMatchObject({ project: { id: 'support-agent' }, current: 'triage-bot' });
    expect(host.currentProject()).toBe('triage-bot');
    expect(host.context('support-agent').dbPath).toBe(custom);
    expect(events(custom, 'project.added').map((e) => e.data?.again)).toContain(true);
    expect(existsSync(projectDbPath(support))).toBe(false);
    expect(() => host.restore('support-agent')).toThrow(expect.objectContaining({ code: 'not-found' }));
    host.close();
  });
});
