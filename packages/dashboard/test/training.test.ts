import { describe, expect, it } from 'vitest';
import { Store, type ModelListing, type Task, type TaskScoreRow } from '@shadowlap/engine';
import { approx, exportPairsJob, money, readTraining, scoreModelJob, scoreNote, trainingView } from '../src/training.js';
import { DONE, ESCALATE, ESCALATE_2, LOOKUP, POLICY, REFUND, recordRun, type Step } from '../../engine/test/training-fixtures.js';

/**
 * The Training screen's read model, from a store holding a blame and a verify, four goldens as
 * tasks, two models' scores and one export. No HTTP: the view is plain JSON.
 */

const LOST = [LOOKUP, POLICY, REFUND, DONE];

function store() {
  const s = Store.open(':memory:');
  const lost = recordRun(s, LOST, { status: 'failed', meta: { labels: ['refund-bug'] } }).run;
  s.updateRunMeta(lost.runId, { blame: { at: 2, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
  for (const steps of [[LOOKUP, POLICY, ESCALATE, DONE], [LOOKUP, POLICY, ESCALATE_2, DONE]]) recordRun(s, steps, { parentRunId: lost.runId, meta: { probe: { of: lost.runId, callNo: 5, passed: true } } });
  // Another order, so verify's pair isn't one blame already made (identical answers count once).
  const user = 'The customer asks for a refund on order A-1103.';
  const target = recordRun(s, LOST, { status: 'failed', user }).run;
  const attempt = (steps: Step[], passed: boolean) => recordRun(s, steps, { parentRunId: target.runId, status: passed ? 'completed' : 'failed', codeVersion: 'c91d0f4', user, meta: { verify: { role: 'target', passed }, repeat: { group: `v1-${target.runId}`, attempt: 1, of: 2 } } });
  attempt(LOST, false);
  attempt([LOOKUP, POLICY, ESCALATE, DONE], true);
  const rec = recordRun(s, [LOOKUP, POLICY, ESCALATE, DONE]).run;
  for (let i = 0; i < 2; i++) recordRun(s, [LOOKUP, POLICY, ESCALATE, DONE], { parentRunId: rec.runId, meta: { repeat: { group: 'r1', attempt: i + 1, of: 2 } } });
  s.addPairsExport({ pairs: 4, file: 'pairs.jsonl', format: 'openai-preference', minConfidence: 'high', at: 5000 });
  return { s, lost, target, rec };
}

const task = (golden: string, status: Task['status'], rewards: string | null, extra: Partial<Task> = {}): Task => ({
  golden,
  name: golden.split('/').at(-1)!,
  status,
  note: status === 'blocked' ? 'its test fails' : status === 'not-a-task' ? 'its checks only cap tokens and cost' : status === 'no-golden' ? 'the golden is gone' : null,
  runId: status === 'no-golden' ? null : `RUN_${golden.split('/').at(-1)}`,
  takeover: status === 'no-golden' ? null : { callNo: 17, why: 'decides between refunding and escalating', from: 'config' },
  scope: null,
  scopes: [null],
  rewards,
  checks: status === 'not-a-task' ? [{ label: 'at most 60000 input tokens', cap: true }] : [{ label: 'issue_refund called 0 times', cap: false }, { label: 'at most 60000 input tokens', cap: true }],
  after: { live: ['queue_status'], stubbed: ['send_email'] },
  prefix: 16,
  model: 'claude-sonnet-5',
  provider: 'anthropic',
  callName: 'POST /v1/messages',
  tokensAfter: { inputTokens: 10_000, outputTokens: 1_000 },
  ...extra,
});

const TASKS = [
  task('goldens/refund-over-limit', 'ready', 'escalate above the limit'),
  task('goldens/escalate-over-limit', 'ready', 'escalate above the limit'),
  task('goldens/refund-flow-budget', 'not-a-task', null),
  task('goldens/refund-in-limit', 'blocked', 'refund within the limit'),
];

const score = (model: string, baseUrl: string | null, golden: string, attempt: number, value: number, at: number, spent = 0): TaskScoreRow => ({ model, baseUrl, golden, attempt, runId: `${model}-${golden}-${attempt}`, score: value, checks: [], spent, via: baseUrl ? 'Ollama, on this machine' : 'the recorded model', session: 's', at });

const SCORES: TaskScoreRow[] = [
  ...[1, 1, 1, 1, 1].map((v, i) => score('claude-sonnet-5', null, 'goldens/refund-over-limit', i + 1, v, 100, 0.033)),
  ...[1, 1, 1, 1, 1].map((v, i) => score('claude-sonnet-5', null, 'goldens/escalate-over-limit', i + 1, v, 100, 0.033)),
  ...[1, 0.5, 1, 0.5, 1].map((v, i) => score('qwen2.5:7b', 'http://127.0.0.1:11434/v1', 'goldens/refund-over-limit', i + 1, v, 200)),
  ...[0, 0].map((v, i) => score('qwen2.5:7b', 'http://127.0.0.1:11434/v1', 'goldens/refund-in-limit', i + 1, v, 200)),
];

const MODELS: ModelListing = {
  choices: [
    { group: 'Recorded with', id: 'claude-sonnet-5', via: 'the recorded model', where: 'Anthropic API', baseUrl: null, flags: ['--model', 'claude-sonnet-5'], perAttempt: 0.0165, local: false },
    { group: 'Anthropic API', id: 'claude-haiku-4-5', via: 'Anthropic API', where: 'Anthropic API', baseUrl: null, flags: ['--model', 'claude-haiku-4-5'], perAttempt: 0.0041, local: false },
    { group: 'OpenAI API', id: 'gpt-5-mini', via: 'OpenAI API', where: 'OpenAI API', baseUrl: null, flags: ['--model', 'openai:gpt-5-mini'], perAttempt: null, local: false },
    { group: 'Ollama, on this machine', id: 'qwen2.5:7b', via: 'Ollama, on this machine', where: 'Ollama, on this machine', baseUrl: 'http://127.0.0.1:11434/v1', flags: ['--model', 'qwen2.5:7b', '--base-url', 'http://127.0.0.1:11434/v1'], perAttempt: 0, local: true },
  ],
  notes: [{ group: 'Ollama, on this machine', note: "isn't running" }],
  tokens: { inputTokens: 10_000, outputTokens: 1_000 },
};

describe('the Training read model', () => {
  it('has an empty state for everything before anything was blamed or packed', () => {
    const s = Store.open(':memory:');
    const view = trainingView(readTraining(s, { tasks: [] }));
    expect(view.strip).toEqual({
      pairs: { value: '0', sub: 'blame a failing run to make some', href: '#/training', high: 0, medium: 0 },
      tasks: { value: '0 / 0', sub: 'no goldens yet', href: '#/training/tasks', ready: 0, total: 0, blocked: 0, notTask: 0 },
      best: { value: '—', sub: 'no model scored yet', href: '#/training/tasks', model: null, mean: null },
      left: { value: '0', sub: 'nothing until you export it', href: null, pairs: 0, file: null, at: null },
    });
    expect(view.actions).toEqual({ exportPairs: false, scoreModel: false });
    expect(view.pairs.empty).toEqual({ title: 'No pairs yet', text: 'Blame a failing run. The answer it was lost on and an answer that went on to pass make a pair.', command: 'shadowlap blame <run> --expect <checks>' });
    expect(view.tasks.empty?.command).toBe('shadowlap pack <run> goldens/<name>');
    expect(view.scores.empty).toBe('No scores yet.');
    expect(view.serve).toBeNull();
    expect(view.scoreDialog).toBeNull();
    s.close();
  });

  it('groups pairs per call with the rejected answer next to the chosen ones, and lists every source', () => {
    const { s, lost, target, rec } = store();
    const input = readTraining(s, { tasks: TASKS, fixOf: (src) => (src.kind === 'blame' ? { id: 'fx-refund-limit', label: 'refund-bug' } : null) });
    const view = trainingView(input);
    expect(view.strip.pairs).toMatchObject({ value: '3', sub: '2 high confidence · 1 medium' });
    expect(view.strip.left).toMatchObject({ value: '4', sub: 'pairs, to pairs.jsonl', at: 5000 });
    expect(view.tabs).toEqual({ pairs: 3, tasks: 2 });
    expect(view.actions).toEqual({ exportPairs: true, scoreModel: true });

    expect(view.pairs.groups).toHaveLength(2);
    const [blame, verify] = view.pairs.groups;
    expect(blame).toMatchObject({
      confidence: 'high',
      runId: lost.runId,
      callNo: 5,
      href: `#/run/${lost.runId}/5`,
      about: lost.runId,
      attemptOf: null,
      fix: { label: 'refund-bug', href: '#/fixes/fx-refund-limit/blame' },
      source: { kind: 'blame', label: 'blame · refund-bug', href: '#/fixes/fx-refund-limit/blame' },
      from: 'from blame',
      count: 2,
      chosenLabel: 'chosen · 2 attempts that passed',
      rejected: { what: 'the recording', text: '"Issuing the refund.", issue_refund({"order_id":"A-1042","amount":240})' },
    });
    expect(blame!.chosen.map((c) => c.text)).toEqual(['"Above the limit.", escalate({"reason":"refund of $240 is above $100"})', '"$240 is over the $100 limit, so this needs approval.", escalate({"reason":"above the refund limit"})']);
    expect(blame!.context).toContain('read_policy returned');
    expect(verify).toMatchObject({ confidence: 'medium', runId: target.runId, about: target.runId, attemptOf: null, fix: null, from: 'from verify', count: 1, chosenLabel: 'chosen · verify attempt, passed' });
    expect(verify!.source.href).toBe(`#/run/${target.runId}/5/forks`);
    // The group opens the run verify replayed, at the call; the rejected answer opens its own attempt.
    expect(verify!.href).toBe(`#/run/${target.runId}/5`);
    expect(verify!.rejected).toMatchObject({ what: 'verify attempt, failed', callNo: 5 });
    expect(verify!.rejected.runId).not.toBe(target.runId);
    expect(verify!.rejected.href).toBe(`#/run/${verify!.rejected.runId}/5`);
    expect(view.pairs.madeBy).toEqual({ [`blame:${lost.runId}`]: 2, [verify!.source.key]: 1 });

    expect(view.pairs.sources.map((x) => [x.label, x.made, x.confidence])).toEqual([
      ['blame · refund-bug', 2, 'high'],
      ['verify · c91d0f4', 1, 'medium'],
      [`replay --repeat 2 · ${rec.runId.slice(0, 10)}`, 0, null],
    ]);
    // A source that made no pairs has no call to open its run's forks at.
    expect(view.pairs.sources[2]).toMatchObject({ href: `#/run/${rec.runId}/forks`, why: 'All 2 attempts exited 0, so there is nothing to contrast.' });
    expect(view.pairs.confidence.map((c) => c.level)).toEqual(['high', 'medium']);
    expect(view.pairs.footnote).toBe('Identical answers count once.');

    const medium = trainingView(input, { filter: 'medium' });
    expect(medium.pairs.groups.map((g) => g.confidence)).toEqual(['medium']);
    expect(medium.pairs.counts).toEqual({ all: 3, high: 2, medium: 1 });
    expect(view.exportDialog.levels).toEqual([
      { value: 'high', label: 'High confidence only (2)' },
      { value: 'medium', label: 'High and medium (3)' },
    ]);
    s.close();
  });

  it('heads a verify group with the run it replayed at the same point, or with the attempt when that run never got there', () => {
    const s = Store.open(':memory:');
    const attempt = (target: string, group: string, steps: Step[], passed: boolean, user: string) => recordRun(s, steps, { parentRunId: target, status: passed ? 'completed' : 'failed', codeVersion: group, user, meta: { verify: { role: 'target', passed }, repeat: { group: `${group}-${target}`, attempt: passed ? 2 : 1, of: 2 } } }).run;
    // Recorded with a model list first, which the change dropped: the same decision is #6 in the recording, #5 in the attempts.
    const listed = recordRun(s, LOST, { status: 'failed', user: 'Refund order A-2001.', before: [{ name: 'GET /v1/models', kind: 'api', result: { data: [] } }] }).run;
    attempt(listed.runId, 'v1', LOST, false, 'Refund order A-2001.');
    attempt(listed.runId, 'v1', [LOOKUP, POLICY, ESCALATE, DONE], true, 'Refund order A-2001.');
    // The change reads a template before deciding: the attempts decide at #7, where the recording had refunded already.
    const TEMPLATE: Step = { tools: [{ name: 'get_template', input: { kind: 'refund' } }] };
    const added = recordRun(s, LOST, { status: 'failed', user: 'Refund order A-2002.' }).run;
    const failing = attempt(added.runId, 'v2', [LOOKUP, POLICY, TEMPLATE, REFUND, DONE], false, 'Refund order A-2002.');
    attempt(added.runId, 'v2', [LOOKUP, POLICY, TEMPLATE, ESCALATE, DONE], true, 'Refund order A-2002.');

    const view = trainingView(readTraining(s, { tasks: [] }));
    const group = (about: string) => view.pairs.groups.find((g) => g.about === about)!;
    expect(group(listed.runId)).toMatchObject({ runId: listed.runId, callNo: 6, href: `#/run/${listed.runId}/6`, attemptOf: null, rejected: { callNo: 5 } });
    expect(group(added.runId)).toMatchObject({
      runId: failing.runId,
      callNo: 7,
      href: `#/run/${failing.runId}/7`,
      attemptOf: { runId: added.runId, href: `#/run/${added.runId}` },
      rejected: { runId: failing.runId, callNo: 7 },
      context: expect.stringContaining('get_template returned'),
    });
    // Without a fix, a source opens its run's forks at the call its pairs are about, and with none there, the forks alone.
    expect(Object.fromEntries(view.pairs.sources.map((x) => [x.label, x.href]))).toEqual({ 'verify · v1': `#/run/${listed.runId}/6/forks`, 'verify · v2': `#/run/${added.runId}/forks` });
    s.close();
  });

  it('compares means over the same tasks: the best is among the models scored on every ready task', () => {
    const s = Store.open(':memory:');
    const ready = [task('goldens/a', 'ready', null), task('goldens/b', 'ready', null)];
    // qwen was scored before b was a task, on a alone, where it did better than sonnet did on both.
    const scores = [score('claude-sonnet-5', null, 'goldens/a', 1, 0.5, 100), score('claude-sonnet-5', null, 'goldens/b', 1, 1, 100), score('qwen2.5:7b', 'http://127.0.0.1:11434/v1', 'goldens/a', 1, 1, 200)];
    const view = trainingView({ ...readTraining(s, { tasks: ready }), scores });
    expect(view.scores.cards.map((c) => [c.model, c.mean, c.coverage])).toEqual([
      ['claude-sonnet-5', 0.75, null],
      ['qwen2.5:7b', 1, 'on 1 of 2 tasks'],
    ]);
    expect(view.strip.best).toMatchObject({ value: '0.75', model: 'claude-sonnet-5', sub: 'claude-sonnet-5 · 2 models scored' });
    // When no model was scored on every ready task, the best of the rest says what it covers.
    const later = trainingView({ ...readTraining(s, { tasks: [...ready, task('goldens/c', 'ready', null)] }), scores });
    expect(later.scores.cards.map((c) => c.coverage)).toEqual(['on 2 of 3 tasks', 'on 1 of 3 tasks']);
    expect(later.strip.best).toMatchObject({ value: '1.00', model: 'qwen2.5:7b', sub: 'qwen2.5:7b · on 1 of 3 tasks' });
    s.close();
  });

  it('shows each golden as a task, warns when they all reward the same thing, and scores each model', () => {
    const s = Store.open(':memory:');
    // The store holds two goldens' runs; the budget golden was packed elsewhere and never imported.
    const view = trainingView({ ...readTraining(s, { tasks: TASKS, models: MODELS }), scores: SCORES, storedRuns: new Set(['RUN_refund-over-limit', 'RUN_escalate-over-limit']) });
    expect(view.strip.tasks).toMatchObject({ value: '2 / 4', sub: '1 blocked · 1 not a task' });
    expect(view.tasks.warning).toMatchObject({
      rewards: 'escalate above the limit',
      tasks: ['goldens/refund-over-limit', 'goldens/escalate-over-limit'],
      text: 'All of them reward “escalate above the limit”, so a model that learned only that would score full marks. refund-in-limit rewards the opposite once its test passes.',
      fix: { label: 'Fix it on Tests', href: '#/tests' },
    });
    expect(view.tasks.rows.map((r) => [r.name, r.status.label, r.status.badge, r.href])).toEqual([
      ['refund-over-limit', 'ready', 'ok', '#/run/RUN_refund-over-limit/17'],
      ['escalate-over-limit', 'ready', 'ok', '#/run/RUN_escalate-over-limit/17'],
      ['refund-in-limit', 'blocked', 'y', '#/tests'],
      ['refund-flow-budget', 'not a task', 'n', null],
    ]);
    expect(view.tasks.rows[0]).toMatchObject({ sub: 'takes over at #17 · decides between refunding and escalating', checks: ['the agent exits 0', 'issue_refund called 0 times'], after: { live: ['queue_status'], stubbed: ['send_email'] } });
    // Checks that only cap spending score nothing, so no model takes over: no call, no tools after it.
    expect(view.tasks.rows[3]).toMatchObject({ sub: 'no call to take over', takeover: null, after: null, checks: ['at most 60000 input tokens'], status: { short: 'its checks only cap tokens and cost' } });
    expect(view.tasks.weak).toBe('refund-flow-budget');
    // A golden with a simulated user: the row says which scope the model plays, and why it can't be scored yet.
    const dialogue = task('goldens/dialogue', 'not-a-task', 'escalate above the limit', { scope: 'agent', scopes: ['agent', 'user'], checks: [{ label: 'issue_refund called 0 times', cap: false }], note: "its model calls are made in more than one scope (agent, user), and scoring can't yet send only agent's to the model under test" });
    expect(trainingView({ ...readTraining(s, { tasks: [dialogue] }) }).tasks.rows[0]).toMatchObject({ sub: 'takes over at #17 · decides between refunding and escalating · plays scope agent', status: { label: 'not a task', short: expect.stringContaining('more than one scope') } });

    // Means count the ready tasks only: qwen's zeros on the blocked task don't, and its card says it was scored on one of the two.
    expect(view.scores.cards.map((c) => [c.model, c.via, c.mean, c.cost, c.tasks, c.coverage])).toEqual([
      ['claude-sonnet-5', 'the recorded model', 1, '≈$0.330 spent', 2, null],
      ['qwen2.5:7b', 'Ollama, on this machine', 0.8, '$0, not a paid API', 1, 'on 1 of 2 tasks'],
    ]);
    expect(view.strip.best).toMatchObject({ value: '1.00', sub: 'claude-sonnet-5 · 2 models scored' });
    expect(view.scores.sub).toBe('mean share of checks passed, 2 tasks');
    const [first, second] = view.scores.rows;
    expect(first!.cells[1]).toMatchObject({ model: 'qwen2.5:7b', mean: 0.8 });
    expect(first!.cells[1]!.pips.map((x) => x.kind)).toEqual(['all', 'some', 'all', 'some', 'all']);
    expect(first!.cells[1]!.pips[1]).toMatchObject({ attempt: 2, href: '#/run/qwen2.5:7b-goldens/refund-over-limit-2' });
    expect(second!.cells).toEqual([expect.objectContaining({ model: 'claude-sonnet-5', mean: 1 }), null]);

    expect(view.serve!.request).toBe('POST /v1/tasks/refund-over-limit/attempts\nAuthorization: Bearer <token>\n{ "model": "my-finetune", "baseUrl": "http://127.0.0.1:8000/v1",\n  "from": 17 }');
    expect(view.serve!.response).toContain('"check": "issue_refund called 0 times"');

    const dialog = view.scoreDialog!;
    expect(dialog.title).toBe('Score a model on 2 tasks');
    expect(dialog.groups).toEqual(['Recorded with', 'Anthropic API', 'OpenAI API', 'Ollama, on this machine']);
    expect(dialog.options.map((o) => [o.label, o.lastScore, o.request])).toEqual([
      ['claude-sonnet-5 · scored 1.00', 1, { model: 'claude-sonnet-5', baseUrl: null }],
      ['claude-haiku-4-5', null, { model: 'claude-haiku-4-5', baseUrl: null }],
      ['gpt-5-mini', null, { model: 'openai:gpt-5-mini', baseUrl: null }],
      ['qwen2.5:7b · scored 0.80', 0.8, { model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/v1' }],
    ]);
    // The first model not scored yet is preselected.
    expect(dialog.selected).toBe('claude-haiku-4-5\n');
    expect(dialog.options.map((o) => o.note)).toEqual([
      'Anthropic API · about $0.017 an attempt · replaces its score of 1.00',
      'Anthropic API · about $0.0041 an attempt',
      "OpenAI API · no price for this model, so the cost isn't estimated",
      'Runs at http://127.0.0.1:11434/v1 · not a paid API · replaces its score of 0.80',
    ]);
    expect(dialog.endpoint).toEqual({ key: '__endpoint', group: 'Other', label: 'Your own endpoint…', baseUrl: 'http://127.0.0.1:8000/v1', model: 'my-finetune', note: 'Any OpenAI-compatible server, such as vLLM serving the model you’re training. Not a paid API.' });
    expect(dialog.notes).toEqual([{ group: 'Ollama, on this machine', note: "isn't running" }]);
    expect(dialog.attempts).toEqual([5, 10]);
    s.close();
  });

  it('builds the jobs the dialogs start from what they name, never from a command line', () => {
    expect(exportPairsJob({ format: 'trl', minConfidence: 'medium' })).toEqual({ args: ['export', 'pairs', '--min-confidence', 'medium', '--format', 'trl', '--out', '.shadowlap/exports/pairs.jsonl'], out: '.shadowlap/exports/pairs.jsonl' });
    expect(exportPairsJob({})).toMatchObject({ args: ['export', 'pairs', '--min-confidence', 'high', '--format', 'openai-preference', '--out', '.shadowlap/exports/pairs.jsonl'] });
    expect(exportPairsJob({ format: 'csv' })).toEqual({ error: 'format must be openai-preference or trl' });
    expect(exportPairsJob({ minConfidence: 'low' })).toEqual({ error: 'minConfidence must be high or medium' });

    // Every ready task when none are named; the endpoint as given, without a trailing slash.
    expect(scoreModelJob({ model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/v1/', attempts: 10 }, TASKS)).toEqual({
      args: ['tasks', 'score', 'goldens/refund-over-limit', 'goldens/escalate-over-limit', '--model', 'qwen2.5:7b', '--base-url', 'http://127.0.0.1:11434/v1', '--attempts', '10'],
      goldens: ['goldens/refund-over-limit', 'goldens/escalate-over-limit'],
    });
    expect(scoreModelJob({ model: 'anthropic:claude-haiku-4-5', goldens: ['goldens/escalate-over-limit'] }, TASKS)).toMatchObject({ args: ['tasks', 'score', 'goldens/escalate-over-limit', '--model', 'anthropic:claude-haiku-4-5', '--attempts', '5'] });
    expect(scoreModelJob({ model: 'm', goldens: ['goldens/refund-in-limit'] }, TASKS)).toEqual({ error: 'goldens/refund-in-limit is not a ready task' });
    expect(scoreModelJob({ model: 'm', goldens: ['../../etc'] }, TASKS)).toEqual({ error: '../../etc is not a ready task' });
    expect(scoreModelJob({ model: '--help' }, TASKS)).toEqual({ error: 'model must be a model name, such as qwen2.5:7b' });
    expect(scoreModelJob({ model: 'm; rm -rf /' }, TASKS)).toEqual({ error: 'model must be a model name, such as qwen2.5:7b' });
    expect(scoreModelJob({ model: 'm', baseUrl: 'file:///etc/passwd' }, TASKS)).toEqual({ error: 'baseUrl must be an http or https URL' });
    expect(scoreModelJob({ model: 'm', baseUrl: 'http://user:pw@127.0.0.1:8000/v1' }, TASKS)).toMatchObject({ error: expect.stringContaining('must not carry credentials') });
    expect(scoreModelJob({ model: 'm', attempts: 0 }, TASKS)).toEqual({ error: 'attempts must be 5 or 10' });
    expect(scoreModelJob({ model: 'm', attempts: 3 }, TASKS)).toEqual({ error: 'attempts must be 5 or 10' });
    expect(scoreModelJob({ model: 'm' }, TASKS.filter((t) => t.status !== 'ready'))).toEqual({ error: 'no task is ready to score' });
  });

  it('writes amounts as the mock does', () => {
    expect([money(0), money(0.0041), money(0.0165), money(0.03), money(1.5)]).toEqual(['$0', '$0.0041', '$0.017', '$0.03', '$1.5']);
    expect([approx(0), approx(0.165), approx(2.5)]).toEqual(['$0', '≈$0.165', '≈$2.50']);
    expect(scoreNote({ where: 'Anthropic API', baseUrl: null, perAttempt: null, local: false }, null)).toBe("Anthropic API · no price for this model, so the cost isn't estimated");
  });
});
