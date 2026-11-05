import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, packRun, recordEvent, Store, unpackRun } from '@shadowlap/engine';
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

const api = (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json', ...init.headers } });
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

  it('is answered as it was while a test runs on another run, or anything else happens', async () => {
    const rec = addRun(store, { startedAt: T0 + 4, calls: 'll' });
    const etag = (await api(`runs/${rec}`)).headers.get('etag')!;
    const other = addRun(store, { startedAt: T0 + 5, calls: 'll' });
    store.putInjectionResult({ resultId: 'inj-other', runId: other, golden: null, sessionId: null, mode: 'plant', at: T0, endedAt: null, attempts: 1, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0, verdict: 'obeyed', actor: null, data: { mode: 'plant', gate: { verdict: 'passed' }, attempts: [] } });
    recordEvent(store, { kind: 'normalize.added', ref: 'x', data: {} });
    expect((await api(`runs/${rec}`, { headers: { 'if-none-match': etag } })).status).toBe(304);
  });
});

describe('a long run', () => {
  const LONG = 'l'.repeat(1000);
  type Answer = { next: NextStep; warming?: unknown };

  it('leaves what its step bills to a read of its own, which answers with it whole', async () => {
    const long = addRun(store, { startedAt: T0 + 50, status: 'failed', calls: LONG });
    const first = await get<Answer>(`runs/${long}`);
    expect(first.warming).toBeDefined();
    expect(first.next).toMatchObject({ key: 'blame', later: true });
    expect(first.next.estimate).toBeUndefined();
    const whole = await get<{ next: NextStep }>(`runs/${long}/next`);
    expect(whole.next).toMatchObject({ key: 'blame', estimate: { kind: 'blame', ceiling: true } });
    expect(whole.next).not.toHaveProperty('later');
    expect((await api('runs/01M5JEQWA2QMJ3NYD1C687WP00/next')).status).toBe(404);
  });

  it('reads no other long run for a short run’s first answer, and says what it bills from its own read', async () => {
    const rec = addRun(store, { startedAt: T0 + 60, calls: LONG });
    goldens = [{ path: GOLDEN, runId: rec, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
    config({ tests: { [GOLDEN]: {} } });
    const session = store.startTestSession({ command: ['shadowlap', 'test', GOLDEN], startedAt: T0 + 61, revision: 'bbbbbbb' }).sessionId;
    const t = addRun(store, { parent: rec, startedAt: T0 + 61, status: 'failed', calls: 'r', meta: { test: { golden: GOLDEN, session } } });
    store.setDivergence(t, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.system', op: 'changed', before: 'a', after: 'b' }] });
    store.addTestResult({ sessionId: session, golden: GOLDEN, ok: false, failure: 'diverged', reason: 'diverged at call 1', runId: t, goldenRunId: rec, revision: 'bbbbbbb', at: T0 + 61 });
    const first = await get<Answer>(`runs/${t}`);
    expect(first.warming).toBeUndefined();
    expect(first.next).toMatchObject({ key: 'update-golden', later: true });
    expect(first.next.estimate).toBeUndefined();
    expect((await get<{ next: NextStep }>(`runs/${t}/next`)).next).toMatchObject({ key: 'update-golden', estimate: { kind: 'update' } });
  });
});

describe('a list’s rows', () => {
  it('carry each run’s step in its light form, in Runs and the sidebar alike', async () => {
    const failed = addRun(store, { startedAt: T0 + 10, status: 'failed', calls: 'lll' });
    const fork = addRun(store, { parent: failed, startedAt: T0 + 11, divergence: 2, calls: 'rl' });
    const page = await get<{ runs: Array<{ runId: string; next?: NextStepRow }> }>('runs/page?limit=500');
    const recent = await get<{ runs: Array<{ runId: string; next?: NextStepRow }> }>('runs');
    for (const list of [page.runs, recent.runs]) {
      expect(list.find((r) => r.runId === failed)?.next).toEqual({ key: 'blame', label: 'Run blame', command: `shadowlap blame ${failed.slice(0, 10)}` });
      expect(list.find((r) => r.runId === fork)?.next).toEqual({ key: 'compare', label: 'Compare with parent', href: `#/compare/${failed}/${fork}`, title: `Against ${failed.slice(0, 10)}`, command: `shadowlap diff ${failed.slice(0, 10)} ${fork.slice(0, 10)}` });
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

describe('a run with a record that can’t be read', () => {
  const lists = async () => {
    for (const path of ['runs', 'runs/page?limit=50', 'summary?tz=UTC']) {
      const res = await api(path);
      expect(res.status, `${path}: ${res.status === 200 ? '' : await res.text()}`).toBe(200);
    }
  };

  it('fails neither a list nor its page, unpacked from a pack that carries anything', async () => {
    goldens = [{ path: GOLDEN, runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
    for (const meta of [{ checks: 'x' }, { checks: [], test: { golden: GOLDEN, session: { a: 1 } } }]) {
      const other = Store.open(':memory:');
      const packDir = join(dir, 'sent', String(Math.random()).slice(2));
      const theirs = addRun(other, { startedAt: T0 + 30, status: 'failed', calls: '' });
      packRun(other, theirs, packDir);
      other.close();
      const manifest = JSON.parse(readFileSync(join(packDir, 'run.json'), 'utf8')) as { runs: Array<{ meta?: object }> };
      manifest.runs[0].meta = { ...manifest.runs[0].meta, ...meta };
      writeFileSync(join(packDir, 'run.json'), JSON.stringify(manifest));
      expect(unpackRun(store, packDir).imported.length).toBeGreaterThan(0);
      await lists();
      // Its page, and what its page offers beyond the run's record.
      for (const path of [`runs/${theirs}`, `runs/${theirs}/offers`]) {
        const res = await api(path);
        expect(res.status, `${path}: ${res.status === 200 ? '' : await res.text()}`).toBe(200);
      }
      store.deleteRun(theirs);
    }
  });

  it('leaves that row with no step and its old action, and every other row with its own', async () => {
    const good = addRun(store, { startedAt: Date.now() - 1000, status: 'failed', calls: 'l' });
    const rec = addRun(store, { startedAt: T0 + 40, calls: 'll' });
    goldens = [{ path: GOLDEN, runId: rec, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
    const failing = () => addRun(store, { parent: rec, startedAt: Date.now() - 900, status: 'failed', calls: 'r', meta: { test: { golden: GOLDEN, session: 's1' } } });
    const diff = failing();
    store.setDivergence(diff, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: 'x' as never });
    const hints = addRun(store, { parent: rec, startedAt: Date.now() - 800, calls: 'rl' });
    store.setDivergence(hints, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, hints: 'x' as never });
    await lists();
    const { runs } = await get<{ runs: Array<{ runId: string; next?: NextStepRow }> }>('runs');
    expect(runs.find((r) => r.runId === hints)?.next).toBeUndefined();
    expect(runs.find((r) => r.runId === good)?.next?.key).toBe('blame');
    expect(runs.find((r) => r.runId === diff)?.next).toBeUndefined();
    // Its page answers too, with no step to lead with.
    expect((await get<{ next?: NextStep }>(`runs/${diff}`)).next).toBeUndefined();
    for (const id of [good, rec, diff, hints]) store.deleteRun(id);
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
