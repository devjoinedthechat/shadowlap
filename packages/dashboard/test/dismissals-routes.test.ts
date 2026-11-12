import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectHost, ProjectRegistry, Store } from '@shadowlap/engine';
import { parseStoreUrl, pull, push } from '@shadowlap/remote';
import { startDashboard, type Dashboard, type ProjectConfig } from '../src/index.js';
import type { NeedsLookRow, OverviewSummary } from '../src/overview.js';
import { MemoryStore } from '../../remote/test/fakes/memory.js';
import { DAY } from './read-model-store.js';

/**
 * Dismiss over HTTP: a POST puts Needs a look's advice away with the facts its row states and says
 * what was kept before, for an Undo to write back; a DELETE brings it back (Restore). Kept in the
 * project's store alone: never an event, never pushed, refused for anything that isn't advice.
 */

const NOW = Date.now();
const TEAM = 's3://northwind-agent-runs/support-agent';
let project: string;
let store: Store;
let dash: Dashboard;
let runs: string[];

/** A finished recording made here, which a push can send. */
function recorded(at: number): string {
  const r = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' }, startedAt: at });
  store.endRun(r.runId, 'completed', at + 1_000);
  return r.runId;
}

beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-dismiss-routes-')));
  writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ store: TEAM }));
  store = Store.open(':memory:');
  runs = [recorded(NOW - 2 * DAY), recorded(NOW - DAY)];
  dash = await startDashboard({ store, dbPath: ':memory:', readOnly: false, project: { path: project } });
});
afterEach(async () => {
  await dash.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

type Answer = { status: number; body: Record<string, unknown> };
async function api(d: Dashboard, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null } = {}): Promise<Answer> {
  const res = await fetch(`${d.url}/api/${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.token === null ? {} : { 'x-shadowlap-token': init.token ?? d.token }), 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const dismiss = (key: unknown, facts: unknown, d: Dashboard = dash, headers: Record<string, string> = {}) => api(d, 'needs-look/dismissals', { method: 'POST', body: { key, facts }, headers });
const restore = (key: string, d: Dashboard = dash) => api(d, `needs-look/dismissals/${encodeURIComponent(key)}`, { method: 'DELETE' });
async function localRow(): Promise<NeedsLookRow | undefined> {
  const s = await api(dash, 'summary');
  expect(s.status).toBe(200);
  return (s.body as unknown as OverviewSummary).needsLook.items.find((x) => x.kind === 'local');
}
const counter = () => store.changeCounts().dismissals;

describe('Dismiss and Restore', () => {
  it('puts the runs only here away with the facts their row states, and an Undo of a first Dismiss deletes it', async () => {
    const row = await localRow();
    expect(row?.advice).toEqual({ key: 'local', facts: [...runs].sort(), until: 'Until another run is only on this machine', dismissed: false });
    const total = ((await api(dash, 'summary')).body as unknown as OverviewSummary).needsLook.total;
    const put = await dismiss('local', row!.advice!.facts);
    expect(put).toEqual({ status: 200, body: { key: 'local', facts: [...runs].sort(), was: null, dismissals: counter() } });
    expect(store.getDismissal('local')).toMatchObject({ key: 'local', facts: [...runs].sort() });
    const after = (await api(dash, 'summary')).body as unknown as OverviewSummary;
    expect(after.needsLook.items.find((x) => x.kind === 'local')?.advice?.dismissed).toBe(true);
    expect(after.needsLook.total).toBe(total - 1);
    expect(after.needsLook.dismissals).toBe(put.body.dismissals);
    // Undo, nothing having been kept before: a DELETE.
    expect(await restore('local')).toEqual({ status: 200, body: { key: 'local', restored: true, dismissals: counter() } });
    expect((await localRow())?.advice?.dismissed).toBe(false);
  });

  // The team store status names only the newest 500 runs only here: a row stating those alone would
  // come back each time a push moved older ones into them.
  it('states every run only here, past the newest 500, and stays put away when a push sends the newest', async () => {
    const older = Array.from({ length: 501 }, (_, i) => recorded(NOW - 3 * DAY + i * 1_000));
    const row = await localRow();
    expect(row?.title).toBe('503 runs are only on this machine');
    expect(row?.advice?.facts).toEqual([...runs, ...older].sort());
    expect((await dismiss('local', row!.advice!.facts)).status).toBe(200);
    expect((await localRow())?.advice?.dismissed).toBe(true);
    const remote = new MemoryStore(parseStoreUrl(TEAM));
    expect((await push({ store, remote, actor: 'dana@northwind.example', now: () => NOW }, { runIds: runs })).pushed.sort()).toEqual([...runs].sort());
    const after = await localRow();
    expect(after?.title).toBe('501 runs are only on this machine');
    expect(after?.advice).toMatchObject({ facts: [...older].sort(), dismissed: true });
  });

  it('answers what a second Dismiss replaced, and its Undo writes that back', async () => {
    await dismiss('local', [runs[0]]);
    const again = await dismiss('local', runs);
    expect(again.body).toMatchObject({ facts: [...runs].sort(), was: { facts: [runs[0]] } });
    expect((await localRow())?.advice?.dismissed).toBe(true);
    const undone = await dismiss('local', (again.body.was as { facts: string[] }).facts);
    expect(undone.body).toMatchObject({ facts: [runs[0]], was: { facts: [...runs].sort() } });
    expect(store.getDismissal('local')!.facts).toEqual([runs[0]]);
    expect((await localRow())?.advice?.dismissed).toBe(false);
  });

  it('Restores, and a second Restore is no error', async () => {
    await dismiss('retire claude-sonnet-4-5', ['retires 2026-11-30', 'goldens/refund-flow']);
    expect((await restore('retire claude-sonnet-4-5')).body).toMatchObject({ key: 'retire claude-sonnet-4-5', restored: true });
    expect(store.getDismissal('retire claude-sonnet-4-5')).toBeNull();
    expect(await restore('retire claude-sonnet-4-5')).toEqual({ status: 200, body: { key: 'retire claude-sonnet-4-5', restored: false, dismissals: counter() } });
  });

  it('moves the dismissals counter alone: no event, so Activity lists nothing, and the runs and team counters stay', async () => {
    const before = store.changeCounts();
    const events = store.listEvents().length;
    await dismiss('coverage', ['aaaa000011112222']);
    await restore('coverage');
    const after = store.changeCounts();
    expect(after.dismissals).toBeGreaterThanOrEqual(before.dismissals + 2);
    expect({ ...after, dismissals: 0 }).toEqual({ ...before, dismissals: 0 });
    expect(store.listEvents()).toHaveLength(events);
  });

  it('takes the facts of 10,000 runs only here in one Dismiss', async () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `01M${String(i).padStart(23, '0')}`);
    const res = await dismiss('local', ids);
    expect(res.status).toBe(200);
    expect(store.getDismissal('local')!.facts).toHaveLength(10_000);
  });
});

describe('what Dismiss refuses', () => {
  it('needs the session token', async () => {
    expect((await api(dash, 'needs-look/dismissals', { method: 'POST', body: { key: 'local', facts: runs }, token: null })).status).toBe(401);
    expect((await api(dash, 'needs-look/dismissals/local', { method: 'DELETE', token: null })).status).toBe(401);
  });

  it('refuses no key, anything but advice, and no facts, in words that say why', async () => {
    expect(await dismiss(undefined, runs)).toEqual({ status: 400, body: { error: 'a dismissal needs the key of the advice it puts away' } });
    expect(await dismiss('attn:failed:goldens/refund', ['x'])).toEqual({ status: 400, body: { error: 'only advice can be dismissed, not "attn:failed:goldens/refund"' } });
    expect((await restore('unblamed')).body).toEqual({ error: 'only advice can be dismissed, not "unblamed"' });
    for (const facts of [undefined, [], 'RUN', [1], [''], ['x'.repeat(1025)]]) expect(await dismiss('local', facts), JSON.stringify(facts)).toEqual({ status: 400, body: { error: 'facts must list what the advice states, at least one' } });
    expect(store.listDismissals()).toEqual([]);
  });

  it('refuses a body past 2 MB', async () => {
    const big = JSON.stringify({ key: 'local', facts: Array.from({ length: 80_000 }, (_, i) => `01M${String(i).padStart(23, '0')}`) });
    const u = new URL(dash.url);
    // Refused by its declared length: the server answers and closes, so the rest of the body may meet a closed socket.
    const got = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: '/api/needs-look/dismissals', method: 'POST', headers: { host: u.host, 'x-shadowlap-token': dash.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('error', (err) => (/EPIPE|ECONNRESET/.test(err.message) ? resolve({ status: 413, text: '' }) : reject(err)));
      req.end(big);
    });
    expect(got.status).toBe(413);
    if (got.text) expect(JSON.parse(got.text)).toEqual({ error: 'the body is too large: at most 2 MB' });
    expect(store.getDismissal('local')).toBeNull();
  });

  it('is refused on a read-only dashboard', async () => {
    const readOnly = await startDashboard({ store, dbPath: ':memory:', readOnly: true, project: { path: project } });
    try {
      expect((await dismiss('local', runs, readOnly)).status).toBe(403);
      expect((await restore('local', readOnly)).status).toBe(403);
      expect(store.listDismissals()).toEqual([]);
    } finally {
      await readOnly.close();
    }
  });

  it('is refused from a page still showing another project: a dismissal is the current project’s', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sl-dismiss-projects-')));
    const folder = (name: string) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{}');
      return dir;
    };
    const support = folder('support-agent');
    const triage = folder('triage-bot');
    const registry = new ProjectRegistry({ home: root, env: { SHADOWLAP_HOME: root }, actor: () => null });
    const loadConfig = (): ProjectConfig => ({ normalize: [], redact: [] });
    const host = ProjectHost.open<ProjectConfig>(support, { registry, loadConfig });
    registry.add(triage);
    const several = await startDashboard({ projects: host, readOnly: false });
    try {
      expect((await api(several, 'projects/triage-bot/select', { method: 'POST' })).status).toBe(200);
      const stale = await dismiss('coverage', ['aaaa000011112222'], several, { 'x-shadowlap-project': 'support-agent' });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('The dashboard switched to triage-bot elsewhere, so nothing was done in support-agent.');
      expect((await dismiss('coverage', ['aaaa000011112222'], several, { 'x-shadowlap-project': 'triage-bot' })).status).toBe(200);
    } finally {
      await several.close();
      host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('never pushed', () => {
  it('sends nothing put away to the team store, and a pull brings none down', async () => {
    await dismiss('retire claude-sonnet-4-5', ['dash-only-retires-2026-11-30', 'dash-only-goldens/refund-flow']);
    await dismiss('local', runs);
    const remote = new MemoryStore(parseStoreUrl(TEAM));
    const pushed = await push({ store, remote, actor: 'dana@northwind.example', now: () => NOW }, { all: true });
    expect([...pushed.pushed].sort()).toEqual([...runs].sort());
    const text = (body: Buffer) => (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString('utf8');
    const sent = [...remote.objects.entries()].map(([key, o]) => `${key}\n${text(o.body)}`).join('\n');
    for (const word of ['dash-only-', 'retire claude-sonnet-4-5', 'dismiss']) expect(sent, word).not.toContain(word);
    const teammate = Store.open(':memory:');
    try {
      expect((await pull({ store: teammate, remote, actor: 'maya@northwind.example', now: () => NOW })).pulled.sort()).toEqual([...runs].sort());
      expect(teammate.listDismissals()).toEqual([]);
    } finally {
      teammate.close();
    }
  });
});
