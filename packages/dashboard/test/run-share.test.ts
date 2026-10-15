import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store, type Normalizer } from '@shadowlap/engine';
import { lineage } from '../src/api.js';
import { cliSpawner, runDetail, showRunJson, startDashboard, type Dashboard, type JobView } from '../src/index.js';
import { collectorUrl, copyRules, exportDatasetJob, exportHarJob, exportHtmlJob, exportOtelJob, insideProject, packFolder, packJob, traceFile } from '../src/run-exports.js';
import { blameOffer, goldenExpect, runOffers } from '../src/run-offers.js';
import { addRun, blameOf } from './read-model-store.js';
import { RunBuilder } from '../../engine/test/run-fixtures.js';

/**
 * The run page's Share menu and what it offers: the export jobs (each builds its command from checked
 * fields and writes into the project folder), how many redaction rules each copy applies, whether a
 * run is only on this machine, the check Run blame would use, and the Forks view's marks.
 */

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const T0 = 1_790_000_000_000;

let project: string;
let outside: string;
let store: Store;

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-share-project-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'sl-share-outside-')));
  store = Store.open(':memory:');
});
afterAll(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const proj = () => ({ name: 'demo', path: project });

describe('the Share menu’s jobs', () => {
  it('writes HTML and HAR into .shadowlap/exports, with the runs it came from in the HTML', () => {
    const id = addRun(store, { startedAt: T0, calls: 'll' });
    const html = exportHtmlJob(store, proj(), { runId: id.slice(0, 10) });
    expect(html).toEqual({ args: ['export', 'html', id, `.shadowlap/exports/shadowlap-${id.slice(0, 10).toLowerCase()}.html`, '--lineage'], runId: id, title: 'Exporting HTML' });
    expect(exportHarJob(store, proj(), { runId: id })).toEqual({ args: ['export', 'har', id, `.shadowlap/exports/${id.slice(0, 10).toLowerCase()}.har`], runId: id, title: 'Exporting HAR' });
    // The folder is there for the CLI to write into.
    expect(() => readFileSync(join(project, '.shadowlap', 'exports'))).toThrow(/EISDIR/);
    expect(exportHtmlJob(store, proj(), {})).toMatchObject({ error: 'runId is required' });
    expect(exportHtmlJob(store, proj(), { runId: 'ZZZZZZ' })).toMatchObject({ error: 'no run ZZZZZZ', status: 404 });
    expect(exportHtmlJob(store, null, { runId: id })).toMatchObject({ status: 501 });
  });

  it('packs into a folder inside the project, never outside it or into the store’s own folder', () => {
    const id = addRun(store, { startedAt: T0 + 1, calls: 'l' });
    const low = id.slice(0, 10).toLowerCase();
    expect(packJob(store, proj(), { runId: id })).toEqual({ args: ['pack', id, `./.shadowlap/exports/${low}`], runId: id, title: 'Packing' });
    expect(packJob(store, proj(), { runId: id, dir: 'goldens/refund' })).toMatchObject({ args: ['pack', id, './goldens/refund'] });
    // A folder that reads like an option is still a folder.
    expect(packJob(store, proj(), { runId: id, dir: '--no-redact' })).toMatchObject({ args: ['pack', id, './--no-redact'] });
    for (const dir of ['../elsewhere', '/tmp/x', 'share/../../x', '.shadowlap', '.shadowlap/blobs', '', '  ', 7]) expect(packJob(store, proj(), { runId: id, dir })).toHaveProperty('error');
    // A folder that is a link out of the project.
    symlinkSync(outside, join(project, 'escape'));
    expect(packFolder(project, 'escape/pack')).toHaveProperty('error');
    expect(insideProject(project, 'escape')).toBe(false);
    expect(insideProject(project, 'share/new/deeper')).toBe(true);
  });

  it('exports a dataset of one run or many, in a format and with the examples asked for', () => {
    const a = addRun(store, { startedAt: T0 + 2, calls: 'l' });
    const b = addRun(store, { startedAt: T0 + 3, calls: 'l' });
    expect(exportDatasetJob(store, proj(), { runIds: [a], format: 'braintrust', calls: 'model' })).toEqual({
      args: ['export', 'dataset', a, '--calls', 'model', '--format', 'braintrust', '--out', `.shadowlap/exports/dataset-${a.slice(0, 10).toLowerCase()}.jsonl`],
      runId: a,
      title: 'Exporting a dataset',
    });
    const both = exportDatasetJob(store, proj(), { runIds: [a, b, a.slice(0, 12)] }, new Date('2026-10-15T09:41:07Z'));
    expect(both).toMatchObject({ args: ['export', 'dataset', a, b, '--calls', 'final', '--format', 'jsonl', '--out', '.shadowlap/exports/dataset-2-runs-20261015-094107.jsonl'], runId: null });
    expect(exportDatasetJob(store, proj(), { runIds: [a], format: 'csv' })).toHaveProperty('error');
    expect(exportDatasetJob(store, proj(), { runIds: [a], calls: 'all' })).toHaveProperty('error');
    expect(exportDatasetJob(store, proj(), { runIds: ['--all'] })).toHaveProperty('error');
    expect(exportDatasetJob(store, proj(), { runIds: [] })).toHaveProperty('error');
  });

  it('sends a trace to a collector, or writes it into .shadowlap/exports', () => {
    const id = addRun(store, { startedAt: T0 + 4, calls: 'l' });
    expect(exportOtelJob(store, proj(), { runId: id, endpoint: 'http://localhost:4318/' })).toEqual({ args: ['export', 'otel', id, '--endpoint', 'http://localhost:4318'], runId: id, title: 'Sending a trace' });
    expect(exportOtelJob(store, proj(), { runId: id, out: 'trace.json' })).toMatchObject({ args: ['export', 'otel', id, '--out', '.shadowlap/exports/trace.json'] });
    expect(exportOtelJob(store, proj(), { runId: id })).toMatchObject({ args: ['export', 'otel', id, '--out', `.shadowlap/exports/${id.slice(0, 10).toLowerCase()}.otel.json`] });
    // Only the file's name is kept: it lands in the exports folder whatever path was typed.
    expect(traceFile('../../etc/trace.json', id)).toBe('trace.json');
    expect(traceFile('-x', id)).toBeNull();
    expect(collectorUrl('file:///etc/passwd')).toBeNull();
    expect(collectorUrl('--endpoint')).toBeNull();
    expect(exportOtelJob(store, proj(), { runId: id, endpoint: 'ftp://x' })).toHaveProperty('error');
  });

  it('counts the redaction rules each copy applies (decision 6)', () => {
    const rules: Normalizer[] = [{ pattern: 'email', replace: '<email>' }, { path: '$.metadata.user_id', replace: '<user>' }, { pattern: 'uuid', replace: '<id>', kind: 'api' }];
    const c = copyRules(rules);
    expect(c).toMatchObject({ total: 3, pathless: 2 });
    expect(Object.fromEntries(c.formats.map((f) => [f.id, [f.applies, f.rules]]))).toEqual({ html: ['all', 3], pack: ['all', 3], dataset: ['messages', 3], otel: ['attributes', 2], har: ['all', 3] });
    expect(copyRules([]).formats.every((f) => f.rules === 0)).toBe(true);
  });
});

describe('what the run page offers', () => {
  it('says whether a run is only on this machine, queued, or in the team store', () => {
    const local = addRun(store, { startedAt: T0 + 10, calls: 'l' });
    const pushed = addRun(store, { startedAt: T0 + 11, calls: 'l' });
    const queued = addRun(store, { startedAt: T0 + 12, calls: 'l' });
    const fromPr = addRun(store, { startedAt: T0 + 13, calls: 'l', meta: { imported: { at: T0, from: 'store', pr: '138' } } });
    const live = addRun(store, { startedAt: T0 + 14, calls: 'l', status: 'running' });
    const url = 's3://northwind-agent-runs/support-agent';
    store.setTeamRun(url, { runId: pushed, state: 'pushed', at: T0, base: null, baseHash: null, remoteHash: 'h1', entry: null });
    store.setTeamRun(url, { runId: queued, state: 'queued', at: T0, base: null, baseHash: null, remoteHash: null, entry: null });
    const team = (id: string) => runOffers(store, id, { redact: [], config: { store: url } })!.team;
    expect(team(local)).toEqual({ store: 'northwind-agent-runs/support-agent', state: 'only-here' });
    expect(team(pushed)!.state).toBe('in-store');
    expect(team(queued)!.state).toBe('queued');
    expect(team(fromPr)!.state).toBe('pull-request');
    expect(team(live)!.state).toBe('recording');
    expect(runOffers(store, local, { redact: [], config: null })!.team).toBeNull();
    expect(runOffers(store, local, { redact: [], config: { store: 'not a url' } })!.team).toBeNull();
    expect(runOffers(store, 'ZZZZZZZZ', { redact: [], config: null })).toBeNull();
  });

  it('gives Run blame the check the run failed: its own --expect, its golden’s, or asks', () => {
    const own = addRun(store, { startedAt: T0 + 20, calls: 'l', meta: { expect: { tools: { send_email: 0 } }, checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }] } });
    expect(blameOffer(store, store.getRun(own)!, null)).toEqual({ from: 'run', expect: { tools: { send_email: 0 } }, failed: ['send_email called 0 times'] });
    const tested = addRun(store, { startedAt: T0 + 21, calls: 'l', meta: { test: { golden: 'goldens/research', session: 's1' }, checks: [{ ok: false, label: 'send_email called 1 time', detail: 'called 0 times' }] } });
    const tests = { 'goldens/*': { expect: { tools: { send_email: 1 } } } };
    expect(blameOffer(store, store.getRun(tested)!, tests)).toMatchObject({ from: 'golden', expect: { tools: { send_email: 1 } } });
    expect(goldenExpect({ 'goldens/research': { expect: { modelCalls: '<= 3' } }, 'goldens/*': { expect: {} } }, './goldens/research/')).toEqual({ modelCalls: '<= 3' });
    expect(goldenExpect(tests, 'other/research')).toBeUndefined();
    // A check nothing names: the page asks for it.
    const unknown = addRun(store, { startedAt: T0 + 22, calls: 'l', meta: { checks: [{ ok: false, label: 'at most 3 model calls', detail: '5' }] } });
    expect(blameOffer(store, store.getRun(unknown)!, null)).toEqual({ from: 'ask', failed: ['at most 3 model calls'] });
    // An agent that exited with an error: blame on the exit status alone.
    const crashed = addRun(store, { startedAt: T0 + 23, calls: 'l', status: 'failed' });
    expect(blameOffer(store, store.getRun(crashed)!, null)).toEqual({ from: 'exit', expect: null, failed: [] });
    // Nothing to blame: it passed, it was blamed, it is a capture, a probe, or still recording.
    const passed = addRun(store, { startedAt: T0 + 24, calls: 'l', meta: { checks: [{ ok: true, label: 'x', detail: null }] } });
    const blamed = addRun(store, { startedAt: T0 + 25, calls: 'l', status: 'failed', meta: { blame: blameOf(1, null, T0) } });
    const cap = addRun(store, { startedAt: T0 + 26, argv: [NO_COMMAND], status: 'failed', calls: 'l' });
    const probe = addRun(store, { startedAt: T0 + 27, calls: 'l', status: 'failed', meta: { probe: { of: blamed, callNo: 1, passed: false } } });
    for (const id of [passed, blamed, cap, probe]) expect(blameOffer(store, store.getRun(id)!, null)).toBeNull();
  });

  it('offers Find the commit and the diverged test’s actions, from the tests read model', () => {
    const id = addRun(store, { startedAt: T0 + 30, calls: 'l' });
    const o = runOffers(store, id, { redact: [{ pattern: 'email', replace: '<e>' }], config: null })!;
    expect(o.copies.total).toBe(1);
    expect(o.bisect).toMatchObject({ target: { kind: 'run', runId: id }, failed: false });
    expect(o.test).toBeNull();
  });
});

describe('the Forks view’s marks and the Calls view’s values', () => {
  it('marks blame probes and verify attempts, and where the blamed run was lost', () => {
    const failing = addRun(store, { startedAt: T0 + 40, calls: 'llll', meta: { blame: blameOf(3, null, T0) } });
    const probe = addRun(store, { startedAt: T0 + 41, parent: failing, divergence: 3, calls: 'rrll', meta: { repeat: { group: 'g1', attempt: 1, of: 2 }, probe: { of: failing, callNo: 3, passed: true } } });
    const verify = addRun(store, { startedAt: T0 + 42, parent: failing, calls: 'rrrr', meta: { verify: { role: 'target', passed: false } } });
    const nodes = lineage(store, failing)!;
    const at = (id: string) => nodes.find((n) => n.runId === id)!;
    expect(at(failing)).toMatchObject({ blamedAt: 3, probe: null, verify: null });
    expect(at(probe)).toMatchObject({ probe: { of: failing, callNo: 3, passed: true }, blamedAt: null });
    expect(at(verify)).toMatchObject({ verify: { role: 'target', passed: false } });
  });

  it('shows a clock read’s and a random value’s value beside the call', () => {
    const b = RunBuilder.start(store, { startedAt: T0 + 50 });
    const id = b.run.runId;
    for (const [kind, value] of [['clock', 1_792_094_173_884], ['random', '7f3c2a1e-9b4d-4c61-a0e2-5d8f1b6c3e90']] as const) {
      const callNo = ++b.callNo;
      const identity = { kind, name: kind === 'clock' ? 'now' : 'uuid', fingerprint: `fp-${callNo}`, occurrence: 1 };
      store.appendCallStart({ runId: id, callNo, ...identity, origin: 'live', effect: null, requestRef: store.putJson({ label: 'start' }), meta: {}, at: T0 + 50 + callNo });
      store.appendCallEnd(identity, { runId: id, callNo, attempt: 0, responseRef: store.putJson({ result: value }), outcome: 'ok', meta: {}, at: T0 + 51 + callNo });
    }
    b.end();
    expect(runDetail(store, id)!.calls.map((c) => c.resultShort)).toEqual(['1792094173884', '"7f3c2a1e-9b4d-4c61-a0e2-5d8f1b6c3e90"']);
  });
});

describe('the run page’s routes', () => {
  let dash: Dashboard;
  let projectDir: string;
  let id: string;
  const spawned: string[][] = [];
  const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  async function waitJob(jobId: string): Promise<JobView> {
    for (let i = 0; i < 200; i++) {
      const view = (await (await api(`jobs/${jobId}`)).json()) as JobView;
      if (view.done) return view;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`job ${jobId} did not finish`);
  }

  beforeAll(async () => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'sl-share-routes-')));
    writeFileSync(join(projectDir, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<email>' }, { path: '$.metadata.user_id', replace: '<user>' }], store: 's3://bucket/team' }));
    id = addRun(store, { startedAt: T0 + 60, calls: 'll' });
    const spawner = cliSpawner({ command: [process.execPath, FAKE], cwd: projectDir });
    dash = await startDashboard({
      store,
      version: '0.1.0',
      dbPath: ':memory:',
      project: { path: projectDir },
      loadConfig: () => ({ normalize: [], redact: JSON.parse(readFileSync(join(projectDir, 'shadowlap.config.json'), 'utf8')).redact as Normalizer[] }),
      spawnCli: (args, options) => {
        spawned.push(args);
        return spawner(args, options);
      },
    });
  });
  afterAll(async () => {
    await dash.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('lists the export kinds, and answers what the page offers for a run', async () => {
    const meta = (await (await api('meta')).json()) as { jobKinds: string[] };
    expect(meta.jobKinds).toEqual(expect.arrayContaining(['export-html', 'pack', 'export-dataset', 'export-otel', 'export-har']));
    const res = await api(`runs/${id.slice(0, 10)}/offers`);
    expect(res.status).toBe(200);
    const o = (await res.json()) as { runId: string; copies: { total: number; formats: Array<{ id: string; rules: number }> }; team: unknown };
    expect(o.runId).toBe(id);
    expect(o.copies.total).toBe(2);
    expect(o.copies.formats.find((f) => f.id === 'otel')!.rules).toBe(1);
    expect(o.team).toEqual({ store: 'bucket/team', state: 'only-here' });
    expect((await api('runs/ZZZZZZZZZZ/offers')).status).toBe(404);
  });

  it('serves show --json as the CLI prints it', async () => {
    const res = await api(`runs/${id}/show`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(showRunJson(store, id))));
    expect((await api('runs/ZZZZZZZZZZ/show')).status).toBe(404);
  });

  it('builds each export on the server and refuses what the browser should not decide', async () => {
    const start = (body: unknown) => api('jobs', { method: 'POST', body: JSON.stringify(body) });
    const html = await start({ kind: 'export-html', runId: id, args: ['rm', id] });
    expect(html.status).toBe(202);
    await waitJob(((await html.json()) as JobView).id);
    expect(spawned.at(-1)).toEqual(['export', 'html', id, `.shadowlap/exports/shadowlap-${id.slice(0, 10).toLowerCase()}.html`, '--lineage']);
    const bad = await start({ kind: 'pack', runId: id, dir: '../../outside' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/inside the project/);
    const otel = await start({ kind: 'export-otel', runId: id, endpoint: 'javascript:alert(1)' });
    expect(otel.status).toBe(400);
  });
});
