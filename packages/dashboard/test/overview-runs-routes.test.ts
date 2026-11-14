import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store, storeApiRequest } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard, type JobView } from '../src/index.js';
import type { OverviewSummary } from '../src/overview.js';
import { choicesHere, commitsHere } from '../src/commits-here.js';
import type { DaysBisect, RunsPageRow } from '../src/routes/runs-list.js';
import { traceHost, traceSources } from '../src/routes/imports.js';
import type { RunsByDay, RunsPage } from '../src/runs-list.js';
import type { RecordedHit } from '../src/search-hits.js';
import { teamStoreStatus } from '../src/team-store.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun, DAY, HOUR, type CallSpec } from './read-model-store.js';

/**
 * The Overview's and the Runs page's routes over HTTP, with the team store's and the imports' job
 * kinds: what each answers, what it refuses, and the command line each kind builds from a request
 * the browser sends (a stand-in CLI runs instead of the real one).
 */

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const NOW = Date.now();

let project: string;
let store: Store;
let dash: Dashboard;
let ro: Dashboard;
const spawned: string[][] = [];
const ids: Record<string, string> = {};
const goldens: GoldenSource[] = [{ path: 'goldens/refund-flow', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }];

const api = (d: Dashboard, path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } });
const get = async <T,>(d: Dashboard, path: string): Promise<T> => {
  const res = await api(d, path);
  expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as T;
};
const post = (d: Dashboard, path: string, body: unknown) => api(d, path, { method: 'POST', body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

/** Starts a job and hands back the command line its kind built. */
async function built(body: Record<string, unknown>): Promise<string[]> {
  const before = spawned.length;
  const res = await post(dash, 'jobs', body);
  expect(res.status, await res.clone().text()).toBe(202);
  const job = (await res.json()) as JobView;
  for (let i = 0; i < 200 && spawned.length === before; i++) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 200; i++) {
    const view = (await (await api(dash, `jobs/${job.id}`)).json()) as JobView;
    if (view.done) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return spawned[spawned.length - 1];
}

const setConfig = (config: Record<string, unknown> | null) => {
  const file = join(project, 'shadowlap.config.json');
  if (config) writeFileSync(file, JSON.stringify(config));
  else rmSync(file, { force: true });
};

beforeAll(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-ovr-routes-')));
  store = Store.open(':memory:');
  ids.rec = addRun(store, { startedAt: NOW - 3 * HOUR, calls: 'llll', meta: { labels: ['refund-flow'], author: 'dana@northwind.example' } });
  ids.fork = addRun(store, { parent: ids.rec, startedAt: NOW - 2 * HOUR, divergence: 3, calls: 'rrll' });
  ids.failed = addRun(store, { startedAt: NOW - HOUR, status: 'failed', calls: 'll', meta: { author: 'ci', ci: 'github' } });
  ids.old = addRun(store, { startedAt: NOW - 20 * DAY, calls: 'l' });
  const spawner = cliSpawner({ command: [process.execPath, FAKE], cwd: tmpdir() });
  const common = { store, dbPath: ':memory:', project: { path: project }, goldens: () => goldens };
  dash = await startDashboard({ ...common, spawnCli: (args, o) => (spawned.push(args), spawner(['text-only'], o)) });
  ro = await startDashboard({ ...common, readOnly: true });
});

afterAll(async () => {
  await dash.close();
  await ro.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

afterEach(() => setConfig(null));

describe('the Overview', () => {
  it('answers in the viewer’s days, and refuses a time zone it does not know', async () => {
    const s = await get<OverviewSummary>(dash, 'summary?tz=Europe%2FBerlin');
    expect(s.tz).toBe('Europe/Berlin');
    expect(s.sums.week.runs).toBe(3);
    expect(s.counts).toEqual({ runs: 4, attempts: 0 });
    // A golden on disk that has not run yet: none passing, none failed, one not run yet.
    expect(s.outcomes.testsPassing).toEqual({ goldens: 1, passing: 0, inconclusive: 0, untested: 1, lastWeek: null, regressions: 0, lastRunAt: null });
    expect(s.needsLook.items.map((i) => [i.kind, i.runId])).toEqual([['unblamed', ids.failed]]);
    const bad = await api(dash, 'summary?tz=Mars%2FOlympus');
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toMatch(/time zone/);
  });

  it('lists runs only on this machine in Needs a look once a team store is set', async () => {
    setConfig({ store: 's3://northwind-agent-runs/support-agent?region=eu-central-1' });
    const s = await get<OverviewSummary>(dash, 'summary');
    // The row opens the runs it means: Runs with Local picked, which lists those four and counts them; its step pushes them all.
    expect(s.needsLook.items.at(-1)).toMatchObject({ kind: 'local', title: '4 runs are only on this machine', step: { of: 'push', label: 'Push local runs' }, href: '#/runs?types=local' });
    const page = await get<Omit<RunsPage, 'runs'> & { runs: RunsPageRow[] }>(dash, 'runs/page?types=local');
    expect(page.runs.map((r) => r.runId)).toEqual([ids.failed, ids.fork, ids.rec, ids.old]);
    expect(page.runs.every((r) => r.local)).toBe(true);
    expect(page.chipCounts.local).toBe(4);
    const days = await get<RunsByDay>(dash, 'runs/days?types=local&weeks=4');
    expect(days.totals.runs).toBe(4);
    // Without a store, nothing is only on this machine.
    setConfig(null);
    expect((await get<RunsPage>(dash, 'runs/page?types=local')).runs).toEqual([]);
  });
});

describe('the Runs table', () => {
  it('pages past its limit with a cursor, and counts each chip', async () => {
    const first = await get<RunsPage>(dash, 'runs/page?limit=2');
    expect(first.runs.map((r) => r.runId)).toEqual([ids.failed, ids.fork]);
    expect(first.total).toBe(4);
    expect(first.chipCounts).toMatchObject({ all: 4, recording: 3, fork: 1, failed: 1 });
    const second = await get<RunsPage>(dash, `runs/page?limit=2&cursor=${first.next}`);
    expect(second.runs.map((r) => r.runId)).toEqual([ids.rec, ids.old]);
    expect(second.next).toBeNull();
    // Who made it, and in CI where.
    expect(first.runs[0]).toMatchObject({ author: 'ci', ci: 'github', outcome: { kind: 'check-failed' } });
    // No team store: no local tag.
    expect(first.runs[0]).not.toHaveProperty('local');
  });

  it('filters, sorts and narrows to days on the server', async () => {
    const failed = await get<RunsPage>(dash, 'runs/page?types=failed');
    expect(failed.runs.map((r) => r.runId)).toEqual([ids.failed]);
    const q = await get<RunsPage>(dash, 'runs/page?q=refund-flow');
    expect(q.runs.map((r) => r.runId)).toEqual([ids.rec]);
    const byCalls = await get<RunsPage>(dash, 'runs/page?sort=calls');
    expect(byCalls.runs[0].calls).toBe(4);
    const day = await get<RunsPage>(dash, `runs/page?from=${NOW - 25 * DAY}&to=${NOW - 15 * DAY}`);
    expect(day.runs.map((r) => r.runId)).toEqual([ids.old]);
    expect(day.chipCounts.all).toBe(1);
  });

  it('refuses a cursor it did not hand out, an unknown sort or type, and a time zone it does not know', async () => {
    for (const [path, error] of [
      ['runs/page?cursor=bm9wZQ', /cursor/],
      ['runs/page?sort=size', /sort/],
      ['runs/page?types=recording,nightly', /unknown type/],
      ['runs/page?limit=ten', /whole number/],
      ['runs/days?tz=Mars%2FOlympus', /time zone/],
    ] as const) {
      const res = await api(dash, path);
      expect(res.status, path).toBe(400);
      expect(await errorOf(res)).toMatch(error);
    }
  });

  it('tags each run only on this machine once a team store is set', async () => {
    setConfig({ store: 's3://northwind-agent-runs/support-agent' });
    const page = await get<{ runs: RunsPageRow[] }>(dash, 'runs/page');
    expect(page.runs.map((r) => r.local)).toEqual([true, true, true, true]);
    // A recording in progress is only here too, though no count has it yet: it can't be pushed until
    // it ends. Needs a look says the store status's count, as Settings → Store and the CLI do: by
    // run, the attempt bundled under one of them counted with its run, as the Runs page files it.
    const live = addRun(store, { startedAt: NOW, calls: 'l', status: 'running' });
    const attempt = addRun(store, { parent: ids.rec, startedAt: NOW - 30 * 60_000, calls: 'rrrr', meta: { repeat: { group: 'g', attempt: 1, of: 1 } } });
    try {
      const now = await get<{ runs: RunsPageRow[] }>(dash, 'runs/page');
      expect(now.runs.find((r) => r.runId === live)).toMatchObject({ status: 'running', local: true });
      expect(now.runs.some((r) => r.runId === attempt)).toBe(false);
      const s = await get<OverviewSummary>(dash, 'summary');
      expect(s.needsLook.items.at(-1)).toMatchObject({ kind: 'local', title: '4 runs are only on this machine' });
      expect(teamStoreStatus(store, { store: 's3://northwind-agent-runs/support-agent' })).toMatchObject({ onlyLocal: 4, localAttempts: 1 });
      // Pushing the run sends the attempt bundled under it as well, so it leaves nothing behind.
      expect(await built({ kind: 'push', runIds: [ids.rec] })).toEqual(['push', ids.rec, attempt]);
      // The run in the store, its attempt not (made after the push): the run's row still says local,
      // and why, so Push in the bulk bar picks it up and sends the attempt.
      const remote = 's3://northwind-agent-runs/support-agent';
      const pushed = (runId: string) => store.setTeamRun(remote, { runId, state: 'pushed', at: NOW, base: null, baseHash: null, remoteHash: 'h', entry: null });
      pushed(ids.rec);
      const after = await get<{ runs: RunsPageRow[] }>(dash, 'runs/page');
      expect(after.runs.find((r) => r.runId === ids.rec)).toMatchObject({ local: true, localAttempts: { run: false, attempts: 1 } });
      expect(after.runs.find((r) => r.runId === ids.fork)).toMatchObject({ local: true });
      expect(after.runs.find((r) => r.runId === ids.fork)).not.toHaveProperty('localAttempts');
      expect(await built({ kind: 'push', runIds: [ids.rec] })).toEqual(['push', ids.rec, attempt]);
      pushed(attempt);
      const all = await get<{ runs: RunsPageRow[] }>(dash, 'runs/page');
      expect(all.runs.find((r) => r.runId === ids.rec)).toMatchObject({ local: false });
      expect(await built({ kind: 'push', runIds: [ids.rec] })).toEqual(['push', ids.rec]);
      store.deleteTeamRun(remote, ids.rec);
      store.deleteTeamRun(remote, attempt);
    } finally {
      store.deleteRun(live);
      store.deleteRun(attempt);
    }
  });
});

describe('the calendar', () => {
  it('counts runs per day in the viewer’s days, Failed included', async () => {
    const days = await get<RunsByDay>(dash, 'runs/days?tz=UTC&weeks=4');
    expect(days.weeks).toBe(4);
    expect(days.totals).toMatchObject({ runs: 4, failed: 1 });
    const failed = await get<RunsByDay>(dash, 'runs/days?tz=UTC&types=failed');
    expect(failed.totals).toMatchObject({ runs: 1, failed: 1, all: 4 });
  });

  it('finds the first failure on the days picked for Find the commit, or says nothing failed', async () => {
    const found = await get<DaysBisect>(dash, `runs/bisect?from=${NOW - DAY}&to=${NOW + HOUR}`);
    expect(found).toMatchObject({ runId: ids.failed, label: 'recording', command: 'python refund_agent.py' });
    if (found.runId) expect(found.choices).toMatchObject({ target: { kind: 'run', runId: ids.failed }, failed: true });
    expect(await get<DaysBisect>(dash, `runs/bisect?from=${NOW - 25 * DAY}&to=${NOW - 15 * DAY}`)).toEqual({ runId: null, reason: 'nothing failed on the days picked' });
    const res = await api(dash, 'runs/bisect');
    expect(res.status).toBe(400);
  });

  it('offers only commits this checkout has: a teammate’s pulled runs name commits of theirs', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sl-ovr-git-')));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
    try {
      git('init', '-q', '.');
      writeFileSync(join(repo, 'policy.txt'), 'refund limit 100\n');
      git('add', '-A');
      git('commit', '-qm', 'Start');
      const first = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'policy.txt'), 'refund limit 50\n');
      git('commit', '-qam', 'Tighten');
      const second = git('rev-parse', 'HEAD');
      const theirs = '1fb4209c0ffee00000000000000000000000beef';
      // A full name and a short one are commits here; another checkout's, a branch name and
      // anything that reads like an option are not asked about.
      expect(await commitsHere(repo, [first, second.slice(0, 7), theirs, null, 'HEAD', '--all'])).toEqual(new Set([first, second.slice(0, 7)]));
      expect(await commitsHere(repo, [])).toEqual(new Set());
      // Not a repository: git can't say, so nothing is taken away.
      expect(await commitsHere(tmpdir(), [first])).toBeNull();

      const choices = {
        target: { kind: 'run' as const, runId: ids.failed },
        failed: true,
        good: theirs,
        bad: 'feedface',
        revisions: [
          { rev: theirs, at: NOW - DAY, runs: 2, failed: 0 },
          { rev: second, at: NOW - 2 * DAY, runs: 1, failed: 1 },
          { rev: first, at: NOW - 3 * DAY, runs: 3, failed: 0 },
        ],
        fork: true,
        live: true,
        unavailable: null,
        args: ['bisect', ids.failed, '--good', theirs, '--bad', 'feedface', '--fork'],
      };
      const here = (await commitsHere(repo, [choices.good, choices.bad, ...choices.revisions.map((r) => r.rev)]))!;
      // The good commit falls to the newest one here where the runs didn't all fail; the bad one to HEAD.
      expect(choicesHere(choices, here)).toEqual({ ...choices, good: first, bad: null, revisions: choices.revisions.slice(1), args: ['bisect', ids.failed, '--good', first, '--fork'] });
      expect(choicesHere({ ...choices, unavailable: 'this run is still recording' }, here).args).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('bulk actions', () => {
  it('labels several runs at once by their full ids, and refuses a label it cannot keep', async () => {
    const out = (await (await post(dash, 'runs/labels', { ids: [ids.rec, ids.fork, 'NOPE'], add: ['good'] })).json()) as { done: Array<{ runId: string; labels: string[] }>; skipped: Array<{ runId: string; reason: string }> };
    expect(out.done.map((d) => d.runId)).toEqual([ids.rec, ids.fork]);
    expect(out.done[0].labels).toEqual(['refund-flow', 'good']);
    expect(out.skipped).toEqual([{ runId: 'NOPE', reason: 'no such run' }]);
    const bad = await post(dash, 'runs/labels', { ids: [ids.rec], add: ['x'.repeat(41)] });
    expect(bad.status).toBe(400);
    const none = await post(dash, 'runs/labels', { ids: [], add: ['good'] });
    expect(await errorOf(none)).toMatch(/pick at least one run/);
    await post(dash, 'runs/labels', { ids: [ids.rec, ids.fork], remove: ['good'] });
    expect(store.getRun(ids.rec)!.meta?.labels).toEqual(['refund-flow']);
  });

  it('says which runs picked are still there, on a read-only dashboard too', async () => {
    const gone = addRun(store, { startedAt: NOW - 5 * DAY, calls: 'l' });
    store.deleteRun(gone);
    for (const d of [dash, ro]) {
      const res = await post(d, 'runs/known', { ids: [ids.rec, gone, 'NOPE'] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ known: [ids.rec] });
    }
    expect((await post(dash, 'runs/known', { ids: 'all' })).status).toBe(400);
  });

  it('deletes several runs at once, and is refused on a read-only dashboard', async () => {
    const gone = addRun(store, { startedAt: NOW - 5 * DAY, calls: 'l' });
    const keep = addRun(store, { startedAt: NOW - 5 * DAY, calls: 'l', status: 'running' });
    for (const [path, body] of [
      ['runs/delete', { ids: [gone] }],
      ['runs/labels', { ids: [gone], add: ['x'] }],
    ] as const) {
      const res = await post(ro, path, body);
      expect(res.status, path).toBe(403);
    }
    const out = (await (await post(dash, 'runs/delete', { ids: [gone, keep] })).json()) as { done: string[]; skipped: Array<{ runId: string; reason: string }> };
    expect(out.done).toEqual([gone]);
    expect(store.getRun(gone)).toBeNull();
    // This process is recording it.
    expect(out.skipped).toEqual([{ runId: keep, reason: 'still recording' }]);
  });
});

describe('a run its recorder left', () => {
  // Killed two days ago before it ended: still marked running, with nothing recording it.
  const left = '01K4ZZ0000000000000000LEFT';
  const leave = () =>
    store.importRun({ runId: left, parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['python', 'refund_agent.py'], cwd: '/work' }, codeVersion: null, startedAt: NOW - 2 * DAY, endedAt: null });
  afterEach(() => store.deleteRun(left));

  it('is listed interrupted, not in progress, and deleted like a run that ended', async () => {
    leave();
    const page = await get<RunsPage>(dash, 'runs/page');
    expect(page.runs.find((r) => r.runId === left)).toMatchObject({ status: 'crashed', outcome: { kind: 'none' }, failed: false });
    // Sorted by its calls, not kept on top as a run still adding them.
    const byCalls = await get<RunsPage>(dash, 'runs/page?sort=calls');
    expect(byCalls.runs.at(-1)!.runId).toBe(left);
    // The sidebar's list says so too: the top bar's chip looks there for a run recording.
    const { runs } = await get<{ runs: Array<{ runId: string; status: string }> }>(dash, 'runs');
    expect(runs.find((r) => r.runId === left)?.status).toBe('crashed');
    const out = (await (await post(dash, 'runs/delete', { ids: [left] })).json()) as { done: string[] };
    expect(out.done).toEqual([left]);
  });

  it('is counted as only here, and a push names it: the CLI ends it as interrupted, as gc would, and sends it', async () => {
    leave();
    setConfig({ store: 's3://northwind-agent-runs/support-agent' });
    // Still marked running, but nothing records it: the store's count (and the CLI's) has it
    // already, since a push ends it and sends it.
    const before = await get<OverviewSummary>(dash, 'summary');
    expect(before.needsLook.items.at(-1)).toMatchObject({ kind: 'local', title: '5 runs are only on this machine' });
    expect(await built({ kind: 'push', runIds: [left] })).toEqual(['push', left]);
    expect(await built({ kind: 'push', all: true })).toEqual(['push', '--all']);
    // Building the job changes nothing: a job refused after it is built (too many running, the
    // working tree in use) must leave the run as it was.
    expect(store.getRun(left)).toMatchObject({ status: 'running' });
    const after = await get<OverviewSummary>(dash, 'summary');
    expect(after.needsLook.items.at(-1)).toMatchObject({ kind: 'local', title: '5 runs are only on this machine' });
  });
});

describe('the team store', () => {
  it('says there is none until the config names one, then what this machine knows of it and who it records as', async () => {
    expect(await get(dash, 'store')).toEqual({ store: null, you: null });
    setConfig({ store: 's3://northwind-agent-runs/support-agent?region=eu-central-1' });
    const author = process.env.SHADOWLAP_AUTHOR;
    process.env.SHADOWLAP_AUTHOR = 'dana@northwind.example';
    try {
      const { store: s, you } = await get<{ store: { name: string; onlyLocal: number; pushedAt: number | null }; you: string | null }>(dash, 'store');
      expect(s).toMatchObject({ name: 'northwind-agent-runs/support-agent', pushedAt: null });
      expect(s.onlyLocal).toBeGreaterThan(0);
      // The By column's "you": what a run made on this machine is stamped with.
      expect(you).toBe('dana@northwind.example');
    } finally {
      if (author === undefined) delete process.env.SHADOWLAP_AUTHOR;
      else process.env.SHADOWLAP_AUTHOR = author;
    }
  });

  it('pushes the runs picked or every local run, pulls, and shares a run with its ancestors', async () => {
    const refused = await post(dash, 'jobs', { kind: 'push', all: true });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toMatch(/no team store yet/);
    setConfig({ store: 's3://northwind-agent-runs/support-agent' });
    expect(await built({ kind: 'push', runIds: [ids.fork, ids.rec, ids.fork] })).toEqual(['push', ids.fork, ids.rec]);
    expect(await built({ kind: 'push', all: true })).toEqual(['push', '--all']);
    expect(await built({ kind: 'pull' })).toEqual(['pull']);
    expect(await built({ kind: 'share', runId: ids.fork.slice(0, 10) })).toEqual(['share', ids.fork, '--lineage']);
    expect(await built({ kind: 'share', runId: ids.fork, lineage: false })).toEqual(['share', ids.fork]);
    // A prefix could name another run: the bulk bar sends full ids.
    for (const [body, status] of [
      [{ kind: 'push', runIds: [ids.fork.slice(0, 10)] }, 404],
      [{ kind: 'push', runIds: [] }, 400],
      [{ kind: 'push', runIds: 'all' }, 400],
      [{ kind: 'share' }, 400],
      [{ kind: 'share', runId: 'NOPE' }, 404],
    ] as const) {
      const res = await post(dash, 'jobs', body);
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
  });
});

describe('imports', () => {
  const env = { ...process.env };
  /** What the trace stores are read with, and where: the developer's own are out of the way. */
  const KEYS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY', 'PHOENIX_API_KEY', 'PHOENIX_ENDPOINT', 'PHOENIX_COLLECTOR_ENDPOINT', 'PHOENIX_BASE_URL', 'PHOENIX_PROJECT', 'PHOENIX_PROJECT_NAME', 'LOGFIRE_READ_TOKEN', 'LOGFIRE_BASE_URL'];
  afterEach(() => {
    for (const k of [...KEYS, 'LANGFUSE_HOST']) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });

  it('imports an uploaded file under the name it was picked by, as the format chosen', async () => {
    const send = async (filename: string) => {
      const up = await api(dash, 'uploads', { method: 'POST', body: '{"log":{"entries":[]}}', headers: { 'x-filename': encodeURIComponent(filename), 'content-type': 'application/octet-stream' } });
      expect(up.status).toBe(201);
      return (await up.json()) as { uploadId: string; name: string };
    };
    // Kept on disk under a safe name; the run's source is the name as picked.
    const { uploadId, name } = await send('my capture (2).har');
    expect(name).toBe('my_capture_2.har');
    expect(await built({ kind: 'import', format: 'har', uploadId })).toEqual(['import', 'har', `.shadowlap/uploads/${uploadId}-my_capture_2.har`, '--name=my capture (2).har']);
    // A name no source can carry (folders, a control character) goes by the safe one.
    const odd = await send('..\\captures\u0007\\prod.har');
    expect((await built({ kind: 'import', format: 'har', uploadId: odd.uploadId })).slice(3)).toEqual([`--name=${odd.name}`]);
    // A file named like a flag stays a name: one argument with --name, never one of its own, and the
    // file on disk goes by a name that reads as no option either.
    for (const picked of ['--json', '-x.har', '--host=evil.har']) {
      const up = await send(picked);
      const args = await built({ kind: 'import', format: 'har', uploadId: up.uploadId });
      expect(args, picked).toEqual(['import', 'har', `.shadowlap/uploads/${up.uploadId}-${up.name}`, `--name=${picked}`]);
      expect(args.slice(0, 3).some((a) => a.startsWith('-')), picked).toBe(false);
    }
    // One upload, one import.
    const again = await post(dash, 'jobs', { kind: 'import', format: 'har', uploadId });
    expect(again.status).toBe(400);
    const yaml = await post(dash, 'jobs', { kind: 'import', format: 'yaml', uploadId });
    expect(await errorOf(yaml)).toMatch(/format: one of har, nock, vcr, litellm, otel, langfuse, langsmith, phoenix, logfire/);
  });

  it('fetches a trace with the keys already on this machine, which the browser never sends', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_HOST;
    const sources = await get<{ traces: ReturnType<typeof traceSources> }>(dash, 'imports');
    expect(sources.traces.langfuse).toEqual({ keys: false, keyNames: ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'], host: 'https://cloud.langfuse.com' });
    const missing = await post(dash, 'jobs', { kind: 'import', format: 'langfuse', traceId: '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07' });
    expect(missing.status).toBe(409);
    expect(await errorOf(missing)).toMatch(/LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY/);
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    expect((await get<{ traces: ReturnType<typeof traceSources> }>(dash, 'imports')).traces.langfuse.keys).toBe(true);
    expect(await built({ kind: 'import', format: 'langfuse', traceId: '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07', host: 'https://cloud.langfuse.com' })).toEqual(['import', 'langfuse', '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07']);
    expect(await built({ kind: 'import', format: 'langfuse', traceId: 'abc', host: 'https://langfuse.northwind.example/' })).toEqual(['import', 'langfuse', 'abc', '--host', 'https://langfuse.northwind.example']);
    // With a host in the environment, the public API typed in the dialog is a host of its own: the CLI is told.
    process.env.LANGFUSE_HOST = 'https://langfuse.northwind.example/';
    expect(await built({ kind: 'import', format: 'langfuse', traceId: 'abc', host: 'https://cloud.langfuse.com' })).toEqual(['import', 'langfuse', 'abc', '--host', 'https://cloud.langfuse.com']);
    expect(await built({ kind: 'import', format: 'langfuse', traceId: 'abc', host: 'https://langfuse.northwind.example' })).toEqual(['import', 'langfuse', 'abc']);
    delete process.env.LANGFUSE_HOST;
    for (const body of [
      { kind: 'import', format: 'langfuse', traceId: '--host=evil' },
      { kind: 'import', format: 'langfuse', traceId: 'abc', host: 'http://langfuse.northwind.example' },
      { kind: 'import', format: 'langfuse', traceId: 'abc', host: 'https://user:pw@langfuse.northwind.example' },
    ]) {
      const res = await post(dash, 'jobs', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('fetches a Phoenix trace with a key only where Phoenix asks for one, from the project named, and a Logfire trace with the read token', async () => {
    const id = '4a2db41deabc4aec332fb9fbfa0fc3e2';
    for (const k of KEYS) delete process.env[k];
    // A Phoenix on this machine, as `phoenix serve` starts it, asks for no key.
    const sources = await get<{ traces: ReturnType<typeof traceSources> }>(dash, 'imports');
    expect(sources.traces.phoenix).toEqual({ keys: true, keyNames: ['PHOENIX_API_KEY'], optional: true, host: 'http://localhost:6006', project: 'default' });
    expect(await built({ kind: 'import', format: 'phoenix', traceId: id, host: 'http://localhost:6006', project: 'default' })).toEqual(['import', 'phoenix', id]);
    // Another project goes on the command line, as one argument whatever it looks like.
    expect(await built({ kind: 'import', format: 'phoenix', traceId: id, project: 'support-agent' })).toEqual(['import', 'phoenix', id, '--project=support-agent']);
    expect(await built({ kind: 'import', format: 'phoenix', traceId: id, project: '--host=evil' })).toEqual(['import', 'phoenix', id, '--project=--host=evil']);
    // The project the CLI would look in is its own variable's: PHOENIX_PROJECT, else PHOENIX_PROJECT_NAME, as Phoenix's client reads them.
    process.env.PHOENIX_PROJECT_NAME = 'support-agent';
    expect(await built({ kind: 'import', format: 'phoenix', traceId: id, project: 'support-agent' })).toEqual(['import', 'phoenix', id]);
    expect(await built({ kind: 'import', format: 'phoenix', traceId: id, project: 'default' })).toEqual(['import', 'phoenix', id, '--project=default']);
    process.env.PHOENIX_PROJECT = 'refunds';
    expect((await get<{ traces: ReturnType<typeof traceSources> }>(dash, 'imports')).traces.phoenix.project).toBe('refunds');
    expect(await built({ kind: 'import', format: 'phoenix', traceId: id, project: 'refunds' })).toEqual(['import', 'phoenix', id]);
    expect(await built({ kind: 'import', format: 'phoenix', traceId: id, project: 'support-agent' })).toEqual(['import', 'phoenix', id, '--project=support-agent']);
    delete process.env.PHOENIX_PROJECT;
    const missing = await post(dash, 'jobs', { kind: 'import', format: 'logfire', traceId: id });
    expect(missing.status).toBe(409);
    expect(await errorOf(missing)).toMatch(/^Logfire needs LOGFIRE_READ_TOKEN in the environment/);
    // A Phoenix that asks for no key is read over http on another host too, as a compose file names it; with a key, https.
    expect(await built({ kind: 'import', format: 'phoenix', traceId: id, host: 'http://phoenix:6006' })).toEqual(['import', 'phoenix', id, '--host', 'http://phoenix:6006']);
    process.env.PHOENIX_API_KEY = 'phx_6b1d_do_not_store';
    const keyed = await post(dash, 'jobs', { kind: 'import', format: 'phoenix', traceId: id, host: 'http://phoenix:6006' });
    expect(keyed.status).toBe(400);
    expect(await errorOf(keyed)).toMatch(/^host: an https address/);
    delete process.env.PHOENIX_API_KEY;
    process.env.LOGFIRE_READ_TOKEN = 'pylf_v1_eu_test';
    expect(await built({ kind: 'import', format: 'logfire', traceId: id, host: 'https://logfire-eu.pydantic.dev' })).toEqual(['import', 'logfire', id]);
    expect((await post(dash, 'jobs', { kind: 'import', format: 'logfire', traceId: id, host: 'http://logfire.northwind.example' })).status).toBe(400);
    for (const body of [
      { kind: 'import', format: 'phoenix', traceId: '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07' },
      { kind: 'import', format: 'logfire', traceId: 'abc' },
      { kind: 'import', format: 'phoenix', traceId: id, project: 'a/b' },
      { kind: 'import', format: 'phoenix', traceId: id, project: 42 },
    ]) {
      const res = await post(dash, 'jobs', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('reads the trace stores’ keys and hosts from the environment, never their values', () => {
    expect(traceSources({ LANGSMITH_API_KEY: 'lsv2_x', LANGSMITH_ENDPOINT: 'https://eu.api.smith.langchain.com' }).langsmith).toEqual({ keys: true, keyNames: ['LANGSMITH_API_KEY'], host: 'https://eu.api.smith.langchain.com' });
    expect(traceSources({ LANGCHAIN_API_KEY: 'x' }).langsmith.keys).toBe(true);
    expect(traceSources({ LANGFUSE_PUBLIC_KEY: 'x' }).langfuse.keys).toBe(false);
    expect(JSON.stringify(traceSources({ LANGFUSE_PUBLIC_KEY: 'pk-secret', LANGFUSE_SECRET_KEY: 'sk-secret' }))).not.toMatch(/secret/);
    // Where Phoenix traces are sent names Phoenix itself, less the OTLP path; a Logfire read token names its region.
    expect(traceSources({ PHOENIX_COLLECTOR_ENDPOINT: 'https://app.phoenix.arize.com/s/northwind/v1/traces' }).phoenix.host).toBe('https://app.phoenix.arize.com/s/northwind');
    expect(traceSources({ PHOENIX_ENDPOINT: 'https://phoenix.northwind.example', PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces' }).phoenix.host).toBe('https://phoenix.northwind.example');
    expect(traceSources({ LOGFIRE_READ_TOKEN: 'pylf_v1_eu_secret' }).logfire).toEqual({ keys: true, keyNames: ['LOGFIRE_READ_TOKEN'], host: 'https://logfire-eu.pydantic.dev' });
    expect(traceSources({ LOGFIRE_READ_TOKEN: 'pylf_v1_eu_secret', LOGFIRE_BASE_URL: 'https://logfire.northwind.example' }).logfire.host).toBe('https://logfire.northwind.example');
    expect(traceSources({}).logfire).toEqual({ keys: false, keyNames: ['LOGFIRE_READ_TOKEN'], host: 'https://logfire-us.pydantic.dev' });
    expect(JSON.stringify(traceSources({ PHOENIX_API_KEY: 'px-secret', LOGFIRE_READ_TOKEN: 'pylf_v1_us_secret' }))).not.toMatch(/secret/);
    // A password in an address the environment names stays off the page, as the CLI refuses that address.
    expect(traceSources({ LANGFUSE_HOST: 'https://proxy:hunter2@langfuse.northwind.example' }).langfuse.host).toBe('https://langfuse.northwind.example');
    expect(JSON.stringify(traceSources({ PHOENIX_COLLECTOR_ENDPOINT: 'https://ops:hunter2@phoenix.northwind.example/s/support/v1/traces', LOGFIRE_BASE_URL: 'https://ops:hunter2@logfire.northwind.example' }))).not.toMatch(/hunter2|ops@/);
    expect(traceSources({ PHOENIX_COLLECTOR_ENDPOINT: 'https://ops:hunter2@phoenix.northwind.example/s/support/v1/traces' }).phoenix.host).toBe('https://phoenix.northwind.example/s/support');
    expect(traceHost('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(traceHost('http://phoenix:6006')).toBeNull();
    expect(traceHost('http://phoenix:6006', true)).toBe('http://phoenix:6006');
    expect(traceHost('http://ops:hunter2@phoenix:6006', true)).toBeNull();
    expect(traceHost('ftp://x')).toBeNull();
    expect(traceHost('')).toBeNull();
  });

  it('imports the traces that started in a window from Langfuse, Phoenix and Logfire, each field one argument, and Logfire’s trace from as far back as asked', async () => {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, { LANGFUSE_PUBLIC_KEY: 'pk-lf-EXAMPLE', LANGFUSE_SECRET_KEY: 'sk-lf-EXAMPLE', LOGFIRE_READ_TOKEN: 'pylf_v1_us_EXAMPLE' });
    const id = '4a2db41deabc4aec332fb9fbfa0fc3e2';
    expect(await built({ kind: 'import', format: 'langfuse', window: { since: '7d', limit: 50, traceName: '--json' } })).toEqual(['import', 'langfuse', '--since=7d', '--limit=50', '--trace-name=--json']);
    // A window left as the CLI has it, the last 30 days: said, since the CLI takes no import without a trace id or a flag.
    expect(await built({ kind: 'import', format: 'phoenix', window: {}, project: 'support-agent' })).toEqual(['import', 'phoenix', '--since=30d', '--project=support-agent']);
    expect(await built({ kind: 'import', format: 'logfire', window: { since: '2026-09-01', until: '2026-10-01' } })).toEqual(['import', 'logfire', '--since=2026-09-01', '--until=2026-10-01']);
    expect(await built({ kind: 'import', format: 'logfire', traceId: id, window: { since: '90d' } })).toEqual(['import', 'logfire', id, '--since=90d']);
    for (const [body, error] of [
      [{ kind: 'import', format: 'langfuse', window: { since: 'last week' } }, 'window: --since: a date (2026-09-30), a time (2026-09-30T14:00Z), or how long ago (30d, 12h), not "last week"'],
      [{ kind: 'import', format: 'langfuse', window: { limit: 20000 } }, 'window: --limit: a number of traces from 1 to 10000, not "20000"'],
      [{ kind: 'import', format: 'langfuse', window: { since: '2d', until: '3d' } }, 'window: --until: "3d" is not after --since'],
      [{ kind: 'import', format: 'langfuse', traceId: 'abc', window: { limit: '5' } }, 'window: --limit is for the traces in a window, without a trace id'],
      [{ kind: 'import', format: 'langsmith', window: { since: '7d' } }, 'traceId: the id from the trace’s page'],
      [{ kind: 'import', format: 'langfuse' }, 'traceId: the id from the trace’s page, or window: the traces that started in a window'],
      [{ kind: 'import', format: 'langfuse', window: 'last week' }, 'window: since, until, limit and traceName, each a string'],
    ] as const) {
      const res = await post(dash, 'jobs', body);
      expect([res.status, await errorOf(res)], JSON.stringify(body)).toEqual([400, error]);
    }
  });

  it('imports several LiteLLM or OpenTelemetry files together, as one import puts a run together from them, and one of any other format', async () => {
    const send = async (filename: string, body: string) => {
      const up = await api(dash, 'uploads', { method: 'POST', body, headers: { 'x-filename': encodeURIComponent(filename), 'content-type': 'application/octet-stream' } });
      expect(up.status).toBe(201);
      return ((await up.json()) as { uploadId: string; name: string }).uploadId;
    };
    const traces = await send('traces.json', '{"resourceSpans":[]}');
    const logs = await send('logs.json', '{"resourceLogs":[]}');
    expect(await built({ kind: 'import', format: 'otel', uploadIds: [traces, logs] })).toEqual(['import', 'otel', `.shadowlap/uploads/${traces}-traces.json`, `.shadowlap/uploads/${logs}-logs.json`, '--name=traces.json, logs.json']);
    const workers = await Promise.all(['worker-1.jsonl', 'worker-2.jsonl', 'worker-3.jsonl', 'worker-4.jsonl'].map((n) => send(n, '{}\n')));
    expect((await built({ kind: 'import', format: 'litellm', uploadIds: workers })).at(-1)).toBe('--name=worker-1.jsonl, worker-2.jsonl, worker-3.jsonl and 1 more');
    const hars = [await send('a.har', '{"log":{"entries":[]}}'), await send('b.har', '{"log":{"entries":[]}}')];
    for (const [body, error] of [
      [{ kind: 'import', format: 'har', uploadIds: hars }, 'uploadIds: several files go in together for LiteLLM and OpenTelemetry, which put a run together from them; import HAR files one at a time'],
      [{ kind: 'import', format: 'otel', uploadIds: [hars[0], hars[0]] }, 'uploadIds: from 1 to 20 uploads, each once'],
      [{ kind: 'import', format: 'otel', uploadIds: [] }, 'uploadIds: from 1 to 20 uploads, each once'],
      [{ kind: 'import', format: 'otel', uploadIds: [traces] }, 'uploadIds: upload the file first (POST /api/uploads), and use it for one import'],
    ] as const) {
      const res = await post(dash, 'jobs', body);
      expect([res.status, await errorOf(res)], JSON.stringify(body)).toEqual([400, error]);
    }
    // One HAR goes in alone, as before.
    expect((await built({ kind: 'import', format: 'har', uploadIds: [hars[1]] })).slice(0, 2)).toEqual(['import', 'har']);
  });
});

describe('searching what runs recorded', () => {
  /** A model call whose prompt says `text`, a conversation of its own. */
  const say = (code: string, text: string, scope = 's1'): CallSpec => ({ code, scope, request: { model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: text }] } });
  type Answer = { hits: RecordedHit[]; indexing?: { runs: number; of: number } };
  /** A search asked again while the index catches up, as the palette asks: the answer once it has. */
  const settled = async (d: Dashboard, path: string): Promise<Answer> => {
    for (let i = 0; i < 300; i++) {
      const a = await get<Answer>(d, path);
      if (!a.indexing) return a;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`${path}: the index never caught up`);
  };

  it('answers at once while the index catches up beside it, saying how many runs it has yet to read', async () => {
    const s = Store.open(':memory:');
    const d = await startDashboard({ store: s, dbPath: ':memory:', project: { path: project } });
    try {
      // The index caught up with the empty store as the dashboard started; then runs arrive, and it has read none of them.
      await new Promise((r) => setTimeout(r, 50));
      const runs = Array.from({ length: 40 }, (_, i) => addRun(s, { startedAt: NOW - DAY + i * 1000, calls: [say('l', `refund order A-${1000 + i}`), say('l', 'escalate it', 's2')] }));
      const first = await get<Answer>(d, 'search?q=refund&limit=40');
      expect(first).toEqual({ hits: [], indexing: { runs: 40, of: 40 } });
      // Asked again, as the palette does, it has caught up: every run, and nothing more to say.
      const later = await settled(d, 'search?q=refund&limit=40');
      expect(new Set(later.hits.map((h) => h.runId))).toEqual(new Set(runs));
      expect(later.indexing).toBeUndefined();
      expect(s.searchState(runs[0])).toMatchObject({ calls: 2 });
    } finally {
      await d.close();
      s.close();
    }
  });

  it('keeps answering every page while another command writes the store, and catches up once it is done', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-search-busy-'));
    const dbPath = join(dir, 'shadowlap.db');
    const s = Store.open(dbPath);
    const runs = Array.from({ length: 20 }, (_, i) => addRun(s, { startedAt: NOW - DAY + i * 1000, calls: [say('l', `refund order A-${1000 + i}`)] }));
    // Another command writing the store as the dashboard starts catching up: gc's VACUUM, a pull, an import.
    const holder = new DatabaseSync(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    const d = await startDashboard({ store: s, dbPath, project: { path: project } });
    try {
      await new Promise((r) => setTimeout(r, 150));
      // A search answers from what the index holds, and has it catch up again from there; the other
      // pages go on being answered. Neither waits for the index waiting for the store's write lock
      // (10 s, after which it gave up).
      const timed = async <T,>(path: string): Promise<T> => {
        const t0 = Date.now();
        const out = await get<T>(d, path);
        expect(Date.now() - t0, path).toBeLessThan(1500);
        return out;
      };
      expect(await timed<Answer>('search?q=refund&limit=40')).toEqual({ hits: [], indexing: { runs: 20, of: 20 } });
      for (let i = 0; i < 4; i++) {
        await timed('meta');
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(Date.now() - started).toBeLessThan(5000);
      holder.exec('ROLLBACK');
      const later = await settled(d, 'search?q=refund&limit=40');
      expect(new Set(later.hits.map((h) => h.runId))).toEqual(new Set(runs));
    } finally {
      holder.close();
      await d.close();
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers with what a recording said since the last search, rather than that it has yet to read it', async () => {
    const s = Store.open(':memory:');
    const d = await startDashboard({ store: s, dbPath: ':memory:', project: { path: project } });
    try {
      const rec = addRun(s, { startedAt: NOW - HOUR, status: 'running', calls: [say('l', 'Where is order A-1042?')] });
      expect((await settled(d, 'search?q=order&limit=40')).hits.map((h) => [h.runId, h.callNo])).toEqual([[rec, 1]]);
      // The recording goes on, a call between each search the palette makes: each is in the next
      // answer, and none says the index is behind, so the palette doesn't ask again every second.
      for (let n = 2; n <= 4; n++) {
        const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `fp${n}`, occurrence: 1 };
        const requestRef = storeApiRequest(s, { model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: `Refund order A-104${n}, ticket T-${n}0` }] });
        s.appendCallStart({ runId: rec, callNo: n, ...identity, origin: 'live', effect: null, requestRef, meta: { scope: `s${n}` }, at: NOW - HOUR + n * 1000 });
        s.appendCallEnd(identity, { runId: rec, callNo: n, attempt: 0, responseRef: null, outcome: 'ok', meta: { latencyMs: 900 }, at: NOW - HOUR + n * 1000 + 900 });
        const a = await get<Answer>(d, `search?q=T-${n}0&limit=40`);
        expect(a.indexing).toBeUndefined();
        expect(a.hits.map((h) => [h.runId, h.callNo])).toEqual([[rec, n]]);
      }
    } finally {
      await d.close();
      s.close();
    }
  });

  it('answers a run’s own hits before any attempt’s, and an attempt’s only for a run with none, naming that run', async () => {
    const s = Store.open(':memory:');
    const d = await startDashboard({ store: s, dbPath: ':memory:', project: { path: project } });
    try {
      const rec = addRun(s, { startedAt: NOW - DAY, status: 'failed', calls: [say('l', 'Order A-1042: refund it, though it is above the limit the policy sets for a refund without a manager.')] });
      // A blame's probes of it say what it said, closer to the words searched for.
      for (let i = 0; i < 30; i++) addRun(s, { parent: rec, startedAt: NOW - HOUR + i, divergence: 1, meta: { probe: { of: rec, callNo: 1, passed: false } }, calls: [say('r', 'refund the order'), say('r', 'refund it', 's2')] });
      // A run that never said it, whose attempts did.
      const quiet = addRun(s, { startedAt: NOW - 2 * DAY, calls: [say('l', 'Where is order A-1042?')] });
      const tries = [1, 2, 3].map((i) => addRun(s, { parent: quiet, startedAt: NOW - 2 * HOUR + i, divergence: 1, meta: { repeat: { group: 'g', attempt: i, of: 3 } }, calls: [say('l', 'refund issued'), say('l', 'refund sent', 's2')] }));

      const { hits } = await settled(d, 'search?q=refund&limit=40');
      expect(hits[0]).toMatchObject({ runId: rec, attemptOf: null, callNo: 1, field: 'prompt' });
      expect(hits.filter((h) => h.runId === rec || h.attemptOf === rec)).toHaveLength(1);
      expect(hits.slice(1).map((h) => h.attemptOf)).toEqual([quiet, quiet]);
      expect(hits.slice(1).every((h) => tries.includes(h.runId))).toBe(true);
      // The palette asks for a few: a run of its own still comes first.
      expect((await settled(d, 'search?q=refund&limit=1')).hits.map((h) => h.runId)).toEqual([rec]);
      expect((await settled(d, 'search?q=')).hits).toEqual([]);
    } finally {
      await d.close();
      s.close();
    }
  });

  it('asks for the token', async () => {
    expect((await fetch(`${dash.url}/api/search?q=refund`)).status).toBe(401);
  });
});
