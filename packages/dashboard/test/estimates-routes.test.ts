import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bisectCommits, blameEstimate, forkEstimate, gateResult, goldenTestEstimate, noEstimate, pricedCalls, repeatEstimate, runBisectEstimate, Store, testsEstimate, updateEstimate, type RunMeta, type TestResultData } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import type { RunEstimates, TestsEstimates } from '../src/estimates.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun } from './read-model-store.js';

/**
 * The estimates a page asks for over HTTP, each worked out beside the server: a run's Run blame and
 * its fork menu's rows, Tests' buttons and Find breaking commit's, the engine's figure for each as the
 * job runs, and none for a row that bills nothing or is turned off. The project is a repository of
 * three commits, `FIRST` to `LAST`.
 */

const T0 = Date.now() - 3_600_000;

let store: Store;
let dash: Dashboard;
let dir: string;
let goldens: GoldenSource[] = [];
let FIRST: string;
let LAST: string;

const api = (path: string, headers: Record<string, string> = {}) => fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token, ...headers } });
const get = async <T = RunEstimates,>(path: string): Promise<T> => {
  const res = await api(path);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
};
const golden = (path: string, runId: string, o: Partial<GoldenSource> = {}): GoldenSource => ({ path, runId, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [], ...o });
const newest = (path: string) => store.listTestResults({ golden: path, limit: 1 })[0];
/** A golden's injection gate that ended, having spent `spent` live. */
function gateSpent(runId: string, path: string, spent: number, at: number): void {
  const data = { resultId: `inj-${String(at)}`, mode: 'plant', runId, golden: path, baselines: [{ read: 1, runs: ['a', 'b'], writes: 1, failed: [] }], totals: { attempts: 4, obeyed: 0, influenced: 0, ignored: 4, inconclusive: 0 }, cost: { spent, upstreamRequests: 8, unknownModels: [] } };
  store.putInjectionResult({ resultId: data.resultId, runId, golden: path, sessionId: null, mode: 'plant', at, endedAt: at + 1, attempts: 4, obeyed: 0, influenced: 0, ignored: 4, inconclusive: 0, verdict: 'ignored', actor: null, data });
}
const priced = (runId: string) => pricedCalls(store.getCalls(runId));
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sl-estimates-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' } }).trim();
  git('init', '-q');
  for (const m of ['one', 'two', 'three']) git('commit', '-q', '--allow-empty', '-m', m);
  [LAST, , FIRST] = git('log', '--format=%h').split('\n') as [string, string, string];
  store = Store.open(':memory:');
  dash = await startDashboard({ store, readOnly: false, port: 0, project: { path: dir }, goldens: () => goldens });
});
afterAll(async () => {
  await dash.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
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

describe('Tests’ estimates', () => {
  it('prices Run tests and each golden’s re-run and update as their jobs run, and never one that runs live as free', async () => {
    const replay = addRun(store, { startedAt: T0 + 10, calls: 'lll' });
    const fork = addRun(store, { startedAt: T0 + 11, calls: 'll' });
    const gated = addRun(store, { startedAt: T0 + 12, calls: 'll' });
    const both = addRun(store, { startedAt: T0 + 13, calls: 'l' });
    goldens = [golden('goldens/replay', replay), golden('goldens/fork', fork, { mode: 'fork' }), golden('goldens/gated', gated, { injection: true }), golden('goldens/both', both, { mode: 'fork', injection: true }), golden('goldens/gone', null as never, { error: 'run.json is missing' })];
    const before = await get<TestsEstimates>('tests/estimates');
    expect(Object.keys(before.goldens).sort()).toEqual(['goldens/both', 'goldens/fork', 'goldens/gated', 'goldens/replay']);
    expect(before.run).toMatchObject({ kind: 'tests', usd: null, none: 'no estimate until a session has run' });
    expect(before.goldens['goldens/replay'].rerun).toMatchObject({ kind: 'tests', usd: 0 });
    // A replay golden with an injection gate runs live from each read: no estimate before it has run, never Free.
    for (const path of ['goldens/fork', 'goldens/gated', 'goldens/both']) expect(before.goldens[path].rerun?.usd, path).toBeNull();
    expect(before.goldens['goldens/replay'].update).toEqual(plain(updateEstimate([{ calls: priced(replay) }])));
    expect(before.goldens['goldens/replay'].more).toBeUndefined();

    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: T0 + 20 }).sessionId;
    for (const [path, runId, spent] of [['goldens/replay', replay, 0], ['goldens/fork', fork, 0.02], ['goldens/gated', gated, 0], ['goldens/both', both, 0.03]] as const) store.addTestResult({ sessionId: session, golden: path, ok: true, runId, at: T0 + 21, data: { checks: [], spent } });
    gateSpent(gated, 'goldens/gated', 0.5, T0 + 22);
    gateSpent(both, 'goldens/both', 0.25, T0 + 23);
    const after = await get<TestsEstimates>('tests/estimates');
    expect(after.goldens['goldens/replay'].rerun).toMatchObject({ usd: 0 });
    expect(after.goldens['goldens/fork'].rerun).toEqual(plain(goldenTestEstimate(true, newest('goldens/fork'))));
    expect(after.goldens['goldens/gated'].rerun).toMatchObject({ kind: 'injection', usd: 0.5 });
    expect(after.goldens['goldens/both'].rerun).toEqual(plain(testsEstimate(1, { results: [newest('goldens/both')], injection: [{ spent: 0.25, unknownModels: [] }] })));
    expect(after.goldens['goldens/both'].rerun?.usd).toBeCloseTo(0.28, 10);
    // Run tests: what the last session spent live, with each live golden's gate at what it spent the last time.
    expect(after.run?.usd).toBeCloseTo(0.02 + 0.03 + 0.5 + 0.25, 10);
  });

  it('prices more attempts at its gate’s ceiling, and an update that only lacks a verdict at one judge’s call', async () => {
    const rec = addRun(store, { startedAt: T0 + 40, calls: 'll' });
    const attempts = [addRun(store, { parent: rec, startedAt: T0 + 41, calls: 'rl' }), addRun(store, { parent: rec, startedAt: T0 + 42, calls: 'rll' })];
    const flaky = 'goldens/flaky';
    const sprt = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 20 };
    goldens = [golden(flaky, rec, { mode: 'fork', gate: sprt })];
    const session = store.startTestSession({ command: ['shadowlap', 'test', flaky], startedAt: T0 + 43 }).sessionId;
    const unsure = Array.from({ length: 4 }, () => [true, true, true, true, false]).flat();
    const data: TestResultData = { mode: 'fork', attempts: { total: 20, passed: 16, required: null, runs: attempts }, verdict: 'inconclusive', gate: gateResult(sprt, unsure, { history: null }), spent: 0.4 };
    store.addTestResult({ sessionId: session, golden: flaky, ok: false, failure: 'inconclusive', reason: 'inconclusive', runId: attempts[1], at: T0 + 44, data });
    const more = (await get<TestsEstimates>('tests/estimates')).goldens[flaky].more;
    expect(more).toMatchObject({ kind: 'more', ceiling: true, attempts: 20, parts: ['up to 20 more attempts', 'live from where the golden forks, writes blocked'] });
    expect(more?.usd).toBeGreaterThan(0);

    const judged = 'goldens/judged';
    goldens = [golden(judged, rec, { checks: ['the reply is polite'] })];
    const check = { ok: false, label: 'the reply is polite', detail: null, status: 'inconclusive', judge: { model: 'claude-haiku-4-5', cost: 0.004, offline: false } };
    store.addTestResult({ sessionId: session, golden: judged, ok: false, failure: 'inconclusive', reason: 'inconclusive', runId: rec, at: T0 + 45, data: { checks: [check], verdict: 'inconclusive' } as never });
    const update = (await get<TestsEstimates>('tests/estimates')).goldens[judged].update;
    expect(update).toEqual(plain(updateEstimate([{ calls: [], judge: 0.004 }])));
  });
});

describe('Find breaking commit’s estimate', () => {
  it('waits for a commit to start from, then counts the commits with git and prices the search as it runs', async () => {
    const rec = addRun(store, { startedAt: T0 + 50, calls: 'll' });
    const attempt = addRun(store, { parent: rec, startedAt: T0 + 51, calls: 'rl' });
    goldens = [golden('goldens/forked', rec, { mode: 'fork', repeat: 3 }), golden('goldens/replayed', rec)];
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/forked'], startedAt: T0 + 52 }).sessionId;
    store.addTestResult({ sessionId: session, golden: 'goldens/forked', ok: true, runId: attempt, at: T0 + 53, data: { checks: [], spent: 0.01, attempts: { total: 1, passed: 1, required: 1, runs: [attempt] } } });
    const bisect = async (q: string) => (await get<{ estimate: unknown }>(`estimates/bisect?${q}`)).estimate;
    expect(await bisect('golden=goldens/forked')).toEqual(plain(noEstimate('bisect', 'no estimate until it has a commit to start from')));
    // Two commits after FIRST up to HEAD: three tested, three attempts each.
    expect(await bisect(`golden=goldens/forked&good=${FIRST}`)).toMatchObject({ kind: 'bisect', ceiling: true, attempts: bisectCommits(2) * 3, parts: [expect.stringContaining('3 attempts each'), 'live at each commit, as a golden marked fork runs'] });
    expect(await bisect(`golden=goldens/forked&good=${FIRST}&bad=${LAST}~1`)).toMatchObject({ attempts: bisectCommits(1) * 3 });
    expect(await bisect(`golden=goldens/replayed&good=${FIRST}`)).toMatchObject({ kind: 'bisect', usd: 0 });
    // A run that failed on its own replays live at each commit; its own commit isn't in this checkout, so up to HEAD.
    const failed = addRun(store, { startedAt: T0 + 54, status: 'failed', calls: 'lll' });
    expect(await bisect(`runId=${failed}&good=${FIRST}`)).toEqual(plain(runBisectEstimate(priced(failed), 2)));
    const passed = addRun(store, { startedAt: T0 + 55, calls: 'll' });
    expect(await bisect(`runId=${passed}&good=${FIRST}`)).toMatchObject({ kind: 'bisect', usd: 0 });
  });

  it('refuses what it can’t search, and says why a job it would refuse has no price', async () => {
    const rec = addRun(store, { startedAt: T0 + 60, calls: 'l' });
    goldens = [golden('goldens/one', rec)];
    for (const q of ['good=abc', `runId=${rec}&golden=goldens/one&good=${FIRST}`, `golden=goldens/one&good=--all`, `golden=goldens/one&good=${FIRST}&bad=a..b`]) expect((await api(`estimates/bisect?${q}`)).status, q).toBe(400);
    expect((await api(`estimates/bisect?golden=goldens/other&good=${FIRST}`)).status).toBe(404);
    expect((await api(`estimates/bisect?runId=01ZZZZZZZZZZZZZZZZZZZZZZZZ&good=${FIRST}`)).status).toBe(404);
    const running = addRun(store, { startedAt: T0 + 61, status: 'running', calls: 'l' });
    expect((await get<{ estimate: unknown }>(`estimates/bisect?runId=${running}&good=${FIRST}`)).estimate).toMatchObject({ kind: 'bisect', usd: null, none: 'this run is still recording' });
    expect((await get<{ estimate: unknown }>(`estimates/bisect?golden=goldens/one&good=nosuchcommit`)).estimate).toMatchObject({ usd: null, none: 'git could not say how many commits it would search' });
  });
});
