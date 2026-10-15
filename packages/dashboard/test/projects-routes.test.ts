import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ProjectHost, ProjectRegistry, Store, projectDbPath, type SetupFindings } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard, type DashboardOptions, type ProjectConfig, type RouteModule } from '../src/index.js';

/**
 * One dashboard over several projects: the switcher, adding a folder within the limits, removing
 * one, the setup, and the jobs that run in the current project's folder against its store. The CLI
 * is a stand-in that says how it was started and reports what a recording or a calibration would.
 */

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

function files(root: string, tree: Record<string, string>): string {
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** The stand-in CLI: prints its arguments, folder and the upstream it was given, and reports on fd 3 as `run` and `calibrate` do. */
const FAKE = `
import { writeSync } from 'node:fs';
const args = process.argv.slice(2);
const fd = Number(process.env.SHADOWLAP_EVENTS_FD);
const emit = (e) => { if (fd >= 3) writeSync(fd, JSON.stringify(e) + '\\n'); };
console.log('args ' + JSON.stringify(args));
console.log('cwd ' + process.cwd());
console.log('upstream ' + (process.env.SHADOWLAP_UPSTREAM_OPENAI ?? 'none'));
const db = args[args.indexOf('--db') + 1];
const rest = args.slice(args.indexOf('--db') + 2);
if (rest[0] === 'run' && process.env.FAKE_RUN) emit({ type: 'run', runId: process.env.FAKE_RUN, role: 'new' });
if (rest[0] === 'calibrate') emit({ type: 'result', data: { runId: rest[1], source: 'given', clean: true, rounds: [], normalizers: [], written: false, added: [], stopped: null } });
if (rest[0] === 'init') emit({ type: 'result', data: { project: { id: null, noted: false, why: 'stand-in' } } });
console.log('db ' + db);
`;

/** A finished recording with calls, as `shadowlap run` leaves it. */
function recordInto(store: Store, cwd: string, calls = 2): string {
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd } });
  for (let callNo = 1; callNo <= calls; callNo++) store.appendCallStart({ runId: run.runId, callNo, kind: 'api', name: 'POST /v1/messages', fingerprint: `f${callNo}`, occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: Date.now() });
  store.endRun(run.runId, 'completed');
  return run.runId;
}

const findings = (over: Partial<SetupFindings> = {}): SetupFindings => ({
  at: Date.now(),
  language: 'Python 3.12 · uv',
  files: ['pyproject.toml', 'uv.lock'],
  sdk: 'anthropic 0.69.0',
  framework: null,
  command: ['uv', 'run', 'agent.py'],
  commandFrom: 'the entry file agent.py',
  config: { file: 'shadowlap.config.json', created: true, existed: false },
  tools: [
    { name: 'lookup', effect: 'read', wrapped: true, why: 'declared', file: 'agent.py', line: 3 },
    { name: 'save_report', effect: 'write', wrapped: false, why: 'leading verb “save”', file: 'agent.py', line: 9 },
  ],
  wrap: [{ language: 'python', tools: ['save_report'], code: 'from shadowlap import tool\n\n@tool(effect="write")\ndef save_report(…):\n    …' }],
  ...over,
});

let open: Array<{ dash: Dashboard; host: ProjectHost<ProjectConfig> }> = [];
afterEach(async () => {
  for (const o of open) {
    await o.dash.close();
    o.host.close();
  }
  open = [];
});

async function world(options: { routes?: RouteModule[]; env?: Record<string, string>; projectOptions?: DashboardOptions['projectOptions'] } = {}) {
  const home = tempDir('sl-proj-home-');
  const slHome = join(home, '.sl');
  const support = files(join(home, 'support-agent'), { 'pyproject.toml': '[project]\nname = "support"\n' });
  const triage = files(join(home, 'triage-bot'), { 'package.json': '{}', 'package-lock.json': '{}' });
  const downloads = files(join(home, 'Downloads'), { 'notes.txt': 'hi' });
  files(join(home, '.ssh'), { 'id_rsa': 'secret' });
  const research = files(join(home, 'research-agent'), { 'pyproject.toml': '', 'uv.lock': '' });
  const fake = join(home, 'fake-cli.mjs');
  writeFileSync(fake, FAKE);
  const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: slHome }, actor: () => null });
  const loadConfig = (cwd: string): ProjectConfig => {
    const file = join(cwd, 'shadowlap.config.json');
    const raw = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectConfig>) : {};
    return { normalize: raw.normalize ?? [], redact: raw.redact ?? [] };
  };
  // The support agent has runs; the dashboard starts there.
  const store = Store.open(projectDbPath(support));
  const supportRuns = [recordInto(store, support), recordInto(store, support, 3)];
  store.close();
  const host = ProjectHost.open<ProjectConfig>(support, { registry, loadConfig });
  const dash = await startDashboard({
    projects: host,
    spawnCli: cliSpawner({ command: [process.execPath, fake], cwd: support, env: { ...process.env, ...(options.env ?? {}) } }),
    version: '0.1.0',
    routes: options.routes ?? [],
    ...(options.projectOptions ? { projectOptions: options.projectOptions } : {}),
  });
  open.push({ dash, host });
  const api = async <T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${dash.url}/api/${path}`, {
      method: init.method ?? 'GET',
      headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const waitJob = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const j = await api<{ done: boolean; code: number | null; lines: string[]; newRunId: string | null }>(`jobs/${id}`);
      if (j.body.done) return j.body;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the job did not end');
  };
  return { home, slHome, support, triage, downloads, research, registry, host, dash, api, waitJob, supportRuns };
}

describe('the switcher', () => {
  it('lists the projects with their paths and runs, and switching swaps the store, the config and the folder jobs run in', async () => {
    const w = await world();
    w.registry.add(w.triage);
    const list = await w.api<{ heading: string; items: Array<{ id: string; detail: string; current: boolean; removable: boolean }>; add: { label: string } }>('projects');
    expect(list.status).toBe(200);
    expect(list.body.heading).toBe('Projects on this machine');
    expect(list.body.items.map((i) => [i.id, i.detail, i.current, i.removable])).toEqual([
      ['support-agent', '~/support-agent · 2 runs', true, true],
      ['triage-bot', '~/triage-bot · no runs yet · setting up', false, true],
    ]);
    expect(list.body.add.label).toBe('Add project…');

    const meta = await w.api<{ project: { id: string; name: string; path: string; settingUp: boolean }; counts: { runs: number }; dbPath: string }>('meta');
    expect(meta.body.project).toEqual({ id: 'support-agent', name: 'support-agent', path: w.support, display: '~/support-agent', settingUp: false });
    expect(meta.body.counts.runs).toBe(2);
    expect(meta.body.dbPath).toBe(projectDbPath(w.support));
    const before = await w.api<{ cursor: string }>('changes');
    const runs = await w.api<{ runs: Array<{ runId: string }> }>('runs');
    expect(runs.body.runs.map((r) => r.runId).sort()).toEqual([...w.supportRuns].sort());

    // Switch: every read is the other project's now.
    expect((await w.api('projects/triage-bot/select', { method: 'POST' })).body).toEqual({ current: 'triage-bot', name: 'triage-bot' });
    const after = await w.api<{ project: { id: string; settingUp: boolean }; counts: { runs: number }; dbPath: string }>('meta');
    expect(after.body).toMatchObject({ project: { id: 'triage-bot', settingUp: true }, counts: { runs: 0 }, dbPath: projectDbPath(w.triage) });
    expect((await w.api<{ runs: unknown[] }>('runs')).body.runs).toEqual([]);
    expect((await w.api(`runs/${w.supportRuns[0]}`)).status).toBe(404);
    // What the browser learned from the other store no longer holds: everything changed.
    const changed = await w.api<{ changed: boolean; runs: boolean; events: boolean }>(`changes?since=${encodeURIComponent(before.body.cursor)}`);
    expect(changed.body).toMatchObject({ changed: true, runs: true, events: true });

    // A job runs in the current project's folder, against its store.
    const job = await w.api<{ id: string }>('jobs', { method: 'POST', body: { kind: 'init' } });
    expect(job.status).toBe(202);
    const done = await w.waitJob(job.body.id);
    expect(done.lines).toContain(`cwd ${w.triage}`);
    expect(done.lines).toContain(`db ${projectDbPath(w.triage)}`);
    expect(done.lines).toContain(`args ${JSON.stringify(['--db', projectDbPath(w.triage), 'init'])}`);

    // The switcher marks the new current one; an unknown project is a 404.
    const again = await w.api<{ items: Array<{ id: string; current: boolean }> }>('projects');
    expect(again.body.items.find((i) => i.current)?.id).toBe('triage-bot');
    expect((await w.api('projects/nope/select', { method: 'POST' })).status).toBe(404);
  });

  it('keeps a job in the project it started in when the dashboard switches while it runs', async () => {
    const sleeper: RouteModule = {
      register: (_router, ctx) =>
        ctx.jobs.registerJobKind('slow', {
          title: () => 'Waiting',
          build: () => ({ args: ['run', '--', 'sleep'] }),
        }),
    };
    const w = await world({ routes: [sleeper], env: { FAKE_RUN: '' } });
    w.registry.add(w.triage);
    const job = await w.api<{ id: string }>('jobs', { method: 'POST', body: { kind: 'slow' } });
    await w.api('projects/triage-bot/select', { method: 'POST' });
    const done = await w.waitJob(job.body.id);
    expect(done.lines).toContain(`cwd ${w.support}`);
    expect(done.lines).toContain(`db ${projectDbPath(w.support)}`);
  });

  it('gives each project its own instance of a route module, so one that keeps the store and folder from registration serves each project’s', async () => {
    const heard: Array<[string, string]> = [];
    const capturing: RouteModule = {
      register: (router, ctx) => {
        const { store, project, jobs } = ctx;
        // What the CLI gives per folder (how to list its goldens, say) is the project's own too.
        const folder = (ctx.options as { folder?: string }).folder;
        router.get('/kept', (r) => r.json({ runs: store.allRuns().length, project: project?.name, folder }));
        jobs.registerJobKind('kept', { title: () => 'Keeping', build: () => ({ args: ['kept', project!.name] }) });
        // Each instance hears the jobs of its own project.
        jobs.onJob((n) => (n.type === 'end' ? heard.push([project!.name, n.job.kind]) : undefined));
      },
    };
    const w = await world({ routes: [capturing], projectOptions: (p) => ({ folder: p.path }) as Partial<DashboardOptions> });
    w.registry.add(w.triage);
    expect((await w.api('kept')).body).toEqual({ runs: 2, project: 'support-agent', folder: w.support });
    await w.api('projects/triage-bot/select', { method: 'POST' });
    expect((await w.api('kept')).body).toEqual({ runs: 0, project: 'triage-bot', folder: w.triage });
    // The kind is listed once, and its job is built by the current project's instance.
    expect((await w.api<{ jobKinds: string[] }>('meta')).body.jobKinds.filter((k) => k === 'kept')).toHaveLength(1);
    const job = await w.api<{ id: string }>('jobs', { method: 'POST', body: { kind: 'kept' } });
    const done = await w.waitJob(job.body.id);
    expect(done.lines).toContain(`args ${JSON.stringify(['--db', projectDbPath(w.triage), 'kept', 'triage-bot'])}`);
    expect(heard).toEqual([['triage-bot', 'kept']]);
    // Back again: the first project's instance, with its store.
    await w.api('projects/support-agent/select', { method: 'POST' });
    expect((await w.api('kept')).body).toEqual({ runs: 2, project: 'support-agent', folder: w.support });
  });

  it('shows an empty stand-in for a project whose folder is gone, so the switcher still works, and refuses its jobs with the reason', async () => {
    const w = await world();
    const gone = files(join(w.home, 'old-agent'), { 'package.json': '{}' });
    w.registry.add(gone);
    rmSync(gone, { recursive: true, force: true });
    await w.api('projects/old-agent/select', { method: 'POST' });
    const meta = await w.api<{ project: { id: string; problem: string }; counts: { runs: number } }>('meta');
    expect(meta.status).toBe(200);
    expect(meta.body.project).toMatchObject({ id: 'old-agent', problem: '~/old-agent doesn’t exist any more. Remove the project, or put the folder back.' });
    expect(meta.body.counts.runs).toBe(0);
    expect((await w.api<{ runs: unknown[] }>('runs')).body.runs).toEqual([]);
    const list = await w.api<{ items: Array<{ id: string; detail: string }> }>('projects');
    expect(list.body.items.find((i) => i.id === 'old-agent')?.detail).toBe('~/old-agent · folder not found');
    expect(await w.api('jobs', { method: 'POST', body: { kind: 'init' } })).toMatchObject({ status: 400, body: { error: expect.stringContaining('doesn’t exist any more') } });
    // Switching back serves the real store again.
    await w.api('projects/support-agent/select', { method: 'POST' });
    expect((await w.api<{ counts: { runs: number }; project: { id: string } }>('meta')).body).toMatchObject({ counts: { runs: 2 }, project: { id: 'support-agent' } });
  });
});

describe('adding a project', () => {
  it('suggests folders under the home folder with their kinds, marks those already added, and explains one without project files', async () => {
    const w = await world();
    const page = await w.api<{ title: string; folders: Array<{ display: string; note: string; disabled: boolean }>; button: { label: string; disabled: boolean }; next: { title: string; steps: Array<{ title: string }> } }>('projects/folders?q=');
    expect(page.status).toBe(200);
    expect(page.body.title).toBe('Add a project');
    const shown = Object.fromEntries(page.body.folders.map((f) => [f.display, [f.note, f.disabled]]));
    expect(shown).toMatchObject({
      '~/research-agent': ['Python · uv · pyproject.toml · uv.lock', false],
      '~/triage-bot': ['Node · npm · package.json · package-lock.json', false],
      '~/support-agent': ['already added', true],
      '~/Downloads': ['no project files found', false],
    });
    // Hidden folders never show, and a typed path into one lists nothing.
    expect(page.body.folders.some((f) => f.display.includes('.ssh'))).toBe(false);
    expect((await w.api<{ folders: unknown[]; empty: string }>('projects/folders?q=~/.ssh/')).body).toMatchObject({ folders: [], empty: 'Hidden folders aren’t listed.' });
    expect(page.body.button).toEqual({ label: 'Add project', disabled: true, path: null });
    expect(page.body.next.steps.map((s) => s.title)).toEqual(['Inspect', 'Record', 'Calibrate', 'Keep it as a test']);

    // Typing filters; picking names the folder on the button.
    const typed = await w.api<{ folders: Array<{ display: string }> }>('projects/folders?q=~/re');
    expect(typed.body.folders.map((f) => f.display)).toEqual(['~/research-agent']);
    const picked = await w.api<{ button: { label: string; disabled: boolean; path: string }; error: string | null }>(`projects/folders?q=&pick=${encodeURIComponent(w.research)}`);
    expect(picked.body.button).toEqual({ label: 'Add ~/research-agent', disabled: false, path: w.research });
    expect(picked.body.error).toBeNull();
    const none = await w.api<{ button: { disabled: boolean }; error: string }>(`projects/folders?pick=${encodeURIComponent('~/Downloads')}`);
    expect(none.body.button.disabled).toBe(true);
    expect(none.body.error).toBe('No pyproject.toml, package.json or requirements file in ~/Downloads. Pick the folder your agent’s code is in.');
    const outside = await w.api<{ error: string }>(`projects/folders?pick=${encodeURIComponent('/etc')}`);
    expect(outside.body.error).toMatch(/^Only folders in your home folder/);
  });

  it('adds a folder and opens on it, refuses one outside the limits, and brings a removed one back with its runs', async () => {
    const w = await world();
    const added = await w.api<{ project: { id: string; path: string }; message: string; current: string; again: boolean }>('projects', { method: 'POST', body: { path: w.research } });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ project: { id: 'research-agent', path: '~/research-agent' }, message: 'Added ~/research-agent', current: 'research-agent', again: false });
    expect((await w.api<{ project: { id: string; settingUp: boolean } }>('meta')).body.project).toMatchObject({ id: 'research-agent', settingUp: true });
    // Already added, no project files, outside the home folder, hidden: each refused with the reason.
    expect(await w.api('projects', { method: 'POST', body: { path: w.research } })).toMatchObject({ status: 409, body: { error: '~/research-agent is already in the dashboard.' } });
    expect(await w.api('projects', { method: 'POST', body: { path: w.downloads } })).toMatchObject({ status: 400, body: { error: expect.stringContaining('No pyproject.toml') } });
    expect((await w.api('projects', { method: 'POST', body: { path: '/etc' } })).status).toBe(400);
    expect((await w.api('projects', { method: 'POST', body: { path: '~/.ssh' } })).status).toBe(400);
    expect((await w.api('projects', { method: 'POST', body: {} })).status).toBe(400);

    // Removed and added again: its runs come back, and the toast says so.
    await w.api('projects/support-agent/remove', { method: 'POST', body: {} });
    const back = await w.api<{ message: string; again: boolean; runs: number }>('projects', { method: 'POST', body: { path: w.support } });
    expect(back.body).toMatchObject({ message: 'Added ~/support-agent back · 2 runs', again: true, runs: 2 });
    expect((await w.api<{ counts: { runs: number } }>('meta')).body.counts.runs).toBe(2);
  });
});

describe('removing a project', () => {
  it('shows what stays on disk, forgets the folder, and deletes the recordings only once the name is typed', async () => {
    const w = await world();
    w.registry.add(w.triage);
    const dialog = await w.api<{ title: string; onDisk: Array<{ key: string; label: string; path: string }>; deleteZone: { confirm: string; mode: { button: { label: string } } } | null; canRemove: boolean }>('projects/support-agent/remove');
    expect(dialog.body.title).toBe('Remove support-agent from the dashboard?');
    expect(dialog.body.onDisk.map((r) => [r.key, r.label, r.path])).toEqual([
      ['code', 'The folder and its code', '~/support-agent'],
      ['rec', 'Its recordings', '.shadowlap/shadowlap.db'],
      ['cfg', 'Its settings', 'shadowlap.config.json'],
    ]);
    expect(dialog.body.deleteZone?.confirm).toBe('Type support-agent to confirm. This can’t be undone.');
    expect(dialog.body.canRemove).toBe(true);
    // No runs: no zone that deletes them.
    expect((await w.api<{ deleteZone: unknown }>('projects/triage-bot/remove')).body.deleteZone).toBeNull();

    // The wrong name deletes nothing and keeps the project.
    const wrong = await w.api('projects/support-agent/remove', { method: 'POST', body: { deleteRecordings: true, name: 'support' } });
    expect(wrong).toMatchObject({ status: 400, body: { error: 'Type support-agent to confirm deleting its recordings.' } });
    expect(existsSync(projectDbPath(w.support))).toBe(true);

    // Removing the current project forgets it and moves on; the store stays.
    const removed = await w.api<{ removed: string; current: string; deleted: string[]; message: string }>('projects/support-agent/remove', { method: 'POST', body: {} });
    expect(removed.body).toEqual({ removed: 'support-agent', current: 'triage-bot', deleted: [], message: 'Removed support-agent · its folder and recordings are untouched' });
    expect(existsSync(projectDbPath(w.support))).toBe(true);
    expect((await w.api<{ project: { id: string } }>('meta')).body.project.id).toBe('triage-bot');
    // The only project left can't be removed.
    expect(await w.api('projects/triage-bot/remove', { method: 'POST', body: {} })).toMatchObject({ status: 409, body: { error: 'This is the only project. Add another one first.' } });
    expect((await w.api<{ canRemove: boolean; why: string }>('projects/triage-bot/remove')).body).toMatchObject({ canRemove: false, why: 'The only project can’t be removed' });

    // Back, then removed with its recordings: the store goes, the folder stays.
    await w.api('projects', { method: 'POST', body: { path: w.support } });
    const gone = await w.api<{ deleted: string[]; message: string }>('projects/support-agent/remove', { method: 'POST', body: { deleteRecordings: true, name: 'support-agent' } });
    expect(gone.body.message).toBe('Removed support-agent and deleted its recordings');
    expect(gone.body.deleted).toContain('.shadowlap/shadowlap.db');
    expect(existsSync(projectDbPath(w.support))).toBe(false);
    expect(existsSync(join(w.support, 'pyproject.toml'))).toBe(true);
  });
});

describe('the setup', () => {
  it('shows the four steps for a project with no runs, then the findings, the record step and the job that records', async () => {
    const w = await world();
    await w.api('projects', { method: 'POST', body: { path: w.research } });
    const fresh = await w.api<{ title: string; eyebrow: string; shows: string; steps: Array<{ title: string; state: string; cli: string[] }> }>('setup');
    expect(fresh.body).toMatchObject({ title: 'No runs yet', eyebrow: 'research-agent · ~/research-agent', shows: 'everywhere' });
    expect(fresh.body.steps.map((s) => [s.title, s.state])).toEqual([
      ['Inspect the folder', 'current'],
      ['Record a first run', 'todo'],
      ['Make the replay clean', 'todo'],
      ['Keep it as a test', 'todo'],
    ]);
    expect(fresh.body.steps[0]!.cli).toEqual(['shadowlap init']);

    // What init finds (here noted as init notes it), with the unwrapped tool and its code.
    w.registry.noteInspected('research-agent', findings());
    const inspected = await w.api<{ inspect: { state: string; warning: { title: string; recheck: { label: string } } }; record: { state: string; command: { value: string; enabled: boolean } } }>('setup');
    expect(inspected.body.inspect).toMatchObject({ state: 'done', warning: { title: '1 write tool isn’t wrapped.', recheck: { label: 'I wrapped it, check again' } } });
    expect(inspected.body.record).toMatchObject({ state: 'current', command: { value: 'uv run agent.py', enabled: true } });

    // The first command in the folder asks first; the browser's line is split without a shell.
    const plan = await w.api<{ display: string; confirm: { title: string; button: string } }>('setup/record', { method: 'POST', body: { command: 'node agent.mjs "a b"' } });
    expect(plan.body).toMatchObject({ display: 'shadowlap run -- node agent.mjs \'a b\'', confirm: { title: 'Run this command in ~/research-agent?', button: 'Run and record' } });
    expect(await w.api('setup/record', { method: 'POST', body: { command: 'node agent.mjs | tee log' } })).toMatchObject({ status: 400, body: { error: expect.stringContaining('pipe') } });
    const unconfirmed = await w.api('jobs', { method: 'POST', body: { kind: 'record', command: 'node agent.mjs "a b"' } });
    expect(unconfirmed).toMatchObject({ status: 409, body: { error: expect.stringContaining('Run this command in ~/research-agent?') } });
    const started = await w.api<{ id: string; title: string; args: string[] }>('jobs', { method: 'POST', body: { kind: 'record', command: 'node agent.mjs "a b"', confirmed: true, project: 'research-agent' } });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ title: 'Recording', args: ['run', '--', 'node', 'agent.mjs', 'a b'] });
    const done = await w.waitJob(started.body.id);
    expect(done.lines).toContain(`cwd ${w.research}`);
    // Confirmed once: the same command there doesn't ask again.
    expect((await w.api<{ confirm: unknown }>('setup/record', { method: 'POST', body: { command: 'node agent.mjs "a b"' } })).body.confirm).toBeNull();
    // A page that still shows another project is refused, so a click never acts on the wrong one.
    expect(await w.api('jobs', { method: 'POST', body: { kind: 'record', command: 'node agent.mjs', confirmed: true, project: 'support-agent' } })).toMatchObject({ status: 409, body: { error: expect.stringContaining('switched to research-agent') } });
    expect(await w.api('setup/finish', { method: 'POST', body: { project: 'support-agent' } })).toMatchObject({ status: 409 });
  });

  it('records through the project’s own model server, and never through one whose address holds credentials', async () => {
    const w = await world();
    await w.api('projects', { method: 'POST', body: { path: w.research } });
    w.registry.noteInspected('research-agent', findings({ modelServer: { url: 'http://127.0.0.1:11434/v1', upstream: 'http://127.0.0.1:11434/v1', from: 'OPENAI_BASE_URL in .env' } }));
    const job = await w.api<{ id: string }>('jobs', { method: 'POST', body: { kind: 'record', command: 'uv run agent.py', confirmed: true } });
    const done = await w.waitJob(job.body.id);
    expect(done.lines).toContain('upstream http://127.0.0.1:11434/v1');
    w.registry.noteInspected('research-agent', findings({ modelServer: { url: 'http://user:pw@10.0.0.2:8000/v1', upstream: 'http://user:pw@10.0.0.2:8000/v1', from: 'OPENAI_BASE_URL in .env' } }));
    const refused = await w.api('jobs', { method: 'POST', body: { kind: 'record', command: 'uv run agent.py', confirmed: true } });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringContaining('can’t record through this project’s model server') } });
  });

  it('notes the recording a job made, a clean calibration of it, and the golden’s test, and finishes the setup', async () => {
    const calibrate: RouteModule = {
      register: (_router, ctx) => {
        ctx.jobs.registerJobKind('calibrate', { title: () => 'Calibrating', build: (req) => ({ args: ['calibrate', String(req.runId), ...(req.write === true ? ['--write'] : [])] }) });
        ctx.jobs.registerJobKind('test', { title: () => 'Running the tests', build: (req) => ({ args: ['test', String(req.golden)] }) });
      },
    };
    const w = await world({ routes: [calibrate] });
    await w.api('projects', { method: 'POST', body: { path: w.research } });
    w.registry.noteInspected('research-agent', findings({ tools: [], wrap: [] }));
    // The recording the job reports: made by the stand-in here, as `shadowlap run` would.
    const store = w.host.context('research-agent').store();
    const runId = recordInto(store, w.research, 4);
    const job = await w.api<{ id: string }>('jobs', { method: 'POST', body: { kind: 'record', command: 'uv run agent.py', confirmed: true } });
    expect(job.status).toBe(202);
    await w.waitJob(job.body.id);
    // The stand-in reported no run (FAKE_RUN unset), but the store holds the recording: the setup takes it.
    const recorded = await w.api<{ record: { state: string; recorded: { text: string } }; calibrate: { state: string; button: { label: string; action: string } }; skip: { label: string } | null }>('setup');
    expect(recorded.body.record).toMatchObject({ state: 'done', recorded: { text: expect.stringMatching(new RegExp(`^Recorded ${runId.slice(0, 10)} · 4 calls`)) } });
    expect(recorded.body.calibrate).toMatchObject({ state: 'current', button: { label: 'Calibrate', action: 'calibrate' } });
    expect(recorded.body.skip).toEqual({ label: 'Skip the rest', action: 'finishsetup' });

    // Calibrate finds the replay clean: step 3 is done, and noted.
    const cal = await w.api<{ id: string }>('jobs', { method: 'POST', body: { kind: 'calibrate', runId } });
    await w.waitJob(cal.body.id);
    expect(w.registry.get('research-agent')!.setup).toMatchObject({ stage: 'clean', runId, calibration: { added: [] } });
    const clean = await w.api<{ calibrate: { state: string; text: string }; test: { state: string; golden: { value: string } } }>('setup');
    expect(clean.body.calibrate).toMatchObject({ state: 'done', text: 'The replay was clean as recorded: nothing to add.' });
    expect(clean.body.test).toMatchObject({ state: 'current', golden: { value: 'goldens/research-agent' } });

    // The golden's path is checked before anything packs there.
    expect(await w.api('setup/golden', { method: 'POST', body: { golden: '../outside' } })).toMatchObject({ status: 400 });
    expect((await w.api<{ path: string }>('setup/golden', { method: 'POST', body: { golden: 'first-run' } })).body.path).toBe('goldens/first-run');
    // Packed (here by hand, as pack would), then its test passes: step 4 is done.
    files(w.research, { 'goldens/research-agent/run.json': JSON.stringify({ runs: [{ runId }] }) });
    const test = await w.api<{ id: string }>('jobs', { method: 'POST', body: { kind: 'test', golden: 'goldens/research-agent' } });
    await w.waitJob(test.body.id);
    expect(w.registry.get('research-agent')!.setup).toMatchObject({ stage: 'tested', golden: 'goldens/research-agent' });
    const tested = await w.api<{ test: { state: string; result: { text: string } }; done: { title: string; button: { label: string } } }>('setup');
    expect(tested.body.test).toMatchObject({ state: 'done', result: { text: 'goldens/research-agent replayed clean offline · 4/4 calls' } });
    expect(tested.body.done).toMatchObject({ title: 'research-agent is set up.', button: { label: 'Go to the overview' } });

    // Go to the overview: set up, and the Overview is the Overview again.
    expect((await w.api('setup/finish', { method: 'POST', body: { project: 'research-agent' } })).body).toMatchObject({ project: 'research-agent', stage: 'done', skipped: false });
    expect((await w.api<{ project: { settingUp: boolean } }>('meta')).body.project.settingUp).toBe(false);
    expect((await w.api<{ shows: string }>('setup')).body.shows).toBe('none');
  });

  it('can’t be finished before a first recording', async () => {
    const w = await world();
    await w.api('projects', { method: 'POST', body: { path: w.research } });
    expect(await w.api('setup/finish', { method: 'POST', body: {} })).toMatchObject({ status: 409, body: { error: 'Record a first run before finishing the setup.' } });
  });
});

describe('a dashboard that serves one store', () => {
  it('has no project routes or setup jobs, and says why', async () => {
    const dir = tempDir('sl-proj-one-');
    const store = Store.open(join(dir, 'db.sqlite'));
    const dash = await startDashboard({ store, spawnCli: cliSpawner({ command: [process.execPath, '-e', ''], cwd: dir }), project: { path: dir } });
    try {
      const headers = { 'x-shadowlap-token': dash.token };
      const res = await fetch(`${dash.url}/api/projects`, { headers });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain('serves one store');
      const meta = (await (await fetch(`${dash.url}/api/meta`, { headers })).json()) as { jobKinds: string[]; project: { name: string; id?: string } };
      expect(meta.jobKinds).not.toContain('record');
      expect(meta.project.id).toBeUndefined();
    } finally {
      await dash.close();
      store.close();
    }
  });
});

// A folder the dashboard can't read isn't listed in suggestions, and checking it says nothing about what is in it.
describe('folder limits', () => {
  it('lists nothing inside a folder it can’t read', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const w = await world();
    const locked = files(join(w.home, 'locked'), { 'inner/package.json': '{}' });
    chmodSync(locked, 0o000);
    try {
      const page = await w.api<{ folders: unknown[]; empty: string }>('projects/folders?q=~/locked/');
      expect(page.body.folders).toEqual([]);
      expect(page.body.empty).toBe('Can’t read ~/locked.');
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
