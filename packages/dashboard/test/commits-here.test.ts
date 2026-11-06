import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type TestResultData } from '@shadowlap/engine';
import { parentlessHere } from '../src/commits-here.js';
import { commitsHere, commitSubjects, forgetCommits, startDashboard, type Dashboard, type GoldenSource, type JobView, type SpawnCli, type TestsView } from '../src/index.js';
import type { DaysBisect } from '../src/routes/runs-list.js';

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
  // Another agent, which failed at the repository's first commit, before any of them.
  const digest = store.createRun({ mode: 'record', command: { argv: ['node', 'digest.mjs'], cwd: repo }, codeVersion: first, startedAt: T0 - 4 * DAY });
  store.endRun(digest.runId, 'failed');
  ids.failedAtFirst = digest.runId;

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
    // Its dialog offers the commits it was tested at that are here, each with its subject.
    const revisions = Object.fromEntries(view.failures.map((f) => [f.golden, f.revisions]));
    expect(revisions['goldens/refund-flow']).toEqual([]);
    expect(revisions['goldens/refund-limit']).toEqual([{ rev: first, at: T0 - 3 * DAY + 1, result: 'pass', verdict: 'passed', sameChecks: true, subject: 'Start' }]);
    // The history's revisions, each named by its commit's subject where this checkout has it, by no
    // one (no team store is set); and a verdict of a commit git doesn't have is never called older.
    expect(view.revisions).toContain(first);
    expect(view.revisionFacts).toEqual(view.revisions.map((rev) => ({ rev, subject: rev === first ? 'Start' : null, by: null })));
    expect(view.older).toBe(false);
  });

  it('offers no search from a failure at the first commit, and on the calendar the first failure that started later', async () => {
    const why = `${ids.failedAtFirst.slice(0, 10)} failed at the first commit, ${first}: there is nothing before it to search`;
    expect((await getJson<{ bisect: Choices & { first?: boolean; unavailable: string | null } }>(`runs/${ids.failedAtFirst}/offers`)).bisect).toMatchObject({ first: true, good: null, args: null, unavailable: why });
    // The first failure on the days picked failed there: the first that failed later is offered, saying why.
    const later = await getJson<DaysBisect>(`runs/bisect?from=${T0 - 5 * DAY}&to=${T0 + DAY}`);
    expect(later).toMatchObject({ runId: ids.failedTheirs, earlier: { runId: ids.failedAtFirst, why } });
    if (later.runId) expect(later.choices.first).toBeUndefined();
    // None started later on the days picked: the first failure says there is nothing to search.
    const none = await getJson<DaysBisect>(`runs/bisect?from=${T0 - 5 * DAY}&to=${T0 - 3 * DAY - 1}`);
    expect(none).toMatchObject({ runId: ids.failedAtFirst, choices: { first: true, args: null, unavailable: `${why}, and no failure on the days picked started later` } });
    expect('earlier' in none).toBe(false);
  });

  it('names each commit a run’s Find the commit offers by its subject', async () => {
    const offered = (await getJson<{ bisect: Choices & { revisions: Array<{ rev: string; subject: string | null }> } }>(`tests/runs/${ids.failedHere}`)).bisect;
    expect(offered.revisions).toEqual([expect.objectContaining({ rev: first, subject: 'Start' })]);
  });
});

describe('what git said about the commits, kept', () => {
  it('says a commit with no parent here has nothing before it: the first, or the oldest a shallow clone has', async () => {
    const here = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-commits-first-')));
    const shallow = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-commits-shallow-')));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd }).toString().trim();
    try {
      git(here, 'init', '-q', '.');
      writeFileSync(join(here, 'a.txt'), 'a\n');
      git(here, 'add', '-A');
      git(here, 'commit', '-qm', 'Start the agent');
      const start = git(here, 'rev-parse', 'HEAD');
      writeFileSync(join(here, 'a.txt'), 'b\n');
      git(here, 'commit', '-qam', 'Escalate refunds above the limit');
      const next = git(here, 'rev-parse', 'HEAD');
      forgetCommits();
      expect(await parentlessHere(here, start, 0)).toEqual({ shallow: false });
      expect(await parentlessHere(here, start.slice(0, 7), 0)).toEqual({ shallow: false });
      expect(await parentlessHere(here, next, 0)).toBe(false);
      // Only a commit's hex name is handed to git; one git doesn't have, it can't say of.
      expect(await parentlessHere(here, 'HEAD~1', 0)).toBeNull();
      expect(await parentlessHere(here, 'f'.repeat(40), 0)).toBeNull();
      // A clone of the newest commit alone: it has no parent there, though it has one here.
      git(shallow, 'clone', '-q', '--depth', '1', `file://${here}`, '.');
      expect(await parentlessHere(shallow, next, 0)).toEqual({ shallow: true });
      // Its parent found, the answer stands; none found is asked again after a minute, as a fetch may deepen the clone.
      git(shallow, 'fetch', '-q', '--unshallow');
      expect(await parentlessHere(shallow, next, 30_000)).toEqual({ shallow: true });
      expect(await parentlessHere(shallow, next, 61_000)).toBe(false);
    } finally {
      forgetCommits();
      rmSync(here, { recursive: true, force: true });
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it('keeps a commit found, asks again about a missing one after a minute, and forgets when told', async () => {
    const here = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-commits-kept-')));
    const there = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-commits-there-')));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', ...args], { cwd }).toString().trim();
    try {
      git(here, 'init', '-q', '.');
      writeFileSync(join(here, 'a.txt'), 'a\n');
      git(here, 'add', '-A');
      git(here, 'commit', '-qm', 'Start the agent');
      const start = git(here, 'rev-parse', 'HEAD');
      // A teammate's commit, made in their clone: not here until a fetch brings it.
      git(there, 'clone', '-q', here, '.');
      writeFileSync(join(there, 'a.txt'), 'b\n');
      git(there, 'commit', '-qam', 'Escalate refunds above the limit');
      const theirs = git(there, 'rev-parse', 'HEAD');
      forgetCommits();
      expect(await commitsHere(here, [start, theirs, null], 0)).toEqual(new Set([start]));
      expect(await commitSubjects(here, [start, theirs], 0)).toEqual(new Map([[start, 'Start the agent']]));
      git(here, 'fetch', '-q', there, 'HEAD');
      // Git said it lacks the commit a moment ago: that stands for a minute, then git is asked again.
      expect(await commitsHere(here, [theirs], 30_000)).toEqual(new Set());
      expect(await commitsHere(here, [theirs], 61_000)).toEqual(new Set([theirs]));
      expect((await commitSubjects(here, [theirs], 61_000)).get(theirs)).toBe('Escalate refunds above the limit');
      // A commit found stays found, with its subject, without asking git again.
      renameSync(join(here, '.git'), join(here, 'git-away'));
      expect(await commitsHere(here, [start, theirs], 120_000)).toEqual(new Set([start, theirs]));
      // Forgotten, git is asked, and can't say.
      forgetCommits();
      expect(await commitsHere(here, [start], 120_000)).toBeNull();
      // Only a commit's hex name is ever handed to git.
      expect(await commitsHere(here, ['--output=/tmp/x', 'HEAD~1'], 0)).toEqual(new Set());
    } finally {
      forgetCommits();
      rmSync(here, { recursive: true, force: true });
      rmSync(there, { recursive: true, force: true });
    }
  });
});
