import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeResponse, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { startMockOpenAI, toolCall, turn, type MockServer as OpenAIServer, type ScriptContext as OpenAIContext } from '@shadowlap-testing/mock-openai';

/**
 * Training through the CLI: preference pairs exported from a real blame, goldens scored as tasks by
 * another model of the same provider and by an OpenAI-compatible endpoint (the conversation
 * translated there and back), an OpenAI recording taken over by an Anthropic model, the endpoint a
 * training loop asks, and the model listing. The mocks play every model: "small-model",
 * "claude-good", "gpt-small" and "my-finetune" escalate the $240 refund, as policy says; any other
 * model refunds it. Under `alternate`, the small model refunds on odd decisions instead, so blame can
 * rescue the run.
 */

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./training-agent.mjs', import.meta.url));
const OPENAI_AGENT = fileURLToPath(new URL('./training-openai-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: 0 } });
const GOOD = new Set(['small-model', 'claude-good', 'gpt-small', 'my-finetune']);

let anthropic: MockServer;
let openai: OpenAIServer;
let policy: 'models' | 'alternate' = 'models';
let decisions = 0;

function decide(model: string): boolean {
  if (policy === 'alternate') return decisions++ % 2 === 1;
  return GOOD.has(model);
}

function anthropicScript(ctx: ScriptContext) {
  const last = JSON.stringify(ctx.request.messages.at(-1)?.content ?? '');
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([text('Looking the order up.'), toolUse('lookup_order', { order_id: 'A-1042' }, `toolu_lookup_${ctx.requestNo}`)]) };
    case 1:
      return { message: message([toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)]) };
    case 2:
      return decide(ctx.request.model)
        ? { message: message([text('Above the limit.'), toolUse('escalate', { reason: 'refund of $240 is above $100' }, `toolu_decide_${ctx.requestNo}`)]) }
        : { message: message([text('Issuing the refund.'), toolUse('issue_refund', { order_id: 'A-1042', amount: 240 }, `toolu_decide_${ctx.requestNo}`)]) };
    default:
      return { message: message([text(last.includes('ticket') ? 'Escalated to a manager.' : 'Refunded $240.')], { stop_reason: 'end_turn' }) };
  }
}

function openaiScript(ctx: OpenAIContext) {
  switch (ctx.assistantTurns) {
    case 0:
      return { turn: turn('Looking the order up.', { tool_calls: [toolCall('lookup_order', { order_id: 'A-1042' })] }) };
    case 1:
      return { turn: turn(null, { tool_calls: [toolCall('read_policy', {})] }) };
    case 2:
      return GOOD.has(ctx.request.model)
        ? { turn: turn('Above the limit.', { tool_calls: [toolCall('escalate', { reason: 'refund of $240 is above $100' })] }) }
        : { turn: turn('Issuing the refund.', { tool_calls: [toolCall('issue_refund', { order_id: 'A-1042', amount: 240 })] }) };
    default:
      return { turn: turn('Escalated to a manager.') };
  }
}

/** Fake model lists: Anthropic's and Ollama's, on this machine. No network. */
let lists: Server;
let listsUrl = '';

beforeAll(async () => {
  anthropic = await startMockAnthropic({ script: anthropicScript, eventDelayMs: () => 0 });
  openai = await startMockOpenAI({ script: openaiScript });
  lists = createServer((req, res) => {
    const body = req.url?.startsWith('/v1/models') ? { data: [{ id: 'claude-good', type: 'model' }, { id: 'claude-haiku-4-5', type: 'model' }] } : req.url === '/api/tags' ? { models: [{ name: 'qwen2.5:7b' }] } : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'no route' }));
  });
  await new Promise<void>((resolve) => lists.listen(0, '127.0.0.1', resolve));
  listsUrl = `http://127.0.0.1:${(lists.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await anthropic.close();
  await openai.close();
  await new Promise<void>((resolve) => lists.close(() => resolve()));
});

function workdir(prefix: string) {
  const work = mkdtempSync(join(tmpdir(), prefix));
  return { work, db: join(work, '.shadowlap', 'shadowlap.db') };
}

interface Result {
  code: number | null;
  out: string;
  stdout: string;
  events: Array<Record<string, unknown>>;
}

function shadowlap(work: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url, SHADOWLAP_UPSTREAM_OPENAI: openai.url, ANTHROPIC_API_KEY: 'test-key', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_EVENTS_FD: '3', AGENT_OUTBOX: join(work, 'outbox.jsonl'), ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    let fd3 = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
    });
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => (fd3 += d.toString()));
    child.on('close', (code) => resolve({ code, out, stdout, events: fd3.trim() ? fd3.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [] }));
  });
}

async function record(work: string, argv: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const r = await shadowlap(work, ['run', '--', process.execPath, ...argv], env);
  expect(r.code, r.out).toBe(0);
  return /recording run (\w{26})/.exec(r.out)![1]!;
}

function withStore<T>(db: string, fn: (s: Store) => T): T {
  const s = Store.open(db);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

describe('shadowlap export pairs', () => {
  it('writes the answer blame proved lost the run next to one that passed, and keeps a record of the export', async () => {
    policy = 'alternate';
    decisions = 0;
    const { work, db } = workdir('sl-pairs-');
    try {
      const runId = await record(work, [AGENT]);
      const blame = await shadowlap(work, ['blame', runId, '--expect', ORACLE, '--attempts', '3', '--passes', '1']);
      expect(blame.code, blame.out).toBe(0);
      expect(blame.stdout).toContain('The run was lost at model call #5');
      writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: '/A-1042/', replace: '<ORDER>' }] }));

      const r = await shadowlap(work, ['export', 'pairs', '--out', 'pairs.jsonl']);
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toContain('▸ reading blame, verify and --repeat attempts from the store: 1 source');
      expect(r.stdout).toMatch(/blame · \w{10} +1 pair, high/);
      expect(r.stdout).toContain('1 pair at confidence high · identical answers count once');
      expect(r.stdout).toContain('openai-preference: { input: { messages, tools }, preferred_output, non_preferred_output }');
      expect(r.stdout).toContain('redaction: 1 rule applied to the copy');
      expect(r.stdout).toContain('✓ wrote pairs.jsonl · 1 pair');
      const rows = readFileSync(join(work, 'pairs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { input: { messages: Array<{ role: string; content: string }>; tools: unknown[] }; preferred_output: Array<{ tool_calls: Array<{ function: { name: string } }> }>; non_preferred_output: Array<{ tool_calls: Array<{ function: { name: string; arguments: string } }> }> });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.input.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
      expect(rows[0]!.input.messages[1]!.content).toBe('The customer asks for a refund on order <ORDER>.');
      expect(rows[0]!.input.tools).toHaveLength(4);
      expect(rows[0]!.preferred_output[0]!.tool_calls[0]!.function.name).toBe('escalate');
      expect(rows[0]!.non_preferred_output[0]!.tool_calls[0]!.function).toEqual({ name: 'issue_refund', arguments: '{"order_id":"<ORDER>","amount":240}' });
      expect(r.events).toEqual([
        { type: 'file', path: realpathSync(join(work, 'pairs.jsonl')), label: 'pairs.jsonl' },
        { type: 'link', label: 'Open Training', href: '#/training' },
        { type: 'result', data: expect.objectContaining({ pairs: 1, file: 'pairs.jsonl', format: 'openai-preference', minConfidence: 'high', leftOut: 0, redaction: 1 }) },
      ]);
      withStore(db, (s) => {
        expect(s.listPairsExports()[0]).toMatchObject({ pairs: 1, file: 'pairs.jsonl', format: 'openai-preference', minConfidence: 'high' });
        expect(s.listEvents({ kinds: ['pairs.exported'] })[0]).toMatchObject({ ref: 'pairs.jsonl', data: expect.objectContaining({ count: 1 }) });
      });

      const trl = await shadowlap(work, ['export', 'pairs', '--format', 'trl', '--min-confidence', 'medium', '--no-redact']);
      expect(trl.code, trl.out).toBe(0);
      expect(trl.out).toContain('redaction skipped (--no-redact)');
      const row = JSON.parse(trl.stdout.trim()) as { prompt: unknown[]; chosen: Array<{ tool_calls: Array<{ function: { arguments: unknown } }> }>; rejected: unknown[] };
      expect(row.chosen[0]!.tool_calls[0]!.function.arguments).toEqual({ reason: 'refund of $240 is above $100' });
      expect(JSON.stringify(row)).toContain('A-1042');
      withStore(db, (s) => expect(s.listPairsExports().map((e) => e.file)).toEqual(['-', 'pairs.jsonl']));
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

describe('shadowlap tasks', () => {
  let work = '';
  let db = '';
  let golden = '';

  beforeAll(async () => {
    policy = 'models';
    ({ work, db } = workdir('sl-tasks-'));
    golden = await record(work, [AGENT, '--stream']);
    const budget = await record(work, [AGENT]);
    for (const [run, dir] of [[golden, 'goldens/refund-over-limit'], [budget, 'goldens/budget']] as const) {
      const r = await shadowlap(work, ['pack', run, dir]);
      expect(r.code, r.out).toBe(0);
    }
    writeFileSync(
      join(work, 'shadowlap.config.json'),
      JSON.stringify({
        tests: {
          'goldens/refund-over-limit': { expect: { tools: { issue_refund: 0, escalate: 1 } }, task: { takeover: 5, why: 'decides between refunding and escalating', rewards: 'escalate above the limit' } },
          'goldens/budget': { expect: { inputTokens: '<= 60000', cost: '<= 0.05' } },
        },
      }),
    );
  }, 60_000);
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('lists the goldens as tasks: where a model takes over, why, what it rewards, and which can be scored', async () => {
    const r = await shadowlap(work, ['tasks', '--json']);
    expect(r.code, r.out).toBe(0);
    const { tasks, oneSided } = JSON.parse(r.stdout) as { tasks: Array<Record<string, unknown>>; oneSided: { rewards: string } | null };
    expect(tasks.map((t) => [t.golden, t.status, t.note])).toEqual([
      ['goldens/budget', 'not-a-task', 'its checks only cap tokens and cost'],
      ['goldens/refund-over-limit', 'ready', null],
    ]);
    expect(tasks[1]).toMatchObject({ runId: golden, takeover: { callNo: 5, why: 'decides between refunding and escalating', from: 'config' }, rewards: 'escalate above the limit', after: { live: [], stubbed: ['escalate'] }, prefix: 4, model: 'small-model', provider: 'anthropic' });
    expect(oneSided?.rewards).toBe('escalate above the limit');
    const plain = await shadowlap(work, ['tasks']);
    expect(plain.stdout).toContain('1 of 2 tasks ready · 1 not a task');
    expect(plain.stdout).toContain('takes over at #5 · decides between refunding and escalating · #1–#4 replay free');
    expect(plain.stdout).toContain('! One-sided: every ready task rewards "escalate above the limit"');
  });

  it('scores another model of the recording\'s provider: the golden replays up to the takeover, the model answers from there', async () => {
    const before = anthropic.requests.length;
    const r = await shadowlap(work, ['tasks', 'score', '--model', 'weak-model', '--attempts', '2']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('▸ refund-over-limit · #1–#4 replayed · weak-model from #5 · writes stubbed');
    expect(r.out).toMatch(/ 1 · ✓ the agent exits 0 · ✗ issue_refund called 0 times · ✗ escalate called 1 time · 0\.33/);
    expect(r.stdout).toMatch(/✓ weak-model · mean 0\.33 · 2 attempts on 1 task · .*every call before a takeover replayed/);
    // Only the calls from the takeover on reached a model, and they asked for the model under test.
    const asked = anthropic.requests.slice(before);
    expect(asked.map((x) => x.body.model)).toEqual(['weak-model', 'weak-model', 'weak-model', 'weak-model']);
    expect(r.events.filter((e) => e.type === 'run')).toHaveLength(2);
    expect(r.events.at(-1)).toMatchObject({ type: 'result', data: { model: 'weak-model', baseUrl: null, via: 'Anthropic API', mean: 1 / 3, attempts: 2 } });
    withStore(db, (s) => {
      const rows = s.listTaskScores();
      expect(rows.map((x) => [x.model, x.baseUrl, x.golden, x.attempt, Number(x.score.toFixed(2))])).toEqual([
        ['weak-model', null, 'goldens/refund-over-limit', 1, 0.33],
        ['weak-model', null, 'goldens/refund-over-limit', 2, 0.33],
      ]);
      const attempt = s.getRun(rows[0]!.runId!)!;
      expect(attempt.parentRunId).toBe(golden);
      expect(attempt.divergence).toMatchObject({ type: 'forced', callNo: 5 });
      expect(attempt.meta?.task).toMatchObject({ golden: 'goldens/refund-over-limit', model: 'weak-model', takeover: 5, attempt: 1, of: 2 });
      // Writes after the takeover were stubbed: nothing was refunded.
      expect(s.getCalls(attempt.runId).filter((c) => c.name === 'issue_refund').map((c) => c.origin)).toEqual(['stubbed']);
    });
    expect(readFileSync(join(work, 'outbox.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2); // the two recordings' escalations only
  }, 120_000);

  it('scores a model at an OpenAI-compatible endpoint: the conversation is translated there and the answer back', async () => {
    const before = openai.requests.length;
    const r = await shadowlap(work, ['tasks', 'score', 'goldens/refund-over-limit', '--model', 'my-finetune', '--base-url', `${openai.url}/v1`, '--attempts', '2', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as { mean: number; spent: number; via: string; baseUrl: string; tasks: Array<{ attempts: Array<{ run: string; checks: Array<{ check: string; pass: boolean }> }> }> };
    expect(report).toMatchObject({ mean: 1, spent: 0, via: 'on this machine', baseUrl: `${openai.url}/v1` });
    expect(report.tasks[0]!.attempts[0]!.checks).toEqual([
      { check: 'the agent exits 0', pass: true, detail: null },
      { check: 'issue_refund called 0 times', pass: true, detail: null },
      { check: 'escalate called 1 time', pass: true, detail: null },
    ]);
    expect(r.out).toContain('$0, on this machine');
    const asked = openai.requests.slice(before);
    expect(asked).toHaveLength(4);
    const first = asked[0]!.body as { model: string; stream?: boolean; messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>; tools: Array<{ type: string; function: { name: string } }> };
    expect(first.model).toBe('my-finetune');
    expect(first.stream).toBe(false);
    expect(first.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(first.messages[0]!.content).toBe('You are a support agent. Follow the refund policy.');
    expect(first.tools.map((t) => t.function.name)).toEqual(['lookup_order', 'read_policy', 'issue_refund', 'escalate']);
    withStore(db, (s) => {
      // The agent streamed: it got Anthropic events made from the endpoint's answer, and the store keeps those.
      const runId = report.tasks[0]!.attempts[0]!.run;
      const call = s.getCalls(runId).find((c) => c.callNo === 5)!;
      expect(call.end!.meta).toMatchObject({ model: 'my-finetune', provider: 'anthropic', stopReason: 'tool_use' });
      expect(call.end!.meta.headers?.['content-type']).toContain('text/event-stream');
      expect(normalizeResponse(s.getBlob(call.end!.responseRef!), 'text/event-stream', [], 'anthropic').blocks).toEqual([{ type: 'text', text: 'Above the limit.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'refund of $240 is above $100' } }]);
      expect(s.getRun(runId)!.meta?.task).toMatchObject({ model: 'my-finetune', baseUrl: `${openai.url}/v1` });
    });
  }, 120_000);

  it('replaces a model\'s scores when it is scored again, and logs each scoring', async () => {
    const r = await shadowlap(work, ['tasks', 'score', '--model', 'weak-model', '--attempts', '3']);
    expect(r.code, r.out).toBe(0);
    withStore(db, (s) => {
      const rows = s.listTaskScores();
      expect(rows.filter((x) => x.model === 'weak-model').map((x) => x.attempt)).toEqual([1, 2, 3]);
      expect(rows.filter((x) => x.model === 'my-finetune')).toHaveLength(2);
      expect(s.listEvents({ kinds: ['model.scored'] }).map((e) => e.ref)).toEqual(['weak-model', 'my-finetune', 'weak-model']);
    });
  }, 120_000);

  it('refuses what can\'t be scored, and says why', async () => {
    const r = await shadowlap(work, ['tasks', 'score', 'goldens/budget', '--model', 'weak-model']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('skipped goldens/budget is not a task: its checks only cap tokens and cost');
    const down = await shadowlap(work, ['tasks', 'score', '--model', 'my-finetune', '--base-url', 'http://127.0.0.1:9/v1', '--attempts', '1']);
    expect(down.code).toBe(1);
    expect(down.out).toContain("my-finetune didn't answer #5");
    expect(down.out).toContain("isn't reachable");
  }, 120_000);

  it('lists models to score with a price per attempt, and the scores they have', async () => {
    // A port nothing listens on: the OpenAI-compatible server isn't running.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const nobody = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const r = await shadowlap(work, ['tasks', 'models', '--json'], { SHADOWLAP_UPSTREAM_ANTHROPIC: listsUrl, OLLAMA_HOST: listsUrl, SHADOWLAP_UPSTREAM_OPENAI: nobody, OPENAI_API_KEY: '' });
    expect(r.code, r.out).toBe(0);
    const { choices, notes } = JSON.parse(r.stdout) as { choices: Array<{ group: string; id: string; flags: string[]; perAttempt: number | null; lastScore: number | null }>; notes: Array<{ group: string; note: string }> };
    expect(choices.map((c) => [c.group, c.id])).toEqual([
      ['Recorded with', 'small-model'],
      ['Anthropic API', 'claude-good'],
      ['Anthropic API', 'claude-haiku-4-5'],
      ['Ollama, on this machine', 'qwen2.5:7b'],
      ['Endpoints scored before', 'my-finetune'],
      ['Endpoints scored before', 'weak-model'],
    ]);
    expect(choices.find((c) => c.id === 'qwen2.5:7b')).toMatchObject({ flags: ['--model', 'qwen2.5:7b', '--base-url', `${listsUrl}/v1`], perAttempt: 0 });
    expect(choices.find((c) => c.id === 'claude-haiku-4-5')!.perAttempt).toBeGreaterThan(0);
    expect(choices.find((c) => c.id === 'my-finetune')).toMatchObject({ lastScore: 1, flags: ['--model', 'my-finetune', '--base-url', `${openai.url}/v1`] });
    expect(choices.find((c) => c.id === 'weak-model')!.lastScore).toBeCloseTo(1 / 3);
    expect(notes).toEqual([{ group: 'OpenAI-compatible, on this machine', note: "isn't running" }]);
  }, 60_000);

  it('serves one attempt per request to a training loop, behind a token', async () => {
    const token = 'tok-' + 'x'.repeat(20);
    const child = spawn(process.execPath, [CLI, 'tasks', 'serve'], { cwd: work, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_TASKS_TOKEN: token, AGENT_OUTBOX: join(work, 'outbox.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        child.stdout!.on('data', (d: Buffer) => {
          out += d.toString();
          const m = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
          if (m) resolve(m[1]!);
        });
        child.on('exit', () => reject(new Error(`tasks serve exited: ${out}`)));
      });
      const call = (path: string, init: { method?: string; body?: unknown; token?: string | null; host?: string } = {}) =>
        new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
          const u = new URL(path, url);
          const req = httpRequest(u, { method: init.method ?? 'GET', headers: { host: init.host ?? u.host, 'content-type': 'application/json', ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? token}` }) } }, (res) => {
            let data = '';
            res.on('data', (d: Buffer) => (data += d.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> }));
          });
          req.on('error', reject);
          req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
        });

      const listed = await call('/v1/tasks');
      expect(listed.status).toBe(200);
      expect((listed.body.tasks as Array<{ task: string; status: string }>).map((t) => [t.task, t.status])).toEqual([['budget', 'not-a-task'], ['refund-over-limit', 'ready']]);
      const attempt = await call('/v1/tasks/refund-over-limit/attempts', { method: 'POST', body: { model: 'my-finetune', baseUrl: `${openai.url}/v1` } });
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(200);
      expect(attempt.body).toMatchObject({ task: 'refund-over-limit', model: 'my-finetune', takeover: 5, score: 1, spent: 0, exitCode: 0 });
      expect(attempt.body.checks).toEqual([
        { check: 'the agent exits 0', pass: true, detail: null },
        { check: 'issue_refund called 0 times', pass: true, detail: null },
        { check: 'escalate called 1 time', pass: true, detail: null },
      ]);
      expect(attempt.body.run).toMatch(/^\w{26}$/);
      const weak = await call('/v1/tasks/goldens%2Frefund-over-limit/attempts', { method: 'POST', body: { model: 'weak-model' } });
      expect(weak.body.score).toBeCloseTo(1 / 3);

      expect((await call('/v1/tasks', { token: null })).status).toBe(401);
      expect((await call('/v1/tasks', { token: 'wrong' })).status).toBe(401);
      expect((await call('/v1/tasks', { host: 'evil.example:80' })).status).toBe(403);
      expect((await call('/v1/tasks/nope/attempts', { method: 'POST', body: { model: 'm' } })).status).toBe(404);
      expect(await call('/v1/tasks/budget/attempts', { method: 'POST', body: { model: 'm' } })).toMatchObject({ status: 409, body: { status: 'not-a-task' } });
      expect((await call('/v1/tasks/refund-over-limit/attempts', { method: 'POST', body: { baseUrl: 'x' } })).status).toBe(400);
      // A training loop's attempts are runs, but not a model's scores.
      withStore(db, (s) => {
        expect(s.listTaskScores().filter((x) => x.model === 'my-finetune')).toHaveLength(2);
        expect(s.getRun(attempt.body.run as string)!.meta?.task).toMatchObject({ model: 'my-finetune', session: expect.stringMatching(/^serve-/) });
      });
    } finally {
      child.kill('SIGTERM');
    }
  }, 120_000);
});

describe('an OpenAI recording taken over by an Anthropic model', () => {
  it('translates the chat conversation for the model, and its answer back into chunks the OpenAI SDK reads', async () => {
    policy = 'models';
    const { work, db } = workdir('sl-reverse-');
    try {
      const runId = await record(work, [OPENAI_AGENT, '--stream']);
      expect((await shadowlap(work, ['pack', runId, 'goldens/openai'])).code).toBe(0);
      writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/openai': { expect: { tools: { issue_refund: 0 } }, task: { takeover: 5 } } } }));
      const before = anthropic.requests.length;
      const r = await shadowlap(work, ['tasks', 'score', '--model', 'anthropic:claude-good', '--attempts', '1']);
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toMatch(/✓ claude-good · mean 1\.00 · 1 attempt on 1 task/);
      const asked = anthropic.requests.slice(before);
      expect(asked.length).toBeGreaterThanOrEqual(2);
      const first = asked[0]!;
      expect(first.headers['x-api-key']).toBe('test-key');
      expect(first.body).toMatchObject({ model: 'claude-good', system: 'You are a support agent. Follow the refund policy.', stream: false });
      expect(first.body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
      expect(JSON.stringify(first.body.messages[2])).toContain('tool_result');
      withStore(db, (s) => {
        const rows = s.listTaskScores();
        expect(rows).toMatchObject([{ model: 'claude-good', baseUrl: null, via: 'Anthropic API', score: 1 }]);
        const call = s.getCalls(rows[0]!.runId!).find((c) => c.callNo === 5)!;
        expect(call.end!.meta).toMatchObject({ model: 'claude-good', provider: 'openai', stopReason: 'tool_calls' });
      });
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});
