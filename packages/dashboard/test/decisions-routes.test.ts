import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, NO_TOKENS, Store, type DecisionRun, type DecisionStep } from '@shadowlap/engine';
import { DONE, ESCALATE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import { decisionRow, decisionSession, retirementsView, runDecisions, type DecisionsListView } from '../src/decisions.js';
import { commandTreeUse } from '../src/worktree.js';

/**
 * The decision diff over HTTP, for the Changes page: the sessions the store keeps, one whole with its
 * matrix, a run's decisions, the goldens' models that retire, and the jobs that ask again, migrate
 * and verify what a session flagged, whose command lines the server builds.
 */

let store: Store;
let dash: Dashboard;
let readOnly: Dashboard;
let project = '';
let refunded = '';
let failed = '';
let golden = '';
const spawned: string[][] = [];

const step = (callNo: number, rank: DecisionStep['rank'], o: Partial<DecisionStep> = {}): DecisionStep => ({
  callNo,
  step: callNo,
  scope: null,
  rank,
  majority: rank,
  changes: [],
  recorded: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  now: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  samples: { asked: 2, answered: 2, changed: rank === null ? 0 : 2, ranks: [rank ?? 0, rank ?? 0] },
  model: { recorded: 'claude-sonnet-4-5-20250929', asked: 'claude-sonnet-5-5' },
  tokens: { before: null, after: null },
  cost: { before: null, after: null, spent: 0 },
  thinkingStripped: 0,
  error: null,
  ...o,
});

const runOf = (runId: string, golden: string | null, decisions: DecisionStep[]): DecisionRun => {
  const ranks = decisions.map((d) => d.rank).filter((r): r is NonNullable<typeof r> => r !== null);
  const rank = ranks.length ? (Math.min(...ranks) as DecisionRun['rank']) : null;
  return { runId, golden, steps: decisions.length, asked: decisions.length, rank, majority: rank, counts: emptyCounts(), cost: { before: 0.04, after: 0.02, spent: 0.02 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions, warnings: [] };
};

const api = (d: Dashboard, path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const startJob = (d: Dashboard, body: unknown) => api(d, 'jobs', { method: 'POST', body: JSON.stringify(body) });

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'sl-decisions-routes-'));
  // The golden's checks, as shadowlap.config.json gives them: verify is judged by them.
  writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund': { expect: { tools: { issue_refund: 0 } } } } }));
  store = Store.open(':memory:');
  refunded = recordRun(store, [LOOKUP, POLICY, REFUND, DONE], { model: 'claude-sonnet-4-5-20250929' }).run.runId;
  failed = recordRun(store, [LOOKUP, POLICY, REFUND], { model: 'claude-sonnet-4-5-20250929', status: 'failed' }).run.runId;
  golden = refunded;
  const runs = [
    runOf(refunded, 'goldens/refund', [step(5, 1, { changes: [{ rank: 1, kind: 'write-removed', tool: 'issue_refund', effect: 'write', before: { amount: 240 }, after: null, detail: 'issue_refund is no longer called' }] }), step(1, null), step(3, 4)]),
    runOf(failed, null, [step(1, null), step(3, null), step(5, 2)]),
  ];
  const report = { decisionsId: 'dc-01M5000000000000000000000A', kind: 'decisions', at: 1_000, change: { model: 'claude-sonnet-5-5', fields: { temperature: 1 }, fromCode: null, text: 'the model claude-sonnet-5-5 and temperature=1' }, command: 'shadowlap decisions goldens/* --model claude-sonnet-5-5', samples: 2, counts: emptyCounts(), flagged: [refunded, failed], remedies: [], notes: [], warnings: [], verify: null, stopReason: null };
  store.putDecisionSession({ sessionId: 'dc-01M5000000000000000000000A', kind: 'decisions', at: 1_000, change: report.change.text, actor: 'dev', revision: 'abc1234', data: report, runs: runs.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: r.decisions.filter((d) => d.rank !== null).length, data: r as unknown as Record<string, unknown> })) });
  const migrate = { migrateId: 'mg-01M5000000000000000000000B', kind: 'migrate', at: 2_000, from: ['claude-sonnet-4-5-20250929'], to: 'claude-haiku-4-5', decisions: { ...report, decisionsId: null, flagged: [refunded], change: { model: 'claude-haiku-4-5', fields: {}, from: ['claude-sonnet-4-5-20250929'], fromCode: null, text: 'the model claude-haiku-4-5' }, remedies: [{ field: 'max_tokens', value: 512, leftOut: false, why: 'refused', source: null, steps: 3 }], runs: [] }, passes: { verdict: 'accepted', runs: [] } };
  store.putDecisionSession({ sessionId: 'mg-01M5000000000000000000000B', kind: 'migrate', at: 2_000, change: 'the model claude-haiku-4-5', actor: 'dev', revision: null, data: migrate, runs: [{ runId: refunded, golden: 'goldens/refund', rank: 1, changed: 1, data: runs[0] as unknown as Record<string, unknown> }] });

  const spawnCli = (args: string[]) => {
    spawned.push(args);
    return spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  };
  const goldens = () => [{ path: 'goldens/refund', runId: golden, packedAt: 1, mode: 'replay' as const, repeat: 1, passes: 1, checks: ['issue_refund called 0 times'] }];
  dash = await startDashboard({ store, spawnCli, project: { path: project }, goldens });
  readOnly = await startDashboard({ store, spawnCli, readOnly: true, project: { path: project }, goldens });
});

afterAll(async () => {
  await Promise.all([dash?.close(), readOnly?.close()]);
  store?.close();
  if (project) rmSync(project, { recursive: true, force: true });
});

describe('the decision read models', () => {
  it("draws a run's row as its model calls in call order, each with its rank", () => {
    const run = decisionSession(store, 'dc-01M5000000000000000000000A')!;
    expect(run.matrix).toEqual([
      { runId: refunded, golden: 'goldens/refund', title: 'goldens/refund', rank: 1, cells: [{ callNo: 1, step: 1, rank: 0, majority: 0, changed: 0, answered: 2 }, { callNo: 3, step: 3, rank: 4, majority: 4, changed: 2, answered: 2 }, { callNo: 5, step: 5, rank: 1, majority: 1, changed: 2, answered: 2 }] },
      { runId: failed, golden: null, title: failed.slice(0, 10), rank: 2, cells: [{ callNo: 1, step: 1, rank: 0, majority: 0, changed: 0, answered: 2 }, { callNo: 3, step: 3, rank: 0, majority: 0, changed: 0, answered: 2 }, { callNo: 5, step: 5, rank: 2, majority: 2, changed: 2, answered: 2 }] },
    ]);
    expect(decisionRow({ ...(run.runs as DecisionRun[])[0]!, decisions: [step(2, null, { samples: { asked: 1, answered: 0, changed: 0, ranks: [] }, error: 'HTTP 529' })] }).cells).toEqual([{ callNo: 2, step: 2, rank: null, majority: null, changed: 0, answered: 0 }]);
    // A write changed in 1 of 3 samples: drawn split, its majority the same.
    expect(decisionRow({ ...(run.runs as DecisionRun[])[0]!, decisions: [step(4, 1, { majority: null, samples: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0] } })] }).cells).toEqual([{ callNo: 4, step: 4, rank: 1, majority: 0, changed: 1, answered: 3 }]);
  });

  it('fills a migrate session\'s decisions in from its runs, and finds a run\'s decisions newest first', () => {
    const m = decisionSession(store, 'mg-01M5000000000000000000000B')!;
    expect(m).toMatchObject({ kind: 'migrate', to: 'claude-haiku-4-5', decisions: { runs: [{ runId: refunded }] } });
    expect(runDecisions(store, refunded).sessions.map((s) => [s.sessionId, s.kind, s.rank, s.href])).toEqual([
      ['mg-01M5000000000000000000000B', 'migrate', 1, '#/changes/migrate/mg-01M5000000000000000000000B'],
      ['dc-01M5000000000000000000000A', 'decisions', 1, '#/changes/decisions/dc-01M5000000000000000000000A'],
    ]);
    expect(decisionSession(store, 'dc-nope')).toBeNull();
  });

  it('names the models the goldens use that retire, with the goldens that use each', () => {
    const view = retirementsView(store, [{ path: 'goldens/refund', runId: golden, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] }, { path: 'goldens/gone', runId: null, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] }], Date.parse('2026-10-19T12:00:00Z'));
    expect(view.version).toBe('2026-10-19');
    expect(view.notices).toHaveLength(1);
    expect(view.notices[0]).toMatchObject({ model: 'claude-sonnet-4-5-20250929', retires: '2026-11-30', days: 42, goldens: ['goldens/refund'], source: 'https://platform.claude.com/docs/en/about-claude/model-deprecations' });
  });
});

describe('the decision routes', () => {
  it('lists the sessions newest first, with the goldens\' models that retire', async () => {
    const res = await api(dash, 'decisions');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
    const view = (await res.json()) as DecisionsListView;
    expect(view.sessions.map((s) => [s.sessionId, s.kind, s.runs, s.flagged, s.href])).toEqual([
      ['mg-01M5000000000000000000000B', 'migrate', 1, 1, '#/changes/migrate/mg-01M5000000000000000000000B'],
      ['dc-01M5000000000000000000000A', 'decisions', 2, 2, '#/changes/decisions/dc-01M5000000000000000000000A'],
    ]);
    expect(view.retirements.notices.map((n) => n.model)).toEqual(['claude-sonnet-4-5-20250929']);
    const only = (await (await api(dash, 'decisions?kind=decisions')).json()) as DecisionsListView;
    expect(only.sessions.map((s) => s.kind)).toEqual(['decisions']);
    expect((await api(dash, 'decisions?kind=other')).status).toBe(400);
  });

  it('serves a session whole, a run\'s decisions, and the retirements', async () => {
    const one = (await (await api(dash, 'decisions/dc-01M5000000000000000000000A')).json()) as { runs: DecisionRun[]; matrix: unknown[]; command: string };
    expect(one.runs.map((r) => r.runId)).toEqual([refunded, failed]);
    expect(one.matrix).toHaveLength(2);
    expect(one.command).toBe('shadowlap decisions goldens/* --model claude-sonnet-5-5');
    expect((await api(dash, 'decisions/dc-01M5000000000000000000000Z')).status).toBe(404);
    const run = (await (await api(dash, `runs/${failed}/decisions`)).json()) as ReturnType<typeof runDecisions>;
    expect(run.sessions.map((s) => s.sessionId)).toEqual(['dc-01M5000000000000000000000A']);
    expect((await api(dash, 'runs/01NOPE000000000000000000/decisions')).status).toBe(404);
    const retirements = (await (await api(dash, 'retirements')).json()) as { notices: Array<{ model: string }> };
    expect(retirements.notices.map((n) => n.model)).toEqual(['claude-sonnet-4-5-20250929']);
  });

  it('builds the decisions job from what the page names, and refuses what it cannot check', async () => {
    const asked = await startJob(dash, { kind: 'decisions', goldens: ['goldens/refund'], runs: [failed], model: 'claude-sonnet-5-5', set: { temperature: 0 }, samples: 3 });
    expect(asked.status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', failed, 'goldens/refund', '--model', 'claude-sonnet-5-5', '--set', 'temperature=0', '--samples', '3']);
    const fromCode = await startJob(dash, { kind: 'decisions', goldens: 'all', fromCode: true, thenVerify: true });
    expect(fromCode.status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', 'goldens/refund', '--from-code', '--then-verify']);
    for (const [body, error] of [
      [{ kind: 'decisions', goldens: ['goldens/refund'] }, 'give the change: a model, fields to set, or fromCode for the prompt and tools in the working tree'],
      [{ kind: 'decisions', model: 'claude-sonnet-5-5' }, 'name the runs or goldens to ask again: runs, goldens, or goldens "all"'],
      [{ kind: 'decisions', goldens: ['goldens/elsewhere'], model: 'x' }, 'goldens/elsewhere is not one of the project\'s goldens'],
      [{ kind: 'decisions', runs: [refunded], model: 'a b' }, 'model is a model name, such as claude-sonnet-5-5'],
      [{ kind: 'decisions', runs: [refunded], set: { 'a b': 1 } }, 'a b is not a request field to set'],
      [{ kind: 'decisions', runs: [refunded], model: 'm', samples: 50 }, 'samples is a whole number from 1 to 20'],
    ] as const) {
      const res = await startJob(dash, body);
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
  });

  it('builds the migrate job, every golden when none are named', async () => {
    expect((await startJob(dash, { kind: 'migrate', to: 'claude-haiku-4-5' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['migrate', '--to', 'claude-haiku-4-5', 'goldens/refund']);
    expect((await startJob(dash, { kind: 'migrate', to: 'claude-haiku-4-5', runs: [failed], set: { max_tokens: 512 } })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['migrate', '--to', 'claude-haiku-4-5', failed, '--set', 'max_tokens=512']);
    const none = await startJob(dash, { kind: 'migrate' });
    expect(none.status).toBe(400);
  });

  it("verifies the runs a session flagged with decisions --verify, which judges each by its golden's own checks", async () => {
    // The CLI reads each golden's checks and each run's role itself: one verify per set of checks, whatever the goldens are.
    expect((await startJob(dash, { kind: 'decisions-verify', sessionId: 'dc-01M5000000000000000000000A', runId: refunded })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', 'dc-01M5000000000000000000000A', refunded]);
    expect((await startJob(dash, { kind: 'decisions-verify', sessionId: 'dc-01M5000000000000000000000A', yes: true })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', 'dc-01M5000000000000000000000A', '--yes']);
    expect((await startJob(dash, { kind: 'decisions-verify', sessionId: 'mg-01M5000000000000000000000B' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', 'mg-01M5000000000000000000000B']);
    const missing = await startJob(dash, { kind: 'decisions-verify', sessionId: 'dc-01M5000000000000000000000Z' });
    expect(missing.status).toBe(404);
    const unflagged = await startJob(dash, { kind: 'decisions-verify', sessionId: 'mg-01M5000000000000000000000B', runId: failed });
    expect(unflagged.status).toBe(404);
    expect(commandTreeUse(['decisions', '--verify', 'dc-01M5000000000000000000000A'])).toMatchObject({ use: 'reads', verb: 'verify the changed runs' });
  });

  it('passes the models a switch changes, and the scope, to decisions and migrate', async () => {
    expect((await startJob(dash, { kind: 'decisions', runs: [refunded], model: 'claude-sonnet-5-5', from: ['claude-sonnet-4-5-20250929'], scope: 'none' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', refunded, '--model', 'claude-sonnet-5-5', '--from', 'claude-sonnet-4-5-20250929', '--scope', 'none']);
    expect((await startJob(dash, { kind: 'migrate', to: 'claude-sonnet-5-5', from: ['claude-sonnet-4-5-20250929'], scope: 'agent' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['migrate', '--to', 'claude-sonnet-5-5', 'goldens/refund', '--from', 'claude-sonnet-4-5-20250929', '--scope', 'agent']);
    for (const [body, error] of [
      [{ kind: 'decisions', runs: [refunded], model: 'm', from: 'one' }, 'from is a list of the recorded models to switch from, such as ["claude-sonnet-4-5-20250929"]'],
      [{ kind: 'decisions', runs: [refunded], model: 'm', scope: 'shadowlap:judge' }, 'scope is the name of a scope the agent made calls in, or none'],
      [{ kind: 'decisions', runs: [refunded], fromCode: true, from: ['m'] }, 'from names the model calls a model or fields change: give one of them'],
    ] as const) {
      const res = await startJob(dash, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
  });

  it("leaves each run it verifies to verify's own gate: no job gives a count or a gate of its own", async () => {
    const jobs = [
      { kind: 'decisions', goldens: 'all', model: 'claude-sonnet-5-5', thenVerify: true },
      { kind: 'migrate', to: 'claude-haiku-4-5' },
      { kind: 'decisions-verify', sessionId: 'dc-01M5000000000000000000000A' },
      { kind: 'decisions-verify', sessionId: 'mg-01M5000000000000000000000B' },
    ];
    for (const body of jobs) {
      expect((await startJob(dash, body)).status, JSON.stringify(body)).toBe(202);
      expect(spawned.at(-1)!.filter((a) => ['--attempts', '--passes', '--gate', '--inconclusive'].includes(a)), JSON.stringify(body)).toEqual([]);
    }
  });

  it('refuses every job on a read-only dashboard', async () => {
    const res = await startJob(readOnly, { kind: 'decisions', goldens: 'all', model: 'claude-haiku-4-5' });
    expect(res.status).toBe(403);
  });

  it('holds the working tree for a job that runs the agent from it', () => {
    expect(commandTreeUse(['decisions', 'goldens/refund', '--model', 'm'])).toBeNull();
    expect(commandTreeUse(['decisions', 'goldens/refund', '--from-code'])).toMatchObject({ use: 'reads', verb: 'preview the change' });
    expect(commandTreeUse(['migrate', '--to', 'm'])).toMatchObject({ use: 'reads', verb: 'migrate' });
  });
});
