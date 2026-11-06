import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyCounts, Store, type TestResultData } from '@shadowlap/engine';
import { verifyReport } from '../../engine/test/fix-fixtures.js';
import { forgetCommits, startDashboard, type Dashboard, type GoldenSource } from '../src/index.js';
import type { VerdictRevision, VerdictsView } from '../src/verdicts.js';

/**
 * Changes › Verdicts over HTTP: the changes checked, newest first, a chip at a time; a revision's
 * page; each revision titled by its commit's subject from the project's git; who made a change named
 * only when the project's config names a team store; and nothing without the session token.
 */

const T0 = Date.UTC(2026, 9, 20, 9, 0);
const HOUR = 3_600_000;

const goldens: GoldenSource[] = [
  { path: 'goldens/refund-flow', runId: null, packedAt: T0 - 48 * HOUR, mode: 'replay', repeat: 1, passes: 1, checks: [] },
  { path: 'goldens/refund-in-limit', runId: null, packedAt: T0 - 48 * HOUR, mode: 'replay', repeat: 1, passes: 1, checks: [] },
];

let repo = '';
let team = '';
let broken = '';
let tightened = '';
let store: Store;
let dash: Dashboard;
let shared: Dashboard;
let unshared: Dashboard;

const spawnCli = () => spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] });
const api = (d: Dashboard, path: string, headers: Record<string, string> = {}) => fetch(`${d.url}/api/${path}`, { headers: { 'x-shadowlap-token': d.token, ...headers } });
const getJson = async <T>(d: Dashboard, path: string): Promise<T> => {
  const res = await api(d, path);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
};

beforeAll(async () => {
  // The project's git, where the revisions' commits are: the newest tightens the refund wording.
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-verdicts-routes-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
  git('init', '-q', '.');
  writeFileSync(join(repo, 'policy.txt'), 'refund limit 100\n');
  git('add', '-A');
  git('commit', '-qm', 'Start');
  writeFileSync(join(repo, 'policy.txt'), 'refund limit 50\n');
  git('commit', '-qam', 'Tighten refund wording');
  tightened = git('rev-parse', '--short=7', 'HEAD');
  // Another checkout of the project, with a team store: checks there are shared. And one whose store isn't a store URL.
  team = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-verdicts-team-')));
  execFileSync('git', ['clone', '-q', repo, team]);
  writeFileSync(join(team, 'shadowlap.config.json'), JSON.stringify({ store: 's3://northwind-shadowlap/support-agent' }));
  broken = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-verdicts-broken-')));
  writeFileSync(join(broken, 'shadowlap.config.json'), JSON.stringify({ store: 'a bucket somewhere' }));

  store = Store.open(':memory:');
  const ok: TestResultData = { mode: 'replay', verdict: 'passed', calls: { total: 4, replayed: 4, live: 0, blocked: 0, stubbed: 0 } };
  const session = (revision: string | null, at: number, failing: string | null) => {
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision, actor: 'maya@example.com', startedAt: at, owner: null });
    goldens.forEach((g, i) => store.addTestResult({ sessionId: s.sessionId, golden: g.path, ok: g.path !== failing, ...(g.path === failing ? { failure: 'exit' as const, reason: 'the agent exited with code 1', data: { mode: 'replay', verdict: 'failed' } } : { data: ok }), revision, at: at + i + 1 }));
    store.finishTestSession(s.sessionId, { passed: failing ? 1 : 2, failed: failing ? 1 : 0, upstreamRequests: 0, endedAt: at + 60_000 });
  };
  session('c0ffee1', T0, null);
  session(tightened, T0 + 2 * HOUR, 'goldens/refund-in-limit');
  session(`${tightened}+dirty`, T0 + 4 * HOUR, null);
  session(null, T0 + 5 * HOUR, null);
  store.putDecisionSession({
    sessionId: 'dc-01M5000000000000000000000A',
    kind: 'decisions',
    at: T0 + 3 * HOUR,
    change: 'the model claude-haiku-4-5',
    actor: 'ravi@example.com',
    revision: tightened,
    data: { kind: 'decisions', change: { model: 'claude-haiku-4-5', fields: {}, from: null, fromCode: null, text: 'the model claude-haiku-4-5' }, counts: { ...emptyCounts(), 1: 1, same: 9 }, flagged: ['01K5RUN0000000000000000001'], verify: null, judge: null, stopReason: null },
    runs: [
      { runId: '01K5RUN0000000000000000001', golden: 'goldens/refund-flow', rank: 1, changed: 1, data: { runId: '01K5RUN0000000000000000001', refused: null, decisions: [] } },
      { runId: '01K5RUN0000000000000000002', golden: 'goldens/refund-in-limit', rank: null, changed: 0, data: { runId: '01K5RUN0000000000000000002', refused: null, decisions: [] } },
    ],
  });
  store.insertFix({ fixId: 'fx-01M5FIX0000000000000000001', title: 'issue_refund called with amount 240', labels: [], check: { expect: null, key: 'check:exit', oracle: ['the agent exits 0'], text: 'the agent exits 0' }, status: 'open', openedAt: T0, verifiedAt: null, appliedAt: null, data: {} });
  store.putVerdict({ verifyId: 'vf-01M5000000000000000000000A', at: T0 + 6 * HOUR, verdict: 'accepted', repairId: null, candidate: null, report: verifyReport([{ runId: '01M3RZ0001000000000000000A', role: 'target', pass: true }]), expect: null, command: 'shadowlap verify --fixes 01M3RZ0001' });
  store.addFixLink('fx-01M5FIX0000000000000000001', 'verify', 'vf-01M5000000000000000000000A', T0 + 6 * HOUR, { counts: true, why: null });

  forgetCommits();
  dash = await startDashboard({ store, spawnCli, project: { path: repo }, goldens: () => goldens });
  shared = await startDashboard({ store, spawnCli, project: { path: team }, goldens: () => goldens });
  unshared = await startDashboard({ store, spawnCli, project: { path: broken }, goldens: () => goldens });
});

afterAll(async () => {
  await Promise.all([dash?.close(), shared?.close(), unshared?.close()]);
  store?.close();
  for (const dir of [repo, team, broken]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/verdicts', () => {
  it('lists every change checked, newest first, each revision titled by its commit’s subject', async () => {
    const view = await getJson<VerdictsView>(dash, 'verdicts');
    expect(view.rows.map((r) => [r.kind, r.id, r.title, r.word])).toEqual([
      ['verify', 'vf-01M5000000000000000000000A', 'issue_refund called with amount 240', 'accepted'],
      ['session', 'no-revision', 'Tested with no revision', 'passed'],
      ['session', `${tightened}+dirty`, 'Tighten refund wording', 'passed'],
      ['preview', 'dc-01M5000000000000000000000A', 'Model switch to claude-haiku-4-5', 'not verified'],
      ['session', tightened, 'Tighten refund wording', 'failed'],
      // A commit this checkout doesn't have, as a CI merge commit is: named by its revision.
      ['session', 'c0ffee1', 'c0ffee1', 'passed'],
    ]);
    expect(view.counts).toEqual({ all: 6, sessions: 4, previews: 1, verifies: 1 });
    expect(view.lead).toMatchObject({ id: 'no-revision' });
    // On one machine every check is its own: no one is named.
    expect(view.shared).toBe(false);
    expect(view.rows.every((r) => r.by === null)).toBe(true);
  });

  it('names who made each change where the config names a team store: a commit by its author, a preview by who ran it', async () => {
    const view = await getJson<VerdictsView>(shared, 'verdicts');
    expect(view.shared).toBe(true);
    // Never the session's runner: a commit this checkout lacks, and no revision at all, name no one.
    expect(view.rows.map((r) => [r.id, r.by])).toEqual([
      ['vf-01M5000000000000000000000A', null],
      ['no-revision', null],
      [`${tightened}+dirty`, 'dana@northwind.example'],
      ['dc-01M5000000000000000000000A', 'ravi@example.com'],
      [tightened, 'dana@northwind.example'],
      ['c0ffee1', null],
    ]);
    expect(view.rows.find((r) => r.id === tightened)!.title).toBe('Tighten refund wording');
    expect((await getJson<VerdictRevision>(shared, `verdicts/${tightened}`)).row.by).toBe('dana@northwind.example');
  });

  it('tells a team store from the config alone: no run is counted for it, however many the store keeps', async () => {
    const sql: string[] = [];
    const query = vi.spyOn(store, 'query').mockImplementation(function (this: Store, text, ...params) {
      sql.push(text);
      return Store.prototype.query.call(this, text, ...params);
    });
    const recording = vi.spyOn(store, 'recordingRuns');
    const counted: number[] = [];
    try {
      expect((await getJson<VerdictsView>(shared, 'verdicts')).shared).toBe(true);
      expect((await getJson<VerdictRevision>(shared, `verdicts/${tightened}`)).shared).toBe(true);
      counted.push(recording.mock.calls.length);
    } finally {
      query.mockRestore();
      recording.mockRestore();
    }
    // The team store's status counts every run and asks what its runs left open: neither happens here.
    expect(counted).toEqual([0]);
    expect(sql.filter((text) => /\bFROM runs\b/.test(text) && !/\brun_id IN\b/.test(text))).toEqual([]);
  });

  it('names no one when the config names no team store, or one that is no store URL', async () => {
    for (const d of [dash, unshared]) {
      const view = await getJson<VerdictsView>(d, 'verdicts');
      expect(view.shared).toBe(false);
      expect(view.rows.every((r) => r.by === null)).toBe(true);
      expect((await getJson<VerdictRevision>(d, 'verdicts/no-revision')).shared).toBe(false);
    }
  });

  it('filters by chip and limit, and refuses a kind it has no chip for', async () => {
    expect((await getJson<VerdictsView>(dash, 'verdicts?kind=previews')).rows.map((r) => r.id)).toEqual(['dc-01M5000000000000000000000A']);
    const two = await getJson<VerdictsView>(dash, 'verdicts?kind=sessions&limit=2');
    expect(two.rows.map((r) => r.id)).toEqual(['no-revision', `${tightened}+dirty`]);
    expect(two.more).toBe(true);
    // A limit is a whole number from 1 to the window: 0 shows one row, one past the window every row it holds.
    const one = await getJson<VerdictsView>(dash, 'verdicts?limit=0');
    expect([one.rows.length, one.more]).toEqual([1, true]);
    expect((await getJson<VerdictsView>(dash, 'verdicts?limit=-3')).rows).toHaveLength(1);
    expect((await getJson<VerdictsView>(dash, 'verdicts?limit=2.9')).rows).toHaveLength(2);
    const all = await getJson<VerdictsView>(dash, 'verdicts?limit=100000');
    expect([all.rows.length, all.more]).toEqual([6, false]);
    expect((await getJson<VerdictsView>(dash, 'verdicts?limit=many')).rows).toHaveLength(6);
    const bad = await api(dash, 'verdicts?kind=runs');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('kind is all, sessions, previews, verifies');
  });

  it('answers a page the browser already has with a 304', async () => {
    const first = await api(dash, 'verdicts');
    const again = await api(dash, 'verdicts', { 'if-none-match': first.headers.get('etag')! });
    expect(again.status).toBe(304);
  });

  it('serves nothing without the session token', async () => {
    expect((await fetch(`${dash.url}/api/verdicts`)).status).toBe(401);
    expect((await fetch(`${dash.url}/api/verdicts/${tightened}`)).status).toBe(401);
  });
});

describe('GET /api/verdicts/:rev', () => {
  it('gives a revision’s goldens as its session judged them, worst first, and the previews asked at it', async () => {
    const page = await getJson<VerdictRevision>(dash, `verdicts/${tightened}`);
    expect(page.row).toMatchObject({ title: 'Tighten refund wording', subject: 'Tighten refund wording', word: 'failed', line: '1 of 2 goldens passed', by: null });
    // Not the newest revision's: the list leads with the session that ran with no revision.
    expect(page.latest).toBe(false);
    expect(page.goldens.map((g) => [g.name, g.verdict, g.note])).toEqual([
      ['refund-in-limit', 'failed', 'the agent exited with code 1'],
      ['refund-flow', 'passed', '4/4 replayed'],
    ]);
    expect(page.lead).toMatchObject({ golden: 'goldens/refund-in-limit' });
    expect(page.decisions.map((d) => [d.id, d.line])).toEqual([['dc-01M5000000000000000000000A', '1 of 2 goldens to verify']]);
  });

  it('opens a revision with changes not committed, and one with no revision', async () => {
    expect((await getJson<VerdictRevision>(dash, `verdicts/${encodeURIComponent(`${tightened}+dirty`)}`)).row).toMatchObject({ title: 'Tighten refund wording', revision: `${tightened}+dirty` });
    expect(await getJson<VerdictRevision>(dash, 'verdicts/no-revision')).toMatchObject({ row: { title: 'Tested with no revision', revision: null }, latest: true });
  });

  it('is a 404 for a change no session checked', async () => {
    const res = await api(dash, 'verdicts/deadbee');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('no change deadbee checked: no test session ran every golden at it');
  });
});
