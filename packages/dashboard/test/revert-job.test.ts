import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { recordEvent, Store } from '@shadowlap/engine';
import { startDashboard, type Dashboard, type GoldenSource, type JobView, type SpawnCli } from '../src/index.js';

/**
 * Revert (A19) on a real git repository, with a stand-in CLI for its test: the first bad commit
 * undone in the working tree and left uncommitted, then the golden tested; git's refusal and its
 * conflicts in git's own words, with no test after them; a merge against its first parent; a golden
 * whose test runs live asked about first, as Run tests asks; and the working tree held while it runs,
 * so Tests' jobs wait for it, as it waits for them.
 */
const FAKE = fileURLToPath(new URL('./fake-tests-cli.mjs', import.meta.url));
const GOLDEN = 'goldens/refund-in-limit';
const BROKEN = 'goldens/broken-flow';
/** A golden marked fork, with a judge: its test runs live from where it forks. */
const FORKED = 'goldens/refund-forked';

let repo: string;
let hold: string;
let store: Store;
let dash: Dashboard;
const at: Record<string, string> = {};

const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
const commit = (name: string, files: Record<string, string>) => {
  for (const [f, content] of Object.entries(files)) writeFileSync(join(repo, f), content);
  git('add', '-A');
  git('commit', '-qm', name);
  at[name] = git('rev-parse', '--short', 'HEAD');
};
const spawnCli: SpawnCli = (args, options) =>
  spawn(process.execPath, [FAKE, ...args], {
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, FAKE_TESTS_HOLD: hold, ...(options?.events ? { SHADOWLAP_EVENTS_FD: '3' } : {}) },
    stdio: options?.events ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
const goldens: GoldenSource[] = [
  ...[GOLDEN, BROKEN].map((path): GoldenSource => ({ path, runId: null, packedAt: 0, mode: 'replay', repeat: 1, passes: 1, checks: [] })),
  { path: FORKED, runId: null, packedAt: 0, mode: 'fork', repeat: 1, passes: 1, checks: [], judges: ['claude-haiku-4-5'] },
];

/** The golden crashed, and Find breaking commit named `rev` for it. */
function named(golden: string, rev: string): void {
  const now = Date.now();
  const session = store.startTestSession({ command: ['shadowlap', 'test', golden], startedAt: now, revision: git('rev-parse', 'HEAD') }).sessionId;
  store.addTestResult({ sessionId: session, golden, ok: false, failure: 'exit', reason: 'the agent exited with code 1', runId: null, goldenRunId: null, revision: git('rev-parse', 'HEAD'), at: now });
  store.finishTestSession(session, { passed: 0, failed: 1, upstreamRequests: 0, endedAt: now });
  recordEvent(store, { kind: 'bisect.found', ref: golden, at: now + 1, data: { commit: rev, first: { rev, subject: 's', author: 'Dana', date: '2026-10-01T10:00:00Z' }, why: 'exit', untested: [], replays: 3, tokens: 0, answered: { at: now, ok: false } } });
}

const api = (path: string, init: RequestInit = {}, d: Dashboard = dash) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const start = (body: unknown, d: Dashboard = dash) => api('jobs', { method: 'POST', body: JSON.stringify(body) }, d);
/** The job once it has ended, however long a loaded machine makes it take: the test's own timeout bounds it, never a count of polls. */
async function ended(res: Response): Promise<JobView> {
  expect(res.status, await res.clone().text()).toBe(202);
  const { id } = (await res.json()) as JobView;
  for (;;) {
    const view = (await (await api(`jobs/${id}`)).json()) as JobView;
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Every job the dashboard started has ended and let go of the tree. A test that stopped waiting for
 * its job (it failed) would otherwise have the next one's git run beside that job's revert, which
 * holds .git/index.lock, and the next revert refused with a 409 while the job holds the tree.
 */
async function letGo(): Promise<void> {
  for (;;) {
    const { jobs } = (await (await api('jobs')).json()) as { jobs: JobView[] };
    if (jobs.every((j) => j.done)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-revert-job-')));
  hold = join(repo, '.hold');
  git('init', '-q', '-b', 'main', '.');
  writeFileSync(join(repo, '.gitignore'), '.hold\n');
  commit('Start', { 'agent.py': 'limit = 100\ntotal = order["amount"]\nprint(total)\n' });
  commit('Log the order total', { 'agent.py': 'limit = 100\ntotal = order["total"]\nprint(total)\n' });
  store = Store.open(':memory:');
  dash = await startDashboard({ store, spawnCli, readOnly: false, project: { path: repo }, goldens: () => goldens });
});
afterEach(async () => {
  rmSync(hold, { force: true });
  await letGo();
  git('reset', '-q', '--hard');
});
afterAll(async () => {
  await dash?.close();
  store?.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('Revert', () => {
  it('undoes the commit in the working tree, uncommitted, then tests the golden', async () => {
    named(GOLDEN, at['Log the order total']);
    const head = git('rev-parse', 'HEAD');
    const job = await ended(await start({ kind: 'revert', golden: GOLDEN, rev: at['Log the order total'] }));
    const rev = at['Log the order total'];
    expect(job).toMatchObject({ title: `Reverting ${rev}`, code: 0, git: 'done', worktree: { use: 'writes' } });
    expect(job.lines).toEqual(expect.arrayContaining([`$ git revert --no-commit ${rev}`, `reverted ${rev} in your working tree · not committed`, `$ shadowlap test ${GOLDEN}`, `argv ["test","${GOLDEN}"]`]));
    expect(git('rev-parse', 'HEAD'), 'nothing is committed').toBe(head);
    expect(readFileSync(join(repo, 'agent.py'), 'utf8')).toContain('order["amount"]');
    expect(job.links.map((l) => l.label)).toContain('Open the passing run');
  });

  it('keeps the revert when the test fails after it', async () => {
    named(BROKEN, at['Log the order total']);
    const job = await ended(await start({ kind: 'revert', golden: BROKEN, rev: at['Log the order total'] }));
    expect(job).toMatchObject({ code: 1, git: 'done' });
    expect(readFileSync(join(repo, 'agent.py'), 'utf8')).toContain('order["amount"]');
  });

  it("says git's refusal in git's words, leaves the tree as it was, and runs no test", async () => {
    named(GOLDEN, at['Log the order total']);
    writeFileSync(join(repo, 'agent.py'), 'limit = 100\ntotal = order["total"]\nprint("mine", total)\n');
    const job = await ended(await start({ kind: 'revert', golden: GOLDEN, rev: at['Log the order total'] }));
    expect(job.code).not.toBe(0);
    expect(job.git).toBe('untouched');
    expect(job.lines.join('\n')).toContain('Your local changes to the following files would be overwritten');
    expect(job.lines.some((l) => l.startsWith('$ shadowlap test')), 'the test never ran').toBe(false);
    expect(readFileSync(join(repo, 'agent.py'), 'utf8')).toContain('print("mine", total)');
  });

  it('leaves the conflicts git leaves, says so, and runs no test', async () => {
    commit('Print the limit too', { 'agent.py': 'limit = 100\ntotal = order["total"] + 0\nprint(limit, total)\n' });
    named(GOLDEN, at['Log the order total']);
    const job = await ended(await start({ kind: 'revert', golden: GOLDEN, rev: at['Log the order total'] }));
    expect(job).toMatchObject({ code: 1, git: 'conflicts' });
    expect(job.lines.join('\n')).toContain('CONFLICT');
    expect(job.lines.some((l) => l.startsWith('$ shadowlap test'))).toBe(false);
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('agent.py');
    git('reset', '-q', '--hard', 'HEAD~1');
  });

  it('reverts a merge against its first parent', async () => {
    git('checkout', '-q', '-b', 'feature');
    commit('Feature', { 'notes.txt': 'feature\n' });
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', 'feature', '-m', 'Merge feature');
    at['Merge'] = git('rev-parse', '--short', 'HEAD');
    named(GOLDEN, at['Merge']);
    const job = await ended(await start({ kind: 'revert', golden: GOLDEN, rev: at['Merge'] }));
    expect(job).toMatchObject({ code: 0, git: 'done' });
    expect(job.lines).toContain(`$ git revert --no-commit -m 1 ${at['Merge']}`);
    expect(existsSync(join(repo, 'notes.txt'))).toBe(false);
    git('reset', '-q', '--hard', 'HEAD~1');
  });

  it('asks first where the golden’s test runs live, as Run tests asks, and starts only with the yes to that question', async () => {
    named(FORKED, at['Log the order total']);
    const asked = await start({ kind: 'revert', golden: FORKED, rev: at['Log the order total'] });
    expect(asked.status).toBe(409);
    const q = (await asked.json()) as { error: string; confirm: string; live: unknown };
    expect(q).toEqual({
      error: `${FORKED} is marked fork, so it runs live from where it forks, writes blocked, and asks its judges live (claude-haiku-4-5). Live calls are billed by your provider. Confirm it to run it`,
      confirm: expect.stringMatching(/^[0-9a-f]{32}$/),
      live: [{ path: FORKED, why: [{ kind: 'fork' }, { kind: 'judges', models: ['claude-haiku-4-5'] }] }],
    });
    expect(git('status', '--porcelain'), 'nothing reverted before the yes').toBe('');
    // A yes to another question is none to this one.
    expect((await start({ kind: 'revert', golden: FORKED, rev: at['Log the order total'], yes: 'f'.repeat(32) })).status).toBe(409);
    const job = await ended(await start({ kind: 'revert', golden: FORKED, rev: at['Log the order total'], yes: q.confirm }));
    expect(job).toMatchObject({ code: 0, git: 'done' });
    expect(job.lines).toEqual(expect.arrayContaining([`$ shadowlap test ${FORKED}`, `argv ["test","${FORKED}"]`]));
    // A golden that only replays asks nothing.
    git('reset', '-q', '--hard');
    named(GOLDEN, at['Log the order total']);
    expect((await ended(await start({ kind: 'revert', golden: GOLDEN, rev: at['Log the order total'] }))).code).toBe(0);
  });

  it('waits for a Tests job, and for a test session started in a terminal, naming either', async () => {
    named(GOLDEN, at['Log the order total']);
    writeFileSync(hold, '');
    const tests = await start({ kind: 'test', golden: GOLDEN });
    expect(tests.status).toBe(202);
    const refused = await start({ kind: 'revert', golden: GOLDEN, rev: at['Log the order total'] });
    expect([refused.status, await refused.json()]).toEqual([409, { error: 'A test session is running: revert it once it is done' }]);
    rmSync(hold);
    await ended(tests);
    // A session this very process runs, as one started in a terminal: its process is alive.
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: git('rev-parse', 'HEAD') });
    try {
      const held = await start({ kind: 'revert', golden: GOLDEN, rev: at['Log the order total'] });
      expect([held.status, await held.json()]).toEqual([409, { error: 'shadowlap test goldens/* is running: revert it once it is done' }]);
    } finally {
      store.finishTestSession(s.sessionId, { passed: 0, failed: 0, upstreamRequests: 0 });
    }
    expect(git('status', '--porcelain'), 'nothing reverted while they ran').toBe('');
  });

  it('reverts only the commit the golden’s answer names, never while Tests run, and nothing read-only', async () => {
    named(GOLDEN, at['Log the order total']);
    expect((await start({ kind: 'revert', golden: GOLDEN, rev: at['Start'] })).status).toBe(400);
    expect((await start({ kind: 'revert', golden: GOLDEN, rev: '--output=x' })).status).toBe(400);
    expect((await start({ kind: 'revert', golden: 'goldens/none', rev: at['Log the order total'] })).status).toBe(400);
    // While it tests, it holds the tree and Tests' jobs: Run tests waits for it.
    writeFileSync(hold, '');
    const running = await start({ kind: 'revert', golden: GOLDEN, rev: at['Log the order total'] });
    expect(running.status).toBe(202);
    const test = await start({ kind: 'test' });
    expect(test.status).toBe(409);
    expect(((await test.json()) as { error: string }).error).toMatch(/^A revert is running/);
    rmSync(hold);
    await ended(running);
    const ro = await startDashboard({ store, spawnCli, readOnly: true, project: { path: repo }, goldens: () => goldens });
    try {
      expect((await start({ kind: 'revert', golden: GOLDEN, rev: at['Log the order total'] }, ro)).status).toBe(403);
    } finally {
      await ro.close();
    }
  });
});
