import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, recordVerdict, Store, type Task, type VerifyReport } from '@shadowlap/engine';
import { blameReport, EXPECT, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { DONE, ESCALATE, ESCALATE_2, LOOKUP, POLICY, REFUND, recordRun, type Step } from '../../engine/test/training-fixtures.js';
import { startDashboard, type Dashboard, type JobView, type ModelsView, type TrainingView } from '../src/index.js';
import { readTraining, sourceFixes, trainingView } from '../src/training.js';

/**
 * Training over HTTP: `GET /api/training` from a store with a blamed run in a fix, a verify of it
 * and two scored models; `GET /api/models` from fake provider lists (no network, no model server);
 * and the `pairs` and `score` job kinds, whose command lines the server builds from what the
 * dialogs name.
 */

const LOST = [LOOKUP, POLICY, REFUND, DONE];
/** An answer to the refund no other attempt gives, so verify's pair is its own. */
const ESCALATE_3: Step = { text: 'Escalating: this is above the limit.', tools: [{ name: 'escalate', input: { reason: '$240 is above the $100 limit' } }] };

const task = (golden: string, status: Task['status'], rewards: string | null, runId: string | null): Task => ({
  golden,
  name: golden.split('/').at(-1)!,
  status,
  note: status === 'blocked' ? 'its test fails' : status === 'not-a-task' ? 'its checks only cap tokens and cost' : null,
  runId,
  takeover: { callNo: 5, why: 'decides between refunding and escalating', from: 'config' },
  scope: null,
  scopes: [null],
  rewards,
  checks: status === 'not-a-task' ? [{ label: 'at most 60000 input tokens', cap: true }] : [{ label: 'issue_refund called 0 times', cap: false }],
  after: { live: [], stubbed: ['escalate'] },
  prefix: 4,
  model: 'claude-sonnet-5',
  provider: 'anthropic',
  callName: 'POST /v1/messages',
  tokensAfter: { inputTokens: 2_000, outputTokens: 100 },
});

/** The verify report of a verify that replayed `target`, with the attempts the store holds. */
function verified(target: string, attempts: Array<{ runId: string; passed: boolean }>): VerifyReport {
  const report = verifyReport([{ runId: target, role: 'target', pass: false, recorded: false }]);
  const run = report.runs[0]!;
  run.attempts = attempts.map((a) => ({ ...run.attempts[0]!, runId: a.runId, passed: a.passed, exitCode: a.passed ? 0 : 1 }));
  run.passes = attempts.filter((a) => a.passed).length;
  return report;
}

let store: Store;
let lostId = '';
let fixId = '';
let verifyId = '';
let goldenRun = '';
let tasks: Task[] = [];
let loads = 0;
const roots: Array<string | null> = [];
let dash: Dashboard;
let readOnly: Dashboard;
let bare: Dashboard;
let broken: Dashboard;
const spawned: string[][] = [];
const asked: string[] = [];
let project = '';

/** Provider model lists, as Anthropic's API and an Ollama on this machine answer them. Nothing else answers. */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(url);
  const body = url.startsWith('https://api.anthropic.com/v1/models') ? { data: [{ id: 'claude-sonnet-5' }, { id: 'claude-haiku-4-5' }] } : url === 'http://127.0.0.1:11434/api/tags' ? { models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] } : null;
  // Anything else is a server that isn't there, as fetch reports one.
  if (!body) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const api = (d: Dashboard, path: string, init: RequestInit = {}) => fetch(`${d.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': d.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const startJob = (d: Dashboard, body: unknown) => api(d, 'jobs', { method: 'POST', body: JSON.stringify(body) });

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'sl-training-routes-'));
  store = Store.open(':memory:');
  // A refund run lost at #5: blamed, its two passing probes escalated, and the blame opened a fix.
  const lost = recordRun(store, LOST, { status: 'failed', meta: { labels: ['refund-bug'] } }).run;
  lostId = lost.runId;
  store.updateRunMeta(lostId, { blame: { at: 2_000, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: ['the agent exits 0'], probes: [{ callNo: 5, passes: 2, attempts: 2, rescued: true }], spent: 0 } });
  for (const steps of [[LOOKUP, POLICY, ESCALATE, DONE], [LOOKUP, POLICY, ESCALATE_2, DONE]]) recordRun(store, steps, { parentRunId: lostId, meta: { probe: { of: lostId, callNo: 5, passed: true } } });
  fixId = recordBlame(store, { runId: lostId, report: blameReport(lostId), expect: EXPECT, scope: null, command: 'shadowlap blame 01TEST --expect …', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 3_000 }).fix.fixId;
  // A verify of the fixed prompt on the same run: one attempt still refunds, one escalates.
  const attempt = (steps: Step[], passed: boolean) => recordRun(store, steps, { parentRunId: lostId, status: passed ? 'completed' : 'failed', codeVersion: 'c91d0f4', meta: { verify: { role: 'target', passed }, repeat: { group: `v1-${lostId}`, attempt: 1, of: 2 } } }).run;
  const failing = attempt(LOST, false);
  const passing = attempt([LOOKUP, POLICY, ESCALATE_3, DONE], true);
  verifyId = recordVerdict(store, { report: verified(lostId, [{ runId: failing.runId, passed: false }, { runId: passing.runId, passed: true }]), expect: EXPECT, command: 'shadowlap verify --fixes 01TEST', fixIds: [fixId], at: 4_000 }).verdict.verifyId;
  // A golden's run, scored by two models.
  goldenRun = recordRun(store, [LOOKUP, POLICY, ESCALATE, DONE]).run.runId;
  tasks = [task('goldens/refund-over-limit', 'ready', 'escalate above the limit', goldenRun), task('goldens/refund-in-limit', 'blocked', 'refund within the limit', null), task('goldens/budget', 'not-a-task', null, null)];
  for (const [model, baseUrl, scores, at] of [['claude-sonnet-5', null, [1, 1], 5_000], ['qwen2.5:7b', 'http://127.0.0.1:11434/v1', [1, 0.5], 6_000]] as const) {
    store.replaceTaskScores(model, baseUrl, 'goldens/refund-over-limit', scores.map((score, i) => ({ attempt: i + 1, runId: goldenRun, score, checks: [], spent: baseUrl ? 0 : 0.02, via: baseUrl ? 'Ollama, on this machine' : 'Anthropic API', session: `s-${model}`, at })));
  }

  const training = {
    loadTasks: (_store: Store, root: string | null) => {
      loads++;
      roots.push(root);
      return tasks;
    },
    env: { ANTHROPIC_API_KEY: 'test-key', OLLAMA_HOST: '127.0.0.1:11434' },
    fetch: fakeFetch,
    timeoutMs: 200,
  };
  const spawnCli = (args: string[]) => {
    spawned.push(args);
    return spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  };
  dash = await startDashboard({ store, spawnCli, project: { path: project }, training });
  readOnly = await startDashboard({ store, spawnCli, readOnly: true, project: { path: project }, training });
  bare = await startDashboard({ store, spawnCli, project: { path: project }, training: { env: { OLLAMA_HOST: '127.0.0.1:2' }, fetch: fakeFetch } });
  broken = await startDashboard({
    store,
    spawnCli,
    project: { path: project },
    training: {
      loadTasks: () => {
        throw new Error('shadowlap.config.json: tests["goldens/x"].task.takeover must be a call number');
      },
    },
  });
});

afterAll(async () => {
  await Promise.all([dash?.close(), readOnly?.close(), bare?.close(), broken?.close()]);
  store?.close();
  if (project) rmSync(project, { recursive: true, force: true });
});

describe('GET /api/training', () => {
  it('serves the screen: pairs grouped per call with their fix, sources, tasks and scores', async () => {
    const res = await api(dash, 'training');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
    const view = (await res.json()) as TrainingView;
    expect(view.strip.pairs).toMatchObject({ value: '3', sub: '2 high confidence · 1 medium' });
    expect(view.strip.tasks).toMatchObject({ value: '1 / 3', sub: '1 blocked · 1 not a task' });
    expect(view.strip.best).toMatchObject({ value: '1.00', sub: 'claude-sonnet-5 · 2 models scored' });
    expect(view.tabs).toEqual({ pairs: 3, tasks: 1 });
    // The blame's pairs open its fix at the Blame step; the verify's open the verify it was.
    const [blame, verify] = view.pairs.groups;
    expect(blame).toMatchObject({ confidence: 'high', count: 2, fix: { label: 'refund-bug', href: `#/fixes/${fixId}/blame` }, source: { kind: 'blame', href: `#/fixes/${fixId}/blame` } });
    expect(verify).toMatchObject({ confidence: 'medium', count: 1, fix: { label: 'refund-bug', href: `#/fixes/${fixId}/verify/${verifyId}` }, from: 'from verify', chosenLabel: 'chosen · verify attempt, passed' });
    expect(view.pairs.sources.map((s) => [s.label, s.made, s.href])).toEqual([
      ['blame · refund-bug', 2, `#/fixes/${fixId}/blame`],
      ['verify · c91d0f4', 1, `#/fixes/${fixId}/verify/${verifyId}`],
    ]);
    expect(view.tasks.rows.map((r) => [r.name, r.status.label, r.href])).toEqual([
      ['refund-over-limit', 'ready', `#/run/${goldenRun}/5`],
      ['refund-in-limit', 'blocked', '#/tests'],
      ['budget', 'not a task', null],
    ]);
    expect(view.tasks.warning).toMatchObject({ rewards: 'escalate above the limit', name: 'refund-in-limit', once: 'its test passes', fix: { label: 'Fix it on Tests', href: '#/tests' } });
    expect(view.tasks.error).toBeNull();
    expect(view.scores.cards.map((c) => [c.model, c.mean, c.cost])).toEqual([
      ['claude-sonnet-5', 1, '≈$0.040 spent'],
      ['qwen2.5:7b', 0.75, '$0, not a paid API'],
    ]);
    expect(view.serve?.response).toContain('{ "check": "issue_refund called 0 times", "pass": true } ],');
  });

  it('answers 304 when nothing changed, filters by confidence, and refuses a filter it doesn’t know', async () => {
    const first = await api(dash, 'training');
    const etag = first.headers.get('etag')!;
    const again = await fetch(`${dash.url}/api/training`, { headers: { 'x-shadowlap-token': dash.token, 'if-none-match': etag } });
    expect(again.status).toBe(304);
    const medium = (await (await api(dash, 'training?filter=medium')).json()) as TrainingView;
    expect(medium.pairs.groups.map((g) => g.confidence)).toEqual(['medium']);
    expect(medium.pairs.counts).toEqual({ all: 3, high: 2, medium: 1 });
    const bad = await api(dash, 'training?filter=low');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'filter must be all, high or medium' });
  });

  it('reads the goldens once for a burst of requests, and says why they can’t be read', async () => {
    const before = loads;
    await Promise.all([api(dash, 'training'), api(dash, 'training'), api(dash, 'training')]);
    expect(loads - before).toBeLessThanOrEqual(1);
    // From the project folder the dashboard's jobs run in.
    expect(new Set(roots)).toEqual(new Set([resolve(project)]));
    const view = (await (await api(broken, 'training')).json()) as TrainingView;
    expect(view.tasks).toMatchObject({ rows: [], empty: null, error: 'shadowlap.config.json: tests["goldens/x"].task.takeover must be a call number' });
    expect(view.strip.tasks).toMatchObject({ value: '0 / 0', sub: 'the tasks can’t be read' });
    expect(view.pairs.counts.all).toBe(3);
    // Scoring needs the tasks: it says why it can't run.
    const job = await startJob(broken, { kind: 'score', model: 'm' });
    expect(job.status).toBe(409);
    expect(await job.json()).toEqual({ error: 'shadowlap.config.json: tests["goldens/x"].task.takeover must be a call number' });
  });

  it('says a dashboard that wasn’t given the goldens can’t list tasks', async () => {
    const view = (await (await api(bare, 'training')).json()) as TrainingView;
    expect(view.tasks.error).toMatch(/doesn’t read the project’s goldens/);
    expect(view.pairs.counts.all).toBe(3);
  });

  it('shows every page on a read-only dashboard', async () => {
    expect((await api(readOnly, 'training')).status).toBe(200);
  });
});

describe('GET /api/models', () => {
  it('lists the recorded model, each provider’s models with the keys here, and endpoints scored before, each priced', async () => {
    asked.length = 0;
    const res = await api(dash, 'models');
    expect(res.status).toBe(200);
    const view = (await res.json()) as ModelsView;
    expect(view.ready).toBe(1);
    expect(view.choices.map((c) => [c.group, c.id, c.local, c.lastScore])).toEqual([
      ['Recorded with', 'claude-sonnet-5', false, 1],
      ['Anthropic API', 'claude-haiku-4-5', false, null],
      ['Ollama, on this machine', 'llama3.1:8b', true, null],
      ['Ollama, on this machine', 'qwen2.5:7b', true, 0.75],
    ]);
    expect(view.choices.find((c) => c.id === 'claude-haiku-4-5')!.perAttempt).toBeGreaterThan(0);
    expect(view.choices.find((c) => c.id === 'qwen2.5:7b')!.perAttempt).toBe(0);
    // No OpenAI key here, so OpenAI was never asked.
    expect(view.notes).toEqual([{ group: 'OpenAI API', note: 'OPENAI_API_KEY is not set' }]);
    expect(asked.sort()).toEqual(['http://127.0.0.1:11434/api/tags', 'https://api.anthropic.com/v1/models?limit=100']);
    expect(view.dialog).toMatchObject({ title: 'Score a model on 1 task', groups: ['Recorded with', 'Anthropic API', 'Ollama, on this machine'], selected: 'claude-haiku-4-5\n', attempts: [5, 10] });
    expect(view.dialog!.options.find((o) => o.id === 'qwen2.5:7b')).toMatchObject({ request: { model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/v1' }, label: 'qwen2.5:7b · scored 0.75', note: 'Runs at http://127.0.0.1:11434/v1 · not a paid API · replaces its score of 0.75' });
  });

  it('keeps a listing for a few seconds, so opening the dialog again asks nobody', async () => {
    await api(dash, 'models');
    asked.length = 0;
    expect((await api(dash, 'models')).status).toBe(200);
    expect(asked).toEqual([]);
  });

  it('fails soft: a provider without a key or a server becomes a note', async () => {
    const view = (await (await api(bare, 'models')).json()) as ModelsView;
    // No tasks, no keys, and nothing answers where Ollama would be: every list is a note, and there is nothing to score.
    expect(view.ready).toBe(0);
    expect(view.dialog).toBeNull();
    // What the store scored before is still offered: it needs no provider to list it.
    expect(view.choices.map((c) => [c.group, c.id, c.lastScore])).toEqual([
      ['Endpoints scored before', 'claude-sonnet-5', null],
      ['Endpoints scored before', 'qwen2.5:7b', null],
    ]);
    expect(view.notes).toEqual([
      { group: 'Anthropic API', note: 'ANTHROPIC_API_KEY is not set' },
      { group: 'OpenAI API', note: 'OPENAI_API_KEY is not set' },
      { group: 'Ollama, on this machine', note: "isn't running" },
    ]);
  });
});

describe('the pairs and score jobs', () => {
  it('exports pairs into the project’s exports folder, in the format and at the confidence asked', async () => {
    spawned.length = 0;
    const res = await startJob(dash, { kind: 'pairs', format: 'trl', minConfidence: 'medium' });
    expect(res.status).toBe(202);
    const job = (await res.json()) as JobView;
    expect(job.title).toBe('Exporting pairs');
    expect(spawned).toEqual([['export', 'pairs', '--min-confidence', 'medium', '--format', 'trl', '--out', '.shadowlap/exports/pairs.jsonl']]);
    const bad = await startJob(dash, { kind: 'pairs', format: 'csv' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'format must be openai-preference or trl' });
  });

  it('scores a model on every ready task, and refuses what it can’t build a command from', async () => {
    spawned.length = 0;
    const res = await startJob(dash, { kind: 'score', model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/v1', attempts: 10 });
    expect(res.status).toBe(202);
    expect(((await res.json()) as JobView).title).toBe('Scoring a model');
    expect(spawned).toEqual([['tasks', 'score', 'goldens/refund-over-limit', '--model', 'qwen2.5:7b', '--base-url', 'http://127.0.0.1:11434/v1', '--attempts', '10']]);
    for (const [body, error] of [
      [{ model: 'm; rm -rf /' }, 'model must be a model name, such as qwen2.5:7b'],
      [{ model: 'm', baseUrl: 'file:///etc/passwd' }, 'baseUrl must be an http or https URL'],
      [{ model: 'm', goldens: ['goldens/refund-in-limit'] }, 'goldens/refund-in-limit is not a ready task'],
      [{ model: 'm', attempts: 1000 }, 'attempts must be 5 or 10'],
      [{ model: 'm', attempts: 7 }, 'attempts must be 5 or 10'],
    ] as const) {
      const r = await startJob(dash, { kind: 'score', ...body });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error });
    }
    expect(spawned).toHaveLength(1);
    const none = await startJob(bare, { kind: 'score', model: 'm' });
    expect(none.status).toBe(409);
  });

  it('runs nothing from a read-only dashboard', async () => {
    spawned.length = 0;
    expect((await startJob(readOnly, { kind: 'pairs' })).status).toBe(403);
    expect((await startJob(readOnly, { kind: 'score', model: 'm' })).status).toBe(403);
    expect(spawned).toEqual([]);
    const meta = (await (await api(dash, 'meta')).json()) as { jobKinds: string[] };
    expect(meta.jobKinds).toEqual(expect.arrayContaining(['pairs', 'score']));
  });
});

describe('the fix a pair source belongs to', () => {
  it('names the fix and the verify, and nothing for a source outside any fix', () => {
    const fixOf = sourceFixes(store);
    const { sources } = readTraining(store, { tasks: [] });
    expect(sources.map((s) => fixOf(s, s.runId))).toEqual([
      { id: fixId, label: 'refund-bug' },
      { id: fixId, label: 'refund-bug', verifyId },
    ]);
    const other = Store.open(':memory:');
    const run = recordRun(other, LOST, { status: 'failed' }).run;
    other.updateRunMeta(run.runId, { blame: { at: 2_000, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
    recordRun(other, [LOOKUP, POLICY, ESCALATE, DONE], { parentRunId: run.runId, meta: { probe: { of: run.runId, callNo: 5, passed: true } } });
    const view = trainingView(readTraining(other, { tasks: [], fixOf: sourceFixes(other) }));
    expect(view.pairs.groups[0]).toMatchObject({ fix: null, source: { href: `#/run/${run.runId}/5/forks` } });
    other.close();
  });

  it('gives each group of one verify the fix of the run its pairs are about, when the verdict counted for both', () => {
    const s = Store.open(':memory:');
    // Two failures blamed into two fixes, then one verify of both: shadowlap verify --fixes <a> <b>.
    const lost = (label: string, user: string) => {
      const run = recordRun(s, LOST, { status: 'failed', user, meta: { labels: [label] } }).run;
      const fix = recordBlame(s, { runId: run.runId, report: blameReport(run.runId), expect: EXPECT, scope: null, command: 'shadowlap blame', title: `${label} refunded $240`, checkText: 'issue_refund never called with {"amount":240}', at: 3_000 }).fix.fixId;
      const attempt = (steps: Step[], passed: boolean) => recordRun(s, steps, { parentRunId: run.runId, status: passed ? 'completed' : 'failed', codeVersion: 'd2e8a1f', user, meta: { verify: { role: 'target', passed }, repeat: { group: `v1-${run.runId}`, attempt: passed ? 2 : 1, of: 2 } } }).run;
      return { run: run.runId, fix, attempts: [{ runId: attempt(LOST, false).runId, passed: false }, { runId: attempt([LOOKUP, POLICY, ESCALATE_3, DONE], true).runId, passed: true }] };
    };
    const a = lost('bug-a', 'Refund order A-3001.');
    const b = lost('bug-b', 'Refund order A-3002.');
    expect(a.fix).not.toBe(b.fix);
    const report = verifyReport([a, b].map((x) => ({ runId: x.run, role: 'target' as const, pass: false, recorded: false })));
    report.runs.forEach((r, i) => {
      r.attempts = [a, b][i]!.attempts.map((x) => ({ ...r.attempts[0]!, runId: x.runId, passed: x.passed, exitCode: x.passed ? 0 : 1 }));
      r.passes = 1;
    });
    const vf = recordVerdict(s, { report, expect: EXPECT, command: 'shadowlap verify --fixes a b', fixIds: [a.fix, b.fix], at: 4_000 }).verdict.verifyId;

    const view = trainingView(readTraining(s, { tasks: [], fixOf: sourceFixes(s) }));
    const verify = view.pairs.groups.filter((g) => g.from === 'from verify');
    expect(verify.map((g) => [g.about, g.fix])).toEqual(
      expect.arrayContaining([
        [a.run, { label: 'bug-a', href: `#/fixes/${a.fix}/verify/${vf}` }],
        [b.run, { label: 'bug-b', href: `#/fixes/${b.fix}/verify/${vf}` }],
      ]),
    );
    expect(verify).toHaveLength(2);
    s.close();
  });
});

describe('a repair\'s verifies as pair sources', () => {
  it('names each by its candidate, and opens one the gate turned down at the fix\'s Repair step', () => {
    const s = Store.open(':memory:');
    const run = recordRun(s, LOST, { status: 'failed', user: 'Refund order A-4001.', meta: { labels: ['refund-bug'] } }).run;
    const fx = recordBlame(s, { runId: run.runId, report: blameReport(run.runId), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'refund-bug refunded $240', checkText: 'issue_refund never called with {"amount":240}', at: 3_000 }).fix.fixId;
    // Candidate 2 refunded once in two attempts and was turned down; repair kept no verdict for it.
    const attempt = (steps: Step[], passed: boolean, n: number) => recordRun(s, steps, { parentRunId: run.runId, status: passed ? 'completed' : 'failed', codeVersion: 'a7b3c2e+dirty', user: 'Refund order A-4001.', meta: { verify: { role: 'target', passed }, repeat: { group: `c2-${run.runId}`, attempt: n, of: 2 } } }).run;
    const tried = [attempt(LOST, false, 1), attempt([LOOKUP, POLICY, ESCALATE_3, DONE], true, 2)];
    const report = repairReport({ targets: [run.runId], accepted: false });
    const turnedDown = report.candidates.find((c) => c.id === 2)!;
    turnedDown.verify!.runs[0]!.attempts = tried.map((a, i) => ({ ...turnedDown.verify!.runs[0]!.attempts[0]!, runId: a.runId, passed: i === 1, exitCode: i === 1 ? 0 : 1 }));
    recordRepair(s, { repairId: 'repair-mx1', dir: '.shadowlap/repairs/repair-mx1', report, expect: EXPECT, command: 'shadowlap repair', at: 5_000 });

    const view = trainingView(readTraining(s, { tasks: [], fixOf: sourceFixes(s) }));
    const source = view.pairs.sources.find((x) => x.kind === 'verify')!;
    expect(source).toMatchObject({ label: 'verify · repair candidate 2', made: 1, href: `#/fixes/${fx}/repair` });
    expect(view.pairs.groups.find((g) => g.from === 'from verify')).toMatchObject({ fix: { label: 'refund-bug', href: `#/fixes/${fx}/repair` }, source: { label: 'verify · repair candidate 2' } });
    s.close();
  });
});

describe('GET /api/models on a read-only dashboard', () => {
  it('asks no provider with this machine’s keys: it lists the recorded models and those scored before', async () => {
    asked.length = 0;
    const res = await api(readOnly, 'models');
    expect(res.status).toBe(200);
    const view = (await res.json()) as ModelsView;
    expect(asked).toEqual([]);
    expect(view.notes).toEqual([]);
    expect(view.choices.map((c) => [c.group, c.id, c.lastScore])).toEqual([
      ['Recorded with', 'claude-sonnet-5', 1],
      ['Endpoints scored before', 'qwen2.5:7b', 0.75],
    ]);
  });
});
