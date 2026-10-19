import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEvent, Store, teamRunCounts, type DivergenceReport } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';

/**
 * The attempts of an error-path preset (`test --chaos`) are bundled under the recording they forked,
 * as blame's probes and verify's attempts are: the Runs page, its counts, the Overview and the
 * activity feed show the recording and the session's line, never one fork per attempt with flags
 * nobody typed.
 */

let dir = '';
let store: Store;
let dash: Dashboard;
let recording = '';
let fork = '';
const attempts: string[] = [];

const api = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token } });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
};

const forkedAt = (callNo: number): DivergenceReport => ({ callNo, kind: 'tool', name: 'get_forecast', replayedBefore: callNo - 1, type: 'forced', reason: 'an error-path preset was played in here' }) as unknown as DivergenceReport;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sl-chaos-attempts-'));
  store = Store.open(':memory:');
  const now = Date.now();
  recording = store.createRun({ mode: 'record', command: { argv: ['node', 'forecast.mjs'], cwd: dir }, codeVersion: 'abc1234', startedAt: now - 10_000 }).runId;
  store.endRun(recording, 'completed', now - 9_000);
  // A fork someone made, which stays a fork of its own.
  fork = store.createRun({ mode: 'replay', parentRunId: recording, command: { argv: ['node', 'forecast.mjs'], cwd: dir }, startedAt: now - 8_000, meta: { interventions: [{ kind: 'fail', at: 3, flag: '--fail-at 3=timeout' }] } as never }).runId;
  store.setDivergence(fork, forkedAt(3));
  store.endRun(fork, 'completed', now - 7_000);
  // A session of three presets on the recording, each attempt forked where its preset was played in.
  store.startChaosSession({ sessionId: 'X1', startedAt: now - 6_000, command: ['shadowlap', 'test', 'goldens/forecast', '--chaos'], presets: ['timeout', 'malformed', '500'] });
  for (const [i, [preset, callNo, flag]] of ([['timeout', 3, '--fail-at 3=timeout'], ['malformed', 3, '--override 3=@malformed'], ['500', 4, '--fail-at 4=500']] as const).entries()) {
    const id = store.createRun({ mode: 'replay', parentRunId: recording, command: { argv: ['node', 'forecast.mjs'], cwd: dir }, codeVersion: 'def5678', startedAt: now - 5_000 + i * 100, meta: { chaos: { preset, callNo, session: 'X1', attempt: 1, golden: 'goldens/forecast' }, interventions: [{ kind: 'fail', at: callNo, flag }, { kind: 'writes', flag: '--writes stub' }] } as never }).runId;
    store.setDivergence(id, forkedAt(callNo));
    store.endRun(id, preset === 'malformed' ? 'failed' : 'completed', now - 4_900 + i * 100);
    attempts.push(id);
  }
  store.finishChaosSession('X1', { passed: 2, failed: 1, inconclusive: 0, upstreamRequests: 3, endedAt: now - 4_000 });
  recordEvent(store, { kind: 'chaos.session', ref: 'X1', at: now - 4_000, data: { passed: 2, failed: 1, inconclusive: 0, notApplicable: 0, goldens: 1 } });
  dash = await startDashboard({ store, project: { path: dir } });
});

afterAll(async () => {
  await dash?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("an error-path preset's attempts", () => {
  it('are bundled under the recording they forked on the Runs page', async () => {
    const { runs } = await api<{ runs: Array<{ runId: string; attempts: number }> }>('runs');
    expect(runs.map((r) => r.runId).sort()).toEqual([recording, fork].sort());
    const page = await api<{ runs: Array<{ runId: string; attempts: number }> }>('runs/page');
    expect(page.runs.map((r) => r.runId).sort()).toEqual([recording, fork].sort());
    expect(page.runs.find((r) => r.runId === recording)).toMatchObject({ attempts: 3 });
    const listed = await api<{ runs: Array<{ runId: string; attemptOf: string | null; attemptKind: string | null }> }>('runs/page?attempts=1');
    for (const id of attempts) expect(listed.runs.find((r) => r.runId === id)).toMatchObject({ attemptOf: recording, attemptKind: 'chaos' });
    expect(listed.runs.find((r) => r.runId === fork)).toMatchObject({ attemptOf: null, attemptKind: null });
  });

  it("aren't counted as runs, nor as today's forks", async () => {
    const meta = await api<{ counts: { runs: number; attempts: number } }>('meta');
    expect(meta.counts).toEqual({ runs: 2, attempts: 3 });
    const summary = await api<{ today: { forks: { count: number } } }>('summary');
    expect(summary.today.forks.count).toBe(1);
    // The team store counts runs the same way: the attempts are filed under the recording.
    expect(teamRunCounts(store, 's3://bucket/project')).toMatchObject({ onlyLocal: 2, localAttempts: 3 });
  });

  it("leave the activity feed to their session's line", async () => {
    const { items } = await api<{ items: Array<{ text: string; runId?: string }> }>('activity?limit=50');
    const forks = items.filter((i) => i.text.startsWith('Forked at'));
    expect(forks.map((i) => i.runId)).toEqual([fork]);
    expect(items.some((i) => i.text === 'Error-path presets ran · 2 passed, 1 failed')).toBe(true);
    expect(items.some((i) => /--writes stub/.test(i.text))).toBe(false);
  });

  it('are left out of the revisions bisect offers', () => {
    // They ran with a failure played in: the revision they ran at says nothing about the code.
    expect(store.runRevisions().map((r) => [r.revision, r.runs])).toEqual([['abc1234', 1]]);
  });
});
