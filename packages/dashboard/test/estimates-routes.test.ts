import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bisectCommits,
  blameEstimate,
  decideVerify,
  decisionRunCost,
  DEFAULT_REPAIRER,
  fixRecords,
  fixRunArgs,
  forkEstimate,
  gateResult,
  goldenTestEstimate,
  injectionAgainEstimate,
  noEstimate,
  pricedCalls,
  recordBlame,
  recordVerdict,
  repairEstimate,
  repeatEstimate,
  resolveFix,
  runBisectEstimate,
  selectedRuns,
  SPRT_DEFAULTS,
  Store,
  testsEstimate,
  updateEstimate,
  verifyEstimate,
  verifyMoreEstimate,
  verifyRunCosts,
  type BlameReport,
  type DecisionRun,
  type RunMeta,
  type SprtGate,
  type TestResultData,
} from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, ORACLE, verifyReport } from '../../engine/test/fix-fixtures.js';
import type { ProjectConfig } from '../src/context.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import type { ConfigVerifyRule, DecisionEstimates, FixEstimates, RunEstimates, TestsEstimates } from '../src/estimates.js';
import { fixDetail } from '../src/fixes.js';
import { pricingOf } from '../src/pricing.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun, MODEL } from './read-model-store.js';

/**
 * The estimates a page asks for over HTTP, each worked out beside the server: a run's Run blame and
 * its fork menu's rows, Tests' buttons and Find breaking commit's, the engine's figure for each as the
 * job runs, Free for one that runs nothing live, and none for a row with nothing to bill. The project
 * is a repository of three commits, `FIRST` to `LAST`, and its config is `config`.
 */

const T0 = Date.now() - 3_600_000;

let store: Store;
let dash: Dashboard;
let dir: string;
let goldens: GoldenSource[] = [];
let FIRST: string;
let LAST: string;
const NO_CONFIG: ProjectConfig = { normalize: [], redact: [] };
let config = NO_CONFIG;

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
  dash = await startDashboard({ store, readOnly: false, port: 0, project: { path: dir }, goldens: () => goldens, loadConfig: () => config });
});
afterAll(async () => {
  await dash.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the estimates’ routes', () => {
  it('answer only with the session token', async () => {
    for (const path of ['runs/01ZZZZZZZZZZZZZZZZZZZZZZZZ/estimates', 'fixes/fx-nosuchfix/estimates', 'tests/estimates', 'estimates/bisect?golden=goldens/one', 'decisions/dc-01ZZZZZZZZZZZZZZZZZZZZZZZZ/estimates']) expect((await fetch(`${dash.url}/api/${path}`)).status, path).toBe(401);
  });
});

describe('what an answer reads', () => {
  it('prices a run’s calls once, however many of its estimates read them, keeping only the last few runs', () => {
    const rec = addRun(store, { startedAt: T0 + 90, calls: 'lll' });
    const p = pricingOf(store, undefined);
    const first = p.calls(rec);
    expect(p.calls(rec)).toBe(first);
    expect(p.raw(rec)).toBe(p.raw(rec));
    // An answer over every golden of Tests holds no more than the last four it read.
    for (let i = 0; i < 4; i++) p.calls(addRun(store, { startedAt: T0 + 91 + i, calls: 'l' }));
    const again = p.calls(rec);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });
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

  it('prices Force live from the tool’s first call, as the replay forces it there', async () => {
    const rec = addRun(store, { startedAt: T0 + 3, calls: 'lolol' });
    const later = await get(`runs/${rec}/estimates?at=4`);
    expect(later.actions.l).toEqual(plain(forkEstimate(priced(rec), { at: 2, write: true })));
    expect(later.actions.l.usd).toBeGreaterThan(plain(forkEstimate(priced(rec), { at: 4, write: true })).usd!);
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

  it('never answers a changed price with the last one’s figures', async () => {
    const rec = addRun(store, { startedAt: T0 + 4, calls: 'll' });
    const first = await api(`runs/${rec}/estimates?at=1`);
    const etag = first.headers.get('etag')!;
    const before = (await first.json()) as RunEstimates;
    const dear = await startDashboard({ store, readOnly: false, port: 0, project: { path: dir }, goldens: () => goldens, prices: { [MODEL]: { input: 300, output: 1500 } } });
    try {
      const res = await fetch(`${dear.url}/api/runs/${rec}/estimates?at=1`, { headers: { 'x-shadowlap-token': dear.token, 'if-none-match': etag } });
      expect(res.status).toBe(200);
      const after = (await res.json()) as RunEstimates;
      expect(after.actions.a.usd).toBeGreaterThan(before.actions.a.usd!);
      expect(after.actions.a).toEqual(plain(forkEstimate(pricedCalls(store.getCalls(rec), { prices: { [MODEL]: { input: 300, output: 1500 } } }), { at: 1, prices: { [MODEL]: { input: 300, output: 1500 } } })));
    } finally {
      await dear.close();
    }
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
    expect(before.goldens['goldens/gated'].rerun).toEqual(plain(injectionAgainEstimate(null)));
    expect(before.goldens['goldens/gated'].rerun).toMatchObject({ kind: 'injection', none: 'no estimate until its injection test has run once' });
    expect(before.goldens['goldens/both'].rerun).toMatchObject({ kind: 'tests', none: 'no estimate until it has run once' });
    expect(before.goldens['goldens/replay'].update).toEqual(plain(updateEstimate([{ calls: priced(replay) }])));
    expect(before.goldens['goldens/replay'].more).toBeUndefined();
    // Update goldens… for the goldens named, as one update; a path that is no golden on disk is left out.
    expect(before.update).toBeUndefined();
    const several = await get<TestsEstimates>('tests/estimates?update=goldens/replay&update=goldens/fork&update=goldens/nosuch');
    expect(several.update).toEqual(plain(updateEstimate([{ calls: priced(replay) }, { calls: priced(fork) }])));
    expect(several.update).toMatchObject({ always: 'it replaces goldens', parts: ['as their recordings cost'] });

    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: T0 + 20 }).sessionId;
    for (const [path, runId, spent] of [['goldens/replay', replay, 0], ['goldens/fork', fork, 0.02], ['goldens/gated', gated, 0], ['goldens/both', both, 0.03]] as const) store.addTestResult({ sessionId: session, golden: path, ok: true, runId, at: T0 + 21, data: { checks: [], spent } });
    // Tested, but no injection gate has run yet: what each gate bills is unknown, so neither is Run tests'.
    const tested = await get<TestsEstimates>('tests/estimates');
    expect(tested.goldens['goldens/both'].rerun).toMatchObject({ kind: 'tests', usd: null, none: 'no estimate until its injection test has run once' });
    expect(tested.run).toMatchObject({ kind: 'tests', usd: null, none: 'no estimate until every golden that runs live has run once' });
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

    // A session that re-ran one golden says nothing of the others: each is priced at its own newest test.
    const one = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/fork'], startedAt: T0 + 30 }).sessionId;
    store.addTestResult({ sessionId: one, golden: 'goldens/fork', ok: true, runId: fork, at: T0 + 31, data: { checks: [], spent: 0.01 } });
    expect((await get<TestsEstimates>('tests/estimates')).run?.usd).toBeCloseTo(0.01 + 0.03 + 0.5 + 0.25, 10);
    // A golden marked fork that has never run leaves Run tests with no estimate, so it asks.
    goldens = [...goldens, golden('goldens/new', addRun(store, { startedAt: T0 + 32, calls: 'l' }), { mode: 'fork' })];
    expect((await get<TestsEstimates>('tests/estimates')).run).toMatchObject({ usd: null, none: 'no estimate until every golden that runs live has run once' });
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

  it('prices Add normalizer as the re-run it ends in, or as the update where its rule alone can’t make the replay match', async () => {
    const masked = addRun(store, { startedAt: T0 + 40, calls: 'll' });
    const more = addRun(store, { startedAt: T0 + 41, calls: 'll' });
    goldens = [golden('goldens/masked', masked), golden('goldens/more', more)];
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], startedAt: T0 + 42 }).sessionId;
    const diverged = (path: string, runId: string, diff: unknown[]) =>
      store.addTestResult({ sessionId: session, golden: path, ok: false, failure: 'diverged', reason: 'diverged at call 1 (api POST /v1/messages)', runId, at: T0 + 43, data: { mode: 'replay', divergence: { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff, text: '✗ Diverged at call 1 (api POST /v1/messages)' } } as TestResultData });
    // A value that changes every run, alone; and with a change of the prompt that no rule masks.
    const id = { path: '$.metadata.user_id', op: 'changed', before: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', after: '6fa459ea-ee8a-4ca4-894e-db77e160355e' };
    diverged('goldens/masked', masked, [id]);
    diverged('goldens/more', more, [id, { path: '$.messages[0].content', op: 'changed', before: 'Refund order A-1131.', after: 'Refund order A-1132.' }]);
    const est = (await get<TestsEstimates>('tests/estimates')).goldens;
    expect(est['goldens/masked'].normalize).toEqual(est['goldens/masked'].rerun);
    expect(est['goldens/masked'].normalize).toMatchObject({ kind: 'tests', usd: 0 });
    expect(est['goldens/more'].normalize).toEqual(est['goldens/more'].update);
    expect(est['goldens/more'].normalize).not.toEqual(est['goldens/more'].rerun);
    expect(est['goldens/more'].normalize).toEqual(plain(updateEstimate([{ calls: priced(more) }])));
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

describe('a fix’s estimates', () => {
  /** A blame of `runId` kept with its fix, as the CLI records one. */
  const blame = (runId: string, report: BlameReport) => recordBlame(store, { runId, report, expect: EXPECT, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, rerun: { flags: [], command: null }, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' }).fix.fixId;
  const RULE = { keptMax: null, baseline: 'paired' as const };

  it('prices Run repair as its command runs: a blame of each failing run only where the repair can’t reuse one', async () => {
    const failing = addRun(store, { startedAt: T0 + 70, status: 'failed', calls: 'lllll', meta: { labels: ['refund-bug'] } });
    const good = addRun(store, { startedAt: T0 + 71, calls: 'll', meta: { labels: ['good'] } });
    const fixId = blame(failing, blameReport(failing));
    const plan = (reused: { outcome: 'blamed' } | null) => repairEstimate({ failing: [{ runId: failing, startedAt: store.getRun(failing)!.startedAt, calls: priced(failing), blame: reused }], good: [{ calls: priced(good) }], scope: null, rule: RULE, repairer: DEFAULT_REPAIRER, noFix: null, last: null });
    const fresh = await get<FixEstimates>(`fixes/${fixId}/estimates`);
    expect(fresh).toEqual({ repair: plain(plan(null)), blameAgain: null, blameStronger: null, verify: {}, verifyLeft: null });
    expect(fresh.repair).toMatchObject({ kind: 'repair', ceiling: true, parts: ['a new blame, then up to 3 candidates', 'each verified up to twice', 'live from each run’s first model call, writes stubbed'] });
    // The blame stored on the run, under the fix's check, with the fork that rescued it: reused, not priced again.
    const rescue = addRun(store, { parent: failing, startedAt: T0 + 72, calls: 'rl' });
    store.updateRunMeta(failing, { blame: { at: 2, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: rescue, fields: {}, oracle: ORACLE, probes: [], spent: 0.03 } });
    const reused = await get<FixEstimates>(`fixes/${fixId}/estimates`);
    expect(reused.repair).toEqual(plain(plan({ outcome: 'blamed' })));
    expect(reused.repair!.parts[0]).toBe('up to 3 candidates');
    expect(reused.repair!.usd).toBeLessThan(fresh.repair!.usd!);
    // Every failing run's reused blame rescued it from no call: the repair ends "No fix to try" before it runs anything.
    const lost = addRun(store, { startedAt: T0 + 73, status: 'failed', calls: 'll', meta: { labels: ['lost-bug'] } });
    const lostFix = blame(lost, blameReport(lost, 'unrescuable'));
    store.updateRunMeta(lost, { blame: { at: 2, outcome: 'unrescuable', callNo: null, confidence: 'high', rescuedRunId: null, fields: {}, oracle: ORACLE, probes: [], spent: 0.03 } });
    expect((await get<FixEstimates>(`fixes/${lostFix}/estimates`)).repair).toMatchObject({ kind: 'repair', usd: 0, parts: [expect.stringMatching(/^nothing runs: the blame it reuses/)] });
    expect((await api('fixes/fx-nosuchfix/estimates')).status).toBe(404);
    expect((await api(`fixes/${fixId}/estimates?model=--help`)).status).toBe(400);
  });

  it('prices Run blame again by the gate or count its command carries, and with a stronger model at the model typed', async () => {
    const stopped = makeRun(store, { labels: ['stopped-bug'], calls: ['api', 'tool', 'api'] });
    const again = blameReport(stopped, 'stopped');
    const est = await get<FixEstimates>(`fixes/${blame(stopped, again)}/estimates`);
    expect(est.blameStronger).toBeNull();
    expect(est.blameAgain).toEqual(plain(blameEstimate(priced(stopped), { attempts: 5, scope: null, model: null, last: again })));

    const unrescued = makeRun(store, { labels: ['unrescued-bug'], calls: ['api', 'tool', 'api'] });
    const report = blameReport(unrescued, 'unrescuable');
    const fixId = blame(unrescued, report);
    expect(fixDetail(store, fixId)!.actions.blameStronger).not.toBeNull();
    const stronger = await get<FixEstimates>(`fixes/${fixId}/estimates`);
    expect(stronger.blameAgain).toBeNull();
    expect(stronger.blameStronger).toEqual(plain(blameEstimate(priced(unrescued), { attempts: 5, scope: null, model: 'claude-opus-5-5', last: report })));
    const haiku = await get<FixEstimates>(`fixes/${fixId}/estimates?model=claude-haiku-4-5`);
    expect(haiku.blameStronger).toEqual(plain(blameEstimate(priced(unrescued), { attempts: 5, scope: null, model: 'claude-haiku-4-5', last: report })));
  });

  const GATE: SprtGate = { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 };
  /** A fix of a failing run whose verify stopped part way, with its budget of $0.012: by that budget, or at an attempt it couldn't judge (`undecided`). */
  function incomplete(label: string, o: { undecided?: string } = {}) {
    const failing = makeRun(store, { labels: [label] });
    const good = makeRun(store, { labels: ['good'], status: 'completed' });
    const fixId = recordBlame(store, { runId: failing, report: blameReport(failing), expect: { tools: { send_email: 1 } }, scope: null, command: 'shadowlap blame', title: 'send_email called twice', checkText: 'send_email called once' }).fix.fixId;
    const report = verifyReport([{ runId: failing, role: 'target', pass: true }, { runId: good, role: 'good', pass: true, deterministic: true }]);
    const outcomes = [true, true, true, true];
    const target = report.runs[0];
    report.runs[0] = { ...target, attempts: outcomes.map((passed, i) => ({ ...target.attempts[0], runId: `${target.attempts[0].runId.slice(0, 20)}${String(i).padStart(6, '0')}`, passed })), passes: 4, verdict: 'open', decision: 'continue', gate: gateResult(GATE, outcomes, {}), ...(o.undecided ? { undecided: o.undecided } : {}) };
    report.gate = GATE;
    report.attemptsPerRun = GATE.max;
    const stopReason = o.undecided ? null : 'the budget of $0.01 is spent';
    Object.assign(report, decideVerify(report.runs, stopReason), { stopReason, attempts: 5, spent: 0.016 });
    const { verdict } = recordVerdict(store, { report, expect: { tools: { send_email: 1 } }, command: `shadowlap verify --fixes label:${label} --keeps label:good --budget 0.012`, rerun: { flags: ['--budget', '0.012'], command: null } });
    return { fixId, report, verifyId: verdict.verifyId, more: fixDetail(store, fixId)!.verify[0].more! };
  }

  it('prices a Verify step’s Run more attempts from the start up to its limit, at what its attempts cost', async () => {
    const { fixId, report, verifyId, more } = incomplete('double-email');
    expect(more).toMatchObject({ kind: 'more', max: 80 });
    const est = await get<FixEstimates>(`fixes/${fixId}/estimates`);
    expect(est.verify).toEqual({ [verifyId]: plain(verifyMoreEstimate(verifyRunCosts(report), { expected: more.expected, cost: more.cost }, { rule: { ...RULE, gate: GATE }, last: report })) });
    expect(est.verify[verifyId]).toMatchObject({ kind: 'verify', ceiling: true });
    expect(est.verify[verifyId].stops).toBeUndefined();
  });

  it('prices Verify again as it runs, stopping at the budget it ran with', async () => {
    const { fixId, report, verifyId, more } = incomplete('unjudged-email', { undecided: 'judge "sent-once" could not answer: no key for anthropic' });
    expect(more).toMatchObject({ kind: 'again', max: 80 });
    expect(more.argv.slice(-2)).toEqual(['--budget', '0.012']);
    const est = await get<FixEstimates>(`fixes/${fixId}/estimates`);
    expect(est.verify[verifyId]).toEqual(plain(verifyEstimate(verifyRunCosts(report), { rule: { ...RULE, gate: GATE }, last: report, budget: 0.012 })));
    expect(est.verify[verifyId]).toMatchObject({ kind: 'verify', ceiling: true, stops: 0.012 });
    expect(est.verify[verifyId].usd).toBeGreaterThan(0.012);
  });

  it('verifies as the config says: the most pairs a good run takes, and what it is kept against', async () => {
    const failing = addRun(store, { startedAt: T0 + 80, status: 'failed', calls: 'lllll', meta: { labels: ['config-bug'] } });
    addRun(store, { startedAt: T0 + 81, calls: 'll', meta: { labels: ['good'] } });
    const fixId = blame(failing, blameReport(failing));
    // The good runs its command keeps passing, as the repair selects them.
    const keeps = selectedRuns(store, ['--keeps', ...fixRunArgs(store, fixRecords(store, resolveFix(store, fixId)!))!.keeps]).map((r) => ({ calls: priced(r.runId) }));
    const plan = (rule: ConfigVerifyRule) => plain(repairEstimate({ failing: [{ runId: failing, startedAt: store.getRun(failing)!.startedAt, calls: priced(failing), blame: null }], good: keeps, scope: null, rule, repairer: DEFAULT_REPAIRER, noFix: null, last: null }));
    config = { ...NO_CONFIG, verify: { max: 40, baseline: 'history' } };
    try {
      const est = await get<FixEstimates>(`fixes/${fixId}/estimates`);
      expect(est.repair).toEqual(plan({ keptMax: 40, baseline: 'history' }));
      expect(est.repair).not.toEqual(plan(RULE));
      const { fixId: verified, report, verifyId, more } = incomplete('config-email');
      const v = (await get<FixEstimates>(`fixes/${verified}/estimates`)).verify[verifyId];
      expect(v).toEqual(plain(verifyMoreEstimate(verifyRunCosts(report), { expected: more.expected, cost: more.cost }, { rule: { keptMax: 40, baseline: 'history', gate: GATE }, last: report })));
    } finally {
      config = NO_CONFIG;
    }
  });
});

describe('a kept preview’s Verify', () => {
  const RULE: ConfigVerifyRule = { keptMax: null, baseline: 'paired' };
  /** A run of a session, as decisions keeps it: what it costs as recorded and under the change. */
  const decided = (runId: string, golden: string | null, before: number | null, after: number | null) =>
    ({ runId, golden, steps: 2, asked: 2, rank: 1, majority: 1, counts: {}, cost: { before, after, spent: 0.001 }, tokens: {}, thinkingStripped: 0, refused: null, decisions: [], warnings: [] }) as unknown as DecisionRun;
  /** A session of `rows`, whose report leaves `toVerify` to verify of the runs it `flagged`. */
  function session(id: string, rows: DecisionRun[], o: { toVerify?: string[]; flagged?: string[]; fromCode?: boolean } = {}): void {
    const change = { model: o.fromCode ? null : 'claude-haiku-4-5', fields: {}, from: null, fromCode: o.fromCode ? { calls: 1, instructions: null, tools: { added: [], removed: [], changed: [] }, codeVersion: null } : null, text: 'the model claude-haiku-4-5' };
    const flagged = o.flagged ?? rows.map((r) => r.runId);
    const data = { change, flagged, ...(o.toVerify ? { toVerify: o.toVerify } : {}), verify: null };
    store.putDecisionSession({ sessionId: id, kind: 'decisions', at: T0, change: change.text, actor: null, revision: null, data, runs: rows.map((r) => ({ runId: r.runId, golden: r.golden, rank: 1, changed: 1, data: r as unknown as Record<string, unknown> })) });
  }

  it('verifies each run it couldn’t clear in the role its recording plays under its checks, at what it costs under the change', async () => {
    // A golden that exits 0 but fails its tests entry as recorded, a run that passes (it has no checks), one that exited 1, and one
    // the preview flagged but cleared.
    const checked = makeRun(store, { status: 'completed', calls: ['api', 'tool'] });
    const passing = makeRun(store, { status: 'completed', calls: ['api'], meta: { imported: { from: 'goldens/unlisted' } } });
    const broken = makeRun(store, { status: 'failed', calls: ['api'] });
    const cleared = makeRun(store, { status: 'completed', calls: ['api'] });
    const rows = [decided(checked, 'goldens/refund', 0.004, 0.002), decided(passing, null, 0.004, 0.002), decided(broken, null, 0.004, 0.003), decided(cleared, null, 0.004, 0.002)];
    session('dc-01M5000000000000000000000V', rows, { toVerify: [checked, passing, broken] });
    const expected = (picked: Array<[DecisionRun, boolean]>, live: 'first' | 'fork' = 'first') => plain(verifyEstimate(picked.map(([r, failed]) => decisionRunCost(r, failed)), { rule: RULE, live, writes: 'stub' }));
    const configFile = join(dir, 'shadowlap.config.json');
    writeFileSync(configFile, JSON.stringify({ tests: { 'goldens/refund': { expect: { tools: { lookup_order: { count: 0 } } } } } }));
    try {
      const all = await get<DecisionEstimates>('decisions/dc-01M5000000000000000000000V/estimates');
      expect(all.verify).toEqual(expected([[rows[0], true], [rows[1], false], [rows[2], true]]));
      expect(all.verify!.parts).toEqual(['up to 80 attempts a failing run, 200 pairs a good one', 'live from the first model call, writes stubbed']);
      // Each run in its role, for Verify's rows.
      expect(all.runs).toEqual([{ runId: checked, role: 'target' }, { runId: passing, role: 'good' }, { runId: broken, role: 'target' }]);
      // Run more attempts' raised limits, as its job passes them: verify's gate with its max raised, and a good run's pairs.
      const more = await get<DecisionEstimates>('decisions/dc-01M5000000000000000000000V/estimates?max=160&keptMax=400');
      expect(more.verify).toEqual(plain(verifyEstimate([decisionRunCost(rows[0], true), decisionRunCost(rows[1], false), decisionRunCost(rows[2], true)], { rule: { ...RULE, gate: { kind: 'sprt', ...SPRT_DEFAULTS, max: 160 }, keptMax: 400 }, live: 'first', writes: 'stub' })));
      expect(more.verify!.parts[0]).toBe('up to 160 attempts a failing run, 400 pairs a good one');
      expect((await api('decisions/dc-01M5000000000000000000000V/estimates?max=1001')).status).toBe(400);
      expect((await api('decisions/dc-01M5000000000000000000000V/estimates?keptMax=two')).status).toBe(400);
      // One run, named by a prefix; one the preview cleared has nothing to verify.
      expect((await get<DecisionEstimates>(`decisions/dc-01M5000000000000000000000V/estimates?runId=${passing.slice(0, 22)}`)).verify).toEqual(expected([[rows[1], false]]));
      expect(await get<DecisionEstimates>(`decisions/dc-01M5000000000000000000000V/estimates?runId=${cleared}`)).toEqual({ verify: null, runs: [] });
      // Several, as Preview names the runs no verify took yet: each priced in its role; one the preview cleared among them, nothing to verify there.
      expect((await get<DecisionEstimates>(`decisions/dc-01M5000000000000000000000V/estimates?runId=${passing}&runId=${broken}`)).verify).toEqual(expected([[rows[1], false], [rows[2], true]]));
      expect((await get<DecisionEstimates>(`decisions/dc-01M5000000000000000000000V/estimates?runId=${passing}&runId=${cleared}`)).verify).toBeNull();
    } finally {
      rmSync(configFile, { force: true });
    }
    // With no entry for it, the golden passes as recorded, so it must keep passing.
    expect((await get<DecisionEstimates>(`decisions/dc-01M5000000000000000000000V/estimates?runId=${checked}`)).verify).toEqual(expected([[rows[0], false]]));
    // A session kept before it said which runs it couldn't clear verifies those it flagged; one from the code forks where a request differs.
    session('dc-01M5000000000000000000000W', rows.slice(1, 3), { fromCode: true });
    expect((await get<DecisionEstimates>('decisions/dc-01M5000000000000000000000W/estimates')).verify).toEqual(expected([[rows[1], false], [rows[2], true]], 'fork'));
    // A run with no price under the change has none; a session cleared of every run, or one that isn't there, has nothing to verify.
    session('dc-01M5000000000000000000000X', [decided(passing, null, 0.004, null)]);
    expect((await get<DecisionEstimates>('decisions/dc-01M5000000000000000000000X/estimates')).verify).toMatchObject({ usd: null, parts: ['up to 200 pairs a run against its baseline', 'live from the first model call, writes stubbed', 'a model of the run has no price'] });
    session('dc-01M5000000000000000000000Y', rows.slice(3), { flagged: [] });
    expect((await get<DecisionEstimates>('decisions/dc-01M5000000000000000000000Y/estimates')).verify).toBeNull();
    expect((await api('decisions/dc-01M5000000000000000000000Z/estimates')).status).toBe(404);
  });
});
