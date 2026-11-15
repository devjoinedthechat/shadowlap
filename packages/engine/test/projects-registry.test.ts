import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/index.js';
import { ProjectError, ProjectRegistry, nameConfirms, projectDbPath, setupRunOf, type ProjectEntry, type SetupFindings } from '../src/projects/index.js';

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

/** A home folder, shadowlap's folder inside it (as SHADOWLAP_HOME would name it), and a registry over both. */
function setup(options: { now?: () => number } = {}) {
  const home = tempDir('sl-reg-home-');
  const shadowlapDir = join(home, 'shadowlap-home');
  const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: shadowlapDir }, actor: () => 'dana@example.com', ...options });
  const agent = (name: string, tree: Record<string, string> = { 'package.json': '{}' }) => files(join(home, name), tree);
  return { home, shadowlapDir, registry, agent };
}

/** Records a finished run with its calls into a project's store, as `shadowlap run` would. */
function record(folder: string, opts: { status?: 'completed' | 'failed' | 'running'; meta?: Record<string, unknown>; mode?: 'record' | 'replay'; parent?: string; calls?: number } = {}): string {
  const store = Store.open(projectDbPath(folder));
  try {
    const run = store.createRun({ mode: opts.mode ?? 'record', command: { argv: ['node', 'agent.mjs'], cwd: folder }, ...(opts.parent ? { parentRunId: opts.parent } : {}), ...(opts.meta ? { meta: opts.meta } : {}) });
    for (let callNo = 1; callNo <= (opts.calls ?? 2); callNo++) store.appendCallStart({ runId: run.runId, callNo, kind: 'api', name: 'POST /v1/messages', fingerprint: `f${callNo}`, occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: Date.now() });
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
    expect(registry.realHome).toBe(registry.home);
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

  it('knows a project moved with a link left at its old path, and keeps it once, at its new path', () => {
    const { registry, agent, home } = setup();
    const folder = agent('agent');
    agent('other');
    record(folder);
    registry.add('~/agent');
    registry.add('~/other');
    // mv agent agent-v2 && ln -s agent-v2 agent
    renameSync(folder, join(home, 'agent-v2'));
    symlinkSync(join(home, 'agent-v2'), folder);
    const moved = join(home, 'agent-v2');
    expect(() => registry.add('~/agent-v2')).toThrow(expect.objectContaining({ code: 'exists', status: 409, message: '~/agent-v2 is already in the dashboard, as agent.' }));
    expect(registry.list().map((p) => [p.id, p.path])).toEqual([['agent', moved], ['other', join(home, 'other')]]);
    expect(registry.find('~/agent-v2')?.id).toBe('agent');
    expect(registry.ensure(moved).id).toBe('agent');
    expect(registry.list()).toHaveLength(2);
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

  it('reads the list again only once its file changed, and always afresh to change it', () => {
    const { registry, agent } = setup();
    agent('one-agent');
    agent('two-agent');
    registry.add('~/one-agent');
    const first = registry.list();
    expect(registry.list()).toBe(first);
    // Another process (the CLI, another dashboard) changes it: the next read sees it.
    const other = new ProjectRegistry({ home: registry.home, env: { SHADOWLAP_HOME: dirname(registry.file) }, actor: () => null });
    other.add('~/two-agent');
    expect(registry.list().map((p) => p.id)).toEqual(['one-agent', 'two-agent']);
    // A change made here starts from the file, whatever was read before.
    registry.remove('one-agent');
    expect(other.list().map((p) => p.id)).toEqual(['two-agent']);
  });

  it('counts a folder as set up when shadowlap is already in use there, whether the dashboard starts in it or it is picked', () => {
    const { registry, agent } = setup();
    const used = agent('used-agent');
    record(used);
    expect(registry.ensure(used).setup.stage).toBe('done');
    // Picked in the dashboard, a folder with recordings made in a terminal opens on its runs too.
    const picked = agent('picked-agent');
    record(picked);
    expect(registry.add('~/picked-agent')).toMatchObject({ project: { setup: { stage: 'done' } }, again: false, runs: 1 });
    // One with no runs starts its setup.
    agent('new-agent');
    expect(registry.add('~/new-agent').project.setup.stage).toBe('added');
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

  it('brings a setup removed halfway back as it was, with its confirmed commands and its id', () => {
    const { registry, agent, shadowlapDir } = setup();
    agent('triage-bot');
    const folder = agent('research-agent', { 'pyproject.toml': '' });
    registry.add('~/triage-bot');
    registry.add('~/research-agent');
    registry.noteInspected('research-agent', findings());
    registry.confirmCommand('research-agent', ['uv', 'run', 'agent.py']);
    const runId = record(folder);
    registry.noteRecording('research-agent', runId, ['uv', 'run', 'agent.py']);
    registry.noteRecorded('research-agent', runId);
    registry.noteCalibrated('research-agent', runId, [{ path: '$.metadata.user_id', why: 'this looks like a UUID' }]);
    const before = registry.get('research-agent')!;
    expect(before.setup.stage).toBe('clean');

    registry.remove('research-agent');
    // Remembered in the list, off the switcher.
    const file = JSON.parse(readFileSync(join(shadowlapDir, 'projects.json'), 'utf8')) as { removed: Array<{ id: string; path: string; removedAt: number }> };
    expect(file.removed).toEqual([expect.objectContaining({ id: 'research-agent', path: folder, removedAt: expect.any(Number) })]);
    // Its id is free meanwhile; another folder of the same name takes the next one when it comes back.
    const back = registry.add('~/research-agent');
    expect(back).toMatchObject({ again: true, runs: 1 });
    expect(back.project).toMatchObject({ id: 'research-agent', setup: { stage: 'clean', runId, findings: { sdk: 'anthropic 0.69.0' }, calibration: { added: [{ path: '$.metadata.user_id', why: 'this looks like a UUID' }] } } });
    expect(back.project.confirmed.map((c) => c.argv)).toEqual([['uv', 'run', 'agent.py']]);
    expect(registry.isConfirmed('research-agent', ['uv', 'run', 'agent.py'])).toBe(true);
    // Brought back once: the list no longer remembers it as removed.
    expect((JSON.parse(readFileSync(join(shadowlapDir, 'projects.json'), 'utf8')) as { removed: unknown[] }).removed).toEqual([]);
  });

  it('forgets a removed project whose recordings were deleted: added again, its setup starts afresh', () => {
    const { registry, agent, shadowlapDir } = setup();
    agent('triage-bot');
    const folder = agent('research-agent', { 'pyproject.toml': '' });
    registry.add('~/triage-bot');
    registry.add('~/research-agent');
    registry.noteInspected('research-agent', findings());
    registry.confirmCommand('research-agent', ['uv', 'run', 'agent.py']);
    record(folder);
    // Removed and remembered once, then added back and removed again with its recordings.
    registry.remove('research-agent');
    registry.add('~/research-agent');
    registry.remove('research-agent', { deleteRecordings: true, typedName: 'research-agent' });
    expect((JSON.parse(readFileSync(join(shadowlapDir, 'projects.json'), 'utf8')) as { removed: unknown[] }).removed).toEqual([]);
    const back = registry.add('~/research-agent');
    expect(back.project).toMatchObject({ setup: { stage: 'added', findings: null }, confirmed: [] });
  });

  it('confirms deleting by the name as it looks, however the folder’s name is composed', () => {
    const { registry, agent } = setup();
    agent('triage-bot');
    // Finder names folders decomposed: `u` and a combining diaeresis.
    agent('Bücher-agent');
    registry.add('~/triage-bot');
    const added = registry.add('~/Bücher-agent');
    expect(added.project).toMatchObject({ name: 'Bücher-agent', id: 'bucher-agent' });
    expect(nameConfirms('Bücher-agent', 'Bücher-agent')).toBe(true);
    expect(nameConfirms('Bücher-agent', 'Bücher-agent')).toBe(true);
    expect(nameConfirms('Bucher-agent', 'Bücher-agent')).toBe(false);
    expect(registry.remove(added.project.id, { deleteRecordings: true, typedName: 'Bücher-agent' }).project.id).toBe('bucher-agent');
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

  it('tells a recording from a run whose process was killed by the process the store names, not by when it started', async () => {
    const { registry, agent } = setup();
    agent('triage-bot');
    const killed = agent('support-agent');
    const long = agent('research-agent');
    registry.add('~/triage-bot');
    registry.add('~/support-agent');
    registry.add('~/research-agent');
    const engine = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const recorder = (folder: string, startedAt: number, hold: boolean) => `
      const { Store } = await import(${JSON.stringify('file://' + engine)});
      const s = Store.open(${JSON.stringify(projectDbPath(folder))});
      const r = s.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: ${startedAt} });
      s.close();
      process.stdout.write(r.runId + '\\n');
      ${hold ? "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));" : 'process.exit(0);'}`;

    // A run killed between calls a minute ago: its process is gone, and .shadowlap/active.json still names it.
    record(killed);
    const gone = spawnSync(process.execPath, ['--input-type=module', '-e', recorder(killed, Date.now() - 60_000, false)], { encoding: 'utf8' });
    writeFileSync(join(killed, '.shadowlap', 'active.json'), JSON.stringify({ url: 'http://127.0.0.1:1', runId: gone.stdout.trim(), pid: gone.pid }));
    const removed = registry.remove('support-agent', { deleteRecordings: true, typedName: 'support-agent' });
    expect(removed.deleted).toContain('.shadowlap/shadowlap.db');
    expect(existsSync(projectDbPath(killed))).toBe(false);

    // A recording two hours long whose process is still there, after another run in the folder removed active.json.
    record(long);
    const child = spawn(process.execPath, ['--input-type=module', '-e', recorder(long, Date.now() - 2 * 3600_000, true)], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      expect(existsSync(join(long, '.shadowlap', 'active.json'))).toBe(false);
      expect(() => registry.remove('research-agent', { deleteRecordings: true, typedName: 'research-agent' })).toThrow(expect.objectContaining({ code: 'recording', status: 409 }));
      expect(existsSync(projectDbPath(long))).toBe(true);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});

describe('ProjectRegistry: setup', () => {
  it('moves a project through its setup, never backwards, and logs when it is set up', () => {
    const { registry, agent } = setup();
    const folder = agent('research-agent', { 'pyproject.toml': '' });
    registry.add('~/research-agent');

    expect(registry.noteInspected('research-agent', findings()).setup).toMatchObject({ stage: 'inspected', findings: { sdk: 'anthropic 0.69.0' }, inspections: [{ at: 1, unwrapped: ['save_report'] }] });
    const recording = registry.noteRecording('research-agent', 'RUN1', ['uv', 'run', 'agent.py']);
    expect(recording.setup).toMatchObject({ stage: 'inspected', runId: 'RUN1', command: ['uv', 'run', 'agent.py'], unwrappedAtRecord: ['save_report'] });
    expect(registry.noteRecorded('research-agent', 'RUN1').setup.stage).toBe('recorded');
    // Checking again after wrapping the tools updates the findings, not the stage, and keeps when.
    const rechecked = registry.noteInspected('research-agent', findings({ at: 2, tools: [] }));
    expect(rechecked.setup).toMatchObject({ stage: 'recorded', findings: { tools: [] }, inspections: [{ at: 1, unwrapped: ['save_report'] }, { at: 2, unwrapped: [] }] });
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

  it('marks a setup finished before a golden was kept as skipped, and keeps it so', () => {
    const { registry, agent } = setup();
    const folder = agent('triage-bot');
    registry.add('~/triage-bot');
    const runId = record(folder);
    const done = registry.finishSetup('triage-bot', { runId });
    expect(done.setup).toMatchObject({ stage: 'done', skipped: true, runId });
    expect(events(folder, 'project.setup')[0]?.data).toMatchObject({ skipped: true });
    // Go to Overview after Skip setup changes nothing.
    expect(registry.finishSetup('triage-bot').setup).toMatchObject({ stage: 'done', skipped: true });
    expect(events(folder, 'project.setup')).toHaveLength(1);
  });

  it('moves the setup to a new recording, leaving what was made for the old one behind', () => {
    const { registry, agent } = setup();
    agent('research-agent', { 'pyproject.toml': '' });
    registry.add('~/research-agent');
    registry.noteInspected('research-agent', findings());
    registry.noteRecording('research-agent', 'R1', ['uv', 'run', 'agent.py']);
    registry.noteRecorded('research-agent', 'R1');
    registry.noteCalibrated('research-agent', 'R1', [{ path: '$.system', why: 'a temp path' }]);
    registry.noteTested('research-agent', 'R1', 'goldens/research-agent');
    expect(registry.get('research-agent')!.setup).toMatchObject({ stage: 'tested', runId: 'R1', golden: 'goldens/research-agent' });

    // Recorded again: back to step 2 for R2, with no calibration or golden of its own yet.
    const again = registry.noteRecording('research-agent', 'R2', ['uv', 'run', 'agent.py', '--all']);
    expect(again.setup).toMatchObject({ stage: 'inspected', runId: 'R2', command: ['uv', 'run', 'agent.py', '--all'], calibration: null, golden: null, skipped: false, unwrappedAtRecord: ['save_report'] });
    // A job's note about a run made in a terminal moves it the same way.
    expect(registry.noteCalibrated('research-agent', 'R3', []).setup).toMatchObject({ stage: 'clean', runId: 'R3', calibration: { added: [] }, command: ['uv', 'run', 'agent.py', '--all'] });
    // The same run again changes only what the note says.
    expect(registry.noteRecorded('research-agent', 'R3').setup).toMatchObject({ stage: 'clean', runId: 'R3', calibration: { added: [] } });
  });

  it('leaves a finished setup as it is, whatever a late job notes', () => {
    const { registry, agent } = setup();
    const folder = agent('triage-bot');
    registry.add('~/triage-bot');
    const runId = record(folder);
    registry.finishSetup('triage-bot', { runId, golden: null, skipped: true });
    for (const late of [() => registry.noteRecording('triage-bot', 'LATE', ['node', 'x.mjs']), () => registry.noteRecorded('triage-bot', 'LATE'), () => registry.noteCalibrated('triage-bot', 'LATE', []), () => registry.noteTested('triage-bot', 'LATE', 'goldens/x')]) {
      expect(late().setup).toMatchObject({ stage: 'done', runId, skipped: true, golden: null });
    }
    // init in the folder still updates what it found.
    expect(registry.noteInspected('triage-bot', findings()).setup).toMatchObject({ stage: 'done', findings: { sdk: 'anthropic 0.69.0' } });
  });

  it('finishes a setup with what the setup found, and logs it once', () => {
    const { registry, agent } = setup();
    const folder = agent('triage-bot');
    registry.add('~/triage-bot');
    registry.noteCalibrated('triage-bot', 'OLD', [{ path: '$.x' }]);
    const runId = record(folder);
    // Finished on a recording made in a terminal, packed there too: the list's calibration was another run's.
    const done = registry.finishSetup('triage-bot', { runId, golden: 'goldens/triage-bot', skipped: false });
    expect(done.setup).toMatchObject({ stage: 'done', runId, golden: 'goldens/triage-bot', skipped: false, calibration: null });
    expect(events(folder, 'project.setup')).toEqual([expect.objectContaining({ runId, data: { stage: 'done', name: 'triage-bot', skipped: false, golden: 'goldens/triage-bot' } })]);
    registry.finishSetup('triage-bot', { runId: 'OTHER', skipped: true });
    expect(registry.get('triage-bot')!.setup).toMatchObject({ runId, skipped: false });
    expect(events(folder, 'project.setup')).toHaveLength(1);
  });

  it('keeps the model server init found, never the credentials in its address', () => {
    const { registry, agent } = setup();
    agent('local-agent');
    registry.add('~/local-agent');
    const local = { url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434', from: 'OPENAI_BASE_URL in .env' };
    expect(registry.noteInspected('local-agent', findings({ modelServer: local })).setup.findings?.modelServer).toEqual(local);
    expect(registry.get('local-agent')!.setup.findings?.modelServer).toEqual(local);

    const secret = { url: 'https://dana:s3cret@llm.internal/v1', upstream: 'https://dana:s3cret@llm.internal', from: '.env' };
    registry.noteInspected('local-agent', findings({ modelServer: secret }));
    expect(readFileSync(registry.file, 'utf8')).not.toContain('s3cret');
    expect(registry.get('local-agent')!.setup.findings?.modelServer).toEqual({ url: 'https://llm.internal/v1', upstream: null, from: '.env' });

    // One written by hand is read the same way.
    const raw = JSON.parse(readFileSync(registry.file, 'utf8')) as { projects: Array<{ setup: { findings: Record<string, unknown> } }> };
    raw.projects[0].setup.findings.modelServer = { url: 'http://u:p@10.0.0.2:8000/v1', upstream: 'http://u:p@10.0.0.2:8000', from: 'x' };
    writeFileSync(registry.file, JSON.stringify(raw));
    expect(registry.get('local-agent')!.setup.findings?.modelServer).toEqual({ url: 'http://10.0.0.2:8000/v1', upstream: null, from: 'x' });
    // Findings an older version kept have none.
    expect(registry.noteInspected('local-agent', findings()).setup.findings?.modelServer).toBeNull();
  });

  it('keeps the Node the project pins, and reads findings without one as pinning none', () => {
    const { registry, agent } = setup();
    agent('node-agent');
    registry.add('~/node-agent');
    expect(registry.noteInspected('node-agent', findings({ nodePin: { version: '18.17', from: '.nvmrc' } })).setup.findings?.nodePin).toEqual({ version: '18.17', from: '.nvmrc' });
    expect(registry.get('node-agent')!.setup.findings?.nodePin).toEqual({ version: '18.17', from: '.nvmrc' });
    expect(registry.noteInspected('node-agent', findings()).setup.findings?.nodePin).toBeNull();
    // One written by hand that isn't a pin is none.
    const raw = JSON.parse(readFileSync(registry.file, 'utf8')) as { projects: Array<{ setup: { findings: Record<string, unknown> } }> };
    raw.projects[0].setup.findings.nodePin = { version: 18 };
    writeFileSync(registry.file, JSON.stringify(raw));
    expect(registry.get('node-agent')!.setup.findings?.nodePin).toBeNull();
  });

  it('remembers the commands confirmed in each folder, exactly, the newest twenty', () => {
    const { registry, agent } = setup();
    agent('triage-bot');
    registry.add('~/triage-bot');
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs'])).toBe(false);
    registry.confirmCommand('triage-bot', ['node', 'triage.mjs']);
    registry.confirmCommand('triage-bot', ['node', 'triage.mjs']);
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs'])).toBe(true);
    // Confirmed for the provider's API: through a model server it asks again, and that is kept apart.
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs'], { upstream: 'http://127.0.0.1:11434' })).toBe(false);
    registry.confirmCommand('triage-bot', ['node', 'triage.mjs'], { upstream: 'http://127.0.0.1:11434' });
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs'], { upstream: 'http://127.0.0.1:11434' })).toBe(true);
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs'], { upstream: 'http://10.0.0.9:8000' })).toBe(false);
    expect(registry.get('triage-bot')!.confirmed.map((c) => c.upstream)).toEqual([null, 'http://127.0.0.1:11434']);
    registry.confirmCommand('triage-bot', ['node', 'triage.mjs'], { upstream: 'http://127.0.0.1:11434' });
    expect(registry.isConfirmed('triage-bot', ['node', 'triage.mjs', '--all'])).toBe(false);
    expect(registry.get('triage-bot')!.confirmed).toHaveLength(2);
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

  it('reads findings it can’t use as none, and keeps keys it doesn’t know inside a project too', () => {
    const { registry, agent, shadowlapDir } = setup();
    const folder = agent('triage-bot');
    mkdirSync(shadowlapDir, { recursive: true });
    writeFileSync(
      registry.file,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: 'triage-bot',
            name: 'triage-bot',
            path: folder,
            addedAt: 1,
            pinned: true,
            setup: { stage: 'inspected', findings: { at: 1 }, laterField: 'kept' },
            confirmed: [{ argv: ['node', 'triage.mjs'], at: 2, note: 'kept' }],
          },
        ],
      }),
    );
    expect(registry.get('triage-bot')!.setup.findings).toBeNull();
    // Recording with findings that don't say which tools aren't wrapped doesn't fail.
    expect(registry.noteRecording('triage-bot', 'RUN', ['node', 'triage.mjs']).setup.unwrappedAtRecord).toEqual([]);
    registry.confirmCommand('triage-bot', ['node', 'triage.mjs', '--all']);
    const onDisk = JSON.parse(readFileSync(registry.file, 'utf8')) as { projects: Array<{ pinned: boolean; setup: Record<string, unknown>; confirmed: Array<Record<string, unknown>> }> };
    expect(onDisk.projects[0].pinned).toBe(true);
    expect(onDisk.projects[0].setup.laterField).toBe('kept');
    // A command confirmed before model servers were part of it was confirmed for the provider's API.
    expect(onDisk.projects[0].confirmed[0]).toEqual({ argv: ['node', 'triage.mjs'], upstream: null, at: 2, note: 'kept' });

    // Findings with tools that aren't what this version writes are cleaned up as they are read.
    const findingsRaw = { at: 3, tools: [{ name: 'send', effect: 'explode', wrapped: 'yes' }, { effect: 'read' }], wrap: [{ code: 'x', language: 'cobol' }, { language: 'python' }] };
    const raw = JSON.parse(readFileSync(registry.file, 'utf8')) as { projects: Array<{ setup: Record<string, unknown> }> };
    raw.projects[0].setup.findings = findingsRaw;
    writeFileSync(registry.file, JSON.stringify(raw));
    expect(registry.get('triage-bot')!.setup.findings).toMatchObject({
      tools: [{ name: 'send', effect: 'write', wrapped: false, why: '', file: '', line: 0 }],
      wrap: [{ code: 'x', language: 'javascript', tools: [] }],
      config: { file: 'shadowlap.config.json', created: false, existed: false },
    });
  });

  it('never deletes a store it can’t open to check that nothing is recording', () => {
    const { registry, agent } = setup();
    agent('triage-bot');
    const folder = agent('support-agent');
    registry.add('~/triage-bot');
    registry.add('~/support-agent');
    writeFileSync(projectDbPath(folder), 'not a database');
    expect(() => registry.remove('support-agent', { deleteRecordings: true, typedName: 'support-agent' })).toThrow(expect.objectContaining({ code: 'store', status: 409 }));
    expect(readFileSync(projectDbPath(folder), 'utf8')).toBe('not a database');
    expect(registry.list()).toHaveLength(2);
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
    expect(() => registry.add('~/triage-bot')).toThrow(/written by a newer shadowlap/);
  });

  it('ignores a relative SHADOWLAP_HOME, which would name another folder in every directory, and says so', () => {
    const home = tempDir('sl-reg-relhome-');
    const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: 'state' } });
    expect(registry.dir).toBe(join(home, '.shadowlap'));
    expect(registry.warnings).toEqual([`SHADOWLAP_HOME is state, which isn’t an absolute path, so it is ignored: the folder for all the files shadowlap keeps for this machine is ${join(home, '.shadowlap')} instead.`]);
    expect(new ProjectRegistry({ home, env: { SHADOWLAP_HOME: '~/sl' } })).toMatchObject({ dir: join(home, 'sl'), warnings: [] });
    expect(new ProjectRegistry({ home, env: { SHADOWLAP_HOME: join(home, 'abs') } })).toMatchObject({ dir: join(home, 'abs'), warnings: [] });
  });

  it('builds the start folder’s entry in memory, without writing, when the list can’t be used', () => {
    const { registry, agent, shadowlapDir } = setup();
    const folder = agent('triage-bot');
    record(folder);
    mkdirSync(shadowlapDir, { recursive: true });
    writeFileSync(registry.file, '{ not json');
    expect(() => registry.ensure(folder)).toThrow(expect.objectContaining({ code: 'registry' }));
    expect(registry.unlisted(folder)).toMatchObject({ id: 'triage-bot', name: 'triage-bot', path: folder, setup: { stage: 'done' } });
    expect(readFileSync(registry.file, 'utf8')).toBe('{ not json');
    // Written by a newer version: readable, and the stand-in's id doesn't clash with the projects in it.
    writeFileSync(registry.file, JSON.stringify({ version: 2, projects: [{ id: 'triage-bot', name: 'triage-bot', path: '/elsewhere/triage-bot', addedAt: 1 }] }));
    expect(registry.unlisted(folder).id).toBe('triage-bot-2');
    expect(() => registry.unlisted(join(folder, 'missing'))).toThrow(expect.objectContaining({ code: 'folder' }));
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

  it('names the setup’s run of a folder for a command that takes it, and nothing it can’t tell', () => {
    const { registry, agent, home, shadowlapDir } = setup();
    const folder = agent('research-agent', { 'pyproject.toml': '' });
    const options = { home, env: { SHADOWLAP_HOME: shadowlapDir } };
    expect(setupRunOf(folder, options)).toBeNull();
    registry.add('~/research-agent');
    expect(setupRunOf(folder, options)).toBeNull();
    const runId = record(folder);
    registry.noteRecording('research-agent', runId, ['uv', 'run', 'agent.py']);
    expect(setupRunOf(folder, options)).toBe(runId);
    expect(setupRunOf(join(folder, 'sub'), options)).toBeNull();
    writeFileSync(join(shadowlapDir, 'projects.json'), '{ not json');
    expect(setupRunOf(folder, options)).toBeNull();
  });

  it('waits for another writer’s lock, and takes over one left by a dead process', () => {
    const { registry, agent, shadowlapDir } = setup();
    agent('triage-bot');
    agent('support-agent');
    agent('research-agent');
    mkdirSync(shadowlapDir, { recursive: true });
    const lock = `${registry.file}.lock`;
    const busy = new ProjectRegistry({ home: registry.home, dir: shadowlapDir, lockTimeoutMs: 100 });

    // Held by a process that is running (this one, standing in for another): wait, then give up.
    writeFileSync(lock, String(process.pid));
    expect(() => busy.add('~/triage-bot')).toThrow(/held by another shadowlap process/);
    expect(existsSync(lock)).toBe(true);

    // Held by a process that is gone: taken over at once. No process has this id: past macOS's ids, at
    // the very top of Linux's, and no multiple of four, as every Windows one is (Windows can give the id
    // of a process that just ended to another, whose lock would then be a running holder's).
    writeFileSync(lock, String(2 ** 22 - 7));
    expect(busy.add('~/triage-bot').project.id).toBe('triage-bot');
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.stale`)).toBe(false);

    // Older than ten seconds: taken over whoever holds it.
    writeFileSync(lock, String(process.pid));
    const old = (Date.now() - 20_000) / 1000;
    utimesSync(lock, old, old);
    expect(busy.add('~/support-agent').project.id).toBe('support-agent');

    // A lock that doesn't say who holds it is waited for like a live one.
    writeFileSync(lock, '');
    expect(() => busy.add('~/research-agent')).toThrow(/held by another shadowlap process/);
    rmSync(lock);
    expect(busy.add('~/research-agent').project.id).toBe('research-agent');
  });
});
