import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, Store, type TestResultData } from '@shadowlap/engine';
import { verifyReport } from '../../engine/test/fix-fixtures.js';
import { forgetCommits, startDashboard, type Dashboard, type GoldenSource } from '../src/index.js';
import type { VerdictRevision, VerdictsView } from '../src/verdicts.js';

/**
 * Changes › Verdicts over HTTP: the changes checked, newest first, a chip at a time; a revision's
 * page; each revision titled by its commit's subject from the project's git; who checked a change
 * named only with a team store; and nothing without the session token.
 */

const T0 = Date.UTC(2026, 9, 20, 9, 0);
const HOUR = 3_600_000;

const goldens: GoldenSource[] = [
  { path: 'goldens/refund-flow', runId: null, packedAt: T0 - 48 * HOUR, mode: 'replay', repeat: 1, passes: 1, checks: [] },
  { path: 'goldens/refund-in-limit', runId: null, packedAt: T0 - 48 * HOUR, mode: 'replay', repeat: 1, passes: 1, checks: [] },
];

let repo = '';
let team = '';
let tightened = '';
let store: Store;
let dash: Dashboard;
let shared: Dashboard;

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
  // Another checkout of the project, with a team store: checks there are shared.
  team = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-verdicts-team-')));
  writeFileSync(join(team, 'shadowlap.config.json'), JSON.stringify({ store: 's3://northwind-shadowlap/support-agent' }));

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
});

afterAll(async () => {
  await Promise.all([dash?.close(), shared?.close()]);
  store?.close();
  for (const dir of [repo, team]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/verdicts', () => {
  it('lists every change checked, newest first, each revision titled by its commit’s subject', async () => {
    const view = await getJson<VerdictsView>(dash, 'verdicts');
    expect(view.rows.map((r) => [r.kind, r.id, r.title, r.word])).toEqual([
      ['verify', 'vf-01M5000000000000000000000A', 'issue_refund called with amount 240', 'accepted'],
      ['session', 'no-revision', 'Tested with no revision', 'passed'],
      ['session', `${tightened}+dirty`, 'Tighten refund wording, with uncommitted changes', 'passed'],
      ['preview', 'dc-01M5000000000000000000000A', 'Model switch to claude-haiku-4-5', 'not verified'],
      ['session', tightened, 'Tighten refund wording', 'failed'],
      // A commit this checkout doesn't have, as a CI merge commit is: named by its revision.
      ['session', 'c0ffee1', 'Commit c0ffee1', 'passed'],
    ]);
    expect(view.counts).toEqual({ all: 6, sessions: 4, previews: 1, verifies: 1 });
    expect(view.lead).toMatchObject({ id: 'no-revision' });
    // On one machine every check is its own: no one is named.
    expect(view.shared).toBe(false);
    expect(view.rows.every((r) => r.by === null)).toBe(true);
  });

  it('names who checked each change where a team store shares checks', async () => {
    const view = await getJson<VerdictsView>(shared, 'verdicts');
    expect(view.shared).toBe(true);
    expect(view.rows.map((r) => r.by)).toEqual([null, 'maya@example.com', 'maya@example.com', 'ravi@example.com', 'maya@example.com', 'maya@example.com']);
    // That checkout has no git: each revision by itself.
    expect(view.rows.find((r) => r.id === tightened)!.title).toBe(`Commit ${tightened}`);
  });

  it('filters by chip and limit, and refuses a kind it has no chip for', async () => {
    expect((await getJson<VerdictsView>(dash, 'verdicts?kind=previews')).rows.map((r) => r.id)).toEqual(['dc-01M5000000000000000000000A']);
    const two = await getJson<VerdictsView>(dash, 'verdicts?kind=sessions&limit=2');
    expect(two.rows.map((r) => r.id)).toEqual(['no-revision', `${tightened}+dirty`]);
    expect(two.more).toBe(true);
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
    expect(page.row).toMatchObject({ title: 'Tighten refund wording', subject: 'Tighten refund wording', word: 'failed', line: '1 passed, 1 failed' });
    expect(page.goldens.map((g) => [g.name, g.verdict, g.note])).toEqual([
      ['refund-in-limit', 'failed', 'the agent exited with code 1'],
      ['refund-flow', 'passed', '4/4 replayed'],
    ]);
    expect(page.lead).toMatchObject({ golden: 'goldens/refund-in-limit' });
    expect(page.decisions.map((d) => [d.id, d.line])).toEqual([['dc-01M5000000000000000000000A', '1 of 2 goldens to verify']]);
  });

  it('opens a revision with changes not committed, and one with no revision', async () => {
    expect((await getJson<VerdictRevision>(dash, `verdicts/${encodeURIComponent(`${tightened}+dirty`)}`)).row.title).toBe('Tighten refund wording, with uncommitted changes');
    expect((await getJson<VerdictRevision>(dash, 'verdicts/no-revision')).row).toMatchObject({ title: 'Tested with no revision', revision: null });
  });

  it('is a 404 for a change no session checked', async () => {
    const res = await api(dash, 'verdicts/deadbee');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('no change deadbee checked: no test session ran every golden at it');
  });
});
