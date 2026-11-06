import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, ulid } from '@shadowlap/engine';
import { cliSpawner, JobManager, startDashboard, type Dashboard, type JobView, type RouteModule, type SpawnCliOptions } from '../src/index.js';

/**
 * Jobs end to end: a kind's builder checks the request, a stand-in CLI runs with the events pipe on
 * fd 3, and what it reports (runs, links, files, a result) reaches the job, the drawer and the
 * file downloads. Uploads are stored for a job and deleted after it.
 */
const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const posix = process.platform !== 'win32';

let project: string;
let outside: string;
let store: Store;
let dash: Dashboard;
const spawned: Array<{ args: string[]; options: SpawnCliOptions | undefined }> = [];
/** Stand-in agents a test started and has not yet seen gone: killed at the end, should an assertion fail first. */
const agents = new Set<number>();

/** A job kind for the tests: each `mode` builds one stand-in command, or refuses. */
const fakeKind: RouteModule = {
  register: (_router, ctx) =>
    ctx.jobs.registerJobKind('fake', {
      title: (req) => (typeof req.title === 'string' ? req.title : 'Faking'),
      build: (req, b) => {
        switch (req.mode) {
          case 'events':
            return { args: ['events', join(outside, 'secret.txt')] };
          case 'text-only':
            return { args: ['text-only'] };
          case 'sleep':
            return { args: ['sleep', '20000'] };
          case 'stubborn':
            return { args: ['stubborn', typeof req.runId === 'string' ? req.runId : ''] };
          case 'lines':
            return { args: ['lines', String(req.n)] };
          case 'fail':
            return { args: ['fail'] };
          case 'cat': {
            const u = b.upload(req.uploadId);
            if (!u) return { error: 'upload not found', status: 404 };
            return { args: ['cat', u.path], title: `Reading ${u.name}` };
          }
          case 'refuse':
            return { error: 'the fake refuses' };
          case 'throw':
            throw new Error('the builder broke');
          case 'empty':
            return { args: [] };
          case 'outside-cwd':
            return { args: ['x'], cwd: outside };
          case 'cwd':
            return { args: ['pwd'], cwd: String(req.cwd) };
          default:
            return { error: `unknown mode ${String(req.mode)}` };
        }
      },
    }),
};

const api = (d: Dashboard, path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } });
const post = (d: Dashboard, path: string, body: unknown) => api(d, path, { method: 'POST', body: JSON.stringify(body) });

async function waitJob(d: Dashboard, id: string): Promise<JobView> {
  for (let i = 0; i < 200; i++) {
    const view = (await (await api(d, `jobs/${id}`)).json()) as JobView;
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${id} did not finish`);
}

async function startJob(d: Dashboard, body: unknown): Promise<JobView> {
  const res = await post(d, 'jobs', body);
  expect(res.status, await res.clone().text()).toBe(202);
  return (await res.json()) as JobView;
}

/** Waits for a line of the job's output that matches, and returns its match. */
async function waitLine(d: Dashboard, id: string, re: RegExp): Promise<RegExpExecArray> {
  for (let i = 0; i < 400; i++) {
    const view = (await (await api(d, `jobs/${id}`)).json()) as JobView;
    for (const line of view.lines) {
      const m = re.exec(line);
      if (m) return m;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${id} printed nothing like ${re}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
}

function upload(d: Dashboard, body: Buffer | string, name = 'capture.har'): Promise<Response> {
  return api(d, 'uploads', { method: 'POST', body, headers: { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' } });
}

beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-jobs-project-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'sl-jobs-outside-')));
  writeFileSync(join(outside, 'secret.txt'), 'not for the browser');
  store = Store.open(':memory:');
  const spawner = cliSpawner({ command: [process.execPath, FAKE], cwd: tmpdir() });
  dash = await startDashboard({
    store,
    version: '0.1.0',
    dbPath: ':memory:',
    spawnCli: (args, options) => {
      spawned.push({ args, options });
      return spawner(args, options);
    },
    project: { path: project },
    uploadLimit: 4096,
    jobStopGraceMs: 500,
    routes: [fakeKind],
  });
});
afterAll(async () => {
  for (const pid of agents) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone, as it should be
    }
  }
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('job kinds', () => {
  it('are registered once, by a plain name, and listed in meta', async () => {
    const jobs = new JobManager({ store, project: null });
    const kind = { title: () => 't', build: () => ({ args: ['x'] }) };
    expect(() => jobs.registerJobKind('Bad Name', kind)).toThrow(/lowercase/);
    jobs.registerJobKind('blame', kind);
    jobs.registerJobKind('export', kind);
    expect(() => jobs.registerJobKind('blame', kind)).toThrow(/twice/);
    expect(jobs.kindNames()).toEqual(['blame', 'export']);
    const meta = (await (await api(dash, 'meta')).json()) as { jobKinds: string[]; actions: boolean; project: { name: string; path: string } };
    // Each feature's kinds besides: sorted, each once.
    expect(meta.jobKinds).toEqual(expect.arrayContaining(['action', 'fake']));
    expect(meta.jobKinds).toEqual([...new Set(meta.jobKinds)].sort());
    expect(meta.actions).toBe(true);
    expect(meta.project).toEqual({ name: project.split(/[\\/]/).pop(), path: project });
  });

  it('check every request through the builder: the browser never sends a command line', async () => {
    const before = spawned.length;
    const refused = async (body: unknown, status: number, message: RegExp) => {
      const res = await post(dash, 'jobs', body);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    };
    await refused({}, 400, /kind is required/);
    await refused({ kind: 'nope', args: ['rm', '-rf', '/'] }, 400, /no job kind "nope" \(this dashboard runs: (?:[a-z-]+, )*action, (?:[a-z-]+, )*fake(?:, [a-z-]+)*\)/);
    await refused({ kind: 'fake', mode: 'refuse' }, 400, /the fake refuses/);
    await refused({ kind: 'fake', mode: 'throw' }, 400, /the builder broke/);
    await refused({ kind: 'fake', mode: 'empty' }, 500, /built no command/);
    await refused({ kind: 'fake', mode: 'outside-cwd' }, 400, /inside the project folder/);
    await refused({ kind: 'fake', mode: 'cwd', cwd: '../elsewhere' }, 400, /inside the project folder/);
    await refused({ kind: 'fake', mode: 'cwd', cwd: 'not-made-yet' }, 400, /inside the project folder/);
    await refused({ kind: 'fake', mode: 'cat', uploadId: '../../etc/passwd' }, 404, /upload not found/);
    expect((await api(dash, 'jobs', { method: 'POST', body: '[1,2]' })).status).toBe(400);
    expect(spawned.length, 'nothing ran').toBe(before);
  });
});

describe('a job hears what the command made on fd 3', () => {
  let job: JobView;

  it('runs in the project folder with the events pipe, and keeps the runs, links, files and result it reports', async () => {
    const started = await startJob(dash, { kind: 'fake', mode: 'events', title: 'Exporting a dataset' });
    expect(started).toMatchObject({ kind: 'fake', title: 'Exporting a dataset', args: ['events', join(outside, 'secret.txt')], runId: null, done: false });
    expect(spawned.at(-1)!.options).toEqual({ events: true, cwd: project });
    job = await waitJob(dash, started.id);
    expect(job.code).toBe(0);
    expect(job.endedAt).toBeGreaterThanOrEqual(job.startedAt);
    expect(job.lines).toEqual(expect.arrayContaining([`cwd ${project}`, 'events fd 3', 'done']));
    // A run named in the output counts too, but the structured event names the run to open; an attempt is listed, never opened.
    expect([...job.runs].sort()).toEqual(['01K5CQ4P2R0000000000000000', '01K5CQ4P2S0000000000000000', '01K5CQ4P2T0000000000000000']);
    expect(job.newRunId).toBe('01K5CQ4P2S0000000000000000');
    // Only dashboard routes are links; one beside the primary action says so.
    expect(job.links).toEqual([
      { label: 'Open fix', href: '#/fixes/fx-1' },
      { label: 'Open the run', href: '#/run/01K5CQ4P2S0000000000000000', secondary: true },
    ]);
    expect(job.files.map((f) => [f.path, f.name, f.label, f.bytes, f.directory])).toEqual([
      ['.shadowlap/exports/dataset.jsonl', 'dataset.jsonl', 'Dataset', 16, false],
      ['share/pack-1', 'pack-1', 'Pack', null, true],
    ]);
    expect(job.lines.join('\n')).toContain('secret.txt is outside the project folder');
    expect(job.result).toEqual({ clean: true, calls: 30 });
  });

  it('runs in a folder of the project when its builder names one', async () => {
    mkdirSync(join(project, 'agents', 'triage'), { recursive: true });
    const view = await waitJob(dash, (await startJob(dash, { kind: 'fake', mode: 'cwd', cwd: 'agents/triage' })).id);
    expect(spawned.at(-1)!.options).toEqual({ events: true, cwd: join(project, 'agents', 'triage') });
    expect(view.lines).toEqual([`cwd ${join(project, 'agents', 'triage')}`]);
  });

  it('still finds the run in the output of a command that sends no events', async () => {
    const view = await waitJob(dash, (await startJob(dash, { kind: 'fake', mode: 'text-only' })).id);
    expect(view).toMatchObject({ code: 0, newRunId: '01K5CQ4P2V0000000000000000', runs: ['01K5CQ4P2V0000000000000000'], links: [], files: [], result: null });
  });

  it('downloads only files a job reported, from inside the project, as attachments, with the token', async () => {
    const file = job.files.find((f) => !f.directory)!;
    const res = await api(dash, `files/${file.fileId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="dataset.jsonl"');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"messages":[]}\n');
    // HEAD: the same headers, and no body.
    const head = await api(dash, `files/${file.fileId}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-disposition')).toBe('attachment; filename="dataset.jsonl"');
    expect(head.headers.get('content-length')).toBe('16');
    expect(await head.text()).toBe('');
    expect((await fetch(`${dash.url}/api/files/${file.fileId}`, { method: 'HEAD' })).status, 'HEAD needs the token too').toBe(401);
    expect((await fetch(`${dash.url}/api/files/${file.fileId}`)).status).toBe(401);
    expect((await api(dash, `files/${'0'.repeat(24)}`)).status).toBe(404);
    expect((await api(dash, 'files/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    const folder = job.files.find((f) => f.directory)!;
    expect((await api(dash, `files/${folder.fileId}`)).status).toBe(400);
    if (posix) {
      // Replaced by a link to something outside the project since the job reported it: not served.
      const path = join(project, '.shadowlap', 'exports', 'dataset.jsonl');
      unlinkSync(path);
      symlinkSync(join(outside, 'secret.txt'), path);
      const swapped = await api(dash, `files/${file.fileId}`);
      expect(swapped.status).toBe(404);
      expect(await swapped.text()).not.toContain('not for the browser');
    }
  });
});

describe('jobs', () => {
  it('are listed newest first, and their output is paged from any line', async () => {
    const view = await waitJob(dash, (await startJob(dash, { kind: 'fake', mode: 'lines', n: 5 })).id);
    expect(view.total).toBe(5);
    const page = (await (await api(dash, `jobs/${view.id}?after=3`)).json()) as JobView;
    expect(page.lines).toEqual(['line 4', 'line 5']);
    expect(page.total).toBe(5);
    const { jobs } = (await (await api(dash, 'jobs')).json()) as { jobs: Array<JobView & { lines?: unknown }> };
    expect(jobs[0].id).toBe(view.id);
    expect(jobs[0].lines).toBeUndefined();
    expect((await api(dash, 'jobs/0123456789abcdef')).status).toBe(404);
  });

  it('end with the command\'s exit code, and can be stopped', async () => {
    const failed = await waitJob(dash, (await startJob(dash, { kind: 'fake', mode: 'fail' })).id);
    expect(failed.code).toBe(3);
    expect(failed.lines).toContain('it went wrong');
    // It ended on its own: the drawer says how, not that someone stopped it.
    expect(failed.stopped).toBe(false);

    const sleeping = await startJob(dash, { kind: 'fake', mode: 'sleep' });
    expect(sleeping.stopped).toBe(false);
    expect(((await (await post(dash, `jobs/${sleeping.id}/stop`, {})).json()) as { stopped: boolean }).stopped).toBe(true);
    const stopped = await waitJob(dash, sleeping.id);
    expect(stopped.done).toBe(true);
    expect(stopped.lines).not.toContain('woke');
    // Its view says it was stopped, in the list of jobs too, whose chip and drawer read it.
    expect(stopped.stopped).toBe(true);
    const { jobs } = (await (await api(dash, 'jobs')).json()) as { jobs: JobView[] };
    expect(jobs.find((j) => j.id === sleeping.id)?.stopped).toBe(true);
    expect(((await (await post(dash, `jobs/${sleeping.id}/stop`, {})).json()) as { stopped: boolean }).stopped).toBe(false);
    expect((await post(dash, 'jobs/0123456789abcdef/stop', {})).status).toBe(404);
  });

  it.skipIf(!posix)('stop the agent too when it ignores SIGTERM, and end the run it left recording as interrupted', async () => {
    const run = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.js'], cwd: project } });
    const started = await startJob(dash, { kind: 'fake', mode: 'stubborn', runId: run.runId });
    const agentPid = Number((await waitLine(dash, started.id, /^agent (\d+)$/))[1]);
    agents.add(agentPid);
    expect(alive(agentPid)).toBe(true);
    expect((await api(dash, `runs/${run.runId}`, { method: 'DELETE' })).status, 'a recording run cannot be deleted').toBe(409);

    expect(((await (await post(dash, `jobs/${started.id}/stop`, {})).json()) as { stopped: boolean }).stopped).toBe(true);
    const stopped = await waitJob(dash, started.id);
    expect(stopped.lines).toEqual(expect.arrayContaining(['passing SIGTERM on', 'agent ignores SIGTERM']));
    expect(stopped.code, 'killed by a signal').toBeNull();
    expect(await gone(agentPid), 'the agent was killed with the CLI').toBe(true);
    agents.delete(agentPid);
    expect(store.getRun(run.runId)!.status).toBe('crashed');
    expect(stopped.lines.join('\n')).toContain(`run ${run.runId} was still recording`);
    const meta = (await (await api(dash, 'meta')).json()) as { live: unknown[] };
    expect(meta.live).toEqual([]);
    expect((await api(dash, `runs/${run.runId}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('leave alone a recording run that a job only named in its output', async () => {
    // The text fallback names a run, but only a run reported on fd 3 is the job's own to end.
    const named = store.createRun({ runId: '01K5CQ4P2V0000000000000000', mode: 'record', command: { argv: ['node', 'agent.js'], cwd: project } });
    try {
      const view = await waitJob(dash, (await startJob(dash, { kind: 'fake', mode: 'text-only' })).id);
      expect(view.runs).toEqual([named.runId]);
      expect(store.getRun(named.runId)!.status).toBe('running');
    } finally {
      store.endRun(named.runId, 'completed');
      store.deleteRun(named.runId);
    }
  });

  it.skipIf(!posix)('are stopped when the dashboard closes, agents and all', async () => {
    const run = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.js'], cwd: project } });
    const d = await startDashboard({ store, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: project }), project: { path: project }, jobStopGraceMs: 300, routes: [fakeKind] });
    const started = await startJob(d, { kind: 'fake', mode: 'stubborn', runId: run.runId });
    const agentPid = Number((await waitLine(d, started.id, /^agent (\d+)$/))[1]);
    agents.add(agentPid);
    await d.close();
    expect(await gone(agentPid)).toBe(true);
    agents.delete(agentPid);
    expect(store.getRun(run.runId)!.status).toBe('crashed');
  });

  it.skipIf(!posix)('are killed at once when the dashboard is closed again with now, without waiting out the grace time', async () => {
    const run = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.js'], cwd: project } });
    const d = await startDashboard({ store, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: project }), project: { path: project }, jobStopGraceMs: 60_000, routes: [fakeKind] });
    const started = await startJob(d, { kind: 'fake', mode: 'stubborn', runId: run.runId });
    const agentPid = Number((await waitLine(d, started.id, /^agent (\d+)$/))[1]);
    agents.add(agentPid);
    const closing = d.close();
    // The first close waits for the agent, which ignores the stop; a second one with now does not.
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(agentPid)).toBe(true);
    const t = Date.now();
    expect(d.close({ now: true })).toBe(closing);
    await closing;
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(await gone(agentPid)).toBe(true);
    agents.delete(agentPid);
    expect(store.getRun(run.runId)!.status).toBe('crashed');
  });
});

describe('uploads', () => {
  const uploadsDir = () => join(project, '.shadowlap', 'uploads');

  it('are stored for a job, readable by the owner only, and deleted when the job ends', async () => {
    const res = await upload(dash, 'hello upload', '../../rés umé.har');
    expect(res.status).toBe(201);
    const up = (await res.json()) as { uploadId: string; name: string; bytes: number };
    expect(up).toMatchObject({ name: 'res_ume.har', bytes: 12 });
    expect(up.uploadId).toMatch(/^[0-9A-Z]{26}$/);
    const path = join(uploadsDir(), `${up.uploadId}-res_ume.har`);
    expect(existsSync(path)).toBe(true);
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);

    const job = await waitJob(dash, (await startJob(dash, { kind: 'fake', mode: 'cat', uploadId: up.uploadId })).id);
    expect(job.title).toBe('Reading res_ume.har');
    expect(job.lines).toEqual(['hello upload']);
    expect(existsSync(path), 'deleted when its job ended').toBe(false);
    const again = await post(dash, 'jobs', { kind: 'fake', mode: 'cat', uploadId: up.uploadId });
    expect(again.status).toBe(404);
  });

  it('are named "upload" when the browser sends no name, or only one that sanitizes to nothing', async () => {
    for (const headers of [{}, { 'x-filename': encodeURIComponent('../../..') }]) {
      const res = await api(dash, 'uploads', { method: 'POST', body: 'nameless', headers: { 'content-type': 'application/octet-stream', ...headers } });
      expect(res.status).toBe(201);
      const up = (await res.json()) as { uploadId: string; name: string; bytes: number };
      expect(up).toMatchObject({ name: 'upload', bytes: 8 });
      expect(readFileSync(join(uploadsDir(), `${up.uploadId}-upload`), 'utf8')).toBe('nameless');
    }
  });

  it('have their own size limit, apart from the JSON limit, and leave nothing behind when refused', async () => {
    expect((await upload(dash, Buffer.alloc(4096, 1))).status).toBe(201);
    const declared = await upload(dash, Buffer.alloc(5000, 1));
    expect(declared.status).toBe(413);
    expect(((await declared.json()) as { error: string }).error).toMatch(/at most 4 KB/);
    // Without a declared length the limit holds as the bytes arrive.
    const u = new URL(dash.url);
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: '/api/uploads', method: 'POST', headers: { host: u.host, 'x-shadowlap-token': dash.token, 'x-filename': 'big.har', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', (err) => (err.message.includes('EPIPE') || err.message.includes('ECONNRESET') ? resolve(413) : reject(err)));
      for (let i = 0; i < 10; i++) req.write(Buffer.alloc(1000, 2));
      req.end();
    });
    expect(streamed).toBe(413);
    // The refused file goes once its write stream has closed, which can take a moment on a busy machine.
    const left = () => readdirSync(uploadsDir()).filter((n) => n.endsWith('big.har'));
    for (let i = 0; i < 200 && left().length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(left()).toEqual([]);
    // A JSON body past its own limit is refused too.
    expect((await api(dash, 'jobs', { method: 'POST', body: JSON.stringify({ kind: 'fake', pad: 'x'.repeat(300 * 1024) }) })).status).toBe(413);
  });

  it('are deleted after an hour unused, when the dashboard closes, and when an earlier one left them', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'sl-jobs-idle-')));
    // A file an earlier dashboard left two hours ago, and one it left just now.
    mkdirSync(join(other, '.shadowlap', 'uploads'), { recursive: true });
    const stale = join(other, '.shadowlap', 'uploads', `${ulid()}-old.har`);
    const recent = join(other, '.shadowlap', 'uploads', `${ulid()}-new.har`);
    writeFileSync(stale, 'x');
    writeFileSync(recent, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    const idle = await startDashboard({ store, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: other }), project: { path: other } });
    let kept: string;
    try {
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      const up = (await (await upload(idle, 'kept until close')).json()) as { uploadId: string; name: string };
      kept = join(other, '.shadowlap', 'uploads', `${up.uploadId}-${up.name}`);
      expect(existsSync(kept)).toBe(true);
    } finally {
      await idle.close();
    }
    expect(existsSync(kept), 'deleted when the dashboard closed').toBe(false);

    const quick = await startDashboard({ store, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: other }), project: { path: other }, uploadMaxIdleMs: 50 });
    try {
      const up = (await (await upload(quick, 'forgotten')).json()) as { uploadId: string; name: string };
      const path = join(other, '.shadowlap', 'uploads', `${up.uploadId}-${up.name}`);
      expect(existsSync(path)).toBe(true);
      for (let i = 0; i < 200 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 25));
      expect(existsSync(path), 'swept once unused for the idle time').toBe(false);
    } finally {
      await quick.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix)('refuse a planted .shadowlap or uploads folder that leads elsewhere, and make nothing there', async () => {
    for (const planted of ['.shadowlap', join('.shadowlap', 'uploads')]) {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sl-jobs-planted-')));
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'sl-jobs-elsewhere-')));
      if (planted !== '.shadowlap') mkdirSync(join(repo, '.shadowlap'));
      symlinkSync(elsewhere, join(repo, planted));
      const d = await startDashboard({ store, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: repo }), project: { path: repo } });
      try {
        const res = await upload(d, 'payload');
        expect(res.status, planted).toBe(500);
        expect(((await res.json()) as { error: string }).error).toMatch(/is not a folder/);
        expect(readdirSync(elsewhere), planted).toEqual([]);
      } finally {
        await d.close();
        rmSync(repo, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
      }
    }
  });

  it('keep a .shadowlap folder they make out of git', async () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'sl-jobs-fresh-')));
    const d = await startDashboard({ store, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: fresh }), project: { path: fresh } });
    try {
      expect((await upload(d, 'x')).status).toBe(201);
      expect(readFileSync(join(fresh, '.shadowlap', '.gitignore'), 'utf8')).toBe('*\n');
    } finally {
      await d.close();
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('need a project folder', async () => {
    const bare = await startDashboard({ store, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: tmpdir() }) });
    try {
      const res = await upload(bare, 'x');
      expect(res.status).toBe(501);
      expect(((await res.json()) as { error: string }).error).toMatch(/project folder/);
    } finally {
      await bare.close();
    }
  });
});

describe('a job’s estimate', () => {
  it('is what the page showed as it started it, kept and shown as it was, and never part of what runs', async () => {
    const shown = { usd: 0.027, ceiling: false, per: 'attempt', stops: 2, parts: ['live from #17'], always: 'it acts on your systems' };
    const job = await startJob(dash, { kind: 'fake', mode: 'text-only', estimate: shown });
    const kept = { usd: 0.027, ceiling: false, per: 'attempt', stops: 2 };
    expect(job.estimate).toEqual(kept);
    expect(JSON.stringify(job.args)).not.toMatch(/0\.027|estimate/);
    expect((await waitJob(dash, job.id)).estimate).toEqual(kept);
    const listed = ((await (await api(dash, 'jobs')).json()) as { jobs: JobView[] }).jobs.find((j) => j.id === job.id);
    expect(listed?.estimate).toEqual(kept);
    // None: a ceiling with no price yet is one, and an estimate in another shape is none, the job started all the same.
    expect((await startJob(dash, { kind: 'fake', mode: 'text-only', estimate: { usd: null, ceiling: true } })).estimate).toEqual({ usd: null, ceiling: true });
    for (const junk of [null, 'cheap', { usd: -1, ceiling: false }, { usd: '1', ceiling: true }, { usd: 1 }, { usd: 1, ceiling: 'no' }, { usd: 1, ceiling: false, per: 'x'.repeat(41) }, { usd: 1, ceiling: false, stops: -2 }]) {
      const started = await startJob(dash, { kind: 'fake', mode: 'text-only', estimate: junk });
      expect(started.estimate, JSON.stringify(junk)).toBeUndefined();
    }
  });
});
