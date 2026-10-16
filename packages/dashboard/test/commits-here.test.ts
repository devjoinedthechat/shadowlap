import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type TestResultData } from '@shadowlap/engine';
import { startDashboard, type Dashboard, type GoldenSource, type JobView, type SpawnCli, type TestsView } from '../src/index.js';

/**
 * Find the commit offers only commits this checkout has, on a run's page, on Tests and in the job
 * they start, as the Runs calendar does: with a team store, a teammate's pulled runs and CI's test
 * sessions name commits of their own checkout, which bisect can't start from or stop at here.
 */
const FAKE = fileURLToPath(new URL('./fake-tests-cli.mjs', import.meta.url));
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 10, 0);
// Commits of a teammate's checkout (or a pull request's merge commit in CI), never fetched here.
const THEIRS = '1fb4209c0ffee00000000000000000000000beef';
const THEIRS_TOO = '2fb4209c0ffee00000000000000000000000beef';

let repo: string;
let first: string;
let second: string;
let store: Store;
let dash: Dashboard;
const ids: Record<string, string> = {};

const spawnCli: SpawnCli = (args, options) =>
  spawn(process.execPath, [FAKE, ...args], {
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...(options?.events ? { SHADOWLAP_EVENTS_FD: '3' } : {}) },
    stdio: options?.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });

const goldens: GoldenSource[] = [
  { path: 'goldens/refund-flow', runId: 'GOLDEN_FLOW', packedAt: T0 - 9 * DAY, mode: 'replay', repeat: 1, passes: 1, checks: [] },
  { path: 'goldens/refund-limit', runId: 'GOLDEN_LIMIT', packedAt: T0 - 9 * DAY, mode: 'replay', repeat: 1, passes: 1, checks: [] },
];

const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const getJson = async <T>(path: string): Promise<T> => {
  const res = await api(path);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
};
async function job(body: unknown): Promise<JobView> {
  const res = await api('jobs', { method: 'POST', body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(202);
  const started = (await res.json()) as JobView;
  for (let i = 0; i < 400; i++) {
    const view = await getJson<JobView>(`jobs/${started.id}`);
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${started.id} did not finish`);
}

beforeAll(async () => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-commits-here-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
  git('init', '-q', '.');
  writeFileSync(join(repo, 'policy.txt'), 'refund limit 100\n');
  git('add', '-A');
  git('commit', '-qm', 'Start');
  first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'policy.txt'), 'refund limit 50\n');
  git('commit', '-qam', 'Tighten');
  second = git('rev-parse', 'HEAD');

  store = Store.open(':memory:');
  const run = (codeVersion: string, at: number, status: 'completed' | 'failed') => {
    const r = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: repo }, codeVersion, startedAt: at });
    store.endRun(r.runId, status);
    return r.runId;
  };
  ids.passedHere = run(first, T0 - 3 * DAY, 'completed');
  ids.passedTheirs = run(THEIRS_TOO, T0 - 2 * DAY, 'completed');
  // A teammate's failure, pulled: its own commit is theirs.
  ids.failedTheirs = run(THEIRS, T0 - DAY, 'failed');
  // One that failed here, at a commit this checkout has.
  ids.failedHere = run(second, T0, 'failed');

  // CI's test sessions: refund-flow last passed at a merge commit this checkout never had; refund-limit
  // passed here and then failed at a teammate's commit.
  const ok: TestResultData = { mode: 'replay', calls: { total: 4, replayed: 4, live: 0, blocked: 0, stubbed: 0 } };
  const session = (revision: string, at: number, results: Array<{ golden: string; ok: boolean }>) => {
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision, actor: 'ci', startedAt: at });
    for (const [i, r] of results.entries()) {
      store.addTestResult({ sessionId: s.sessionId, golden: r.golden, ok: r.ok, ...(r.ok ? {} : { failure: 'exit' as const, reason: 'the agent exited with code 1' }), runId: null, goldenRunId: r.golden === 'goldens/refund-flow' ? 'GOLDEN_FLOW' : 'GOLDEN_LIMIT', revision, at: at + i + 1, data: ok });
    }
    store.finishTestSession(s.sessionId, { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, upstreamRequests: 0, endedAt: at + 10 });
  };
  session(first, T0 - 3 * DAY, [{ golden: 'goldens/refund-limit', ok: true }]);
  session(THEIRS_TOO, T0 - 2 * DAY, [{ golden: 'goldens/refund-flow', ok: true }]);
  session(THEIRS, T0 - DAY, [
    { golden: 'goldens/refund-flow', ok: false },
    { golden: 'goldens/refund-limit', ok: false },
  ]);

  dash = await startDashboard({ store, spawnCli, readOnly: false, project: { path: repo }, goldens: () => goldens });
});

afterAll(async () => {
  await dash?.close();
  store?.close();
  rmSync(repo, { recursive: true, force: true });
});

interface Choices {
  good: string | null;
  bad: string | null;
  revisions: Array<{ rev: string }>;
  args: string[] | null;
}

describe('Find the commit in this checkout', () => {
  it('offers a teammate’s failure only the commits here, up to HEAD, on its page and to the job', async () => {
    const expected = { good: first, bad: null, revisions: [expect.objectContaining({ rev: first })], args: ['bisect', ids.failedTheirs, '--good', first, '--fork'] };
    expect((await getJson<{ bisect: Choices }>(`tests/runs/${ids.failedTheirs}`)).bisect).toMatchObject(expected);
    expect((await getJson<{ bisect: Choices }>(`runs/${ids.failedTheirs}/offers`)).bisect).toMatchObject(expected);
    // The page sends the good commit alone; the job then searches up to HEAD, not up to theirs.
    expect((await job({ kind: 'bisect', runId: ids.failedTheirs, good: first })).args).toEqual(['bisect', ids.failedTheirs, '--good', first, '--fork']);
  });

  it('still stops at the commit where a run failed when this checkout has it', async () => {
    const offered = (await getJson<{ bisect: Choices }>(`tests/runs/${ids.failedHere}`)).bisect;
    expect(offered).toMatchObject({ good: first, bad: second });
    expect(offered.revisions.map((r) => r.rev)).toEqual([first]);
    expect((await job({ kind: 'bisect', runId: ids.failedHere, good: first })).args).toEqual(['bisect', ids.failedHere, '--good', first, '--bad', second, '--fork']);
  });

  it('on Tests, asks for a good commit when a golden last passed at one this checkout lacks, and searches up to HEAD past theirs', async () => {
    const view = await getJson<TestsView>('tests');
    const bisect = Object.fromEntries(view.failures.map((f) => [f.golden, f.bisect]));
    expect(bisect['goldens/refund-flow']).toBeNull();
    expect(bisect['goldens/refund-limit']).toEqual({ good: first, bad: null, args: ['bisect', 'goldens/refund-limit', '--good', first], live: false });
  });
});
