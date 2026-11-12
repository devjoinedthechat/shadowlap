import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLEARED, emptyCounts, NO_TOKENS, Store } from '@shadowlap/engine';
import { DONE, LOOKUP, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import { decisionSession } from '../src/decisions.js';
import { appliedState, goldensLeftWaiting } from '../src/migrate-applied.js';
import type { MigrateStartView } from '../src/migrate-start.js';
import type { MigrateView } from '../src/migrate-view.js';

/**
 * A migration over HTTP and in the store, past its report: the `migrate-apply` job and what it
 * refuses, the applied state with each golden it left behind and whether it still waits, the goldens
 * applied migrations left waiting, and Verify's price on a migration that needs a code change first.
 */

const CLEAR = 'mg-01M5000000000000000000000C';
const NO_FILE = 'mg-01M5000000000000000000000D';
const BLOCKED = 'mg-01M5000000000000000000000E';
let store: Store;
let dash: Dashboard;
let project = '';
let runId = '';
const spawned: string[][] = [];

const api = (d: Dashboard, path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const startJob = (d: Dashboard, body: unknown) => api(d, 'jobs', { method: 'POST', body: JSON.stringify(body) });

/** A migration from claude-sonnet-4-5 to claude-sonnet-5-5 as `migrate --json` keeps it: all clear, with a config change and its files unless told otherwise. */
function migration(id: string, o: { files?: boolean; remedies?: unknown[] } = {}) {
  const run = { runId, golden: 'goldens/refund', steps: 0, asked: 0, rank: null, majority: null, counts: emptyCounts(), cost: { before: 0.04, after: 0.02, spent: 0.02 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions: [], warnings: [] };
  const decisions = { decisionsId: null, kind: 'decisions', at: 1_000, change: { model: 'claude-sonnet-5-5', fields: {}, from: ['claude-sonnet-4-5'], fromCode: null, text: 'the model claude-sonnet-5-5' }, command: 'shadowlap migrate --to claude-sonnet-5-5', samples: 1, counts: emptyCounts(), flagged: [], toVerify: [], remedies: o.remedies ?? [], runs: [run], cost: { before: null, after: null, spent: 0, upstreamRequests: 0, unknownModels: [] }, stopReason: null, judge: null, notes: [], warnings: [] };
  const data = {
    migrateId: id,
    kind: 'migrate',
    at: 1_000,
    from: ['claude-sonnet-4-5'],
    to: 'claude-sonnet-5-5',
    command: 'shadowlap migrate --to claude-sonnet-5-5',
    decisions,
    passes: { verdict: 'not-run', runs: [{ runId, golden: 'goldens/refund', verdict: 'passed', outcome: 'unchanged', verified: false, tally: null, diverges: { callNo: 1, path: '$.model' } }] },
    set: { flags: [], fields: [], given: {}, byHand: [] },
    configChange: o.files === false ? null : { files: [{ path: 'agent.py', places: 1 }], leftOut: [], review: [], patch: '--- a/agent.py\n+++ b/agent.py\n' },
    files: { dir: `.shadowlap/migrations/${id}`, pullRequest: `.shadowlap/migrations/${id}/pull-request.md`, patch: o.files === false ? null : `.shadowlap/migrations/${id}/config.patch` },
    stopReason: null,
    notes: [],
    warnings: [],
  };
  store.putDecisionSession({ sessionId: id, kind: 'migrate', at: 1_000, change: 'the model claude-sonnet-5-5', actor: 'dev', revision: null, data, runs: [{ runId, golden: 'goldens/refund', rank: null, changed: 0, data: run }] });
}

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'sl-migrate-routes-'));
  store = Store.open(':memory:');
  runId = recordRun(store, [LOOKUP, REFUND, DONE], { model: 'claude-sonnet-4-5' }).run.runId;
  migration(CLEAR);
  migration(NO_FILE, { files: false });
  migration(BLOCKED, { remedies: [{ field: 'temperature', value: null, leftOut: true, renamedTo: null, why: 'refused', source: null, steps: 1 }] });
  const spawnCli = (args: string[]) => {
    spawned.push(args);
    return spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  };
  dash = await startDashboard({ store, spawnCli, project: { path: project }, goldens: () => [{ path: 'goldens/refund', runId, packedAt: 1, mode: 'replay' as const, repeat: 1, passes: 1, checks: [] }] });
});

afterAll(async () => {
  await dash?.close();
  store?.close();
  if (project) rmSync(project, { recursive: true, force: true });
});

describe('the migrate-apply job', () => {
  it('runs migrate apply on a migration whose config change can go in, asking nothing', async () => {
    const res = await startJob(dash, { kind: 'migrate-apply', migrationId: CLEAR });
    expect(res.status).toBe(202);
    expect(spawned.at(-1)).toEqual(['migrate', 'apply', CLEAR]);
  });

  it('refuses an id that is no migration’s, a migration the store doesn’t keep, and one migrate apply refuses, in its words', async () => {
    const bad = await startJob(dash, { kind: 'migrate-apply', migrationId: 'dc-01M5000000000000000000000A' });
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, 'migrationId is a migration’s id: mg- and 26 letters and digits']);
    expect((await startJob(dash, { kind: 'migrate-apply', migrationId: 'mg-01M5000000000000000000000Z' })).status).toBe(404);
    const none = await startJob(dash, { kind: 'migrate-apply', migrationId: NO_FILE });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toBe(`mg-01M5000000 has no config change: no string in the project's code or config names claude-sonnet-4-5, so set claude-sonnet-5-5 where your agent reads its model`);
  });
});

describe('a migration’s view', () => {
  const view = async (id: string) => ((await (await api(dash, `decisions/${id}`)).json()) as { migration: MigrateView }).migration;

  it('words a migration on the server: its headline, the golden it leaves behind, What to set, and Apply offered with what the job runs', async () => {
    const m = await view(CLEAR);
    expect([m.word.text, m.headline, m.next]).toEqual(['nothing to verify', { tone: 'pass', text: 'claude-sonnet-5-5 decided the same in the preview', rest: 'claude-sonnet-4-5 → claude-sonnet-5-5, 1 run' }, 'apply']);
    expect(m.passes.runs.map((x) => [x.golden, x.verdict, x.words, x.leftBehind])).toEqual([['goldens/refund', 'passed', CLEARED, 'diverges at #1 on `$.model` once applied']]);
    expect([m.passes.verified, m.set.only, m.changes.none, m.changes.sub]).toEqual(['0 of 1 run verified end to end', 'Only the model: claude-sonnet-5-5', 'No write, stop or judged change.', 'the calls made with claude-sonnet-4-5, asked under claude-sonnet-5-5']);
    expect(m.apply).toEqual({ files: ['agent.py'], leftOut: [], leftBehind: [{ golden: 'goldens/refund', callNo: 1 }], others: 0, command: 'shadowlap migrate apply mg-01M5000000' });
    expect([m.config.sub, m.config.apply, m.applied]).toEqual(['`agent.py` · 1 place', `git apply .shadowlap/migrations/${CLEAR}/config.patch`, null]);
  });

  it('offers no Apply where migrate apply would refuse it, saying why in its words', async () => {
    const m = await view(NO_FILE);
    expect([m.next, m.config.sub, 'why' in m.apply && m.apply.why]).toEqual([null, 'no file names the model', `mg-01M5000000 has no config change: no string in the project's code or config names claude-sonnet-4-5, so set claude-sonnet-5-5 where your agent reads its model`]);
  });
});

describe('Migrate’s start read', () => {
  it('answers the goldens, each model they call that retires with its goldens, scopes and the newest migration that checked it, and the models in use', async () => {
    const res = await api(dash, 'migrate/start');
    expect(res.status).toBe(200);
    const start = (await res.json()) as MigrateStartView;
    expect([start.goldens, start.use.map((u) => [u.model, u.goldens])]).toEqual([1, [['claude-sonnet-4-5', 1]]]);
    expect(start.retiring.map((n) => [n.model, n.goldens, n.scopes, n.owner, n.replacements[0], n.checked])).toEqual([['claude-sonnet-4-5', ['goldens/refund'], [], 'Anthropic', 'claude-sonnet-5-5', { sessionId: BLOCKED, words: 'checked · the config change is ready' }]]);
  });
});

describe('a migration’s applied state', () => {
  it('reads null until applied, then each golden left behind waiting until a result of it at or after the apply passed', () => {
    expect(decisionSession(store, CLEAR)!.applied).toBeNull();
    store.setMigrationApplied(CLEAR, { at: 5_000, by: 'dev', outdated: [{ golden: 'goldens/refund', callNo: 1, path: '$.model' }] });
    const waits = () => decisionSession(store, CLEAR)!.applied!.outdated.map((g) => [g.golden, g.callNo, g.path, g.waits]);
    expect(waits()).toEqual([['goldens/refund', 1, '$.model', true]]);
    expect(goldensLeftWaiting(store)).toEqual([{ golden: 'goldens/refund', callNo: 1, path: '$.model', from: ['claude-sonnet-4-5'], to: 'claude-sonnet-5-5', migrationId: CLEAR }]);
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund'], startedAt: 4_000 });
    // A pass before the apply, and a failure after it, leave it waiting; a pass after it (test --update) doesn't.
    store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/refund', ok: true, at: 4_000 });
    store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/refund', ok: false, at: 6_000 });
    expect(waits()).toEqual([['goldens/refund', 1, '$.model', true]]);
    store.addTestResult({ sessionId: session.sessionId, golden: 'goldens/refund', ok: true, at: 7_000 });
    expect(waits()).toEqual([['goldens/refund', 1, '$.model', false]]);
    expect(goldensLeftWaiting(store)).toEqual([]);
  });

  it('names who applied it only where checks are shared', () => {
    const applied = { at: 1, by: 'dev', outdated: [] };
    expect(appliedState(store, applied)?.by).toBeNull();
    expect(appliedState(store, applied, { shared: true })?.by).toBe('dev');
  });
});

describe('Verify’s price on a migration', () => {
  it('is none while the new model refuses a field the agent’s code sends, which verify can’t send otherwise', async () => {
    const res = await api(dash, `decisions/${BLOCKED}/estimates`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verify: null, runs: [] });
  });
});
