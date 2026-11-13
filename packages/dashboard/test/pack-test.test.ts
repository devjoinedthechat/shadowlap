import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packRun, readConfigFile, Store } from '@shadowlap/engine';
import type { RouteContext } from '../src/context.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import type { JobBuild, JobBuildContext, JobRequest } from '../src/jobs.js';
import { configPrints } from '../src/config-tests.js';
import { packTestKind } from '../src/pack-test.js';
import { addRun } from './read-model-store.js';

/**
 * Pack as golden… on a run's page: any run packed as a golden, then its test, as one job, on every
 * dashboard with a project folder (`shadowlap ui` in one too), the folder checked by the engine's
 * rule, nothing written to the config, a test its golden's tests entry runs live asked about first,
 * as Run tests asks, and a recording from elsewhere asked about before its test runs the command it
 * was recorded with: one question where both apply.
 */

const T0 = 1_790_100_000_000;

let project: string;
let store: Store;
let jobs: Array<{ kind: string; done: boolean; project?: { id: string } }> = [];

const ctx = { jobs: { list: () => jobs } } as unknown as RouteContext;
const kind = packTestKind(ctx, null);
const place = (over: Partial<JobBuildContext> = {}): JobBuildContext => ({ store, project: { name: 'demo', path: project }, projectId: null, upload: () => null, ...over });
const build = (req: JobRequest, over: Partial<JobBuildContext> = {}) => kind.build(req, place(over));

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-pack-test-')));
  store = Store.open(':memory:');
});
afterAll(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

describe('pack-test for a run the request names', () => {
  it('packs a run no setup recorded, then tests it, as Pack as golden… says', async () => {
    const id = addRun(store, { startedAt: T0, calls: 'll' });
    expect(await build({ runId: id.slice(0, 10), golden: 'goldens/refund-flow' })).toEqual({ args: ['pack', id, 'goldens/refund-flow'], then: [['test', 'goldens/refund-flow']], runId: id, title: 'Packing as golden' });
    // A bare name goes under goldens/, as the setup's does.
    expect(await build({ runId: id, golden: 'refund-flow' })).toMatchObject({ args: ['pack', id, 'goldens/refund-flow'] });
  });

  it('refuses a run still recording, an unknown one, and a dashboard with no project folder', async () => {
    const live = addRun(store, { startedAt: Date.now(), calls: 'l', status: 'running' });
    expect(await build({ runId: live, golden: 'goldens/live' })).toEqual({ error: `${live.slice(0, 10)} is still recording: copy it once it has ended`, status: 409 });
    // Marked running by a recorder that left long ago: it was interrupted, and is packed as it is.
    const left = '01K4ZZ0000000000LEFT000000';
    store.importRun({ runId: left, parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: project }, codeVersion: null, startedAt: T0 + 10, endedAt: null });
    expect(await build({ runId: left, golden: 'goldens/left' })).toMatchObject({ args: ['pack', left, 'goldens/left'] });
    expect(await build({ runId: 'ZZZZZZ', golden: 'goldens/x' })).toEqual({ error: 'no run ZZZZZZ', status: 404 });
    expect(await build({ runId: '', golden: 'goldens/x' })).toMatchObject({ error: 'runId is required', status: 400 });
    expect(await build({ runId: left, golden: 'goldens/x' }, { project: null })).toMatchObject({ status: 501 });
  });

  it('checks the folder by the engine’s rule: a bad one 400, a golden of another run 409', async () => {
    const id = addRun(store, { startedAt: T0 + 20, calls: 'll' });
    expect(await build({ runId: id, golden: '../outside' })).toEqual({ error: 'The golden goes inside the project: no empty, . or .. parts.', status: 400 });
    expect(await build({ runId: id, golden: '' })).toEqual({ error: 'Give the golden a folder, such as goldens/first-run.', status: 400 });
    const other = addRun(store, { startedAt: T0 + 30, calls: 'll' });
    packRun(store, other, join(project, 'goldens', 'taken'));
    expect(await build({ runId: id, golden: 'goldens/taken' })).toEqual({ error: 'goldens/taken already holds a golden. Give this one another name: Shadowlap never packs over a golden.', status: 409 });
    mkdirSync(join(project, 'goldens', 'notes'), { recursive: true });
    writeFileSync(join(project, 'goldens', 'notes', 'todo.txt'), 'x');
    expect(await build({ runId: id, golden: 'goldens/notes' })).toMatchObject({ status: 409, error: 'goldens/notes isn’t empty. Give the golden a folder of its own.' });
  });

  it('tests a golden that holds the run already, without packing it again', async () => {
    const id = addRun(store, { startedAt: T0 + 40, calls: 'll' });
    packRun(store, id, join(project, 'goldens', 'kept'));
    expect(await build({ runId: id, golden: 'goldens/kept' })).toEqual({ args: ['test', 'goldens/kept'], runId: id, title: 'Testing the golden' });
  });

  it('waits while a Tests job holds the goldens', async () => {
    const id = addRun(store, { startedAt: T0 + 50, calls: 'll' });
    jobs = [{ kind: 'test', done: false }];
    try {
      expect(await build({ runId: id, golden: 'goldens/busy' })).toEqual({ error: 'A test session is running: pack it once it is done', status: 409 });
      // One in another project holds nothing up here.
      expect(await build({ runId: id, golden: 'goldens/busy' }, { projectId: 'other' })).toMatchObject({ args: ['pack', id, 'goldens/busy'] });
    } finally {
      jobs = [];
    }
  });

  it('asks before the test runs a command from elsewhere, and passes the test --yes once said yes to', async () => {
    const id = addRun(store, { startedAt: T0 + 60, calls: 'll', argv: ['node', 'their-agent.mjs'], meta: { commandFromImport: true } });
    const asked = (await build({ runId: id, golden: 'goldens/sent' })) as { error: string; status: number; confirm: string };
    expect(asked).toMatchObject({ status: 409, confirm: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(asked.error).toBe(`${id.slice(0, 10)} came from an imported pack: its test runs the command it was recorded with (node their-agent.mjs), under shadowlap test goldens/sent. Confirm it to run it`);
    expect(await build({ runId: id, golden: 'goldens/sent', yes: true })).toMatchObject({ status: 409 });
    expect(await build({ runId: id, golden: 'goldens/sent', yes: asked.confirm })).toEqual({ args: ['pack', id, 'goldens/sent'], then: [['test', 'goldens/sent', '--yes']], runId: id, title: 'Packing as golden' });
    // A run this machine recorded asks nothing, whatever the request sent.
    const mine = addRun(store, { startedAt: T0 + 70, calls: 'll' });
    expect(await build({ runId: mine, golden: 'goldens/mine', yes: asked.confirm })).toMatchObject({ then: [['test', 'goldens/mine']] });
  });

  describe('where the golden’s tests entry runs its test live', () => {
    let forks: string;
    const LIVE = 'goldens/x is marked fork, so it runs live from where it forks, writes blocked. Live calls are billed by your provider.';
    beforeAll(() => {
      forks = realpathSync(mkdtempSync(join(tmpdir(), 'sl-pack-test-live-')));
      writeFileSync(join(forks, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/*': { fork: true } } }));
    });
    afterAll(() => rmSync(forks, { recursive: true, force: true }));
    const live = (req: JobRequest) => build(req, { project: { name: 'forks', path: forks } });

    it('asks first, as Run tests does, and packs and tests it on the yes', async () => {
      const id = addRun(store, { startedAt: T0 + 90, calls: 'll' });
      const asked = (await live({ runId: id, golden: 'goldens/x' })) as { error: string; status: number; confirm: string; live: unknown };
      expect(asked).toMatchObject({ status: 409, error: `${LIVE} Confirm it to run it`, live: [{ path: 'goldens/x', why: [{ kind: 'fork' }] }] });
      expect(await live({ runId: id, golden: 'goldens/x', yes: asked.confirm })).toEqual({ args: ['pack', id, 'goldens/x'], then: [['test', 'goldens/x']], runId: id, title: 'Packing as golden' });
    });

    it('asks one question for a recording from elsewhere, naming its command and what runs live, and a yes to it runs both', async () => {
      const id = addRun(store, { startedAt: T0 + 100, calls: 'll', argv: ['node', 'their-agent.mjs'], meta: { commandFromImport: true } });
      const asked = (await live({ runId: id, golden: 'goldens/x' })) as { error: string; status: number; confirm: string; live: unknown };
      expect(asked).toMatchObject({ status: 409, live: [{ path: 'goldens/x', why: [{ kind: 'fork' }] }] });
      expect(asked.error).toBe(`${id.slice(0, 10)} came from an imported pack: its test runs the command it was recorded with (node their-agent.mjs), under shadowlap test goldens/x. ${LIVE} Confirm it to run it`);
      expect(await live({ runId: id, golden: 'goldens/x', yes: asked.confirm })).toEqual({ args: ['pack', id, 'goldens/x'], then: [['test', 'goldens/x', '--yes']], runId: id, title: 'Packing as golden' });
    });
  });
});

describe('pack-test on a dashboard that serves one store', () => {
  let dash: Dashboard;
  let bare: Dashboard;
  let id: string;
  const api = (d: Dashboard, path: string, body?: unknown) => fetch(`${d.url}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-shadowlap-token': d.token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

  beforeAll(async () => {
    id = addRun(store, { startedAt: T0 + 80, calls: 'll' });
    dash = await startDashboard({ store, version: '0.1.0', dbPath: ':memory:', project: { path: project }, spawnCli: () => { throw new Error('nothing runs in this test'); } });
    bare = await startDashboard({ store, version: '0.1.0', dbPath: ':memory:', spawnCli: () => { throw new Error('nothing runs in this test'); } });
  });
  afterAll(async () => {
    await dash.close();
    await bare.close();
  });

  it('registers it beside the project folder, so Pack as golden… works in shadowlap ui too', async () => {
    const meta = (await (await api(dash, 'meta')).json()) as { jobKinds: string[] };
    expect(meta.jobKinds).toContain('pack-test');
    const refused = await api(dash, 'jobs', { kind: 'pack-test', runId: id, golden: '../outside' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'The golden goes inside the project: no empty, . or .. parts.' });
    // With no folder there is nowhere to pack into.
    expect((await api(bare, 'jobs', { kind: 'pack-test', runId: id, golden: 'goldens/x' })).status).toBe(501);
  });
});

describe('Pack with injection gate…: pack-test with a gate', () => {
  let folder: string;
  const gated = packTestKind({ jobs: { list: () => [] }, get store() { return store; } } as unknown as RouteContext, null);
  const configPath = () => join(folder, 'shadowlap.config.json');
  const fileVersion = () => readConfigFile(folder).version;
  const author = process.env.SHADOWLAP_AUTHOR;
  beforeAll(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'sl-pack-gate-')));
    process.env.SHADOWLAP_AUTHOR = 'dana@example.com';
  });
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
    if (author === undefined) delete process.env.SHADOWLAP_AUTHOR;
    else process.env.SHADOWLAP_AUTHOR = author;
  });
  const buildGate = (req: JobRequest) => gated.build(req, place({ project: { name: 'gated', path: folder } }));
  const stepOf = async (req: JobRequest) => {
    const built = (await buildGate(req)) as JobBuild;
    return { built, done: await built.step!.run() };
  };

  it('packs, writes the gate once it is packed, then tests: the gate the dialog picked, against the version read', async () => {
    writeFileSync(configPath(), JSON.stringify({ clock: 'exact', tests: { 'goldens/other': { fork: true } } }));
    const id = addRun(store, { startedAt: T0 + 200, calls: 'll' });
    const { built, done } = await stepOf({ runId: id, golden: 'goldens/gated', gate: { obeyed: 0, repeat: 3 }, version: fileVersion() });
    expect(built).toMatchObject({ args: ['pack', id, 'goldens/gated'], then: [['test', 'goldens/gated']], runId: id, title: 'Packing with injection gate', step: { before: 1 } });
    expect(done).toEqual({ lines: ['  added to shadowlap.config.json, under "tests": "goldens/gated": { "injection": { "obeyed": 0, "repeat": 3 } }'] });
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ clock: 'exact', tests: { 'goldens/other': { fork: true }, 'goldens/gated': { injection: { obeyed: 0, repeat: 3 } } } });
    expect(store.listEvents({ kinds: ['checks.changed'] })[0]).toMatchObject({ ref: 'goldens/gated', actor: 'dana@example.com', data: { gate: { obeyed: 0, repeat: 3 } } });
    // Templates only when not all of them.
    const some = await stepOf({ runId: id, golden: 'goldens/some', gate: { obeyed: 0, repeat: 2, templates: ['system-notice', 'user-urgent'] }, version: fileVersion() });
    expect(some.done.lines[0]).toBe('  added to shadowlap.config.json, under "tests": "goldens/some": { "injection": { "obeyed": 0, "repeat": 2, "templates": ["system-notice","user-urgent"] } }');
  });

  it('writes first, before the test alone, when the folder holds this run’s pack already', async () => {
    const id = addRun(store, { startedAt: T0 + 210, calls: 'll' });
    packRun(store, id, join(folder, 'goldens', 'held'));
    const { built } = await stepOf({ runId: id, golden: 'goldens/held', gate: { obeyed: 0, repeat: 3 }, version: fileVersion() });
    expect(built).toMatchObject({ args: ['test', 'goldens/held'], title: 'Packing with injection gate', step: { before: 0 } });
  });

  it('ends at the write when the file changed since the page read it, naming what changed, and tests nothing', async () => {
    writeFileSync(configPath(), JSON.stringify({ tests: {} }));
    const read = configPrints(readConfigFile(folder).data);
    const was = fileVersion();
    writeFileSync(configPath(), JSON.stringify({ tests: {}, prices: { 'my-model': { input: 1, output: 2 } } }));
    const id = addRun(store, { startedAt: T0 + 220, calls: 'll' });
    const { done } = await stepOf({ runId: id, golden: 'goldens/late', gate: { obeyed: 0, repeat: 3 }, version: was, read });
    expect(done.code).toBe(1);
    expect(done.lines).toEqual([expect.stringMatching(/^goldens\/late is packed without its gate: shadowlap\.config\.json changed on disk since this page read it: "prices" added$/)]);
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).not.toHaveProperty('tests.goldens/late');
  });

  it('refuses a gate the config would refuse, and one with no version, before anything runs', async () => {
    const id = addRun(store, { startedAt: T0 + 230, calls: 'll' });
    const error = async (req: JobRequest) => (await buildGate({ runId: id, golden: 'goldens/bad', version: fileVersion(), ...req })) as { error: string };
    expect((await error({ gate: { obeyed: 0, repeat: 0 } })).error).toBe('gate.repeat must be a whole number from 1 to 100');
    expect((await error({ gate: { obeyed: 1, repeat: 3 } })).error).toMatch(/^gate is \{ "obeyed": 0/);
    expect((await error({ gate: { obeyed: 0, repeat: 3, templates: ['nosuch'] } })).error).toMatch(/nosuch/);
    expect((await error({ gate: { obeyed: 0, repeat: 3 }, version: 'x' })).error).toBe('version is the version of shadowlap.config.json the page read: open the dialog again and try again');
  });
});
