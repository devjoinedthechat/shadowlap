import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The providers' other endpoints, in front of the mocks: Anthropic's model list and token counts and
 * OpenAI's embeddings are answered here, and the model calls go on to the mocks. It notes the model
 * each token count named.
 */
async function startFront(): Promise<{ url: string; counted: string[]; close: () => Promise<void> }> {
  const counted: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = (req.url ?? '/').split('?')[0]!;
      const json = (value: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && path === '/v1/models') return json({ data: [{ id: 'small-model', type: 'model', display_name: 'Small', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'small-model', last_id: 'small-model' });
      if (path === '/v1/messages/count_tokens') {
        counted.push((JSON.parse(body.toString('utf8')) as { model: string }).model);
        return json({ input_tokens: 42 });
      }
      if (path === '/v1/embeddings') return json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: 'text-embedding-3-small', usage: { prompt_tokens: 9, total_tokens: 9 } });
      const headers = { ...req.headers };
      delete headers.host;
      const out = httpRequest(new URL(req.url ?? '/', path.endsWith('/chat/completions') ? openai.url : anthropic.url), { method: req.method, headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      out.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      out.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, counted, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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
      // The dashboard's export goes into the project's exports folder, made when it isn't there yet.
      const nested = await shadowlap(work, ['export', 'pairs', '--out', '.shadowlap/exports/pairs.jsonl']);
      expect(nested.code, nested.out).toBe(0);
      expect(readFileSync(join(work, '.shadowlap', 'exports', 'pairs.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

describe('shadowlap export pairs, with nothing to export', () => {
  it('leaves the file alone, records nothing as gone, and tells the job', async () => {
    const { work, db } = workdir('sl-nopairs-');
    try {
      writeFileSync(join(work, 'pairs.jsonl'), '{"earlier":true}\n');
      const r = await shadowlap(work, ['export', 'pairs', '--out', 'pairs.jsonl']);
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toContain('No pairs yet');
      expect(r.stdout).toContain('! nothing exported · pairs.jsonl left as it was');
      expect(readFileSync(join(work, 'pairs.jsonl'), 'utf8')).toBe('{"earlier":true}\n');
      expect(r.events).toEqual([
        { type: 'result', data: expect.objectContaining({ exportId: null, pairs: 0, file: null, minConfidence: 'high' }) },
      ]);
      withStore(db, (s) => {
        expect(s.listPairsExports()).toEqual([]);
        expect(s.listEvents({ kinds: ['pairs.exported'] })).toEqual([]);
      });
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 60_000);
});

describe('a golden whose test forks before its task takes over', () => {
  it('is blocked, said after the test, and re-recorded by test --update, which makes it ready', async () => {
    policy = 'models';
    const { work } = workdir('sl-forked-');
    try {
      const run = await record(work, [AGENT]);
      expect((await shadowlap(work, ['pack', run, 'goldens/refund'])).code).toBe(0);
      expect((await shadowlap(work, ['pack', run, 'goldens/budget'])).code).toBe(0);
      writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund': { fork: true, expect: { tools: { issue_refund: 0 } }, task: { takeover: 5 } }, 'goldens/budget': { fork: true, expect: { inputTokens: '<= 60000' } } } }));
      // The agent asks another model now: its first request differs, so each test forks at #1 and runs live from there, writes stubbed.
      const env = { AGENT_MODEL: 'claude-good' };
      const test = await shadowlap(work, ['test', 'goldens/refund', 'goldens/budget', '--writes', 'stub'], env);
      expect(test.code, test.out).toBe(0);
      expect(test.stdout).toContain('✓ refund: forked at call 1');
      // A model can't take over at #5 where the recording no longer replays: the test passes, and says so. The budget golden is no task.
      expect(test.stdout).toContain("goldens/refund forks at #1, before its task's takeover at #5, so no model can be scored on it. Update it: shadowlap test goldens/refund --update");
      expect(test.stdout).not.toContain('goldens/budget forks');
      const listed = JSON.parse((await shadowlap(work, ['tasks', '--json'], env)).stdout) as { tasks: Array<Record<string, unknown>> };
      expect(listed.tasks.find((t) => t.golden === 'goldens/refund')).toMatchObject({ status: 'blocked', note: 'its test forks at #1, before the takeover: update the golden', fork: { callNo: 1, runId: expect.stringMatching(/^\w{26}$/) } });
      expect((await shadowlap(work, ['tasks'], env)).stdout).toContain('update it: shadowlap test goldens/refund --update');

      const update = await shadowlap(work, ['test', 'goldens/refund', 'goldens/budget', '--update', '--writes', 'stub'], env);
      expect(update.code, update.out).toBe(0);
      expect(update.stdout).toContain("↻ updating goldens/refund: it forks at #1, before its task's takeover at #5, so no model can be scored on it; re-recording live, writes stubbed");
      expect(update.stdout).toContain('replaced goldens/refund in the working tree');
      expect(update.stdout).toMatch(/✓ refund: \d+\/\d+ replayed.*\(updated\)/);
      // A golden that is no task forks as it may: it is left alone.
      expect(update.stdout).not.toContain('updating goldens/budget');
      const after = JSON.parse((await shadowlap(work, ['tasks', '--json'], env)).stdout) as { tasks: Array<Record<string, unknown>> };
      const refund = after.tasks.find((t) => t.golden === 'goldens/refund')!;
      expect(refund).toMatchObject({ status: 'ready', note: null, takeover: { callNo: 5 } });
      expect(refund.fork).toBeUndefined();
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

describe('shadowlap tasks', () => {
  let work = '';
  let db = '';
  let golden = '';

  const TESTS = {
    'goldens/refund-over-limit': { expect: { tools: { issue_refund: 0, escalate: 1 } }, task: { takeover: 5, why: 'decides between refunding and escalating', rewards: 'escalate above the limit' } },
    'goldens/budget': { expect: { inputTokens: '<= 60000', cost: '<= 0.05' } },
  };

  beforeAll(async () => {
    policy = 'models';
    ({ work, db } = workdir('sl-tasks-'));
    golden = await record(work, [AGENT, '--stream']);
    const budget = await record(work, [AGENT]);
    for (const [run, dir] of [[golden, 'goldens/refund-over-limit'], [budget, 'goldens/budget']] as const) {
      const r = await shadowlap(work, ['pack', run, dir]);
      expect(r.code, r.out).toBe(0);
    }
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: TESTS }));
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
    expect(r.events.filter((e) => e.type === 'link')).toEqual([{ type: 'link', label: 'Open the scores', href: '#/training/tasks' }]);
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
    const report = JSON.parse(r.stdout) as { mean: number; spent: number; via: string; baseUrl: string; tasks: Array<{ stored: string; attempts: Array<{ run: string; checks: Array<{ check: string; pass: boolean }> }> }> };
    expect(report).toMatchObject({ mean: 1, spent: 0, via: 'on this machine', baseUrl: `${openai.url}/v1` });
    expect(report.tasks[0]!.stored).toBe('new');
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
    const r = await shadowlap(work, ['tasks', 'score', '--model', 'weak-model', '--attempts', '3', '--concurrency', '2']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('refund-over-limit: replaced 2 earlier attempts (0.33) with these 3');
    withStore(db, (s) => {
      const rows = s.listTaskScores();
      expect(rows.filter((x) => x.model === 'weak-model').map((x) => x.attempt)).toEqual([1, 2, 3]);
      expect(rows.filter((x) => x.model === 'my-finetune')).toHaveLength(2);
      expect(s.listEvents({ kinds: ['model.scored'] }).map((e) => e.ref)).toEqual(['weak-model', 'my-finetune', 'weak-model']);
      // Every attempt, run two at a time, is a run marked with its score.
      for (const row of rows.filter((x) => x.model === 'weak-model')) expect(s.getRun(row.runId!)!.meta?.task).toMatchObject({ model: 'weak-model', attempt: row.attempt, of: 3, score: row.score });
    });
  }, 120_000);

  it('keeps a whole score when a re-score stops short, and says the budget ran out once', async () => {
    const first = await shadowlap(work, ['tasks', 'score', '--model', 'claude-haiku-4-5', '--attempts', '2']);
    expect(first.code, first.out).toBe(0);
    const scored = () => withStore(db, (s) => s.listTaskScores().filter((x) => x.model === 'claude-haiku-4-5').map((x) => x.runId));
    const before = scored();
    expect(before).toHaveLength(2);
    // An attempt costs more than the budget: the second never starts.
    const cut = await shadowlap(work, ['tasks', 'score', '--model', 'claude-haiku-4-5', '--attempts', '2', '--budget', '0.001']);
    expect(cut.code).toBe(1);
    expect(cut.out.match(/the budget of \$0\.0010 is spent/g)).toHaveLength(1);
    expect(cut.out).toContain('refund-over-limit: kept the earlier score (0.33 over 2 attempts): this one stopped after 1 of 2');
    expect(scored()).toEqual(before);
  }, 120_000);

  it('refuses what can\'t be scored, and says why', async () => {
    const r = await shadowlap(work, ['tasks', 'score', 'goldens/budget', '--model', 'weak-model']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('skipped goldens/budget is not a task: its checks only cap tokens and cost');
    // Nothing answers at the endpoint: the first attempt runs alone and stops the task, whatever the concurrency.
    const down = await shadowlap(work, ['tasks', 'score', '--model', 'my-finetune', '--base-url', 'http://127.0.0.1:9/v1', '--attempts', '3', '--concurrency', '3']);
    expect(down.code).toBe(1);
    expect(down.out).toContain("my-finetune didn't answer #5");
    expect(down.out).toContain("isn't reachable");
    expect(down.out).toContain('✗ no attempt was scored');
    // Nothing new to see on the scores, so a dashboard job ends on its reason, with no link there.
    expect(down.events.filter((e) => e.type === 'link')).toEqual([]);
    expect(down.events.at(-1)).toMatchObject({ type: 'result', data: { model: 'my-finetune', mean: null } });
    withStore(db, (s) => {
      const stopped = s.allRuns().filter((x) => x.meta?.task?.baseUrl === 'http://127.0.0.1:9/v1');
      expect(stopped).toHaveLength(1);
      expect(stopped[0]!.meta?.task).toMatchObject({ model: 'my-finetune', attempt: 1, score: null, stopped: expect.stringContaining("my-finetune didn't answer #5") });
    });
    // An attempt that stopped is a scoring attempt still: pairs don't read it as a --repeat that failed.
    const pairs = await shadowlap(work, ['export', 'pairs']);
    expect(pairs.code, pairs.out).toBe(0);
    expect(pairs.out).toContain('from the store: 0 sources');

    // A golden packed straight from a capture can't start its agent: blocked, and refused before anything runs.
    cpSync(join(work, 'goldens', 'refund-over-limit'), join(work, 'goldens', 'captured'), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(work, 'goldens', 'captured', 'run.json'), 'utf8')) as { runs: Array<{ command: { argv: string[] } }> };
    manifest.runs.at(-1)!.command.argv = ['<no-recorded-command>'];
    writeFileSync(join(work, 'goldens', 'captured', 'run.json'), JSON.stringify(manifest));
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { ...TESTS, 'goldens/captured': { expect: { tools: { issue_refund: 0 } } } } }));
    try {
      const listed = JSON.parse((await shadowlap(work, ['tasks', '--json'])).stdout) as { tasks: Array<{ golden: string; status: string; note: string }> };
      expect(listed.tasks.find((t) => t.golden === 'goldens/captured')).toMatchObject({ status: 'blocked', note: expect.stringContaining('imported from a capture and has no command to run') });
      const runs = withStore(db, (s) => s.allRuns().length);
      const captured = await shadowlap(work, ['tasks', 'score', 'goldens/captured', '--model', 'weak-model', '--attempts', '1']);
      expect(captured.code).toBe(1);
      expect(captured.out).toContain('skipped goldens/captured is blocked: it was imported from a capture and has no command to run');
      expect(withStore(db, (s) => s.allRuns().length)).toBe(runs);
    } finally {
      rmSync(join(work, 'goldens', 'captured'), { recursive: true, force: true });
      writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: TESTS }));
    }
  }, 120_000);

  it('lists models to score with a price per attempt, and the scores they have', async () => {
    // A port below any the system hands out, which nothing listens on and fetch doesn't block: the OpenAI-compatible server isn't running.
    const r = await shadowlap(work, ['tasks', 'models', '--json'], { SHADOWLAP_UPSTREAM_ANTHROPIC: listsUrl, OLLAMA_HOST: listsUrl, SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:2', OPENAI_API_KEY: '' });
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
      const call = (path: string, init: { method?: string; body?: unknown; token?: string | null; host?: string; origin?: string } = {}) =>
        new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
          const u = new URL(path, url);
          const req = httpRequest(u, { method: init.method ?? 'GET', headers: { host: init.host ?? u.host, 'content-type': 'application/json', ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? token}` }), ...(init.origin ? { origin: init.origin } : {}) } }, (res) => {
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
      // A body over 64 KB gets its 413; a path that isn't percent-encoded right is a bad request.
      const big = await call('/v1/tasks/refund-over-limit/attempts', { method: 'POST', body: { model: 'm', pad: 'x'.repeat(100_000) } });
      expect(big).toMatchObject({ status: 413, body: { error: 'the request is over 64 KB' } });
      expect(await call('/v1/tasks/%E0%A4%A/attempts', { method: 'POST', body: { model: 'm' } })).toMatchObject({ status: 400, body: { error: expect.stringContaining('percent-encoded') } });

      expect((await call('/v1/tasks', { token: null })).status).toBe(401);
      expect((await call('/v1/tasks', { token: 'wrong' })).status).toBe(401);
      expect((await call('/v1/tasks', { host: 'evil.example:80' })).status).toBe(403);
      // Only the health check answers without the token; nothing answers a web page, token or not.
      expect(await call('/v1/health', { token: null })).toEqual({ status: 200, body: { ok: true } });
      expect(await call('/v1/tasks', { origin: 'https://evil.example' })).toEqual({ status: 403, body: { error: 'requests from web pages are refused' } });
      expect((await call('/v1/tasks/refund-over-limit/attempts', { method: 'POST', body: { model: 'weak-model' }, origin: `${url}` })).status).toBe(403);
      // A takeover asked at a call that isn't a model call is refused before anything runs.
      expect(await call('/v1/tasks/refund-over-limit/attempts', { method: 'POST', body: { model: 'weak-model', from: 2 } })).toMatchObject({ status: 409, body: { error: "#2 is not a model call of goldens/refund-over-limit's run (lookup_order)" } });
      expect((await call('/v1/tasks/nope/attempts', { method: 'POST', body: { model: 'm' } })).status).toBe(404);
      expect(await call('/v1/tasks/budget/attempts', { method: 'POST', body: { model: 'm' } })).toMatchObject({ status: 409, body: { status: 'not-a-task' } });
      expect((await call('/v1/tasks/refund-over-limit/attempts', { method: 'POST', body: { baseUrl: 'x' } })).status).toBe(400);
      // A request can't send a key from the environment to an address it picks.
      expect(await call('/v1/tasks/refund-over-limit/attempts', { method: 'POST', body: { model: 'm', baseUrl: 'https://elsewhere.example/v1', keyEnv: 'ANTHROPIC_API_KEY' } })).toMatchObject({ status: 400, body: { error: expect.stringContaining('--key-env') } });
      // A training loop's attempts are runs, but not a model's scores.
      withStore(db, (s) => {
        expect(s.listTaskScores().filter((x) => x.model === 'my-finetune')).toHaveLength(2);
        expect(s.getRun(attempt.body.run as string)!.meta?.task).toMatchObject({ model: 'my-finetune', session: expect.stringMatching(/^serve-/) });
      });
    } finally {
      child.kill('SIGTERM');
    }
  }, 120_000);
  // Last: it adds a model's scores, which the tests above count.
  it('takes the project folder for every golden in it', async () => {
    const r = await shadowlap(work, ['tasks', 'score', '.', '--model', 'gpt-small', '--base-url', `${openai.url}/v1`, '--attempts', '1']);
    expect(r.out).not.toContain('is not a golden');
    expect(r.out).toContain('▸ refund-over-limit · #1–#4 replayed · gpt-small from #5');
    expect(r.out).toContain('skipped goldens/budget is not a task: its checks only cap tokens and cost');
    // A golden that isn't a task was skipped, so not every task named was scored.
    expect(r.code).toBe(1);
  }, 120_000);
});

describe("a task whose golden's run id the store holds as another recording", () => {
  let work = '';
  let pack = '';
  const TESTS = { 'goldens/refund-over-limit': { expect: { tools: { issue_refund: 0, escalate: 1 } }, task: { takeover: 5, why: 'decides between refunding and escalating', rewards: 'escalate above the limit' } } };

  beforeAll(async () => {
    policy = 'models';
    ({ work } = workdir('sl-tasks-held-'));
    const golden = await record(work, [AGENT, '--stream']);
    const r = await shadowlap(work, ['pack', golden, 'goldens/refund-over-limit']);
    expect(r.code, r.out).toBe(0);
    pack = join(work, 'goldens', 'refund-over-limit');
  }, 60_000);
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /**
   * A project whose store holds the golden's run id as a copy edited by `edit` (as a pull request's
   * folder or a pack someone sent brings it), next to the golden itself.
   */
  async function heldElsewhere(edit: (copy: string) => void): Promise<{ work: string; db: string }> {
    const other = workdir('sl-tasks-copy-');
    const sent = join(other.work, 'sent');
    cpSync(pack, sent, { recursive: true });
    edit(sent);
    const u = await shadowlap(other.work, ['unpack', 'sent']);
    expect(u.code, u.out).toBe(0);
    cpSync(pack, join(other.work, 'goldens', 'refund-over-limit'), { recursive: true });
    writeFileSync(join(other.work, 'shadowlap.config.json'), JSON.stringify({ tests: TESTS }));
    return other;
  }
  const editRun = (dir: string, fn: (run: { command: { argv: string[] } }) => void) => {
    const m = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<{ command: { argv: string[] } }> };
    fn(m.runs.at(-1)!);
    writeFileSync(join(dir, 'run.json'), JSON.stringify(m));
  };

  it("scores the golden's own command, never the command of the store's copy", async () => {
    const argv = (JSON.parse(readFileSync(join(pack, 'run.json'), 'utf8')) as { runs: Array<{ command: { argv: string[] } }> }).runs.at(-1)!.command.argv;
    const other = await heldElsewhere((sent) => editRun(sent, (run) => (run.command.argv = ['sh', '-c', 'echo ran the copy command > PWNED.txt'])));
    try {
      const r = await shadowlap(other.work, ['tasks', 'score', 'goldens/refund-over-limit', '--model', 'weak-model', '--attempts', '1']);
      expect(r.code, r.out).toBe(0);
      expect(existsSync(join(other.work, 'PWNED.txt'))).toBe(false);
      withStore(other.db, (s) => {
        const [row] = s.listTaskScores();
        expect(s.getRun(row!.runId!)!.command.argv).toEqual(argv);
      });
    } finally {
      rmSync(other.work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);

  it("refuses to score it when the store's copy holds other calls, and runs nothing", async () => {
    const other = await heldElsewhere((sent) => {
      editRun(sent, (run) => (run.command.argv = ['sh', '-c', 'echo ran the copy command > PWNED.txt']));
      const lines = readFileSync(join(sent, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { fingerprint: string });
      lines[0]!.fingerprint = 'f'.repeat(64);
      writeFileSync(join(sent, 'calls.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    });
    try {
      const runs = withStore(other.db, (s) => s.allRuns().length);
      const r = await shadowlap(other.work, ['tasks', 'score', 'goldens/refund-over-limit', '--model', 'weak-model', '--attempts', '1']);
      expect(r.code).toBe(1);
      expect(r.out).toContain("the store already holds another recording under this golden's run id");
      expect(existsSync(join(other.work, 'PWNED.txt'))).toBe(false);
      expect(withStore(other.db, (s) => s.allRuns().length)).toBe(runs);
    } finally {
      rmSync(other.work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

describe('shadowlap tasks serve, started with an endpoint', () => {
  it('asks it for requests that name none, sends its key there and nowhere else, and refuses a short token', async () => {
    policy = 'models';
    const { work } = workdir('sl-serve-');
    try {
      const runId = await record(work, [AGENT]);
      expect((await shadowlap(work, ['pack', runId, 'goldens/refund'])).code).toBe(0);
      writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund': { expect: { tools: { issue_refund: 0 } }, task: { takeover: 5 } } } }));
      // Refused before it listens: a token anyone could guess, and a key with no endpoint of its own.
      const short = await shadowlap(work, ['tasks', 'serve'], { SHADOWLAP_TASKS_TOKEN: 'short' });
      expect(short.code).not.toBe(0);
      expect(short.out).toContain('SHADOWLAP_TASKS_TOKEN must be at least 16 characters');
      const keyed = await shadowlap(work, ['tasks', 'serve', '--key-env', 'TRAIN_KEY']);
      expect(keyed.code).not.toBe(0);
      expect(keyed.out).toContain('--key-env needs --base-url');

      const token = 'tok-' + 'y'.repeat(20);
      const child = spawn(process.execPath, [CLI, 'tasks', 'serve', '--base-url', `${openai.url}/v1`, '--key-env', 'TRAIN_KEY'], { cwd: work, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_TASKS_TOKEN: token, TRAIN_KEY: 'train-secret', AGENT_OUTBOX: join(work, 'outbox.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
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
        const attempt = (body: unknown) =>
          new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
            const u = new URL('/v1/tasks/refund/attempts', url);
            const req = httpRequest(u, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (res) => {
              let data = '';
              res.on('data', (d: Buffer) => (data += d.toString()));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> }));
            });
            req.on('error', reject);
            req.end(JSON.stringify(body));
          });
        const before = openai.requests.length;
        const own = await attempt({ model: 'my-finetune' });
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        expect(own.body).toMatchObject({ model: 'my-finetune', score: 1 });
        const mine = openai.requests.slice(before);
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.every((r) => r.headers.authorization === 'Bearer train-secret')).toBe(true);
        // The same server under another name is another origin: it is asked, without the key.
        const elsewhere = openai.requests.length;
        const other = await attempt({ model: 'my-finetune', baseUrl: `${openai.url.replace('127.0.0.1', 'localhost')}/v1` });
        expect(other.status, JSON.stringify(other.body)).toBe(200);
        const theirs = openai.requests.slice(elsewhere);
        expect(theirs.length).toBeGreaterThan(0);
        expect(theirs.every((r) => r.headers.authorization === undefined)).toBe(true);
      } finally {
        const gone = new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(null) : child.once('exit', resolve)));
        child.kill('SIGTERM');
        // Gone before its folder is removed: Windows keeps a folder a process still holds open.
        await gone;
      }
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

describe('a golden that asks its providers more than its model', () => {
  it('scores the model under test from the takeover, whatever the agent asked first: a model list, an embedding, token counts', async () => {
    policy = 'models';
    const { work, db } = workdir('sl-rag-');
    const front = await startFront();
    const env = { SHADOWLAP_UPSTREAM_ANTHROPIC: front.url, SHADOWLAP_UPSTREAM_OPENAI: front.url };
    try {
      const runId = await record(work, [AGENT, '--list-models', '--embed', '--count-tokens'], env);
      expect((await shadowlap(work, ['pack', runId, 'goldens/rag'], env)).code).toBe(0);
      const recorded = withStore(db, (s) => s.getCalls(runId));
      expect(recorded.slice(0, 4).map((c) => c.name)).toEqual(['GET /v1/models', 'POST /v1/embeddings', 'POST /v1/messages/count_tokens', 'POST /v1/messages']);
      // The decision is the third message; its number counts the calls that asked no model too.
      const decision = recorded.filter((c) => c.name === 'POST /v1/messages')[2]!.callNo;
      expect(decision).toBe(10);
      writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/rag': { expect: { tools: { issue_refund: 0, escalate: 1 } }, task: { takeover: decision } } } }));

      // Another model of the recording's provider answers the decision, and refunds.
      front.counted.length = 0;
      const same = await shadowlap(work, ['tasks', 'score', '--model', 'weak-model', '--attempts', '1'], env);
      expect(same.code, same.out).toBe(0);
      expect(same.out).toContain('▸ rag · #1–#9 replayed · weak-model from #10');
      expect(same.out).toMatch(/ 1 · ✓ the agent exits 0 · ✗ issue_refund called 0 times · ✗ escalate called 1 time · 0\.33/);
      // The token count after the takeover still named the model the agent asked, which the provider knows.
      expect(front.counted).toEqual(['small-model']);
      withStore(db, (s) => {
        const [row] = s.listTaskScores();
        const calls = s.getCalls(row!.runId!);
        expect(calls.find((c) => c.callNo === decision)!.end!.meta).toMatchObject({ model: 'weak-model', headers: expect.objectContaining({ 'x-shadowlap-model': 'weak-model' }) });
        expect(calls.filter((c) => c.callNo < decision).every((c) => c.origin === 'replayed')).toBe(true);
        expect(calls.find((c) => c.name === 'POST /v1/messages/count_tokens' && c.callNo > decision)!.end!.meta.model).toBe('small-model');
      });

      // A model at an OpenAI-compatible endpoint: the decision is translated for it, the token count goes to Anthropic as it was.
      front.counted.length = 0;
      const translated = await shadowlap(work, ['tasks', 'score', '--model', 'my-finetune', '--base-url', `${openai.url}/v1`, '--attempts', '1', '--json'], env);
      expect(translated.code, translated.out).toBe(0);
      expect(JSON.parse(translated.stdout)).toMatchObject({ mean: 1, spent: 0, tasks: [{ task: 'goldens/rag', takeover: decision, replayed: 9, stopped: null }] });
      expect(front.counted).toEqual(['small-model']);
    } finally {
      await front.close();
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

      // Another model of OpenAI's: the request names it, and its chunks stream back to the agent as OpenAI sent them.
      const sent = openai.requests.length;
      const weak = await shadowlap(work, ['tasks', 'score', '--model', 'weak-model', '--attempts', '1', '--json']);
      expect(weak.code, weak.out).toBe(0);
      expect(JSON.parse(weak.stdout)).toMatchObject({ mean: 0.5, via: 'OpenAI API', tasks: [{ attempts: [{ checks: [{ pass: true }, { check: 'issue_refund called 0 times', pass: false }] }] }] });
      expect(openai.requests.slice(sent).map((r) => [r.body.model, r.body.stream])).toEqual([
        ['weak-model', true],
        ['weak-model', true],
      ]);
      withStore(db, (s) => {
        const row = s.listTaskScores().find((x) => x.model === 'weak-model')!;
        expect(s.getCalls(row.runId!).find((c) => c.callNo === 5)!.end!.meta).toMatchObject({ model: 'weak-model', provider: 'openai', stopReason: 'tool_calls', headers: expect.objectContaining({ 'content-type': expect.stringContaining('text/event-stream') }) });
      });
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

describe('Training in the dashboard', () => {
  /**
   * `shadowlap dashboard` in the project, asking the mocks, as a person starts it there. It keeps its
   * list of projects in the test's own SHADOWLAP_HOME, never in the real ~/.shadowlap.
   */
  function startDashboardCommand(work: string): Promise<{ child: ChildProcess; url: string; token: string }> {
    const env = { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url, SHADOWLAP_UPSTREAM_OPENAI: openai.url, ANTHROPIC_API_KEY: 'test-key', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(work, '.sl-home'), AGENT_OUTBOX: join(work, 'outbox.jsonl') };
    const child = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '--port', String(40_000 + Math.floor(Math.random() * 20_000))], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`no link printed: ${text}`)), 20_000);
      const on = (c: Buffer) => {
        text += c.toString();
        const m = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]+)/.exec(text);
        if (!m) return;
        clearTimeout(timer);
        resolve({ child, url: m[1]!, token: m[2]! });
      };
      child.stderr!.on('data', on);
      child.stdout!.on('data', on);
    });
  }

  interface Job {
    id: string;
    title: string;
    done: boolean;
    code: number | null;
    links: Array<{ label: string; href: string }>;
    files: Array<{ fileId: string; name: string; path: string }>;
    result: Record<string, unknown> | null;
  }

  it('exports pairs and scores a model as jobs: the file downloads, and the page shows the new scores', async () => {
    policy = 'alternate';
    decisions = 0;
    const { work } = workdir('sl-dash-training-');
    let dash: Awaited<ReturnType<typeof startDashboardCommand>> | null = null;
    try {
      // A failure blame rescues, for a pair; then a golden that escalates, for a task.
      const lost = await record(work, [AGENT]);
      expect((await shadowlap(work, ['blame', lost, '--expect', ORACLE, '--attempts', '3', '--passes', '1'])).code).toBe(0);
      policy = 'models';
      const good = await record(work, [AGENT]);
      expect((await shadowlap(work, ['pack', good, 'goldens/refund-over-limit'])).code).toBe(0);
      writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund-over-limit': { expect: { tools: { issue_refund: 0, escalate: 1 } }, task: { takeover: 5, rewards: 'escalate above the limit' } } } }));

      dash = await startDashboardCommand(work);
      const { url, token } = dash;
      const api = (path: string, init: RequestInit = {}) => fetch(`${url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': token, 'content-type': 'application/json' } });
      const runJob = async (body: Record<string, unknown>): Promise<Job> => {
        const res = await api('jobs', { method: 'POST', body: JSON.stringify(body) });
        expect(res.status, await res.clone().text()).toBe(202);
        let job = (await res.json()) as Job;
        for (let i = 0; i < 1200 && !job.done; i++) {
          await new Promise((r) => setTimeout(r, 50));
          job = (await (await api(`jobs/${job.id}`)).json()) as Job;
        }
        return job;
      };

      // Export pairs: written into the project's exports folder, and offered for download.
      const exported = await runJob({ kind: 'pairs', format: 'openai-preference', minConfidence: 'high' });
      expect(exported).toMatchObject({ done: true, code: 0, title: 'Exporting pairs', links: [], result: expect.objectContaining({ pairs: 1, file: '.shadowlap/exports/pairs.jsonl' }) });
      expect(exported.files).toMatchObject([{ name: 'pairs.jsonl', path: '.shadowlap/exports/pairs.jsonl' }]);
      const download = await api(`files/${exported.files[0]!.fileId}`);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toContain('pairs.jsonl');
      expect(await download.text()).toBe(readFileSync(join(work, '.shadowlap', 'exports', 'pairs.jsonl'), 'utf8'));

      // Score a model: every ready task, 5 attempts, against the mock; the drawer links to the scores.
      const scored = await runJob({ kind: 'score', model: 'claude-good', attempts: 5 });
      expect(scored).toMatchObject({ done: true, code: 0, title: 'Scoring a model', links: [{ label: 'Open the scores', href: '#/training/tasks' }] });

      const view = (await (await api('training')).json()) as {
        strip: { left: { value: string; file: string | null }; best: { value: string } };
        tasks: { rows: Array<{ name: string; status: { key: string }; takeover: number | null }> };
        scores: { cards: Array<{ model: string; mean: number | null }>; rows: Array<{ cells: Array<{ pips: Array<{ href: string | null }> } | null> }> };
      };
      expect(view.strip.left).toMatchObject({ value: '1', file: '.shadowlap/exports/pairs.jsonl' });
      expect(view.tasks.rows.map((r) => [r.name, r.status.key, r.takeover])).toEqual([['refund-over-limit', 'ready', 5]]);
      expect(view.scores.cards.map((c) => [c.model, c.mean])).toEqual([['claude-good', 1]]);
      expect(view.strip.best.value).toBe('1.00');
      // Each pip opens its attempt's run.
      const pips = view.scores.rows[0]!.cells[0]!.pips;
      expect(pips).toHaveLength(5);
      expect(pips.every((p) => /^#\/run\/\w{26}$/.test(p.href ?? ''))).toBe(true);
      const activity = (await (await api('activity')).json()) as { items: Array<{ kind: string; text: string }> };
      expect(activity.items.filter((i) => i.kind === 'train').map((i) => i.text)).toEqual(['Scored claude-good on 1 task · mean 1.00', 'Exported 1 preference pair']);
    } finally {
      if (dash) {
        const exited = new Promise((r) => dash!.child.once('exit', r));
        dash.child.kill('SIGTERM');
        await exited;
      }
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 180_000);
});
