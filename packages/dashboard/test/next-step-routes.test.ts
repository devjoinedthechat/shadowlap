import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store } from '@shadowlap/engine';
import { makeRun } from '../../engine/test/fix-fixtures.js';
import { startDashboard, type Dashboard, type JobView } from '../src/index.js';
import type { NextStep, NextStepRow } from '../src/next-step.js';
import type { OverviewSummary } from '../src/overview.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * A run's next step over HTTP, worked out on a read-model thread beside the server from what the
 * server read of the project: on the run's page with what it bills, in a list's rows in its light
 * form, moving a page on when a test ends; and a capture's blame, which takes your command.
 */

const T0 = Date.now() - 3_600_000;
const GOLDEN = 'goldens/refund';

let dir: string;
let store: Store;
let dash: Dashboard;
const spawned: string[][] = [];
let goldens: GoldenSource[] = [];

const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json', ...init.headers } });
const get = async <T,>(path: string): Promise<T> => {
  const res = await api(path);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
};
const post = (body: Record<string, unknown>) => api('jobs', { method: 'POST', body: JSON.stringify(body) });
const config = (c: unknown) => writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify(c));

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sl-next-step-')));
  const dbPath = join(dir, 'shadowlap.db');
  store = Store.open(dbPath);
  config({});
  dash = await startDashboard({
    store,
    dbPath,
    port: 0,
    project: { path: dir },
    goldens: () => goldens,
    spawnCli: (args) => {
      spawned.push(args);
      return spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    },
  });
});
afterAll(async () => {
  await dash.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  goldens = [];
  config({});
});

describe('a run’s page', () => {
  it('answers with its next step, what it bills and what its Replay replays', async () => {
    const failed = addRun(store, { startedAt: T0, status: 'failed', calls: 'lll' });
    const d = await get<{ next: NextStep; replay: NextStep }>(`runs/${failed}`);
    expect(d.next).toMatchObject({ key: 'blame', label: 'Run blame', offer: { from: 'exit', expect: null, failed: [] }, command: `shadowlap blame ${failed.slice(0, 10)}`, estimate: { kind: 'blame', ceiling: true } });
    expect(d.next.estimate?.usd).toBeGreaterThan(0);
    expect(d.replay).toMatchObject({ key: 'replay', label: 'Replay', runId: failed });
    const clean = addRun(store, { parent: failed, startedAt: T0 + 1, calls: 'rrr' });
    expect((await get<{ replay: NextStep }>(`runs/${clean}`)).replay).toMatchObject({ label: 'Replay recording', runId: failed });
  });

  it('reads the project: a recording a golden is made from no longer leads with Pack as golden…', async () => {
    const rec = addRun(store, { startedAt: T0 + 2, calls: 'll' });
    expect((await get<{ next: NextStep }>(`runs/${rec}`)).next).toMatchObject({ key: 'pack', folder: `goldens/${rec.slice(0, 10).toLowerCase()}` });
    // A golden packed from it, listed once what the goldens are read from moves.
    goldens = [{ path: GOLDEN, runId: rec, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
    config({ tests: { [GOLDEN]: {} } });
    expect((await get<{ next: NextStep }>(`runs/${rec}`)).next.key).toBe('replay');
  });

  it('is answered anew once a test run on it ends, and as it was while nothing it reads moves', async () => {
    const rec = addRun(store, { startedAt: T0 + 3, calls: 'll' });
    const first = await api(`runs/${rec}`);
    expect(((await first.json()) as { next: NextStep }).next.key).toBe('pack');
    const etag = first.headers.get('etag')!;
    expect((await api(`runs/${rec}`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    const report = { mode: 'clean', read: { callNo: 1, name: 'get_ticket' }, writes: [{ callNo: 2, name: 'send_email', attempts: 3, gone: 3, verdict: 'caused', bound: null }] };
    store.putInjectionResult({ resultId: 'inj-1', runId: rec, golden: null, sessionId: null, mode: 'clean', at: T0, endedAt: T0 + 1, attempts: 3, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0, verdict: 'caused', actor: null, data: report });
    const again = await api(`runs/${rec}`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { next: NextStep }).next.key).toBe('pack-gate');
  });
});

describe('a list’s rows', () => {
  it('carry each run’s step in its light form, in Runs and the sidebar alike', async () => {
    const failed = addRun(store, { startedAt: T0 + 10, status: 'failed', calls: 'lll' });
    const fork = addRun(store, { parent: failed, startedAt: T0 + 11, divergence: 2, calls: 'rl' });
    const page = await get<{ runs: Array<{ runId: string; next?: NextStepRow }> }>('runs/page?limit=500');
    const recent = await get<{ runs: Array<{ runId: string; next?: NextStepRow }> }>('runs');
    for (const list of [page.runs, recent.runs]) {
      expect(list.find((r) => r.runId === failed)?.next).toEqual({ key: 'blame', label: 'Run blame' });
      expect(list.find((r) => r.runId === fork)?.next).toEqual({ key: 'compare', label: 'Compare with parent', href: `#/compare/${failed}/${fork}` });
    }
  });
});

describe('Needs a look', () => {
  it('offers Run blame only on a failure whose page leads with it', async () => {
    const can = addRun(store, { startedAt: Date.now() - 2000, status: 'failed', calls: 'l' });
    const cannot = makeRun(store, { startedAt: Date.now() - 1000, status: 'failed' });
    const items = (await get<OverviewSummary>('summary?tz=UTC')).needsLook.items.filter((i) => i.kind === 'unblamed');
    expect(items.find((i) => i.runId === can)?.action).toBe('Run blame');
    expect(items.find((i) => i.runId === cannot)?.action).toBe('Open');
  });
});

describe('Run blame on a capture', () => {
  const capture = (meta: Record<string, unknown> = {}) => {
    const id = store.createRun({ mode: 'record', command: { argv: [NO_COMMAND], cwd: '.' }, startedAt: T0 + 20, meta: { covers: ['api'], imported: { at: T0, from: '/work/cap.jsonl' }, ...meta } }).runId;
    store.endRun(id, 'completed');
    return id;
  };
  const started = async (body: Record<string, unknown>) => {
    const before = spawned.length;
    const res = await post(body);
    expect(res.status, await res.clone().text()).toBe(202);
    const job = (await res.json()) as JobView;
    for (let i = 0; i < 200 && spawned.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    return { job, args: spawned.at(-1)! };
  };

  it('takes your command, as what follows --, with no yes, and is refused without one or on a run with its own', async () => {
    const id = capture();
    const none = await post({ kind: 'blame', runId: id });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toMatch(/no command to re-run: give yours/);
    // Nothing says what a passing run must do: the page asks.
    expect((await post({ kind: 'blame', runId: id, command: 'python agent.py' })).status).toBe(422);
    expect((await started({ kind: 'blame', runId: id, command: 'python agent.py --fast', expect: { tools: { a: 1 } } })).args).toEqual(['blame', id, '--expect', '{"tools":{"a":1}}', '--', 'python', 'agent.py', '--fast']);
    const own = addRun(store, { startedAt: T0 + 21, status: 'failed', calls: 'l' });
    expect((await post({ kind: 'blame', runId: own, command: 'python agent.py' })).status).toBe(409);
  });

  it('blames a capture its import judged failed on the rule it broke', async () => {
    const rule = { tool: 'issue_refund', args: { amount: { '<=': 100 } } };
    config({ tests: { [GOLDEN]: { expect: { calls: [rule] } } } });
    const id = capture({ judged: { rules: 'r', at: T0, verdict: 'failed', why: null, checks: [{ status: 'failed', ok: false, label: 'every issue_refund call: amount <= 100', detail: 'issue_refund #1: amount 240' }] } });
    const { args } = await started({ kind: 'blame', runId: id, command: 'python agent.py' });
    expect(args).toEqual(['blame', id, '--expect', JSON.stringify({ calls: [rule] }), '--', 'python', 'agent.py']);
  });
});
