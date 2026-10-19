import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_COMMAND, packRun } from '../src/pack.js';
import { Store } from '../src/store.js';
import { attemptScore, averageTokens, describeTask, entryFor, goldenPaths, isModelRequest, matchTask, NO_COMMAND_NOTE, oneSided, parseTaskFields, readGolden, type Task, type TaskCheck } from '../src/tasks.js';
import { DONE, ESCALATE, LOOKUP, POLICY, REFUND, recordRun } from './training-fixtures.js';

/** Goldens as tasks: where a model takes over, why, what the task rewards, and whether it can be scored. */

const OUTCOME: TaskCheck[] = [{ label: 'issue_refund called 0 times', cap: false }, { label: 'escalate called 1 time', cap: false }];
const CAPS: TaskCheck[] = [{ label: 'at most 60000 input tokens', cap: true }, { label: 'cost at most $0.05', cap: true }];

function project() {
  const root = mkdtempSync(join(tmpdir(), 'sl-tasks-'));
  const store = Store.open(':memory:');
  return { root, store };
}

describe('goldens', () => {
  it('are read from their pack without importing it', () => {
    const { root, store } = project();
    const { run } = recordRun(store, [LOOKUP, POLICY, ESCALATE, DONE]);
    packRun(store, run.runId, join(root, 'goldens', 'escalate'));
    const golden = readGolden(join(root, 'goldens', 'escalate'), 'goldens/escalate');
    expect(golden.run.runId).toBe(run.runId);
    expect(golden.calls.map((c) => `${c.callNo}:${c.kind}`)).toEqual(['1:api', '2:tool', '3:api', '4:tool', '5:api', '6:tool', '7:api']);
    expect(golden.lineage).toEqual([]);
    expect(() => readGolden(root, 'nothing')).toThrow('is not a Shadowlap pack');
    store.close();
  });

  it('are every pack under goldens/ and every directory the tests name, patterns expanded', () => {
    const { root, store } = project();
    const { run } = recordRun(store, [DONE]);
    for (const dir of ['goldens/a', 'goldens/b', 'suites/refund-1', 'suites/refund-2', 'suites/other']) packRun(store, run.runId, join(root, dir));
    mkdirSync(join(root, 'goldens', 'not-a-pack'));
    expect(goldenPaths(root, ['suites/refund-*', 'goldens/gone', 'goldens/a/'])).toEqual([
      { path: 'goldens/a', exists: true },
      { path: 'goldens/b', exists: true },
      { path: 'goldens/gone', exists: false },
      { path: 'suites/refund-1', exists: true },
      { path: 'suites/refund-2', exists: true },
    ]);
    expect(entryFor(root, ['goldens/*', 'goldens/a'], 'goldens/a')).toBe('goldens/a');
    expect(entryFor(root, ['goldens/*', 'goldens/a'], 'goldens/b')).toBe('goldens/*');
    expect(entryFor(root, ['goldens/*'], 'suites/refund-1')).toBeNull();
    store.close();
  });
});

describe('tasks', () => {
  it('take over at the blamed call when the golden came from a blamed run', () => {
    const { root, store } = project();
    const lost = recordRun(store, [LOOKUP, POLICY, REFUND, DONE], { status: 'failed', meta: { labels: ['refund-bug'] } }).run;
    store.updateRunMeta(lost.runId, { blame: { at: 1, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
    const fork = recordRun(store, [LOOKUP, POLICY, ESCALATE, DONE], { parentRunId: lost.runId, usage: { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 500 } }).run;
    packRun(store, fork.runId, join(root, 'goldens', 'escalate'), { lineage: true });
    const golden = readGolden(join(root, 'goldens', 'escalate'), 'goldens/escalate');
    expect(golden.lineage.map((r) => r.runId)).toEqual([lost.runId]);
    const task = describeTask({ path: 'goldens/escalate', golden, fields: {}, checks: [...OUTCOME, ...CAPS], testFailed: false });
    expect(task).toMatchObject({
      golden: 'goldens/escalate',
      name: 'escalate',
      status: 'ready',
      note: null,
      runId: fork.runId,
      takeover: { callNo: 5, why: 'where refund-bug was lost', from: 'blame' },
      rewards: 'issue_refund called 0 times · escalate called 1 time',
      after: { live: [], stubbed: ['escalate'] },
      prefix: 4,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      callName: 'POST /v1/messages',
      tokensAfter: { inputTokens: 2000, outputTokens: 100, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 },
    });
    // Without the lineage in the pack, the store's runs say where it came from.
    packRun(store, fork.runId, join(root, 'goldens', 'bare'));
    const bare = readGolden(join(root, 'goldens', 'bare'), 'goldens/bare');
    expect(describeTask({ path: 'goldens/bare', golden: bare, fields: {}, checks: OUTCOME, testFailed: null }).takeover!.from).toBe('first');
    expect(describeTask({ path: 'goldens/bare', golden: bare, fields: {}, checks: OUTCOME, testFailed: null, ancestors: [store.getRun(lost.runId)!] }).takeover).toMatchObject({ callNo: 5, from: 'blame' });
    store.close();
  });

  it('take over after the last recorded input, else at the first model call, unless the config says', () => {
    const { root, store } = project();
    const chat = recordRun(store, [LOOKUP, POLICY, ESCALATE], { before: [{ name: 'user_input', result: 'Refund A-1042' }] }).run;
    packRun(store, chat.runId, join(root, 'goldens', 'chat'));
    const golden = readGolden(join(root, 'goldens', 'chat'), 'goldens/chat');
    expect(describeTask({ path: 'goldens/chat', golden, fields: {}, checks: OUTCOME, testFailed: false }).takeover).toEqual({ callNo: 2, why: 'the first model call after the last input', from: 'input' });
    const plain = recordRun(store, [LOOKUP, POLICY, ESCALATE]).run;
    packRun(store, plain.runId, join(root, 'goldens', 'plain'));
    const g2 = readGolden(join(root, 'goldens', 'plain'), 'goldens/plain');
    expect(describeTask({ path: 'goldens/plain', golden: g2, fields: {}, checks: OUTCOME, testFailed: false }).takeover).toEqual({ callNo: 1, why: 'the first model call: the model plays the whole run', from: 'first' });
    expect(describeTask({ path: 'goldens/plain', golden: g2, fields: { takeover: 5, why: 'decides between refunding and escalating', rewards: 'escalate above the limit' }, checks: OUTCOME, testFailed: false })).toMatchObject({ takeover: { callNo: 5, why: 'decides between refunding and escalating', from: 'config' }, rewards: 'escalate above the limit', prefix: 4 });
    expect(describeTask({ path: 'goldens/plain', golden: g2, fields: { takeover: 2 }, checks: OUTCOME, testFailed: false })).toMatchObject({ status: 'not-a-task', note: "#2 is not a model call of the golden's run (lookup_order)" });
    store.close();
  });

  it('never take over at an API call that asks a model nothing: a model list, an embedding, a token count', () => {
    const { root, store } = project();
    // A retrieval agent: it lists the models, embeds the question, then talks to the model.
    const rag = recordRun(store, [LOOKUP, POLICY, ESCALATE], {
      before: [
        { kind: 'api', name: 'GET /v1/models', result: { data: [{ id: 'claude-sonnet-5', type: 'model' }] } },
        { kind: 'api', name: 'POST /v1/embeddings', provider: 'openai', result: { object: 'list', data: [{ embedding: [0.1, 0.2] }] } },
        { kind: 'api', name: 'POST /v1/messages/count_tokens', result: { input_tokens: 42 } },
      ],
    }).run;
    packRun(store, rag.runId, join(root, 'goldens', 'rag'));
    const golden = readGolden(join(root, 'goldens', 'rag'), 'goldens/rag');
    expect(golden.calls.slice(0, 4).map((c) => c.name)).toEqual(['GET /v1/models', 'POST /v1/embeddings', 'POST /v1/messages/count_tokens', 'POST /v1/messages']);
    const task = describeTask({ path: 'goldens/rag', golden, fields: {}, checks: OUTCOME, testFailed: false });
    expect(task).toMatchObject({ status: 'ready', takeover: { callNo: 4, why: 'the first model call: the model plays the whole run', from: 'first' }, prefix: 3, callName: 'POST /v1/messages' });
    for (const k of [1, 2, 3]) expect(describeTask({ path: 'goldens/rag', golden, fields: { takeover: k }, checks: OUTCOME, testFailed: false })).toMatchObject({ status: 'not-a-task', note: `#${k} is not a model call of the golden's run (${golden.calls[k - 1]!.name})` });
    store.close();
  });

  it('know a model call from the endpoint it was made at', () => {
    for (const name of ['POST /v1/messages', 'POST /anthropic/v1/messages', 'POST /v1/chat/completions', 'POST /openai/deployments/gpt-prod/chat/completions', 'POST /v1/completions', 'POST /v1/responses', 'POST /v1beta/models/gemini-2.5-flash:generateContent', 'POST /v1beta/models/gemini-2.5-flash:streamGenerateContent', 'POST /v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:streamRawPredict', 'POST /model/anthropic.claude-sonnet-5-v1%3A0/converse', 'POST /model/anthropic.claude-sonnet-5-v1%3A0/invoke-with-response-stream', 'POST /api/chat']) {
      expect(isModelRequest(name), name).toBe(true);
    }
    for (const name of ['GET /v1/models', 'GET /v1/responses/resp_1', 'POST /v1/messages/count_tokens', 'POST /v1/messages/batches', 'POST /v1/embeddings', 'POST /v1/moderations', 'POST /v1/files', 'POST /v1/threads/thread_1/messages', 'POST /v1/responses/input_tokens', 'POST /v1beta/models/text-embedding-004:embedContent', 'POST /v1beta/models/gemini-2.5-flash:countTokens']) {
      expect(isModelRequest(name), name).toBe(false);
    }
  });

  it('are ready, blocked, not a task or without a golden', () => {
    const { root, store } = project();
    const run = recordRun(store, [LOOKUP, POLICY, ESCALATE, DONE]).run;
    packRun(store, run.runId, join(root, 'g'));
    const golden = readGolden(join(root, 'g'), 'g');
    const status = (t: Task) => [t.status, t.note];
    expect(status(describeTask({ path: 'g', golden, fields: {}, checks: OUTCOME, testFailed: null }))).toEqual(['ready', null]);
    expect(status(describeTask({ path: 'g', golden, fields: {}, checks: OUTCOME, testFailed: true }))).toEqual(['blocked', 'its test fails']);
    // A test that may fork passed, but forked before the takeover: an attempt would leave the recording before the model answers.
    // Its note names the remedy, and the task the call and the test run that forked, which its row opens.
    const forked = describeTask({ path: 'g', golden, fields: { takeover: 5 }, checks: OUTCOME, testFailed: false, forkedAt: 3, forkedRun: 'R' });
    expect(status(forked)).toEqual(['blocked', 'its test forks at #3, before the takeover: update the golden']);
    expect(forked.fork).toEqual({ callNo: 3, runId: 'R' });
    expect(describeTask({ path: 'g', golden, fields: { takeover: 5 }, checks: OUTCOME, testFailed: false, forkedAt: 3 }).fork).toEqual({ callNo: 3, runId: null });
    // A failing test blocks it first: that is fixed on Tests, and no update is offered for it.
    expect(describeTask({ path: 'g', golden, fields: { takeover: 5 }, checks: OUTCOME, testFailed: true, forkedAt: 3, forkedRun: 'R' }).fork).toBeUndefined();
    // Forking at the takeover or after it changes nothing: the model under test answers from there anyway.
    expect(status(describeTask({ path: 'g', golden, fields: { takeover: 5 }, checks: OUTCOME, testFailed: false, forkedAt: 5 }))).toEqual(['ready', null]);
    expect(status(describeTask({ path: 'g', golden, fields: { takeover: 5 }, checks: OUTCOME, testFailed: false, forkedAt: 7 }))).toEqual(['ready', null]);
    expect(describeTask({ path: 'g', golden, fields: { takeover: 5 }, checks: OUTCOME, testFailed: false, forkedAt: 7, forkedRun: 'R' }).fork).toBeUndefined();
    expect(status(describeTask({ path: 'g', golden, fields: {}, checks: CAPS, testFailed: false }))).toEqual(['not-a-task', 'its checks only cap tokens and cost']);
    expect(status(describeTask({ path: 'g', golden, fields: {}, checks: [], testFailed: false }))).toEqual(['not-a-task', 'it has no checks']);
    expect(status(describeTask({ path: 'gone', golden: null, fields: {}, checks: OUTCOME, testFailed: null }))).toEqual(['no-golden', 'the golden is gone']);
    // Packed straight from a capture: shadowlap test can't start its agent, so neither can a score.
    const captured = recordRun(store, [LOOKUP, POLICY, ESCALATE, DONE], { argv: [NO_COMMAND] }).run;
    packRun(store, captured.runId, join(root, 'captured'));
    expect(status(describeTask({ path: 'captured', golden: readGolden(join(root, 'captured'), 'captured'), fields: {}, checks: OUTCOME, testFailed: null }))).toEqual(['blocked', NO_COMMAND_NOTE]);
    store.close();
  });

  it('play the agent\'s scope when a simulated user answers in another, and are not scored yet', () => {
    const { root, store } = project();
    // The agent's model calls in scope "agent", a simulated customer's in "user", turn about; blame was limited to the agent's.
    const turnAbout = (i: number) => (i % 2 === 0 ? 'agent' : 'user');
    const lost = recordRun(store, [LOOKUP, { text: 'It was $240.' }, POLICY, { text: 'Fine.' }, REFUND, DONE], { status: 'failed', scopes: turnAbout, before: [{ name: 'user_input', result: 'Refund A-1042' }] }).run;
    packRun(store, lost.runId, join(root, 'goldens', 'dialogue'));
    const golden = readGolden(join(root, 'goldens', 'dialogue'), 'goldens/dialogue');
    const models = golden.calls.filter((c) => c.kind === 'api').map((c) => [c.callNo, c.meta.scope]);
    expect(models).toEqual([[2, 'agent'], [4, 'user'], [5, 'agent'], [7, 'user'], [8, 'agent'], [10, 'user']]);
    const task = describeTask({ path: 'goldens/dialogue', golden, fields: { scope: 'agent' }, checks: OUTCOME, testFailed: null });
    expect(task).toMatchObject({ scope: 'agent', scopes: ['agent', 'user'], takeover: { callNo: 2, from: 'input' }, status: 'not-a-task' });
    expect(task.note).toBe("its model calls are made in more than one scope (agent, user), and scoring can't yet send only agent's to the model under test");
    // Blame was limited to the agent's scope: its call is the takeover, and its scope the task's.
    store.updateRunMeta(lost.runId, { blame: { at: 1, outcome: 'blamed', callNo: 8, confidence: 'high', rescuedRunId: null, fields: {}, scope: 'agent', oracle: [], probes: [], spent: 0 } });
    expect(describeTask({ path: 'goldens/dialogue', golden, fields: {}, checks: OUTCOME, testFailed: null, ancestors: [store.getRun(lost.runId)!] })).toMatchObject({ scope: 'agent', takeover: { callNo: 8, from: 'blame' } });
    // The first agent call, never the customer's, when nothing else says; and a takeover set at the customer's is refused.
    const noInput = recordRun(store, [{ text: 'Hello.' }, LOOKUP, POLICY, ESCALATE], { scopes: (i) => (i === 0 ? 'user' : 'agent') }).run;
    packRun(store, noInput.runId, join(root, 'goldens', 'greeting'));
    const greeting = readGolden(join(root, 'goldens', 'greeting'), 'goldens/greeting');
    expect(describeTask({ path: 'goldens/greeting', golden: greeting, fields: { scope: 'agent' }, checks: OUTCOME, testFailed: null }).takeover).toMatchObject({ callNo: 2, from: 'first' });
    expect(describeTask({ path: 'goldens/greeting', golden: greeting, fields: { scope: 'agent', takeover: 1 }, checks: OUTCOME, testFailed: null })).toMatchObject({ status: 'not-a-task', note: "#1 is made in scope user, not the agent's (agent)" });
    expect(describeTask({ path: 'goldens/greeting', golden: greeting, fields: { scope: 'planner' }, checks: OUTCOME, testFailed: null })).toMatchObject({ status: 'not-a-task', note: "no model call of the golden's run is made in scope planner" });
    // Every model call in one scope: that is the agent's, and nothing stands in the way.
    const solo = recordRun(store, [LOOKUP, POLICY, ESCALATE, DONE], { scopes: () => 'agent' }).run;
    packRun(store, solo.runId, join(root, 'goldens', 'solo'));
    expect(describeTask({ path: 'goldens/solo', golden: readGolden(join(root, 'goldens', 'solo'), 'goldens/solo'), fields: {}, checks: OUTCOME, testFailed: null })).toMatchObject({ status: 'ready', scope: 'agent', scopes: ['agent'], takeover: { callNo: 1 } });
    // A judge check's call, which a golden packed with its check holds, is none of the agent's: no scope of a task, never a takeover.
    const judged = recordRun(store, [LOOKUP, POLICY, ESCALATE, DONE, { text: '{"verdict":"yes","reason":"it escalates"}' }], { scopes: (i) => (i === 4 ? 'shadowlap:judge' : 'agent') }).run;
    packRun(store, judged.runId, join(root, 'goldens', 'judged'));
    expect(describeTask({ path: 'goldens/judged', golden: readGolden(join(root, 'goldens', 'judged'), 'goldens/judged'), fields: {}, checks: OUTCOME, testFailed: null })).toMatchObject({ status: 'ready', scope: 'agent', scopes: ['agent'], takeover: { callNo: 1 } });
    // A blame of an older run, limited to a scope the golden no longer uses, doesn't hide its calls.
    const unscoped = recordRun(store, [LOOKUP, POLICY, ESCALATE, DONE]).run;
    packRun(store, unscoped.runId, join(root, 'goldens', 'unscoped'));
    expect(describeTask({ path: 'goldens/unscoped', golden: readGolden(join(root, 'goldens', 'unscoped'), 'goldens/unscoped'), fields: {}, checks: OUTCOME, testFailed: null, ancestors: [store.getRun(lost.runId)!] })).toMatchObject({ status: 'ready', scope: null, takeover: { callNo: 1, from: 'first' } });
    store.close();
  });

  it('warn when every ready task rewards the same behaviour, naming one that rewards another', () => {
    const t = (golden: string, status: Task['status'], rewards: string): Task => ({ golden, name: golden, status, note: status === 'blocked' ? 'its test fails' : null, runId: null, takeover: null, scope: null, scopes: [], rewards, checks: [], after: { live: [], stubbed: [] }, prefix: 0, model: null, provider: null, callName: null, tokensAfter: null });
    expect(oneSided([t('a', 'ready', 'escalate above the limit'), t('b', 'ready', 'escalate above the limit'), t('c', 'blocked', 'refund within the limit')])).toEqual({
      rewards: 'escalate above the limit',
      tasks: ['a', 'b'],
      opposite: { golden: 'c', rewards: 'refund within the limit', status: 'blocked', note: 'its test fails' },
    });
    expect(oneSided([t('a', 'ready', 'escalate above the limit'), t('c', 'ready', 'refund within the limit')])).toBeNull();
    expect(oneSided([t('a', 'blocked', 'x')])).toBeNull();
  });

  it('average the tokens after the takeover, score attempts and find tasks by name', () => {
    const t = (u: Task['tokensAfter']) => ({ tokensAfter: u }) as Task;
    expect(averageTokens([t({ inputTokens: 1000, outputTokens: 100 }), t({ inputTokens: 3000, outputTokens: 300, cacheReadInputTokens: 400 }), t(null)])).toEqual({ inputTokens: 2000, outputTokens: 200, cacheReadInputTokens: 200, cacheCreationInputTokens: 0 });
    expect(averageTokens([])).toBeNull();
    expect(attemptScore([{ ok: true }, { ok: false }, { ok: true }, { ok: true }])).toBe(0.75);
    const tasks = [{ golden: 'goldens/refund-over-limit', name: 'refund-over-limit' }, { golden: 'goldens/a/refund', name: 'refund' }, { golden: 'goldens/b/refund', name: 'refund' }];
    expect(matchTask(tasks, 'refund-over-limit')).toEqual({ task: tasks[0] });
    expect(matchTask(tasks, 'goldens/refund-over-limit/')).toEqual({ task: tasks[0] });
    expect(matchTask(tasks, './goldens/a/refund')).toEqual({ task: tasks[1] });
    // Two goldens share the name: it alone says neither, and both are named.
    expect(matchTask(tasks, 'refund')).toEqual({ ambiguous: ['goldens/a/refund', 'goldens/b/refund'] });
    expect(matchTask(tasks, 'goldens/c/refund')).toBeNull();
    expect(matchTask(tasks, 'nope')).toBeNull();
  });

  it('check the task block of a tests entry', () => {
    expect(parseTaskFields({ takeover: 17, why: ' decides ', rewards: 'escalate', scope: ' agent ' }, 'task')).toEqual({ takeover: 17, why: 'decides', rewards: 'escalate', scope: 'agent' });
    expect(() => parseTaskFields({ scope: '' }, 'task')).toThrow('task.scope must be the name of a scope');
    expect(() => parseTaskFields({ scope: 3 }, 'task')).toThrow('task.scope must be the name of a scope');
    expect(parseTaskFields(undefined, 'task')).toEqual({});
    expect(() => parseTaskFields({ takeover: 0 }, 'tests["g"].task')).toThrow('tests["g"].task.takeover must be a model call number');
    expect(() => parseTaskFields({ teaches: 'x' }, 'task')).toThrow('unknown key "teaches"');
    expect(() => parseTaskFields({ why: '\u001b[31m' }, 'task')).toThrow('short line of text');
  });
});
