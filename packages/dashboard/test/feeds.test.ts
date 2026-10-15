import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEvent, Store, ulid } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type ActivityPage, type ChangesView, type Dashboard, type MetaView, type RouteModule } from '../src/index.js';
import { liveRuns } from '../src/meta.js';

/** What the shell polls and shows around every page: meta, the change feed, the activity feed, and read-only refusals. */
const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

let project: string;
let dbPath: string;
let store: Store;
let dash: Dashboard;
let recId: string;
let liveId: string;

const api = (d: Dashboard, path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
const get = async <T>(d: Dashboard, path: string): Promise<T> => (await (await api(d, path)).json()) as T;

function call(runId: string, callNo: number): void {
  const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `${runId}${callNo}`.padEnd(64, '0'), occurrence: 1 };
  store.appendCallStart({ runId, callNo, ...id, origin: 'live', effect: null, requestRef: null, meta: {}, at: Date.now() });
  store.appendCallEnd(id, { runId, callNo, attempt: 0, responseRef: null, outcome: 'ok', meta: {}, at: Date.now() });
}

beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-feeds-')));
  dbPath = join(project, '.shadowlap', 'shadowlap.db');
  store = Store.open(dbPath);
  const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: project }, meta: { author: 'dana@example.com' } });
  recId = rec.runId;
  call(recId, 1);
  call(recId, 2);
  store.endRun(recId, 'completed');
  for (const attempt of [1, 2]) {
    const a = store.createRun({ mode: 'replay', parentRunId: recId, command: { argv: ['node', 'agent.js'], cwd: project }, meta: { repeat: { group: 'g', attempt, of: 2 } } });
    store.endRun(a.runId, 'completed');
  }
  const probe = store.createRun({ mode: 'replay', parentRunId: recId, command: { argv: ['node', 'agent.js'], cwd: project }, meta: { probe: { of: recId, callNo: 1, passed: false } } });
  store.endRun(probe.runId, 'completed');
  liveId = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: project } }).runId;
  call(liveId, 1);
  dash = await startDashboard({ store, dbPath, version: '0.1.0', spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: project }), project: { path: project } });
});
afterAll(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

describe('meta', () => {
  it('has what the status bar shows: counts without attempts, live runs, the store size, the address, the project', async () => {
    const meta = await get<MetaView>(dash, 'meta');
    expect(meta).toMatchObject({
      version: '0.1.0',
      dbPath,
      actions: true,
      readOnly: false,
      readOnlyReason: null,
      address: new URL(dash.url).host,
      counts: { runs: 2, attempts: 3 },
      live: [{ runId: liveId, calls: 1 }],
      jobKinds: expect.arrayContaining(['action']),
      uploadLimit: 64 * 1024 * 1024,
      project: { name: project.split(/[\\/]/).pop(), path: project },
    });
    expect(meta.address).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(meta.storeBytes).toBeGreaterThan(4096);
  });
});

describe('the change feed', () => {
  it('says what changed since a cursor, and nothing when nothing did', async () => {
    const first = await get<ChangesView>(dash, 'changes');
    expect(first).toMatchObject({ changed: true, runs: true, calls: true, events: true, jobs: true, other: [], live: [{ runId: liveId, calls: 1 }] });
    const quiet = await get<ChangesView>(dash, `changes?since=${first.cursor}`);
    expect(quiet).toMatchObject({ changed: false, runs: false, calls: false, events: false, jobs: false, other: [] });
    expect(quiet.cursor).toBe(first.cursor);

    // A live run grows: only calls moved, and the live count says by how much.
    call(liveId, 2);
    const grew = await get<ChangesView>(dash, `changes?since=${quiet.cursor}`);
    expect(grew).toMatchObject({ changed: true, runs: false, calls: true, events: false, jobs: false, live: [{ runId: liveId, calls: 2 }] });

    // A label from the browser, or from the CLI in another process: both write the runs table.
    expect((await api(dash, `runs/${recId}/labels`, { method: 'POST', body: JSON.stringify({ add: ['good'] }) })).status).toBe(200);
    const labelled = await get<ChangesView>(dash, `changes?since=${grew.cursor}`);
    expect(labelled).toMatchObject({ changed: true, runs: true, calls: false, events: false });
    const other = Store.open(dbPath);
    other.updateRunMeta(recId, { notes: [{ callNo: 1, text: 'from the terminal', at: Date.now() }] });
    recordEvent(other, { kind: 'normalizer.added', ref: '$.x' });
    other.close();
    const fromCli = await get<ChangesView>(dash, `changes?since=${labelled.cursor}`);
    expect(fromCli).toMatchObject({ changed: true, runs: true, events: true, calls: false, jobs: false });

    // A job starting is a change too.
    expect((await api(dash, `runs/${recId}/actions`, { method: 'POST', body: JSON.stringify({ key: 'r' }) })).status).toBe(202);
    expect(await get<ChangesView>(dash, `changes?since=${fromCli.cursor}`)).toMatchObject({ changed: true, jobs: true, runs: false });

    // A cursor from another server instance (a restart), or none that parses, means everything changed.
    expect(await get<ChangesView>(dash, 'changes?since=not-a-cursor')).toMatchObject({ changed: true, runs: true, calls: true });
    const restarted = await startDashboard({ store, dbPath });
    try {
      expect(await get<ChangesView>(restarted, `changes?since=${fromCli.cursor}`)).toMatchObject({ changed: true, runs: true, calls: true, events: true });
    } finally {
      await restarted.close();
    }
  });
});

describe('the activity endpoint', () => {
  it('pages the feed, newest first, with an ETag', async () => {
    const all = await get<ActivityPage>(dash, 'activity');
    expect(all.next).toBeNull();
    expect(all.items.map((i) => i.at)).toEqual([...all.items.map((i) => i.at)].sort((a, b) => b - a));
    expect(all.items.find((i) => i.id === `r:${liveId}:start`)).toMatchObject({ kind: 'live', live: true, runId: liveId });
    expect(all.items.find((i) => i.id === `r:${recId}:end`)).toMatchObject({ kind: 'rec', text: 'Recorded 2 calls · node agent.js', actor: 'dana@example.com' });
    expect(all.items.find((i) => i.text === 'Normalizer added · $.x')).toBeDefined();
    expect(all.items.length).toBeGreaterThan(3);
    const first = await api(dash, 'activity?limit=2');
    const page = (await first.json()) as ActivityPage;
    // Exactly two, even when the fixture wrote several entries in one millisecond.
    expect(page.items).toHaveLength(2);
    expect(page.next).toEqual(expect.any(String));
    const rest = await get<ActivityPage>(dash, `activity?limit=100&before=${encodeURIComponent(page.next!)}`);
    expect(rest.next).toBeNull();
    expect([...page.items, ...rest.items].map((i) => i.id)).toEqual(all.items.map((i) => i.id));
    expect((await api(dash, 'activity?limit=2', { headers: { 'if-none-match': first.headers.get('etag')! } })).status).toBe(304);
    // An empty before is the first page; a time in milliseconds is everything older.
    expect((await get<ActivityPage>(dash, 'activity?before=&limit=2')).items).toEqual(page.items);
    expect((await get<ActivityPage>(dash, `activity?before=${Date.now() + 60_000}`)).items).toEqual(all.items);
    expect((await get<ActivityPage>(dash, 'activity?before=1')).items).toEqual([]);
    expect((await api(dash, 'activity?before=yesterday')).status).toBe(400);
    expect((await api(dash, 'activity?limit=many')).status).toBe(400);
  });
});

describe('a read-only dashboard', () => {
  let ro: Dashboard;
  const preview: RouteModule = { register: (router) => void router.post('/preview', (r) => r.json({ previewed: true }), { write: false }) };
  beforeAll(async () => {
    ro = await startDashboard({ store, dbPath, readOnly: true, spawnCli: cliSpawner({ command: [process.execPath, FAKE], cwd: project }), project: { path: project }, routes: [preview] });
  });
  afterAll(() => ro.close());

  it('shows everything and says why it changes nothing', async () => {
    const meta = await get<MetaView>(ro, 'meta');
    expect(meta).toMatchObject({ readOnly: true, actions: false, jobKinds: expect.arrayContaining(['action']), uploadLimit: null });
    expect(meta.readOnlyReason).toMatch(/--read-only/);
    expect(ro.readOnly).toBe(true);
    for (const path of ['runs', `runs/${recId}`, `runs/${recId}/calls/1`, `runs/${recId}/lineage`, 'activity', 'changes', 'jobs']) expect((await api(ro, path)).status, path).toBe(200);
  });

  it('refuses every write with the reason, and serves a request that changes nothing', async () => {
    const refusals: Array<[string, string, string?]> = [
      ['POST', `runs/${recId}/labels`, JSON.stringify({ add: ['bug'] })],
      ['POST', `runs/${recId}/notes`, JSON.stringify({ callNo: 1, text: 'x' })],
      ['POST', `runs/${recId}/actions`, JSON.stringify({ key: 'r' })],
      ['POST', 'jobs', JSON.stringify({ kind: 'action', runId: recId, key: 'r' })],
      ['POST', 'uploads', 'raw bytes'],
      ['DELETE', `runs/${recId}`],
    ];
    for (const [method, path, body] of refusals) {
      const res = await api(ro, path, { method, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/read-only \(started with --read-only\)/);
    }
    expect(store.getRun(recId)).not.toBeNull();
    expect(await (await api(ro, 'preview', { method: 'POST' })).json()).toEqual({ previewed: true });
  });

  it('leaves the project folder as it found it, even the uploads another dashboard left behind', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'sl-feeds-ro-')));
    const uploads = join(other, '.shadowlap', 'uploads');
    mkdirSync(uploads, { recursive: true });
    // Left two hours ago by a dashboard that stopped without closing: a writable dashboard sweeps it.
    const stale = join(uploads, `${ulid()}-old.har`);
    writeFileSync(stale, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    const snapshot = () => readdirSync(other, { recursive: true }).map(String).sort();
    const before = snapshot();
    const d = await startDashboard({ store, dbPath, readOnly: true, project: { path: other } });
    try {
      expect(existsSync(stale), 'not swept at start').toBe(true);
      expect((await api(d, 'uploads', { method: 'POST', body: 'x' })).status).toBe(403);
    } finally {
      await d.close();
    }
    expect(snapshot(), 'nothing made or removed, at start or at close').toEqual(before);
    rmSync(other, { recursive: true, force: true });
  });
});

describe('live runs', () => {
  it('leave out a run its recording process left behind', () => {
    const mem = Store.open(':memory:');
    // Still marked running, recorded by no process here and silent for two days, as a crash leaves a run.
    mem.importRun({ runId: '01K5CQ4N7G0000000000000001', parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['x'], cwd: '.' }, codeVersion: null, startedAt: Date.now() - 2 * 86_400_000, endedAt: null });
    const recording = mem.createRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    expect(liveRuns(mem)).toEqual([{ runId: recording.runId, calls: 0 }]);
    mem.close();
  });
});
