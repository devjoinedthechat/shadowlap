import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blameEstimate, forkEstimate, pricedCalls, repeatEstimate, Store, type RunMeta } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import type { RunEstimates } from '../src/estimates.js';
import { addRun } from './read-model-store.js';

/**
 * The estimates a page asks for over HTTP, each worked out beside the server: a run's Run blame and
 * its fork menu's rows, the engine's figure for each as the job runs, and none for a row that bills
 * nothing or is turned off.
 */

const T0 = Date.now() - 3_600_000;

let store: Store;
let dash: Dashboard;

const api = (path: string, headers: Record<string, string> = {}) => fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token, ...headers } });
const get = async (path: string): Promise<RunEstimates> => {
  const res = await api(path);
  expect(res.status, path).toBe(200);
  return (await res.json()) as RunEstimates;
};
const priced = (runId: string) => pricedCalls(store.getCalls(runId));
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

beforeAll(async () => {
  store = Store.open(':memory:');
  dash = await startDashboard({ store, readOnly: false, port: 0 });
});
afterAll(async () => {
  await dash.close();
  store.close();
});

describe('a run’s estimates', () => {
  it('prices Run blame and the whole run’s rows, and each row at a call as its job runs', async () => {
    const rec = addRun(store, { startedAt: T0, status: 'failed', calls: 'llll' });
    const whole = await get(`runs/${rec}/estimates`);
    expect(whole.blame).toEqual(plain(blameEstimate(priced(rec))));
    // A recording repeats from itself, free; only a replay Shadowlap made has a Replay with writes stubbed that bills.
    expect(whole.actions).toEqual({ e: plain(repeatEstimate(store.getRun(rec)!, store.getCalls(rec))) });
    expect(whole.actions.e).toMatchObject({ usd: 0 });

    const at = await get(`runs/${rec}/estimates?at=2`);
    expect(Object.keys(at.actions).sort()).toEqual(['a', 'e', 'f', 'g', 'i', 'm']);
    expect(at.actions.a).toEqual(plain(forkEstimate(priced(rec), { at: 2 })));
    expect(at.actions.a.usd).toBeGreaterThan(0);
    // Fail with HTTP status: Shadowlap answers #2 itself, so it runs live from #3.
    expect(at.actions.f).toEqual(plain(forkEstimate(priced(rec), { at: 2, answered: true })));
    expect(at.actions.f.usd).toBeLessThan(at.actions.a.usd!);
    // Switch model as recorded until a model is named, then at that model's price.
    expect(at.actions.m).toEqual(at.actions.a);
    const opus = await get(`runs/${rec}/estimates?at=2&model=claude-opus-4-1`);
    expect(opus.actions.m).toEqual(plain(forkEstimate(priced(rec), { at: 2, model: 'claude-opus-4-1' })));
    expect(opus.actions.m.usd).not.toBe(at.actions.a.usd);
    expect(opus.actions.a).toEqual(at.actions.a);
  });

  it('asks first on forcing a write live, and prices a fork’s replay with writes stubbed as one attempt', async () => {
    const parent = addRun(store, { startedAt: T0 + 1, calls: 'lllol' });
    const meta = { interventions: [{ flag: '--diverge-at 2', kind: 'diverge', args: ['--diverge-at', '2'] }] } as unknown as RunMeta;
    const fork = addRun(store, { parent, startedAt: T0 + 2, divergence: 2, meta, calls: 'rllol' });
    const write = await get(`runs/${fork}/estimates?at=4`);
    expect(write.actions.l).toMatchObject({ kind: 'fork', always: expect.any(String) });
    expect(write.actions.s).toEqual(plain(repeatEstimate(store.getRun(fork)!, store.getCalls(fork), 1)));
    expect(write.actions.s.usd).toBeGreaterThan(0);
    expect(write.actions.e.usd).toBeCloseTo(5 * write.actions.s.usd!, 10);
  });

  it('refuses what it can’t price, and answers 304 only for the same question', async () => {
    const rec = addRun(store, { startedAt: T0 + 3, calls: 'll' });
    expect((await api(`runs/${rec}/estimates?at=0`)).status).toBe(400);
    expect((await api(`runs/${rec}/estimates?at=1.5`)).status).toBe(400);
    expect((await api(`runs/${rec}/estimates?at=9`)).status).toBe(404);
    expect((await api(`runs/${rec}/estimates?at=1&model=--help`)).status).toBe(400);
    expect((await api('runs/01ZZZZZZZZZZZZZZZZZZZZZZZZ/estimates')).status).toBe(404);
    const first = await api(`runs/${rec}/estimates?at=1`);
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    expect((await api(`runs/${rec}/estimates?at=1`, { 'if-none-match': etag })).status).toBe(304);
    expect((await api(`runs/${rec}/estimates?at=2`, { 'if-none-match': etag })).status).toBe(200);
    expect((await api(`runs/${rec}/estimates?at=1&model=claude-opus-4-1`, { 'if-none-match': etag })).status).toBe(200);
  });
});
