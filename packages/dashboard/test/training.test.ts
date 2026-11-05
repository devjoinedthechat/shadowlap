import { describe, expect, it } from 'vitest';
import { inconclusiveTestNote, INCONCLUSIVE_TEST_NOTE, Store, type ModelListing, type Task, type TaskScoreRow } from '@shadowlap/engine';
import { approx, exportPairsJob, money, PAIRS_EXPORT_FILE, readTraining, scoreDialogView, scoreModelJob, taskUpdate, taskUpdateJob, trainingView } from '../src/training.js';
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
  // Nothing would score a golden that is no task for want of outcome checks: no call to take over, and nothing after it.
  takeover: status === 'no-golden' || status === 'not-a-task' ? null : { callNo: 17, why: 'decides between refunding and escalating', from: 'config' },
  scope: null,
  scopes: [null],
  rewards,
  checks: status === 'not-a-task' ? [{ label: 'at most 60000 input tokens', cap: true }] : [{ label: 'issue_refund called 0 times', cap: false }, { label: 'at most 60000 input tokens', cap: true }],
  after: status === 'not-a-task' ? { live: [], stubbed: [] } : { live: ['queue_status'], stubbed: ['send_email'] },
  prefix: status === 'not-a-task' ? 0 : 16,
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

const score = (model: string, baseUrl: string | null, golden: string, attempt: number, value: number, at: number, spent = 0, judgeSpent: number | null = null): TaskScoreRow => ({ model, baseUrl, golden, attempt, runId: `${model}-${golden}-${attempt}`, score: value, checks: [], spent, judgeSpent, via: baseUrl ? 'Ollama, on this machine' : 'the recorded model', session: 's', at });

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
      left: { value: '0', sub: 'nothing exported yet', href: null, pairs: 0, file: null, at: null },
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
    expect(blame.chosen.map((c) => c.text)).toEqual(['"Above the limit.", escalate({"reason":"refund of $240 is above $100"})', '"$240 is over the $100 limit, so this needs approval.", escalate({"reason":"above the refund limit"})']);
    expect(blame.context).toContain('read_policy returned');
    expect(verify).toMatchObject({ confidence: 'medium', runId: target.runId, about: target.runId, attemptOf: null, fix: null, from: 'from verify', count: 1, chosenLabel: 'chosen · verify attempt, passed' });
    expect(verify.source.href).toBe(`#/run/${target.runId}/5/forks`);
    // The group opens the run verify replayed, at the call; the rejected answer opens its own attempt.
    expect(verify.href).toBe(`#/run/${target.runId}/5`);
    expect(verify.rejected).toMatchObject({ what: 'verify attempt, failed', callNo: 5 });
    expect(verify.rejected.runId).not.toBe(target.runId);
    expect(verify.rejected.href).toBe(`#/run/${verify.rejected.runId}/5`);
    expect(view.pairs.madeBy).toEqual({ [`blame:${lost.runId}`]: 2, [verify.source.key]: 1 });

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
    // Labels that fit the dialog's select, and the file the job writes, which the dialog names.
    expect(view.exportDialog.formats).toEqual([
      { value: 'openai-preference', label: 'OpenAI preference fine-tuning' },
      { value: 'trl', label: 'prompt, chosen, rejected (TRL)' },
    ]);
    expect(view.exportDialog.out).toBe(PAIRS_EXPORT_FILE);
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

  it('tells apart one model scored at two endpoints by its endpoint, and only then', () => {
    const s = Store.open(':memory:');
    const ready = [task('goldens/a', 'ready', null)];
    const scores = [score('claude-sonnet-5', null, 'goldens/a', 1, 1, 100), score('qwen2.5:7b', 'http://127.0.0.1:11434/v1', 'goldens/a', 1, 0.5, 200), score('qwen2.5:7b', 'http://gpu-box:8000/v1', 'goldens/a', 1, 1, 300)];
    const view = trainingView({ ...readTraining(s, { tasks: ready }), scores });
    expect(view.scores.cards.map((c) => [c.model, c.where])).toEqual([
      ['claude-sonnet-5', null],
      ['qwen2.5:7b', '127.0.0.1:11434'],
      ['qwen2.5:7b', 'gpu-box:8000'],
    ]);
    // Scored at its own provider and at an endpoint: the provider's card says so.
    const both = trainingView({ ...readTraining(s, { tasks: ready }), scores: [...scores, score('claude-sonnet-5', 'http://127.0.0.1:8000/v1', 'goldens/a', 1, 1, 400)] });
    expect(both.scores.cards.filter((c) => c.model === 'claude-sonnet-5').map((c) => c.where)).toEqual(["the provider's API", '127.0.0.1:8000']);
    s.close();
  });

  it("puts what each model's judge checks cost after what its own calls did, apart", () => {
    const s = Store.open(':memory:');
    const judged = [
      // Each attempt kept what its judge's call cost apart from its own: $0.033 and $0.002.
      ...[1, 2, 3].map((n) => score('claude-sonnet-5', null, 'goldens/refund-over-limit', n, 1, 100, 0.033, 0.002)),
      // A score a build before kept has none apart: its spend counted the judge's calls.
      ...[1, 2].map((n) => score('claude-sonnet-5', null, 'goldens/escalate-over-limit', n, 1, 100, 0.035)),
      // A model on this machine answers for nothing; its judge, asked at its provider, does not.
      ...[1, 2].map((n) => score('qwen2.5:7b', 'http://127.0.0.1:11434/v1', 'goldens/refund-over-limit', n, 1, 200, 0, 0.004)),
      // A judge answered from the recording costs nothing, and says nothing.
      score('gpt-small', 'http://127.0.0.1:8000/v1', 'goldens/refund-over-limit', 1, 1, 300, 0, 0),
    ];
    const view = trainingView({ ...readTraining(s, { tasks: TASKS }), scores: judged });
    expect(view.scores.cards.map((c) => [c.model, c.cost, c.spent, c.judgeSpent])).toEqual([
      ['claude-sonnet-5', '≈$0.169 spent · judge ≈$0.006', expect.closeTo(0.169, 9), expect.closeTo(0.006, 9)],
      ['qwen2.5:7b', '$0, not a paid API · judge ≈$0.008', 0, expect.closeTo(0.008, 9)],
      ['gpt-small', '$0, not a paid API', 0, 0],
    ]);
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
    // The task that rewards the opposite failed nothing in its last test, which was inconclusive: it is settled on Tests, not fixed.
    const unsettled = TASKS.map((t) => (t.status === 'blocked' ? { ...t, note: INCONCLUSIVE_TEST_NOTE } : t));
    expect(trainingView({ ...readTraining(s, { tasks: unsettled, models: MODELS }), scores: SCORES }).tasks.warning).toMatchObject({ once: 'its test passes', fix: { label: 'Settle it on Tests', href: '#/tests' } });
    // So is one whose gate ran out of attempts: more attempts settle it.
    const gated = TASKS.map((t) => (t.status === 'blocked' ? { ...t, note: inconclusiveTestNote('gate') } : t));
    const settle = trainingView({ ...readTraining(s, { tasks: gated, models: MODELS }), scores: SCORES });
    expect(settle.tasks.warning).toMatchObject({ fix: { label: 'Settle it on Tests', href: '#/tests' } });
    expect(settle.tasks.rows.find((r) => r.name === 'refund-in-limit')!.status).toMatchObject({ label: 'blocked', short: 'its last test is inconclusive: its gate ran out of attempts' });
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
    // The sentence names a golden whose checks only cap tokens and cost, never one with no checks at all.
    const bare = task('goldens/list-inbox', 'not-a-task', null, { note: 'it has no checks', checks: [] });
    expect(trainingView(readTraining(s, { tasks: [TASKS[0], bare, TASKS[2]] })).tasks.weak).toBe('refund-flow-budget');
    expect(trainingView(readTraining(s, { tasks: [TASKS[0], bare] })).tasks.weak).toBeNull();
    // A golden with a simulated user: the row says which scope the model plays, and why it can't be scored yet.
    const dialogue = task('goldens/dialogue', 'not-a-task', 'escalate above the limit', { scope: 'agent', scopes: ['agent', 'user'], takeover: { callNo: 17, why: 'decides between refunding and escalating', from: 'config' }, checks: [{ label: 'issue_refund called 0 times', cap: false }], note: "its model calls are made in more than one scope (agent, user), and from the takeover on scoring would send them all to the model under test, not only agent's" });
    expect(trainingView({ ...readTraining(s, { tasks: [dialogue] }) }).tasks.rows[0]).toMatchObject({ sub: 'takes over at #17 · decides between refunding and escalating · plays scope agent', status: { label: 'not a task', short: expect.stringContaining('more than one scope') } });

    // Means count the ready tasks only: qwen's zeros on the blocked task don't, and its card says it was scored on one of the two.
    expect(view.scores.cards.map((c) => [c.model, c.via, c.mean, c.cost, c.tasks, c.coverage])).toEqual([
      ['claude-sonnet-5', 'the recorded model', 1, '≈$0.330 spent', 2, null],
      ['qwen2.5:7b', 'Ollama, on this machine', 0.8, '$0, not a paid API', 1, 'on 1 of 2 tasks'],
    ]);
    expect(view.strip.best).toMatchObject({ value: '1.00', sub: 'claude-sonnet-5 · 2 models scored' });
    expect(view.scores.sub).toBe('mean share of checks passed, 2 tasks');
    const [first, second] = view.scores.rows;
    expect(first.cells[1]).toMatchObject({ model: 'qwen2.5:7b', mean: 0.8 });
    expect(first.cells[1]!.pips.map((x) => x.kind)).toEqual(['all', 'some', 'all', 'some', 'all']);
    expect(first.cells[1]!.pips[1]).toMatchObject({ attempt: 2, href: '#/run/qwen2.5%3A7b-goldens%2Frefund-over-limit-2' });
    expect(second.cells).toEqual([expect.objectContaining({ model: 'claude-sonnet-5', mean: 1 }), null]);

    // An example, never a result: no `from` (it only moves the takeover), a placeholder run, and a
    // score that is the share of the checks passed, one of them missed.
    expect(view.serve!.request).toBe('POST /v1/tasks/refund-over-limit/attempts\nAuthorization: Bearer <token>\n{ "model": "my-finetune", "baseUrl": "http://127.0.0.1:8000/v1" }');
    expect(view.serve!.response).toBe(['200 OK', '{ "score": 0.5,', '  "checks": [', '    { "check": "the agent exits 0", "pass": true },', '    { "check": "issue_refund called 0 times", "pass": false } ],', '  "run": "<run id>", "spent": 0 }'].join('\n'));

    const dialog = view.scoreDialog!;
    expect(dialog.title).toBe('Score model on 2 tasks');
    expect(dialog.groups).toEqual(['Recorded with', 'Anthropic API', 'OpenAI API', 'Ollama, on this machine']);
    expect(dialog.options.map((o) => [o.label, o.lastScore, o.request])).toEqual([
      ['claude-sonnet-5 · scored 1.00', 1, { model: 'claude-sonnet-5', baseUrl: null, goldens: null }],
      ['claude-haiku-4-5', null, { model: 'claude-haiku-4-5', baseUrl: null, goldens: null }],
      ['gpt-5-mini', null, { model: 'openai:gpt-5-mini', baseUrl: null, goldens: null }],
      ['qwen2.5:7b · scored 0.80', 0.8, { model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/v1', goldens: null }],
    ]);
    expect(dialog.leftOut).toEqual([]);
    // The first model not scored yet is preselected.
    expect(dialog.selected).toBe('claude-haiku-4-5\n');
    // What an option bills is its cost line's, from these; the score it replaces a row's; its note what it leaves out.
    expect(dialog.options.map((o) => [o.perAttempt, o.local, o.lastScore, o.note])).toEqual([
      [expect.closeTo(0.017, 2), false, 1, ''],
      [expect.closeTo(0.0041, 3), false, null, ''],
      [null, false, null, ''],
      [0, true, 0.8, ''],
    ]);
    expect(dialog.endpoint).toEqual({ key: '__endpoint', group: 'Other', label: 'Your own endpoint…', baseUrl: 'http://127.0.0.1:8000/v1', model: 'my-finetune', note: 'Any OpenAI-compatible server, such as vLLM serving the model you’re training.' });
    expect(dialog.notes).toEqual([{ group: 'Ollama, on this machine', note: "isn't running" }]);
    expect(dialog.attempts).toEqual([5, 10]);
    s.close();
  });

  it('offers only the models that can answer a ready task, scores one that answers some on those, and says why the rest are left out', () => {
    // One task recorded on Anthropic's API, one asking Llama through Bedrock's InvokeModel (a body no translation reads), one through Bedrock's Converse API.
    const tasks = [
      task('goldens/refund', 'ready', 'escalate'),
      task('goldens/llama', 'ready', 'escalate', { provider: 'bedrock', callName: 'POST /model/meta.llama4-maverick-17b-instruct-v1%3A0/invoke', model: 'meta.llama4-maverick-17b-instruct-v1:0' }),
      task('goldens/converse', 'ready', 'escalate', { provider: 'bedrock', callName: 'POST /model/amazon.nova-pro-v1%3A0/converse', model: 'amazon.nova-pro-v1:0' }),
    ];
    const listing: ModelListing = {
      choices: [
        { group: 'Recorded with', id: 'claude-sonnet-5', via: 'the recorded model', where: 'Anthropic API', baseUrl: null, flags: ['--model', 'claude-sonnet-5'], perAttempt: 0.0165, local: false, provider: 'anthropic' },
        { group: 'Recorded with', id: 'gpt-5', via: 'the recorded model', where: 'OpenAI API', baseUrl: null, flags: ['--model', 'gpt-5'], perAttempt: 0.01, local: false, provider: 'openai' },
        { group: 'Recorded with', id: 'amazon.nova-pro-v1:0', via: 'the recorded model', where: 'Amazon Bedrock', baseUrl: null, flags: ['--model', 'amazon.nova-pro-v1:0'], perAttempt: null, local: false, provider: 'bedrock' },
        { group: 'Anthropic API', id: 'claude-haiku-4-5', via: 'Anthropic API', where: 'Anthropic API', baseUrl: null, flags: ['--model', 'anthropic:claude-haiku-4-5'], perAttempt: 0.0041, local: false },
        { group: 'Ollama, on this machine', id: 'qwen2.5:7b', via: 'Ollama, on this machine', where: 'Ollama, on this machine', baseUrl: 'http://127.0.0.1:11434/v1', flags: ['--model', 'qwen2.5:7b', '--base-url', 'http://127.0.0.1:11434/v1'], perAttempt: 0, local: true },
      ],
      notes: [],
      tokens: null,
    };
    const dialog = trainingView({ pairs: [], sources: [], tasks, scores: [], exports: [], models: listing }).scoreDialog!;
    expect(dialog.options.map((o) => [o.id, o.request.goldens])).toEqual([
      ['claude-sonnet-5', ['goldens/refund']],
      // The model Bedrock's Converse task recorded answers that task, its request sent as the agent made it.
      ['amazon.nova-pro-v1:0', ['goldens/converse']],
      ['claude-haiku-4-5', ['goldens/refund', 'goldens/converse']],
      ['qwen2.5:7b', ['goldens/refund', 'goldens/converse']],
    ]);
    expect(dialog.options[1].note).toBe("Scores 1 of 3 tasks, not refund: recorded on Anthropic's API, not Amazon Bedrock; llama: its takeover call goes through Amazon Bedrock, whose request signature covers the model in its URL");
    expect(dialog.options[2].note).toBe("Scores 2 of 3 tasks, not llama: it asks meta.llama4-maverick-17b-instruct-v1:0 through Bedrock's InvokeModel, whose body only Claude's is known to be (use the Converse API for other models), which only another model of its own provider can answer");
    // Two tasks recorded on another provider are one reason, said once.
    expect(dialog.options[0].note).toBe("Scores 1 of 3 tasks, not llama, converse: recorded on Amazon Bedrock, not Anthropic's API");
    // The first model not scored yet that answers every ready task is preselected: none here answers all three, so the first not scored.
    expect(dialog.selected).toBe('claude-sonnet-5\n');
    // OpenAI's recorded model answers none of them: each was recorded on another provider.
    expect(dialog.leftOut).toEqual([{ group: 'Recorded with', models: ['gpt-5'], why: "refund: it was recorded on Anthropic's API, and gpt-5 is asked of OpenAI's API" }]);
    expect(dialog.groups).toEqual(['Recorded with', 'Anthropic API', 'Ollama, on this machine']);
  });

  it('preselects a model not scored yet that answers every ready task over one that answers some', () => {
    const tasks = [task('goldens/azure', 'ready', 'escalate', { provider: 'azure', callName: 'POST /openai/deployments/gpt-prod/chat/completions' }), task('goldens/gemini', 'ready', 'escalate', { provider: 'gemini', callName: 'POST /v1beta/models/gemini-2.5-flash:generateContent' })];
    const listing: ModelListing = {
      choices: [
        { group: 'Gemini API', id: 'gemini-2.5-flash', via: 'Gemini API', where: 'Gemini API', baseUrl: null, flags: ['--model', 'gemini-2.5-flash'], perAttempt: 0.0003, local: false, provider: 'gemini' },
        { group: 'Anthropic API', id: 'claude-good', via: 'Anthropic API', where: 'Anthropic API', baseUrl: null, flags: ['--model', 'anthropic:claude-good'], perAttempt: 0.004, local: false },
      ],
      notes: [],
      tokens: null,
    };
    const dialog = scoreDialogView(tasks, [], listing)!;
    expect(dialog.options.map((o) => [o.id, o.request.goldens])).toEqual([
      ['gemini-2.5-flash', ['goldens/gemini']],
      ['claude-good', null],
    ]);
    expect(dialog.selected).toBe('claude-good\n');
    expect(dialog.options[0].note).toBe('Scores 1 of 2 tasks, not azure: recorded on Azure OpenAI, not the Gemini API');
    // Once it is scored, the next one not scored yet comes first, whatever it answers.
    expect(scoreDialogView(tasks, [score('claude-good', null, 'goldens/azure', 1, 1, 100), score('claude-good', null, 'goldens/gemini', 1, 1, 100)], listing)!.selected).toBe('gemini-2.5-flash\n');
  });

  it('names the best model\'s endpoint, and counts a model scored at two endpoints once', () => {
    const s = Store.open(':memory:');
    const ready = [task('goldens/a', 'ready', null)];
    const scores = [score('claude-haiku-4-5', null, 'goldens/a', 1, 0.5, 100), score('qwen2.5:7b', 'http://127.0.0.1:11434/v1', 'goldens/a', 1, 1, 200), score('qwen2.5:7b', 'http://gpu-box:8000/v1', 'goldens/a', 1, 0.5, 300)];
    const view = trainingView({ ...readTraining(s, { tasks: ready }), scores });
    expect(view.strip.best).toMatchObject({ value: '1.00', model: 'qwen2.5:7b', sub: 'qwen2.5:7b at 127.0.0.1:11434 · 2 models scored' });
    s.close();
  });

  it('offers an update for a task whose test forks before its takeover, and opens the test run where it forked', () => {
    const s = Store.open(':memory:');
    // The test replay forked at #3, where the request carries a per-run user id the recording never had.
    const golden = recordRun(s, [LOOKUP, POLICY, ESCALATE, DONE]).run;
    const forked = recordRun(s, [LOOKUP, POLICY, ESCALATE, DONE], { parentRunId: golden.runId }).run;
    const divergence = { callNo: 3, kind: 'api', name: 'POST /v1/messages', type: 'request_changed', diff: [{ path: '$.metadata', op: 'added', after: { user_id: '9b2f6c1e-4d7a-4c3b-9e8f-2a1b3c4d5e6f' } }] };
    s.setDivergence(forked.runId, divergence as never);
    const fork = { callNo: 3, runId: forked.runId };
    const over = task('goldens/refund-over-limit', 'blocked', 'escalate above the limit', { runId: golden.runId, note: 'its test forks at #3, before the takeover: update the golden', fork });
    const inLimit = task('goldens/refund-in-limit', 'ready', 'refund within the limit', { runId: golden.runId });

    const update = taskUpdate(s, over, []);
    expect(update).toEqual({
      golden: 'goldens/refund-over-limit',
      forkedAt: 3,
      takeover: 17,
      normalizers: ['$.metadata.user_id'],
      rerecords: true,
      steps: [
        ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'],
        ['test', 'goldens/refund-over-limit', '--update'],
      ],
    });
    // A rule at that path in force already (added on Tests for another golden): the update alone, as the rule masks the value from the next run on.
    expect(taskUpdate(s, over, [{ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }])).toMatchObject({ normalizers: [], steps: [['test', 'goldens/refund-over-limit', '--update']] });
    expect(taskUpdate(s, over, [{ path: '$.metadata.user_id', replace: '<ID>' }])?.normalizers).toEqual([]);
    expect(taskUpdate(s, over, [{ kind: 'tool', path: '$.metadata.user_id', replace: '<ID>' }])?.normalizers).toEqual(['$.metadata.user_id']);
    // Nothing but a value that changes every run, in a field the recording has: the rule is the whole fix.
    const changed = { ...divergence, diff: [{ path: '$.metadata.user_id', op: 'changed', before: '1c2b3a4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', after: '9b2f6c1e-4d7a-4c3b-9e8f-2a1b3c4d5e6f' }] };
    s.setDivergence(forked.runId, changed as never);
    expect(taskUpdate(s, over, [])).toMatchObject({ rerecords: false, steps: [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', 'goldens/refund-over-limit']] });
    // Its job is titled as every normalizer's is, for the task it is for.
    expect(taskUpdateJob({ golden: 'goldens/refund-over-limit' }, s, [inLimit, over], [])).toMatchObject({ title: 'Adding normalizer for refund-over-limit' });
    // A change of its own (another prompt): no rule, the update alone.
    const prompt = { ...divergence, diff: [{ path: '$.system', op: 'changed', before: 'Be brief.', after: 'Escalate refunds above the limit.' }] };
    s.setDivergence(forked.runId, prompt as never);
    expect(taskUpdate(s, over, [])).toMatchObject({ normalizers: [], rerecords: true, steps: [['test', 'goldens/refund-over-limit', '--update']] });
    // A task whose test fails, or a ready one, has none: a failing test is fixed on Tests.
    expect(taskUpdate(s, task('goldens/x', 'blocked', null), [])).toBeNull();
    expect(taskUpdate(s, inLimit, [])).toBeNull();

    s.setDivergence(forked.runId, divergence as never);
    const view = trainingView(readTraining(s, { tasks: [inLimit, over] }));
    const row = view.tasks.rows.find((r) => r.name === 'refund-over-limit')!;
    expect(row).toMatchObject({ status: { label: 'blocked', short: 'its test forks at #3, before the takeover: update the golden' }, href: `#/run/${forked.runId}/3`, opens: 'Open the test run where it forked, at #3', update: { forkedAt: 3, normalizers: ['$.metadata.user_id'] } });
    expect(view.tasks.rows.find((r) => r.name === 'refund-in-limit')).toMatchObject({ href: `#/run/${golden.runId}/17`, opens: 'Open the golden’s run at the takeover', update: null });
    // The task that rewards the opposite is ready once its golden is updated: the warning offers that, not Tests.
    expect(view.tasks.warning).toMatchObject({ name: 'refund-over-limit', once: 'its golden is updated', text: expect.stringContaining('refund-over-limit rewards the opposite once its golden is updated.'), fix: { label: 'Update golden', href: null, update: { golden: 'goldens/refund-over-limit' } } });
    // With the test run gone, the row opens the golden's run at the takeover, and the update is still offered.
    const gone = trainingView(readTraining(s, { tasks: [{ ...over, fork: { callNo: 3, runId: 'GONE' } }] }));
    expect(gone.tasks.rows[0]).toMatchObject({ href: `#/run/${golden.runId}/17`, opens: 'Open the golden’s run at the takeover', update: { steps: [['test', 'goldens/refund-over-limit', '--update']] } });

    // The job runs what the store and the config say, for such a task only.
    expect(taskUpdateJob({ golden: 'goldens/refund-over-limit' }, s, [inLimit, over], [])).toEqual({ title: 'Updating refund-over-limit', steps: update!.steps });
    expect(taskUpdateJob({ golden: 'goldens/refund-in-limit' }, s, [inLimit, over], [])).toEqual({ error: 'refund-in-limit is not blocked by its test forking before the takeover' });
    expect(taskUpdateJob({ golden: 'goldens/x' }, s, [task('goldens/x', 'blocked', null)], [])).toEqual({ error: 'x is not blocked by its test forking before the takeover: its test fails; fix it on Tests' });
    // One whose last test was inconclusive failed nothing: it is settled on Tests, not fixed.
    expect(taskUpdateJob({ golden: 'goldens/x' }, s, [task('goldens/x', 'blocked', null, { note: INCONCLUSIVE_TEST_NOTE })], [])).toEqual({ error: 'x is not blocked by its test forking before the takeover: its last test is inconclusive: a check could not be decided; settle it on Tests' });
    expect(taskUpdateJob({ golden: '../../etc' }, s, [inLimit, over], [])).toEqual({ error: '../../etc is not a golden of this project' });
    expect(taskUpdateJob({}, s, [inLimit, over], [])).toEqual({ error: 'name the golden to update' });
    expect(taskUpdateJob({ golden: '-x' }, s, [{ ...over, golden: '-x' }], [])).toEqual({ error: 'a golden path must not start with "-"' });
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
  });
});
