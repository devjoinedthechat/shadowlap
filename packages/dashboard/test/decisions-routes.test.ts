import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, NO_TOKENS, Store, type DecisionRun, type DecisionStep } from '@shadowlap/engine';
import { DONE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import type { ProjectConfig } from '../src/context.js';
import type { PreviewView } from '../src/decision-view.js';
import { decisionRow, decisionSession, retirementsView, runDecisions, type DecisionCell, type DecisionsListView } from '../src/decisions.js';
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
/**
 * Until every job a dashboard started has ended. Each stand-in exits at once, but on a busy machine
 * the jobs this file starts can still be 16 running, and the dashboard then refuses the next with a
 * 429 before its builder can say what it refuses it for.
 */
const jobsEnded = async (d: Dashboard) => {
  for (let i = 0; i < 1500; i++) {
    const { jobs } = (await (await api(d, 'jobs')).json()) as { jobs: Array<{ done: boolean }> };
    if (jobs.every((j) => j.done)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

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
    // A row is named by its run (its golden a chip beside it), each cell by what came of its step.
    const cell = (c: DecisionCell) => [c.callNo, c.step, c.rank, c.majority, c.changed, c.answered, c.judge, c.state];
    expect(run.matrix.map((r) => ({ runId: r.runId, golden: r.golden, title: r.title, rank: r.rank, flagged: r.flagged, cells: r.cells.map(cell) }))).toEqual([
      { runId: refunded, golden: 'goldens/refund', title: refunded.slice(0, 10), rank: 1, flagged: true, cells: [[1, 1, 0, 0, 0, 2, null, 'same'], [3, 3, 4, 4, 2, 2, null, 'ranked'], [5, 5, 1, 1, 2, 2, null, 'ranked']] },
      { runId: failed, golden: null, title: failed.slice(0, 10), rank: 2, flagged: true, cells: [[1, 1, 0, 0, 0, 2, null, 'same'], [3, 3, 0, 0, 0, 2, null, 'same'], [5, 5, 2, 2, 2, 2, null, 'ranked']] },
    ]);
    // Each row ends on what flags it, in its colour, and each cell says what it decided.
    expect(run.matrix.map((r) => r.ending)).toEqual([
      { text: '#5 issue_refund is no longer called', then: '', tone: 'w', callNo: 5, waits: 0, why: null },
      { text: '#5 it stops, hands over or is judged differently', then: '', tone: 's', callNo: 5, waits: 0, why: null },
    ]);
    expect(run.matrix[0].cells.map((c) => c.words)).toEqual(['the same in every sample: calls tools', 'a read asked differently · in 2 of 2 samples', 'issue_refund is no longer called · in 2 of 2 samples']);
    expect(decisionRow({ ...(run.runs as DecisionRun[])[0], decisions: [step(2, null, { samples: { asked: 1, answered: 0, changed: 0, ranks: [] }, error: 'HTTP 529' })] }).cells).toEqual([
      { callNo: 2, step: 2, rank: null, majority: null, changed: 0, answered: 0, judge: null, state: 'not-asked', sampled: null, ranks: [], control: null, detail: null, words: 'not asked: HTTP 529', open: null },
    ]);
    // A write changed in 1 of 3 samples: drawn split, its majority the same, and not flagged.
    const minority = decisionRow({ ...(run.runs as DecisionRun[])[0], majority: null, decisions: [step(4, 1, { majority: null, samples: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0] } })] });
    expect(minority.cells).toEqual([{ callNo: 4, step: 4, rank: 1, majority: 0, changed: 1, answered: 3, judge: null, state: 'ranked', sampled: 1, ranks: [1, 0, 0], control: null, detail: 'a write changed', rankWords: 'a write changed', words: 'a write changed · in 1 of 3 samples, fewer than half: not flagged', open: { short: 'in 1 of 3, not flagged', stops: { recorded: 'calls tools', now: 'calls tools' }, args: [], judges: [], delta: '' } }]);
    expect(minority.ending).toEqual({ text: '#4 a write changed', then: '· in 1 of 3, not flagged', tone: null, callNo: 4, waits: 0, why: null });
    // Left as recorded, the row says so; refused whole, every cell is not asked and the row says why.
    const left = decisionRow({ ...(run.runs as DecisionRun[])[0], asked: 0, steps: 1, counts: { ...emptyCounts(), untouched: 1 }, decisions: [step(2, null, { samples: { asked: 0, answered: 0, changed: 0, ranks: [] } })] });
    expect([left.cells[0].state, left.cells[0].words, left.ending.text]).toEqual(['left', 'left as recorded: made with claude-sonnet-4-5-20250929', 'the change leaves its requests as recorded']);
    // Asked nothing, a step not left as recorded: the report's words, why on the row's card.
    const unasked = decisionRow({ ...(run.runs as DecisionRun[])[0], asked: 0, steps: 1, counts: { ...emptyCounts(), notAsked: 1 }, decisions: [step(2, null, { samples: { asked: 1, answered: 0, changed: 0, ranks: [] }, error: 'HTTP 529' })] });
    expect([unasked.ending.text, unasked.ending.why]).toEqual(['nothing asked', 'HTTP 529']);
    const refused = decisionRow({ ...(run.runs as DecisionRun[])[0], refused: 'its first request differs in more than its prompt and tools\nkeep the rest as recorded', decisions: [step(2, 1)] });
    expect([refused.cells[0].state, refused.cells[0].words, refused.ending.text, refused.ending.tone]).toEqual(['not-asked', 'not asked: its first request differs in more than its prompt and tools', 'not asked: its first request differs in more than its prompt and tools', 'y']);
  });

  it('marks a text-only change a judge check read: raised to rank 2 when it came out otherwise, inconclusive while it waits on the judge', () => {
    const side = (status: 'passed' | 'failed' | 'inconclusive') => ({ status, verdict: status === 'passed' ? ('yes' as const) : status === 'failed' ? ('no' as const) : null, reason: status === 'inconclusive' ? 'not judged: no recorded verdict and no key for openai (OPENAI_API_KEY)' : 'r', source: status === 'inconclusive' ? null : ('live' as const), cost: status === 'inconclusive' ? null : 0.001, request: null });
    const judged = (now: 'passed' | 'failed' | 'inconclusive') => [{ name: 'fences', of: 'answer' as const, model: 'claude-haiku-4-5', pass: 'yes' as const, recorded: side('passed'), now: side(now), changed: now === 'inconclusive' ? null : now !== 'passed' }];
    const base = (decisionSession(store, 'dc-01M5000000000000000000000A')!.runs as DecisionRun[])[0];
    const samples = (ranks: number[], unjudged: number) => ({ asked: ranks.length, answered: ranks.length, changed: ranks.filter((r) => r).length, unjudged, ranks });
    const cells = decisionRow({
      ...base,
      decisions: [
        step(9, 2, { judge: judged('failed'), samples: samples([2, 2], 0) }),
        step(10, 5, { judge: judged('passed'), samples: samples([5, 5], 0) }),
        step(11, 5, { judge: judged('inconclusive'), samples: samples([5, 5], 2) }),
        step(12, 5),
        // One sample came out otherwise, the other could not be judged: not flagged without it, so the cell waits on the judge.
        step(13, 2, { majority: 5, judge: judged('failed'), samples: samples([2, 5], 1) }),
      ],
    }).cells;
    expect(cells.map((c) => [c.callNo, c.rank, c.judge])).toEqual([
      [9, 2, 'changed'],
      [10, 5, 'unchanged'],
      [11, 5, 'inconclusive'],
      [12, 5, null],
      [13, 2, 'inconclusive'],
    ]);
  });

  it('fills a migrate session\'s decisions in from its runs, and finds a run\'s decisions newest first', () => {
    const m = decisionSession(store, 'mg-01M5000000000000000000000B')!;
    expect(m).toMatchObject({ kind: 'migrate', to: 'claude-haiku-4-5', decisions: { runs: [{ runId: refunded }] } });
    // A run's part of a session opens its Decisions view at its most consequential change, and its cell on Changes.
    expect(runDecisions(store, refunded).sessions.map((s) => [s.sessionId, s.kind, s.rank, s.href, s.changes])).toEqual([
      ['mg-01M5000000000000000000000B', 'migrate', 1, `#/run/${refunded}/5/decisions`, `#/changes/migrate/mg-01M5000000000000000000000B/${refunded}/5`],
      ['dc-01M5000000000000000000000A', 'decisions', 1, `#/run/${refunded}/5/decisions`, `#/changes/decisions/dc-01M5000000000000000000000A/${refunded}/5`],
    ]);
    expect(runDecisions(store, refunded).sessions.map((s) => [s.name, s.samples, s.toVerify, s.verified])).toEqual([
      ['claude-sonnet-4-5-20250929 → claude-haiku-4-5', 2, true, null],
      ['Model switch to claude-sonnet-5-5 with temperature=1', 2, true, null],
    ]);
    // Its view lists its ranked steps, most consequential first, each worded on the server.
    expect(runDecisions(store, refunded).sessions[1].steps).toEqual([
      { callNo: 5, rank: 1, within: null, detail: 'issue_refund is no longer called', short: 'in 2 of 2', waits: false, recorded: 'calls tools', now: 'calls tools', delta: '', args: [] },
      { callNo: 3, rank: 4, within: null, detail: 'a read asked differently', short: 'in 2 of 2', waits: false, recorded: 'calls tools', now: 'calls tools', delta: '', args: [] },
    ]);
    expect(runDecisions(store, failed).sessions.map((s) => s.href)).toEqual([`#/run/${failed}/5/decisions`]);
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
  it('lists the sessions newest first, and leaves the goldens\' models that retire to their own read', async () => {
    const res = await api(dash, 'decisions');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
    const view = (await res.json()) as DecisionsListView;
    // A session opens at its own page under Changes: a migration's tab, a preview's.
    expect(view.sessions.map((s) => [s.sessionId, s.kind, s.runs, s.flagged, s.href])).toEqual([
      ['mg-01M5000000000000000000000B', 'migrate', 1, 1, '#/changes/migrate/mg-01M5000000000000000000000B'],
      ['dc-01M5000000000000000000000A', 'decisions', 2, 2, '#/changes/decisions/dc-01M5000000000000000000000A'],
    ]);
    // Reading every golden's calls belongs on the pool: GET /api/retirements and Migrate's start read have them.
    expect('retirements' in view).toBe(false);
    const only = (await (await api(dash, 'decisions?kind=decisions')).json()) as DecisionsListView;
    expect(only.sessions.map((s) => s.kind)).toEqual(['decisions']);
    expect((await api(dash, 'decisions?kind=other')).status).toBe(400);
  });

  it('serves a session whole, a run\'s decisions, and the retirements', async () => {
    const one = (await (await api(dash, 'decisions/dc-01M5000000000000000000000A')).json()) as { runs: DecisionRun[]; matrix: unknown[]; command: string; view: PreviewView };
    expect(one.runs.map((r) => r.runId)).toEqual([refunded, failed]);
    expect(one.matrix).toHaveLength(2);
    // Worded on the server for Preview: no redaction rules in this project, so a cell's cost says none masked.
    expect(one.view).toMatchObject({ name: 'Model switch to claude-sonnet-5-5 with temperature=1', samples: 2, verdict: { word: 'not verified' }, next: { verify: { runs: [refunded, failed], every: true, gone: 0 } }, redacted: false });
    expect(one.command).toBe('shadowlap decisions goldens/* --model claude-sonnet-5-5');
    expect((await api(dash, 'decisions/dc-01M5000000000000000000000Z')).status).toBe(404);
    const run = (await (await api(dash, `runs/${failed}/decisions`)).json()) as ReturnType<typeof runDecisions>;
    expect(run.sessions.map((s) => s.sessionId)).toEqual(['dc-01M5000000000000000000000A']);
    expect((await api(dash, 'runs/01NOPE000000000000000000/decisions')).status).toBe(404);
    const retirements = (await (await api(dash, 'retirements')).json()) as { notices: Array<{ model: string }> };
    expect(retirements.notices.map((n) => n.model)).toEqual(['claude-sonnet-4-5-20250929']);
  });

  it('reads what the working tree sends the runs as a job of its own, offline, titled as the CLI says it', async () => {
    const read = await startJob(dash, { kind: 'decisions-read', goldens: ['goldens/refund'], runs: [failed], scope: 'billing' });
    expect(read.status).toBe(202);
    expect(await read.json()).toMatchObject({ kind: 'decisions-read', title: 'Reading what your working tree sends' });
    expect(spawned.at(-1)).toEqual(['decisions', failed, 'goldens/refund', '--scope', 'billing', '--from-code', '--dry-run']);
    expect((await startJob(dash, { kind: 'decisions-read' })).status).toBe(400);
  });

  it('builds the decisions job from what the page names, and refuses what it cannot check', async () => {
    const asked = await startJob(dash, { kind: 'decisions', goldens: ['goldens/refund'], runs: [failed], model: 'claude-sonnet-5-5', set: { temperature: 0 }, samples: 3 });
    expect(asked.status).toBe(202);
    // Titled by the way it previews, in the engine's words: a model wherever one is named, the fields only where none is.
    expect(await asked.json()).toMatchObject({ kind: 'decisions', title: 'Previewing model switch' });
    expect(spawned.at(-1)).toEqual(['decisions', failed, 'goldens/refund', '--model', 'claude-sonnet-5-5', '--set', 'temperature=0', '--samples', '3']);
    // One sample is asked for as such: left out, the CLI would ask 3 under the change and 3 as recorded.
    expect((await startJob(dash, { kind: 'decisions', runs: [failed], model: 'claude-sonnet-5-5', samples: 1 })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', failed, '--model', 'claude-sonnet-5-5', '--samples', '1']);
    const fromCode = await startJob(dash, { kind: 'decisions', goldens: 'all', fromCode: true, thenVerify: true });
    expect(fromCode.status).toBe(202);
    expect(await fromCode.json()).toMatchObject({ title: 'Previewing changed prompt' });
    // None given: the CLI's own, six requests a step.
    expect(spawned.at(-1)).toEqual(['decisions', 'goldens/refund', '--from-code', '--then-verify']);
    const fields = await startJob(dash, { kind: 'decisions', runs: [failed], set: { temperature: 0 } });
    expect(await fields.json()).toMatchObject({ title: 'Previewing field change' });
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
    const one = await startJob(dash, { kind: 'decisions-verify', sessionId: 'dc-01M5000000000000000000000A', runId: refunded });
    expect(one.status).toBe(202);
    // Titled by the run it takes, or how many: the drawer's words while it runs.
    expect(await one.json()).toMatchObject({ kind: 'decisions-verify', title: `Verifying ${refunded.slice(0, 10)}` });
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', 'dc-01M5000000000000000000000A', refunded]);
    // A bare yes says yes to no question: none of the session's runs is someone else's, so nothing is asked, nor passed on.
    const every = await startJob(dash, { kind: 'decisions-verify', sessionId: 'dc-01M5000000000000000000000A', yes: true });
    expect(every.status).toBe(202);
    expect(await every.json()).toMatchObject({ title: 'Verifying 2 runs' });
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', 'dc-01M5000000000000000000000A']);
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

  it("leaves each run it verifies to verify's own gate unless Run more attempts raises a limit: no job gives a count, or a gate of its own", async () => {
    const jobs = [
      { kind: 'decisions', goldens: 'all', model: 'claude-sonnet-5-5', thenVerify: true },
      { kind: 'migrate', to: 'claude-haiku-4-5' },
      { kind: 'decisions-verify', sessionId: 'dc-01M5000000000000000000000A' },
      { kind: 'decisions-verify', sessionId: 'mg-01M5000000000000000000000B' },
    ];
    for (const body of jobs) {
      expect((await startJob(dash, body)).status, JSON.stringify(body)).toBe(202);
      expect(spawned.at(-1)!.filter((a) => ['--attempts', '--passes', '--gate', '--inconclusive', '--kept-max'].includes(a)), JSON.stringify(body)).toEqual([]);
    }
    // Run more attempts raises only the limits: a failing run's attempts, the gate's other figures as the session's verify had them (its defaults here), and a good run's pairs.
    const more = await startJob(dash, { kind: 'decisions-verify', sessionId: 'dc-01M5000000000000000000000A', max: 160, keptMax: 400 });
    expect(more.status).toBe(202);
    expect(((await more.json()) as { title: string }).title).toBe('Running more attempts');
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', 'dc-01M5000000000000000000000A', '--gate', '{"max":160}', '--kept-max', '400']);
    for (const [bad, said] of [[{ max: 0 }, 'max is the most attempts a run takes, a whole number up to 1000'], [{ max: 1001 }, 'max is the most attempts'], [{ keptMax: 2.5 }, 'keptMax is the most pairs a good run takes']] as const) {
      const r = await startJob(dash, { kind: 'decisions-verify', sessionId: 'dc-01M5000000000000000000000A', ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain(said);
    }
  });

  it('verifies the runs Preview names of those left to verify, an empty list naming none, and says which named run it cleared or never asked', async () => {
    const A = 'dc-01M5000000000000000000000A';
    const error = async (res: Response) => ((await res.json()) as { error: string }).error;
    await jobsEnded(dash);
    // The runs no verify took yet, as Preview's Verify names them once verify took some: each by its id or a prefix, once.
    expect((await startJob(dash, { kind: 'decisions-verify', sessionId: A, runIds: [failed] })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', A, failed]);
    expect((await startJob(dash, { kind: 'decisions-verify', sessionId: A, runIds: [refunded.slice(0, 12), failed, failed] })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', A, refunded, failed]);
    // A list naming none names none: every run left to verify, as the estimate takes it.
    expect((await startJob(dash, { kind: 'decisions-verify', sessionId: A, runIds: [] })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', A]);
    // 500 at most, as a list.
    expect((await startJob(dash, { kind: 'decisions-verify', sessionId: A, runIds: Array.from({ length: 500 }, () => failed) })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', A, failed]);
    for (const runIds of [Array.from({ length: 501 }, () => failed), failed]) {
      const res = await startJob(dash, { kind: 'decisions-verify', sessionId: A, runIds });
      expect([res.status, await error(res)]).toEqual([400, 'runIds is a list of the runs to verify']);
    }
    // A session that cleared a run: named among the others, the job is refused, the run named.
    const C = 'dc-01M5000000000000000000000C';
    const runs = decisionSession(store, A)!.runs as DecisionRun[];
    store.putDecisionSession({ sessionId: C, kind: 'decisions', at: 500, change: 'the model claude-sonnet-5-5', actor: null, revision: null, data: { change: { model: 'claude-sonnet-5-5', fields: {}, fromCode: null, text: 'the model claude-sonnet-5-5' }, flagged: [refunded, failed], toVerify: [refunded], verify: null }, runs: runs.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: 1, data: r as unknown as Record<string, unknown> })) });
    const cleared = await startJob(dash, { kind: 'decisions-verify', sessionId: C, runIds: [refunded, failed] });
    expect([cleared.status, await error(cleared)]).toEqual([409, `this session cleared ${failed}: it has nothing to verify`]);
    const stranger = await startJob(dash, { kind: 'decisions-verify', sessionId: 'mg-01M5000000000000000000000B', runIds: [refunded, failed] });
    expect([stranger.status, await error(stranger)]).toEqual([404, `this session asked no run ${failed}`]);
    expect((await startJob(dash, { kind: 'decisions-verify', sessionId: C })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['decisions', '--verify', C]);
  });

  it('serves a preview whose project config can’t be read, its cost line saying nothing of it, and an exact clock as such', async () => {
    const at = async (loadConfig: () => ProjectConfig) => {
      const own = await startDashboard({ store, project: { path: project }, goldens: () => [], loadConfig });
      try {
        const res = await api(own, 'decisions/dc-01M5000000000000000000000A');
        return [res.status, ((await res.json()) as { view: PreviewView }).view] as const;
      } finally {
        await own.close();
      }
    };
    const [status, view] = await at(() => {
      throw new SyntaxError('Unexpected token } in JSON');
    });
    expect([status, view.redacted, view.clock]).toEqual([200, false, null]);
    const [, exact] = await at(() => ({ normalize: [], redact: [], clock: 'exact' }));
    expect([exact.redacted, exact.clock]).toEqual([false, 'exact']);
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

describe('a golden whose path reads as an option', () => {
  it('is never given to the CLI to ask again', async () => {
    const own = await startDashboard({ store, spawnCli: (args: string[]) => (spawned.push(args), spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })), project: { path: project }, goldens: () => [{ path: '--yes', runId: golden, packedAt: 1, mode: 'replay' as const, repeat: 1, passes: 1, checks: [] }] });
    try {
      const before = spawned.length;
      const res = await startJob(own, { kind: 'decisions', goldens: ['--yes'], model: 'claude-sonnet-5-5' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/^--yes: its path starts with "-", which the CLI would read as an option/);
      expect(spawned.length).toBe(before);
    } finally {
      await own.close();
    }
  });
});
