import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectError, ProjectRegistry, Store, projectDbPath, type ProjectEntry, type SetupFindings } from '../src/index.js';

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

/** A home folder, Shadowlap's folder inside it (as SHADOWLAP_HOME would name it), and a registry over both. */
function setup(options: { now?: () => number } = {}) {
  const home = tempDir('sl-reg-home-');
  const shadowlapDir = join(home, 'shadowlap-home');
  const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: shadowlapDir }, actor: () => 'dana@example.com', ...options });
  const agent = (name: string, tree: Record<string, string> = { 'package.json': '{}' }) => files(join(home, name), tree);
  return { home, shadowlapDir, registry, agent };
}

/** Records a finished run into a project's store, as `shadowlap run` would. */
function record(folder: string, opts: { status?: 'completed' | 'failed' | 'running'; meta?: Record<string, unknown>; mode?: 'record' | 'replay'; parent?: string } = {}): string {
  const store = Store.open(projectDbPath(folder));
  try {
    const run = store.createRun({ mode: opts.mode ?? 'record', command: { argv: ['node', 'agent.mjs'], cwd: folder }, ...(opts.parent ? { parentRunId: opts.parent } : {}), ...(opts.meta ? { meta: opts.meta } : {}) });
    if ((opts.status ?? 'completed') !== 'running') store.endRun(run.runId, (opts.status ?? 'completed') as 'completed' | 'failed');
    return run.runId;
  } finally {
    store.close();
  }
}

function events(folder: string, kind?: string) {
  const store = Store.open(projectDbPath(folder));
  try {
    return store.listEvents(kind ? { kinds: [kind] } : {});
  } finally {
    store.close();
  }
}

const findings = (over: Partial<SetupFindings> = {}): SetupFindings => ({
  at: 1,
  language: 'Python 3.12 · uv',
  files: ['pyproject.toml', 'uv.lock'],
  sdk: 'anthropic 0.69.0',
  framework: null,
  command: ['uv', 'run', 'agent.py'],
  commandFrom: 'agent.py',
  config: { file: 'shadowlap.config.json', created: true, existed: false },
  tools: [
    { name: 'search_filings', effect: 'read', wrapped: true, why: 'declared', file: 'agent/tools.py', line: 3 },
    { name: 'save_report', effect: 'write', wrapped: false, why: '"save" changes something', file: 'agent/tools.py', line: 41 },
  ],
  wrap: [{ language: 'python', tools: ['save_report'], code: 'from shadowlap import tool\n' }],
  ...over,
});

describe('ProjectRegistry: adding', () => {
  it('keeps the list in SHADOWLAP_HOME, owner-only, and logs the add in the project’s own store', () => {
    let t = 1_000;
    const { registry, agent, shadowlapDir } = setup({ now: () => t++ });
    const folder = agent('support-agent', { 'pyproject.toml': '', 'uv.lock': '' });
    const added = registry.add('~/support-agent');
    expect(added).toEqual({ project: expect.objectContaining({ id: 'support-agent', name: 'support-agent', path: folder }), again: false, runs: 0 });
    expect(added.project.setup).toMatchObject({ stage: 'added', runId: null, golden: null, findings: null, skipped: false });
    expect(added.project.confirmed).toEqual([]);

    expect(registry.file).toBe(join(shadowlapDir, 'projects.json'));
    const onDisk = JSON.parse(readFileSync(registry.file, 'utf8')) as { version: number; projects: ProjectEntry[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.projects.map((p) => [p.id, p.path, p.addedAt])).toEqual([['support-agent', folder, 1_000]]);
    if (process.platform !== 'win32') {
      expect(statSync(registry.file).mode & 0o777).toBe(0o600);
      expect(statSync(shadowlapDir).mode & 0o777).toBe(0o700);
    }
    // No temporary file or lock is left behind.
    expect(existsSync(`${registry.file}.lock`)).toBe(false);

    const [event] = events(folder, 'project.added');
    expect(event).toMatchObject({ kind: 'project.added', actor: 'dana@example.com', ref: 'support-agent', data: { path: '~/support-agent', name: 'support-agent' } });
  });

  it('refuses a folder the dashboard may not add, or one already added', () => {
    const { registry, agent, home } = setup();
    agent('triage-bot');
    files(join(home, 'Downloads'), { 'report.pdf': '' });
    registry.add('~/triage-bot');
    const fail = (path: string) => {
      try {
        registry.add(path);
      } catch (err) {
        return err instanceof ProjectError ? [err.code, err.status, err.message] : err;
      }
      return 'added';
    };
    expect(fail('~/triage-bot')).toEqual(['exists', 409, '~/triage-bot is already in the dashboard.']);
    expect(fail(join(home, 'triage-bot', '.', ''))).toEqual(['exists', 409, '~/triage-bot is already in the dashboard.']);
    expect(fail('~/Downloads')).toEqual(['folder', 400, 'No pyproject.toml, package.json or requirements file in ~/Downloads. Pick the folder your agent’s code is in.']);
    expect(fail('/')).toEqual(['folder', 400, expect.stringContaining('Only folders in your home folder')]);
    expect(registry.list().map((p) => p.id)).toEqual(['triage-bot']);
  });

  it('gives each project an id that is unique and safe in a URL', () => {
    const { registry, home } = setup();
    files(join(home, 'a', 'agent'), { 'package.json': '{}' });
    files(join(home, 'b', 'agent'), { 'package.json': '{}' });
    files(join(home, 'Mon Agent (v2)'), { 'package.json': '{}' });
    expect(registry.add('~/a/agent').project.id).toBe('agent');
    expect(registry.add('~/b/agent').project).toMatchObject({ id: 'agent-2', name: 'agent' });
    expect(registry.add('~/Mon Agent (v2)').project).toMatchObject({ id: 'mon-agent-v2', name: 'Mon Agent (v2)' });
  });

  it('finds a project by any path to its folder', () => {
    const { registry, agent, home } = setup();
    const folder = agent('triage-bot');
    registry.add(folder);
    symlinkSync(folder, join(home, 'tb'));
    expect(registry.find('~/triage-bot')?.id).toBe('triage-bot');
    expect(registry.find(join(home, 'tb'))?.id).toBe('triage-bot');
    expect(registry.find('~/elsewhere')).toBeNull();
  });

  it('adds the folder a dashboard starts in without the dashboard’s limits, once', () => {
    const { registry } = setup();
    const anywhere = tempDir('sl-anywhere-');
    const first = registry.ensure(anywhere);
    expect(first.path).toBe(anywhere);
    expect(first.setup.stage).toBe('added');
    expect(registry.ensure(anywhere)).toEqual(first);
    expect(registry.list()).toHaveLength(1);
    expect(() => registry.ensure(join(anywhere, 'missing'))).toThrow(ProjectError);
  });

  it('counts a folder the dashboard starts in as set up when Shadowlap is already in use there', () => {
    const { registry, agent } = setup();
    const used = agent('used-agent');
    record(used);
    expect(registry.ensure(used).setup.stage).toBe('done');
    // Picked in the dashboard instead, the same folder would start its setup.
    const picked = agent('picked-agent');
    record(picked);
    expect(registry.add('~/picked-agent').project.setup.stage).toBe('added');
  });

  it('reads the store --db names, and logs the add there', () => {
    const { registry } = setup();
    const folder = tempDir('sl-dbflag-');
    const custom = join(tempDir('sl-dbflag-store-'), 'runs.db');
    const store = Store.open(custom);
    store.endRun(store.createRun({ mode: 'record', command: { argv: ['node', 'a.mjs'], cwd: folder } }).runId, 'completed');
    store.close();
    expect(registry.ensure(folder, { dbPath: custom }).setup.stage).toBe('done');
    expect(existsSync(projectDbPath(folder))).toBe(false);
    const check = Store.open(custom);
    expect(check.listEvents({ kinds: ['project.added'] })).toHaveLength(1);
    check.close();
  });
});

describe('ProjectRegistry: removing', () => {
  it('can’t remove the only project', () => {
    const { registry, agent } = setup();
    agent('triage-bot');
    registry.add('~/triage-bot');
    expect(() => registry.remove('triage-bot')).toThrow(expect.objectContaining({ code: 'only-project', status: 409, message: 'This is the only project. Add another one first.' }));
    expect(() => registry.remove('nope')).toThrow(expect.objectContaining({ code: 'not-found', status: 404 }));
  });

  it('forgets the folder and touches nothing on disk; adding it again brings its runs and finished setup back', () => {
    const { registry, agent } = setup();
    agent('triage-bot');
    const folder = agent('support-agent', { 'pyproject.toml': '', 'shadowlap.config.json': '{"normalize":[],"redact":[]}', 'goldens/refund/run.json': '{}' });
    registry.add('~/triage-bot');
    registry.add('~/support-agent');
    const runId = record(folder);
    registry.noteRecorded('support-agent', runId);
    registry.finishSetup('support-agent');

    const removed = registry.remove('support-agent');
    expect(removed).toMatchObject({ project: { id: 'support-agent' }, deleted: [] });
    expect(registry.list().map((p) => p.id)).toEqual(['triage-bot']);
    for (const f of ['.shadowlap/shadowlap.db', 'shadowlap.config.json', 'goldens/refund/run.json', 'pyproject.toml']) expect(existsSync(join(folder, f)), f).toBe(true);
    expect(events(folder, 'project.removed')[0]).toMatchObject({ ref: 'support-agent', data: { path: '~/support-agent' } });

    const back = registry.add('~/support-agent');
    expect(back.again).toBe(true);
    expect(back.runs).toBe(1);
    expect(back.project.setup).toMatchObject({ stage: 'done', runId });
    expect(events(folder, 'project.added')[0]?.data).toMatchObject({ again: true });
  });

  it('deletes the recordings only when the project’s name is typed, and never the goldens or config', () => {
    const { registry, agent } = setup();
    agent('triage-bot');
    const folder = agent('support-agent', { 'pyproject.toml': '', 'shadowlap.config.json': '{}', 'goldens/refund/run.json': '{}' });
    registry.add('~/triage-bot');
    registry.add('~/support-agent');
    record(folder);

    expect(() => registry.remove('support-agent', { deleteRecordings: true, typedName: 'support-agen' })).toThrow(expect.objectContaining({ code: 'name-mismatch', status: 400 }));
    expect(() => registry.remove('support-agent', { deleteRecordings: true })).toThrow(expect.objectContaining({ code: 'name-mismatch' }));
    expect(registry.list()).toHaveLength(2);
    expect(existsSync(projectDbPath(folder))).toBe(true);

    const removed = registry.remove('support-agent', { deleteRecordings: true, typedName: ' support-agent ' });
    expect(removed.deleted).toContain('.shadowlap/shadowlap.db');
    expect(existsSync(projectDbPath(folder))).toBe(false);
    for (const f of ['shadowlap.config.json', 'goldens/refund/run.json', 'pyproject.toml', '.shadowlap/.gitignore']) expect(existsSync(join(folder, f)), f).toBe(true);
    expect(registry.list().map((p) => p.id)).toEqual(['triage-bot']);

    // Added again, it starts from an empty store.
    const back = registry.add('~/support-agent');
    expect(back).toMatchObject({ again: false, runs: 0 });
  });

  it('won’t delete a store while a run is being recorded into it, or one reached through a link', () => {
    const { registry, agent } = setup();
    agent('triage-bot');
    const folder = agent('support-agent');
    registry.add('~/triage-bot');
    registry.add('~/support-agent');
    record(folder);
    writeFileSync(join(folder, '.shadowlap', 'active.json'), JSON.stringify({ url: 'http://127.0.0.1:1', runId: 'X', pid: process.pid }));
    expect(() => registry.remove('support-agent', { deleteRecordings: true, typedName: 'support-agent' })).toThrow(expect.objectContaining({ code: 'recording', status: 409 }));
    expect(registry.list()).toHaveLength(2);
    expect(existsSync(projectDbPath(folder))).toBe(true);

    // A run marked running that started just now counts too.
    rmSync(join(folder, '.shadowlap', 'active.json'));
    record(folder, { status: 'running' });
    expect(() => registry.remove('support-agent', { deleteRecordings: true, typedName: 'support-agent' })).toThrow(expect.objectContaining({ code: 'recording' }));

    // A planted link instead of the store folder is never followed.
    const linked = agent('linked');
    const elsewhere = tempDir('sl-elsewhere-');
    record(elsewhere);
    symlinkSync(join(elsewhere, '.shadowlap'), join(linked, '.shadowlap'));
    registry.add('~/linked');
    expect(() => registry.remove('linked', { deleteRecordings: true, typedName: 'linked' })).toThrow(expect.objectContaining({ code: 'store' }));
    expect(existsSync(projectDbPath(elsewhere))).toBe(true);
  });
});

describe('ProjectRegistry: setup', () => {
  it('moves a project through its setup, never backwards, and logs when it is set up', () => {
    const { registry, agent } = setup();
    const folder = agent('research-agent', { 'pyproject.toml': '' });
    registry.add('~/research-agent');

    expect(registry.noteInspected('research-agent', findings()).setup).toMatchObject({ stage: 'inspected', findings: { sdk: 'anthropic 0.69.0' } });
    const recording = registry.noteRecording('research-agent', 'RUN1', ['uv', 'run', 'agent.py']);
    expect(recording.setup).toMatchObject({ stage: 'inspected', runId: 'RUN1', command: ['uv', 'run', 'agent.py'], unwrappedAtRecord: ['save_report'] });
    expect(registry.noteRecorded('research-agent', 'RUN1').setup.stage).toBe('recorded');
    // Checking again after wrapping the tools updates the findings, not the stage.
    const rechecked = registry.noteInspected('research-agent', findings({ tools: [] }));
    expect(rechecked.setup).toMatchObject({ stage: 'recorded', findings: { tools: [] } });
    expect(registry.noteCalibrated('research-agent', 'RUN1', [{ path: '$.system', why: 'a value generated on each run' }]).setup).toMatchObject({ stage: 'clean', calibration: { added: [{ path: '$.system', why: 'a value generated on each run' }] } });
    expect(registry.noteTested('research-agent', 'RUN1', 'goldens/northwind-q3').setup).toMatchObject({ stage: 'tested', golden: 'goldens/northwind-q3' });
    expect(events(folder, 'project.setup')).toEqual([]);

    const done = registry.finishSetup('research-agent');
    expect(done.setup).toMatchObject({ stage: 'done', skipped: false });
    expect(events(folder, 'project.setup')).toEqual([expect.objectContaining({ runId: 'RUN1', ref: 'research-agent', data: { stage: 'done', name: 'research-agent', skipped: false, golden: 'goldens/northwind-q3' } })]);
    // Finishing twice logs once.
    registry.finishSetup('research-agent');
    expect(events(folder, 'project.setup')).toHaveLength(1);
  });

  it('marks a setup finished before a golden was kept as skipped', () => {
    const { registry, agent } = setup();
    const folder = agent('triage-bot');
    registry.add('~/triage-bot');
    const runId = record(folder);
    const done = registry.finishSetup('triage-bot', { runId });
    expect(done.setup).toMatchObject({ stage: 'done', skipped: true, runId });
    expect(events(folder, 'project.setup')[0]?.data).toMatchObject({ skipped: true });
  });

  it('remembers the commands confirmed in each folder, exactly, the newest twenty', () => {
    const { registry, agent } = setup();
    agent('triage-bot');
    registry.add('~/triage-bot');
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs'])).toBe(false);
    registry.confirmCommand('triage-bot', ['node', 'triage.mjs']);
    registry.confirmCommand('triage-bot', ['node', 'triage.mjs']);
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs'])).toBe(true);
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs', '--all'])).toBe(false);
    expect(registry.get('triage-bot')!.confirmed).toHaveLength(1);
    for (let i = 0; i < 25; i++) registry.confirmCommand('triage-bot', ['node', `run-${i}.mjs`]);
    const confirmed = registry.get('triage-bot')!.confirmed;
    expect(confirmed).toHaveLength(20);
    expect(confirmed.at(-1)!.argv).toEqual(['node', 'run-24.mjs']);
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs'])).toBe(false);
  });
});

describe('ProjectRegistry: the file', () => {
  it('keeps what it doesn’t know: other keys, other fields, entries it can’t read', () => {
    const { registry, agent, shadowlapDir } = setup();
    const folder = agent('triage-bot');
    mkdirSync(shadowlapDir, { recursive: true });
    writeFileSync(
      registry.file,
      JSON.stringify({ version: 1, theme: 'kept', roots: [], projects: [{ id: 'old', path: '/somewhere/old', addedAt: 5, pinned: true }, { broken: true }] }),
    );
    registry.add(folder);
    const onDisk = JSON.parse(readFileSync(registry.file, 'utf8')) as { theme: string; projects: Array<Record<string, unknown>> };
    expect(onDisk.theme).toBe('kept');
    expect(onDisk.projects.map((p) => p.id ?? 'broken')).toEqual(['old', 'broken', 'triage-bot']);
    expect(onDisk.projects[0]).toMatchObject({ id: 'old', pinned: true, setup: { stage: 'added' } });
    expect(registry.list().map((p) => p.id)).toEqual(['old', 'triage-bot']);
  });

  it('never overwrites a list it can’t read, or one from a newer version', () => {
    const { registry, agent, shadowlapDir } = setup();
    agent('triage-bot');
    mkdirSync(shadowlapDir, { recursive: true });
    writeFileSync(registry.file, '{ not json');
    expect(() => registry.list()).toThrow(expect.objectContaining({ code: 'registry' }));
    expect(() => registry.add('~/triage-bot')).toThrow(/isn’t valid JSON/);
    expect(readFileSync(registry.file, 'utf8')).toBe('{ not json');

    writeFileSync(registry.file, JSON.stringify({ version: 2, projects: [] }));
    expect(registry.list()).toEqual([]);
    expect(() => registry.add('~/triage-bot')).toThrow(/written by a newer Shadowlap/);
  });

  it('reads configured roots from the file and SHADOWLAP_PROJECT_ROOTS', () => {
    const home = tempDir('sl-reg-roots-');
    const work = tempDir('sl-reg-work-');
    const more = tempDir('sl-reg-more-');
    const dir = join(home, 'sl');
    mkdirSync(dir);
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, roots: [work], projects: [] }));
    const registry = new ProjectRegistry({ home, dir, env: { SHADOWLAP_PROJECT_ROOTS: more } });
    expect(registry.configuredRoots()).toEqual([work, more]);
    expect(registry.roots().roots).toEqual([home, work, more]);
    files(join(work, 'agent'), { 'go.mod': 'module agent\n' });
    expect(registry.add(join(work, 'agent')).project.id).toBe('agent');
  });

  it('waits for another writer’s lock, and takes over one left by a dead process', () => {
    const { registry, agent, shadowlapDir } = setup();
    agent('triage-bot');
    mkdirSync(shadowlapDir, { recursive: true });
    const lock = `${registry.file}.lock`;
    writeFileSync(lock, '999999');
    const busy = new ProjectRegistry({ home: registry.home, dir: shadowlapDir, lockTimeoutMs: 100 });
    expect(() => busy.add('~/triage-bot')).toThrow(/held by another Shadowlap process/);
    // Ten seconds old: its process is gone.
    const old = (Date.now() - 20_000) / 1000;
    utimesSync(lock, old, old);
    expect(busy.add('~/triage-bot').project.id).toBe('triage-bot');
    expect(existsSync(lock)).toBe(false);
  });
});
