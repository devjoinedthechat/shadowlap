import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store, packRun, storeFacts, storeView } from '../src/index.js';
import { ProjectError, ProjectHost, ProjectRegistry, projectDbPath } from '../src/projects/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void } };

/** A finished recording with calls in a store, as `shadowlap run` leaves it. */
function recordInto(store: Store, cwd: string, opts: { calls?: number; status?: 'completed' | 'failed' } = {}): string {
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd } });
  for (let callNo = 1; callNo <= (opts.calls ?? 2); callNo++) store.appendCallStart({ runId: run.runId, callNo, kind: 'api', name: 'POST /v1/messages', fingerprint: `f${callNo}`, occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: Date.now() });
  store.endRun(run.runId, opts.status ?? 'completed');
  return run.runId;
}

const dirs: string[] = [];
/** A temporary folder by its real path as the system names it, the way the project list keeps folders (on Windows, RUNNER~1 written out in full). */
function tempDir(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
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
    store.endRun(store.listRuns(1)[0].runId, 'completed');
    const removed = host.remove('support-agent', { deleteRecordings: true, typedName: 'support-agent' });
    expect(removed).toMatchObject({ current: 'triage-bot', deleted: expect.arrayContaining(['.shadowlap/shadowlap.db']) });
    expect(existsSync(projectDbPath(support))).toBe(false);
    expect(host.currentProject()).toBe('triage-bot');
    expect(() => host.context('support-agent')).toThrow(ProjectError);
    host.close();
  });

  it('never opens a removed project’s store again, so its deleted recordings stay deleted', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    registry.add('~/triage-bot');
    const ctx = host.current();
    ctx.store();
    // A removal refused (the wrong name typed) leaves the project as it was.
    expect(() => host.remove('support-agent', { deleteRecordings: true, typedName: 'support' })).toThrow(ProjectError);
    expect(ctx.store()).toBeTruthy();
    host.remove('support-agent', { deleteRecordings: true, typedName: 'support-agent' });
    expect(existsSync(projectDbPath(support))).toBe(false);
    // Whatever still holds its context, a timer or a request under way, can't bring the store back.
    expect(() => ctx.store()).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(existsSync(projectDbPath(support))).toBe(false);
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
    mkdirSync(join(triage, '.shadowlap', 'repairs', 'rp-1'), { recursive: true });
    expect(host.stats()).toEqual({
      'support-agent': { runs: 0, attempts: 0, goldens: 0, missing: false, settingUp: true, unreadable: null, madeFiles: [] },
      'triage-bot': { runs: 1, attempts: 1, goldens: 1, missing: false, settingUp: true, unreadable: null, madeFiles: ['.shadowlap/repairs'] },
      'gone-agent': { runs: 0, attempts: 0, goldens: 0, missing: true, settingUp: true, unreadable: null, madeFiles: [] },
    });
    // Finished with runs, it is set up; with none left, its setup shows again.
    registry.finishSetup('triage-bot', { skipped: true });
    expect(host.stats()['triage-bot']).toMatchObject({ settingUp: false });
    const empty = files(join(registry.home, 'empty-agent'), { 'package.json': '{}' });
    registry.add('~/empty-agent');
    registry.finishSetup('empty-agent', { skipped: true });
    expect(existsSync(empty)).toBe(true);
    expect(host.stats()['empty-agent']).toMatchObject({ runs: 0, settingUp: true });
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
    const path = registry.get('triage-bot')!.path;
    // A typo: the command never started, and nothing was recorded.
    recordInto(store, path, { calls: 0, status: 'failed' });
    expect(() => host.finishSetup('triage-bot')).toThrow(expect.objectContaining({ code: 'setup' }));
    expect(host.setup('triage-bot')).toMatchObject({ stage: 'added', run: null, empty: { status: 'failed', calls: 0 } });
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'triage.mjs'], cwd: path } });
    store.appendCallStart({ runId: run.runId, callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'f', occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: Date.now() });
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

  // Windows refuses to move or delete a folder while a file in it is open, and the store is open while
  // it is served: there, a served project's folder can't move away.
  it.skipIf(process.platform === 'win32')('lets go of a store whose folder moves away while it is open, and opens it again once it is back', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    const ctx = host.current();
    recordInto(ctx.store(), support);
    expect(ctx.facts().runs).toBe(1);
    renameSync(support, `${support}.moved`);
    expect(() => ctx.store()).toThrow(/doesn’t exist any more/);
    expect(ctx.facts().runs).toBe(0);
    expect(ctx.hasStore()).toBe(false);
    expect(existsSync(support)).toBe(false);
    renameSync(`${support}.moved`, support);
    expect(ctx.store().allRuns()).toHaveLength(1);
    // Its store deleted while open: the next use opens the one there now.
    ctx.close();
    rmSync(join(support, '.shadowlap'), { recursive: true, force: true });
    expect(ctx.facts().runs).toBe(0);
    host.close();
  });
});


describe('ProjectHost: what it reads and keeps', () => {
  it('takes what a store said read elsewhere in place of reading it, and reads the others itself', () => {
    const { registry, loadConfig, support, triage } = world();
    // Every read of every run in the stores the host opens, counted.
    let reads = 0;
    const openStore = (path: string) => {
      const opened = Store.open(path);
      return storeView(opened, { allRuns: () => (reads++, opened.allRuns()) });
    };
    const host = ProjectHost.open(support, { registry, loadConfig, openStore });
    registry.add('~/triage-bot');
    const store = host.context('support-agent').store();
    const runId = recordInto(store, support);
    const triageStore = Store.open(projectDbPath(triage));
    recordInto(triageStore, triage);
    triageStore.close();
    // What a dashboard read of the support agent's store beside its server: the host reads none of it again.
    const read = { ...storeFacts(store), runs: 7, attempts: 2 };
    reads = 0;
    expect(host.stats({ facts: { 'support-agent': read } })).toMatchObject({ 'support-agent': { runs: 7, attempts: 2 }, 'triage-bot': { runs: 1, attempts: 0 } });
    expect(host.setup('support-agent', { facts: read })).toMatchObject({ run: { runId } });
    expect(host.suggestGolden('support-agent', { facts: read })).toBe('goldens/support-agent');
    expect(reads).toBe(0);
    // Without them, it reads the store itself.
    expect(host.stats()['support-agent']).toMatchObject({ runs: 1 });
    expect(reads).toBe(1);
    host.close();
  });

  it('counts another project’s runs without migrating its store or adding to its folder', () => {
    const { registry, loadConfig, support, triage } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    registry.add('~/triage-bot');
    // An older Shadowlap's store: schema v3, before activity events.
    const db = projectDbPath(triage);
    const store = Store.open(db);
    recordInto(store, triage);
    store.close();
    const raw = new DatabaseSync(db);
    raw.exec(`DROP TABLE events; UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    raw.close();
    rmSync(join(triage, '.shadowlap', '.gitignore'));

    expect(host.stats()['triage-bot']).toMatchObject({ runs: 1, attempts: 0 });
    expect(host.setup('triage-bot')).toMatchObject({ stage: 'recorded', run: { calls: 2 } });
    const check = new DatabaseSync(db);
    expect(check.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value).toBe('3');
    check.close();
    expect(existsSync(join(triage, '.shadowlap', '.gitignore'))).toBe(false);

    // One written by a newer Shadowlap is listed, with nothing counted and the reason said.
    const newer = new DatabaseSync(db);
    newer.exec(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`);
    newer.close();
    expect(host.stats()['triage-bot']).toMatchObject({ runs: 0, missing: false, unreadable: expect.stringMatching(/written by a newer Shadowlap/) });
    // Reading its setup says so too, as a store error the dashboard answers with its status.
    expect(() => host.setup('triage-bot')).toThrow(expect.objectContaining({ name: 'ProjectError', code: 'store', status: 409, message: expect.stringMatching(/^Shadowlap can’t read triage-bot’s store: .*newer Shadowlap/) }));
    host.close();
  });

  // Permissions don't hold back root, and work otherwise on Windows.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reads a store in a folder it can’t write to', () => {
    const { registry, loadConfig, support, triage } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    registry.add('~/triage-bot');
    const store = Store.open(projectDbPath(triage));
    const runId = recordInto(store, triage);
    store.close();
    // A clean close leaves no shared-memory file, which SQLite can't make in a read-only folder.
    expect(existsSync(`${projectDbPath(triage)}-shm`)).toBe(false);
    chmodSync(join(triage, '.shadowlap'), 0o555);
    try {
      expect(host.stats()['triage-bot']).toMatchObject({ runs: 1, unreadable: null });
      expect(host.setup('triage-bot')).toMatchObject({ stage: 'recorded', run: { runId, calls: 2 } });
      // Removed and added again, its runs come back.
      registry.remove('triage-bot');
      expect(registry.add('~/triage-bot')).toMatchObject({ again: true, runs: 1 });
      // Its recordings can't be deleted there: said before it leaves the list.
      expect(() => registry.remove('triage-bot', { deleteRecordings: true, typedName: 'triage-bot' })).toThrow(expect.objectContaining({ code: 'store', message: expect.stringMatching(/can’t delete files in/) }));
      expect(registry.get('triage-bot')).not.toBeNull();
    } finally {
      chmodSync(join(triage, '.shadowlap'), 0o755);
    }
    host.close();
  });

  it('takes a golden packed from the setup’s recording in a terminal, once its test passed, as its last step, and offers a free path for a new one', () => {
    const { registry, loadConfig, support, triage } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    registry.add('~/triage-bot');
    const store = host.context('triage-bot').store();
    const runId = recordInto(store, triage);
    // goldens/triage-inbox is another golden: the setup offers goldens/triage-bot.
    expect(host.suggestGolden('triage-bot')).toBe('goldens/triage-bot');
    // goldens/triage-bot holds an earlier setup's golden: the next free path.
    mkdirSync(join(triage, 'goldens', 'triage-bot'), { recursive: true });
    writeFileSync(join(triage, 'goldens', 'triage-bot', 'run.json'), JSON.stringify({ runs: [{ runId: 'SOMEONE-ELSES' }] }));
    expect(host.suggestGolden('triage-bot')).toBe('goldens/triage-bot-2');
    expect(host.setup('triage-bot')).toMatchObject({ stage: 'recorded', steps: { tested: false }, golden: null });
    // Packed in a terminal: the golden is kept, and its test is still to run.
    packRun(store, runId, join(triage, 'goldens', 'triage-bot-old'));
    expect(host.setup('triage-bot')).toMatchObject({ stage: 'recorded', steps: { tested: false }, golden: 'goldens/triage-bot-old', goldenTest: null });
    // Its golden, once kept, is what it offers.
    expect(host.suggestGolden('triage-bot')).toBe('goldens/triage-bot-old');
    // `shadowlap test` passed it: step 4 is done.
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/triage-bot-old'] });
    store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/triage-bot-old', ok: true, goldenRunId: runId });
    expect(host.setup('triage-bot')).toMatchObject({ stage: 'tested', steps: { tested: true }, golden: 'goldens/triage-bot-old', goldenTest: { ok: true } });
    expect(host.finishSetup('triage-bot').setup).toMatchObject({ stage: 'done', runId, golden: 'goldens/triage-bot-old', skipped: false });
    host.close();
  });

  it('confirms a planned recording with the model server it records through', () => {
    const { registry, loadConfig, support } = world();
    const host = ProjectHost.open(support, { registry, loadConfig });
    const plan = host.planRecording('support-agent', 'python agent.py');
    expect(plan.ok && plan.plan.upstream).toBeNull();
    if (plan.ok) host.confirmCommand('support-agent', plan.plan);
    expect(host.planRecording('support-agent', 'python agent.py')).toMatchObject({ ok: true, plan: { confirm: null } });
    // init now finds a model server in .env: the same command asks again before its calls go there.
    registry.noteInspected('support-agent', {
      at: 1, language: 'Python', files: [], sdk: null, framework: null, command: null, commandFrom: null,
      config: { file: 'shadowlap.config.json', created: false, existed: true }, tools: [], wrap: [],
      modelServer: { url: 'http://10.0.0.9:8000/v1', upstream: 'http://10.0.0.9:8000', from: 'OPENAI_BASE_URL in .env' },
    });
    const moved = host.planRecording('support-agent', 'python agent.py');
    expect(moved).toMatchObject({ ok: true, plan: { upstream: 'http://10.0.0.9:8000', confirm: { text: expect.stringMatching(/^It ran here before with its model calls going somewhere else, so it asks again\./) } } });
    if (moved.ok) host.confirmCommand('support-agent', moved.plan);
    expect(host.planRecording('support-agent', 'python agent.py')).toMatchObject({ ok: true, plan: { confirm: null } });
    host.close();
  });
});

describe('ProjectHost: a project list it can’t use', () => {
  it('opens on the start folder with a notice when the list isn’t valid JSON, and changes nothing', () => {
    const { registry, loadConfig, support } = world();
    mkdirSync(dirname(registry.file), { recursive: true });
    writeFileSync(registry.file, '{ not json');
    const host = ProjectHost.open(support, { registry, loadConfig });
    expect(host.notice).toMatch(/isn’t valid JSON\. .*Until it is fixed and the dashboard started again, it shows ~\/support-agent only, and can’t add or remove projects or keep a setup’s progress\.$/);
    expect(host.list().map((p) => p.id)).toEqual(['support-agent']);
    expect(host.current()).toMatchObject({ id: 'support-agent', path: support });
    host.current().store().createRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: support } });
    expect(host.stats()['support-agent'].runs).toBe(1);
    expect(() => host.add('~/triage-bot')).toThrow(expect.objectContaining({ code: 'registry' }));
    expect(() => host.remove('support-agent')).toThrow(expect.objectContaining({ code: 'registry', message: host.notice }));
    expect(() => host.confirmCommand('support-agent', { argv: ['python', 'agent.py'], upstream: null })).toThrow(expect.objectContaining({ code: 'registry' }));
    expect(readFileSync(registry.file, 'utf8')).toBe('{ not json');

    // Fixed, and the folder added under another id by the CLI: its entry serves it from then on.
    writeFileSync(registry.file, JSON.stringify({ version: 1, projects: [{ id: 'agent', name: 'support-agent', path: support, addedAt: 1 }] }));
    expect(host.currentProject()).toBe('agent');
    expect(host.list().map((p) => p.id)).toEqual(['agent']);
    expect(host.current().path).toBe(support);
    host.close();
  });

  it('lists what a newer version’s list holds beside the start folder, which it can’t add', () => {
    const { registry, loadConfig, support, triage } = world();
    mkdirSync(dirname(registry.file), { recursive: true });
    writeFileSync(registry.file, JSON.stringify({ version: 2, projects: [{ id: 'triage-bot', name: 'triage-bot', path: triage, addedAt: 1 }] }));
    const host = ProjectHost.open(support, { registry, loadConfig });
    expect(host.notice).toMatch(/written by a newer Shadowlap/);
    expect(host.list().map((p) => p.id)).toEqual(['support-agent', 'triage-bot']);
    expect(host.switchTo('triage-bot').path).toBe(triage);
    host.close();
    // The start folder in a newer version's list: served from it, with the reason changes fail.
    writeFileSync(registry.file, JSON.stringify({ version: 2, projects: [{ id: 'support-agent', name: 'support-agent', path: support, addedAt: 1 }] }));
    const listed = ProjectHost.open(support, { registry, loadConfig });
    expect(listed.list().map((p) => p.id)).toEqual(['support-agent']);
    expect(listed.notice).toMatch(/written by a newer Shadowlap\. Upgrade Shadowlap to change the project list\.$/);
    listed.close();
    // A list it can use: no notice.
    const fine = world();
    expect(ProjectHost.open(fine.support, { registry: fine.registry, loadConfig: fine.loadConfig }).notice).toBeNull();
  });
});
