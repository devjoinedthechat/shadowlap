import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectError, ProjectHost, ProjectRegistry, projectDbPath } from '../src/index.js';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function files(root: string, tree: Record<string, string>): string {
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function world() {
  const home = tempDir('sl-host-home-');
  const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: join(home, '.sl') }, actor: () => null });
  const loads: string[] = [];
  const loadConfig = (cwd: string) => {
    loads.push(cwd);
    const file = join(cwd, 'shadowlap.config.json');
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { clock?: string }) : {};
  };
  const support = files(join(home, 'support-agent'), { 'pyproject.toml': '' });
  const triage = files(join(home, 'triage-bot'), { 'package.json': '{}', 'goldens/triage-inbox/run.json': '{}' });
  return { home, registry, loads, loadConfig, support, triage };
}

describe('ProjectHost', () => {
  it('opens on the folder the dashboard starts in, and runs its actions there, against its store', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    const ctx = host.current();
    expect(ctx).toMatchObject({ id: 'support-agent', name: 'support-agent', path: support, cwd: support, dbPath: projectDbPath(support) });
    expect(ctx.cliArgs(['replay', '01K5'])).toEqual(['--db', projectDbPath(support), 'replay', '01K5']);
    expect(registry.list().map((p) => p.id)).toEqual(['support-agent']);
    host.close();
  });

  it('opens a project’s store only when it is needed, and never creates one just to count runs', () => {
    const { registry, loadConfig, support, triage } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    registry.add('~/triage-bot');
    rmSync(join(triage, '.shadowlap'), { recursive: true, force: true }); // as if added before it had a store
    const other = host.context('triage-bot');
    expect(other.hasStore()).toBe(false);
    expect(other.facts()).toMatchObject({ runs: 0, recordings: [] });
    expect(existsSync(join(triage, '.shadowlap'))).toBe(false);
    expect(other.goldens()).toBe(1);
    other.store().createRun({ mode: 'record', command: { argv: ['node', 'triage.mjs'], cwd: triage } });
    expect(other.hasStore()).toBe(true);
    expect(other.facts().runs).toBe(1);
    // A recording still running holds the setup where it was.
    expect(host.setup('triage-bot')).toMatchObject({ stage: 'added', live: true, shows: 'overview' });
    host.close();
  });

  it('switches projects by swapping the context', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    registry.add('~/triage-bot');
    expect(host.switchTo('triage-bot').id).toBe('triage-bot');
    expect(host.currentProject()).toBe('triage-bot');
    expect(host.current().path).toBe(registry.get('triage-bot')!.path);
    expect(() => host.switchTo('nope')).toThrow(expect.objectContaining({ code: 'not-found' }));
    host.close();
  });

  it('reads a project’s config through the loader, again only when the file changes', () => {
    const { registry, loadConfig, loads, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    const ctx = host.current();
    expect(ctx.config()).toEqual({});
    expect(ctx.config()).toEqual({});
    expect(loads).toHaveLength(1);
    writeFileSync(join(support, 'shadowlap.config.json'), '{"clock":"exact"}');
    expect(ctx.config()).toEqual({ clock: 'exact' });
    expect(loads).toHaveLength(2);
    host.close();
  });

  it('keeps the store --db named for the project it started in, and won’t delete that one', () => {
    const { registry, loadConfig, support } = world();
    const custom = join(tempDir('sl-custom-'), 'runs.db');
    const host = ProjectHost.open(support, { registry, loadConfig, dbPath: custom });
    expect(host.current().dbPath).toBe(custom);
    expect(host.current().cliArgs(['ls'])).toEqual(['--db', custom, 'ls']);
    registry.add('~/triage-bot');
    expect(() => host.remove('support-agent', { deleteRecordings: true, typedName: 'support-agent' })).toThrow(expect.objectContaining({ code: 'store' }));
    host.close();
  });

  it('closes a removed project’s store first, and moves to another project when the current one goes', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    registry.add('~/triage-bot');
    const store = host.current().store();
    store.createRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: support } });
    store.endRun(store.listRuns(1)[0]!.runId, 'completed');
    const removed = host.remove('support-agent', { deleteRecordings: true, typedName: 'support-agent' });
    expect(removed).toMatchObject({ current: 'triage-bot', deleted: expect.arrayContaining(['.shadowlap/shadowlap.db']) });
    expect(existsSync(projectDbPath(support))).toBe(false);
    expect(host.currentProject()).toBe('triage-bot');
    expect(() => host.context('support-agent')).toThrow(ProjectError);
    host.close();
  });

  it('follows the list when another process changes it', () => {
    const { registry, loadConfig, support, home } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    const other = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: join(home, '.sl') }, actor: () => null });
    other.add('~/triage-bot');
    files(join(home, 'a', 'agent'), { 'package.json': '{}' });
    files(join(home, 'b', 'agent'), { 'package.json': '{}' });
    other.add('~/a/agent');
    expect(host.context('agent').path).toBe(join(home, 'a', 'agent'));

    // Removed elsewhere: gone here too, and the id now names another folder.
    other.remove('agent');
    expect(() => host.context('agent')).toThrow(expect.objectContaining({ code: 'not-found' }));
    other.add('~/b/agent');
    expect(host.context('agent').path).toBe(join(home, 'b', 'agent'));

    // The current project removed elsewhere: the first one left becomes current.
    other.remove('support-agent');
    expect(host.currentProject()).toBe('triage-bot');
    expect(host.current().path).toBe(join(home, 'triage-bot'));
    host.close();
  });

  it('adds the folder it started in again when the list loses every project', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    rmSync(registry.file);
    expect(host.current()).toMatchObject({ id: 'support-agent', path: support });
    expect(registry.list().map((p) => p.id)).toEqual(['support-agent']);
    host.close();
  });

  it('counts runs, attempts and goldens per project, and says when a folder is gone', () => {
    const { registry, loadConfig, support, triage } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    registry.add('~/triage-bot');
    const store = host.context('triage-bot').store();
    const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'triage.mjs'], cwd: triage } });
    store.endRun(rec.runId, 'completed');
    store.endRun(store.createRun({ mode: 'replay', command: { argv: ['node', 'triage.mjs'], cwd: triage }, parentRunId: rec.runId, meta: { repeat: { group: 'g1', attempt: 1, of: 2 } } }).runId, 'completed');
    const gone = files(join(registry.home, 'gone-agent'), { 'package.json': '{}' });
    registry.add('~/gone-agent');
    rmSync(gone, { recursive: true, force: true });
    expect(host.stats()).toEqual({
      'support-agent': { runs: 0, attempts: 0, goldens: 0, missing: false },
      'triage-bot': { runs: 1, attempts: 1, goldens: 1, missing: false },
      'gone-agent': { runs: 0, attempts: 0, goldens: 0, missing: true },
    });
    host.close();
  });

  it('plans a recording with the commands confirmed in the folder and the model server init found', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    const first = host.planRecording('support-agent', 'python agent.py');
    expect(first.ok && first.plan).toMatchObject({ args: ['run', '--', 'python', 'agent.py'], cwd: support, env: {}, confirm: { title: 'Run this command in ~/support-agent?' } });
    registry.confirmCommand('support-agent', ['python', 'agent.py']);
    expect(host.planRecording('support-agent', 'python agent.py')).toMatchObject({ ok: true, plan: { confirm: null } });
    registry.noteInspected('support-agent', {
      at: 1, language: 'Python', files: [], sdk: null, framework: null, command: null, commandFrom: null,
      config: { file: 'shadowlap.config.json', created: false, existed: true }, tools: [], wrap: [],
      modelServer: { url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434', from: 'OPENAI_BASE_URL in .env' },
    });
    expect(host.planRecording('support-agent', 'python agent.py')).toMatchObject({ ok: true, plan: { env: { SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:11434' } } });
    expect(host.current().cliArgs(['run', '--', 'python', 'agent.py'])).toEqual(['--db', projectDbPath(support), 'run', '--', 'python', 'agent.py']);
    expect(() => host.planRecording('nope', 'x')).toThrow(expect.objectContaining({ code: 'not-found' }));
    host.close();
  });

  it('finishes a setup only once its first recording has finished', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    registry.add('~/triage-bot');
    expect(() => host.finishSetup('triage-bot')).toThrow(expect.objectContaining({ code: 'setup', status: 409, message: 'Record a first run before finishing the setup.' }));
    const store = host.context('triage-bot').store();
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'triage.mjs'], cwd: registry.get('triage-bot')!.path } });
    // Still recording: not yet.
    expect(() => host.finishSetup('triage-bot')).toThrow(expect.objectContaining({ code: 'setup' }));
    store.endRun(run.runId, 'completed');
    expect(host.finishSetup('triage-bot').setup).toMatchObject({ stage: 'done', skipped: true, runId: run.runId });
    expect(host.setup('triage-bot')).toMatchObject({ stage: 'done', shows: 'none' });
    // Again: nothing changes.
    expect(host.finishSetup('triage-bot').setup).toMatchObject({ stage: 'done', skipped: true });
    host.close();
  });

  it('doesn’t bring back the folder of a project that was deleted from disk', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    const gone = files(join(registry.home, 'gone-agent'), { 'package.json': '{}' });
    registry.add('~/gone-agent');
    rmSync(gone, { recursive: true, force: true });
    const ctx = host.context('gone-agent');
    expect(ctx.facts().runs).toBe(0);
    expect(() => ctx.store()).toThrow(/doesn’t exist any more/);
    expect(existsSync(gone)).toBe(false);
    host.close();
  });
});

