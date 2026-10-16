import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect as connectHttp2 } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerAs, chatCompletionOf, chatShapeOf, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { startMockOpenAI, toolCall, turn, type MockServer as OpenAIServer, type ScriptContext as OpenAIContext } from '@shadowlap-testing/mock-openai';
import { resolveTarget, startTakeover } from '../src/takeover.js';

/**
 * Scoring on a cloud's recording (E8): the support agent recorded on Azure OpenAI, OpenAI's Responses
 * API, the Gemini API, Vertex AI (Gemini and Claude) and Amazon Bedrock (Claude and the Converse API), each golden then
 * taken over at its decision by a model at an OpenAI-compatible endpoint or by Anthropic's API. The
 * conversation is translated for the model and its answer back into the cloud's own API, streamed as
 * the agent asked, and the agent goes on as if its cloud had answered. The recorded model refunds the
 * $240 order; "my-finetune" and "claude-good" escalate it, as policy says.
 */

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./training-cloud-agent.mjs', import.meta.url));
const GOOD = new Set(['my-finetune', 'claude-good']);

/** What the support agent does at each turn: look up, read the policy, decide, then say so. */
function step(turns: number, good: boolean): { text: string | null; call: [string, Record<string, unknown>] | null } {
  if (turns === 0) return { text: 'Looking the order up.', call: ['lookup_order', { order_id: 'A-1042' }] };
  if (turns === 1) return { text: null, call: ['read_policy', {}] };
  if (turns === 2) return good ? { text: 'Above the limit.', call: ['escalate', { reason: 'refund of $240 is above $100' }] } : { text: 'Issuing the refund.', call: ['issue_refund', { order_id: 'A-1042', amount: 240 }] };
  return { text: good ? 'Escalated to a manager.' : 'Refunded $240.', call: null };
}

let openai: OpenAIServer;
let anthropic: MockServer;
let cloud: Server;
let cloudUrl = '';
const cloudAsked: string[] = [];

/** How many turns the model already had in a request of each shape. */
function assistantTurns(path: string, body: Record<string, unknown>): number {
  // The Responses API keeps the model's turns as items: each of this agent's turns calls one tool.
  if (Array.isArray(body.input)) return (body.input as Array<{ type?: string }>).filter((i) => i.type === 'function_call').length;
  const list = (Array.isArray(body.messages) ? body.messages : Array.isArray(body.contents) ? body.contents : []) as Array<{ role?: string }>;
  return list.filter((m) => m.role === 'assistant' || m.role === 'model').length;
}

beforeAll(async () => {
  openai = await startMockOpenAI({
    script: (ctx: OpenAIContext) => {
      const s = step(ctx.assistantTurns, GOOD.has(ctx.request.model));
      return { turn: turn(s.text, s.call ? { tool_calls: [toolCall(s.call[0], s.call[1])] } : {}) };
    },
  });
  anthropic = await startMockAnthropic({
    eventDelayMs: () => 0,
    script: (ctx: ScriptContext) => {
      const s = step(ctx.assistantTurns, GOOD.has(ctx.request.model));
      return { message: message([...(s.text ? [text(s.text)] : []), ...(s.call ? [toolUse(s.call[0], s.call[1], `toolu_${s.call[0]}_${ctx.requestNo}`)] : [])], s.call ? {} : { stop_reason: 'end_turn' }) };
    },
  });
  // The clouds the recordings were made on: one server answering each cloud's API in its own shape, as the recorded model.
  cloud = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://cloud');
      const path = url.pathname;
      const provider = path.includes('/openai/deployments/') ? 'azure' : path.endsWith('/responses') ? 'openai' : path.startsWith('/model/') ? 'bedrock' : path.includes('/publishers/') ? 'vertex' : 'gemini';
      const shape = chatShapeOf(provider, `POST ${path}`);
      cloudAsked.push(`${provider} ${path}`);
      if (!shape) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: `no route ${path}` }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      const s = step(assistantTurns(path, body), false);
      const completion = chatCompletionOf({ id: `rec-${cloudAsked.length}`, choices: [{ message: { role: 'assistant', content: s.text, ...(s.call ? { tool_calls: [{ id: `call_${s.call[0]}_${cloudAsked.length}`, type: 'function', function: { name: s.call[0], arguments: JSON.stringify(s.call[1]) } }] } : {}) }, finish_reason: s.call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 20 } }, { model: 'the-recorded-model' });
      const stream = /converse-stream|invoke-with-response-stream|streamRawPredict|streamGenerateContent/.test(path) || body.stream === true;
      const a = answerAs(provider, shape, completion, { model: 'the-recorded-model', stream, search: url.search, request: body });
      res.writeHead(200, { 'content-type': a.contentType, 'content-length': String(a.body.length) });
      res.end(a.body);
    });
  });
  await new Promise<void>((resolve) => cloud.listen(0, '127.0.0.1', resolve));
  cloudUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await openai?.close();
  await anthropic?.close();
  await new Promise<void>((resolve) => cloud.close(() => resolve()));
});

interface Result {
  code: number | null;
  out: string;
  stdout: string;
}

function shadowlap(work: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: work,
      env: {
        ...process.env,
        SHADOWLAP_UPSTREAM_AZURE: cloudUrl,
        SHADOWLAP_UPSTREAM_VERTEX: cloudUrl,
        SHADOWLAP_UPSTREAM_BEDROCK: cloudUrl,
        SHADOWLAP_UPSTREAM_GEMINI: cloudUrl,
        SHADOWLAP_UPSTREAM_OPENAI: cloudUrl,
        SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url,
        ANTHROPIC_API_KEY: 'test-key',
        SHADOWLAP_TELEMETRY: '0',
        NO_COLOR: '1',
        SHADOWLAP_GUARD: 'off',
        AGENT_OUTBOX: join(work, 'outbox.jsonl'),
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
    });
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out, stdout }));
  });
}

/** Records the agent on one cloud's API and packs the run as a golden whose task takes over at the decision (#5). */
async function golden(work: string, api: string, stream: boolean): Promise<string> {
  const r = await shadowlap(work, ['run', '--', process.execPath, AGENT, api, ...(stream ? ['--stream'] : [])]);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Refunded $240.');
  const runId = /recording run (\w{26})/.exec(r.out)![1]!;
  expect((await shadowlap(work, ['pack', runId, `goldens/${api}`])).code).toBe(0);
  writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { [`goldens/${api}`]: { expect: { tools: { issue_refund: 0 } }, task: { takeover: 5 } } } }));
  return runId;
}

function withStore<T>(db: string, fn: (s: Store) => T): T {
  const s = Store.open(db);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

const CASES: Array<{ api: string; stream: boolean; provider: string }> = [
  { api: 'azure', stream: true, provider: 'azure' },
  { api: 'openai-responses', stream: true, provider: 'openai' },
  { api: 'openai-responses', stream: false, provider: 'openai' },
  { api: 'gemini', stream: true, provider: 'gemini' },
  { api: 'vertex-gemini', stream: false, provider: 'vertex' },
  { api: 'vertex-claude', stream: true, provider: 'vertex' },
  { api: 'bedrock-claude', stream: true, provider: 'bedrock' },
  { api: 'bedrock-converse', stream: true, provider: 'bedrock' },
  { api: 'bedrock-converse', stream: false, provider: 'bedrock' },
];

describe('a cloud recording scored with a model at your own endpoint', () => {
  for (const c of CASES) {
    it(`takes over ${c.api}${c.stream ? ', streamed' : ''}: the model answers in the cloud's own API, and the agent goes on`, async () => {
      const work = mkdtempSync(join(tmpdir(), `sl-cloud-${c.api}-`));
      try {
        await golden(work, c.api, c.stream);
        const r = await shadowlap(work, ['tasks', 'score', '--model', 'my-finetune', '--base-url', `${openai.url}/v1`, '--attempts', '1']);
        expect(r.code, r.out).toBe(0);
        expect(r.stdout).toMatch(/✓ my-finetune · mean 1\.00 · 1 attempt on 1 task/);
        withStore(join(work, '.shadowlap', 'shadowlap.db'), (s) => {
          const [row] = s.listTaskScores();
          const calls = s.getCalls(row!.runId!);
          // The takeover call is the model under test's, recorded as the cloud's call it answered.
          const decision = calls.find((x) => x.callNo === 5)!;
          expect(decision.origin).toBe('live');
          expect(decision.end!.meta).toMatchObject({ provider: c.provider, model: 'my-finetune' });
          // The agent escalated, and the write was stubbed after the takeover.
          expect(calls.filter((x) => x.kind === 'tool').map((x) => x.name)).toEqual(['lookup_order', 'read_policy', 'escalate']);
        });
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }, 30_000);
  }
});

describe('a cloud recording scored with Anthropic\'s API', () => {
  it('asks Claude on Bedrock of Anthropic\'s API in the same shape, and Bedrock\'s Converse API translated', async () => {
    const work = mkdtempSync(join(tmpdir(), 'sl-cloud-anthropic-'));
    try {
      await golden(work, 'bedrock-claude', true);
      const before = anthropic.requests.length;
      let r = await shadowlap(work, ['tasks', 'score', '--model', 'anthropic:claude-good', '--attempts', '1']);
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toMatch(/✓ claude-good · mean 1\.00/);
      // The cloud's version field is gone, and the model named.
      const first = anthropic.requests[before]!;
      expect(first.headers['x-api-key']).toBe('test-key');
      expect(first.body).toMatchObject({ model: 'claude-good', stream: false });
      expect(first.body).not.toHaveProperty('anthropic_version');

      await golden(work, 'bedrock-converse', false);
      r = await shadowlap(work, ['tasks', 'score', 'goldens/bedrock-converse', '--model', 'anthropic:claude-good', '--attempts', '1']);
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toMatch(/✓ claude-good · mean 1\.00/);

      // OpenAI's Responses API, streamed, answered by Anthropic's API through chat completions.
      await golden(work, 'openai-responses', true);
      r = await shadowlap(work, ['tasks', 'score', 'goldens/openai-responses', '--model', 'anthropic:claude-good', '--attempts', '1']);
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toMatch(/✓ claude-good · mean 1\.00/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses another model of the cloud itself before anything runs, and says what does work', async () => {
    const work = mkdtempSync(join(tmpdir(), 'sl-cloud-same-'));
    try {
      await golden(work, 'azure', false);
      const asked = cloudAsked.length;
      const r = await shadowlap(work, ['tasks', 'score', '--model', 'gpt-other', '--attempts', '1']);
      expect(r.code).toBe(1);
      expect(r.out).toContain("goldens/azure can't be scored with gpt-other: its takeover call goes through Azure OpenAI, where the deployment in the URL picks the model: score Anthropic's or OpenAI's API, or a model at your own endpoint, instead");
      expect(cloudAsked.length).toBe(asked);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('the model a cloud recording used', () => {
  it('is scored on that recording as the agent asked it, its deployment or signed URL unchanged', async () => {
    const work = mkdtempSync(join(tmpdir(), 'sl-cloud-recorded-'));
    try {
      for (const [api, model, path] of [
        ['bedrock-converse', 'amazon.nova-pro-v1:0', 'bedrock /model/amazon.nova-pro-v1%3A0/converse'],
        ['azure', 'gpt-prod', 'azure /openai/deployments/gpt-prod/chat/completions'],
      ] as const) {
        await golden(work, api, false);
        const asked = cloudAsked.length;
        const r = await shadowlap(work, ['tasks', 'score', `goldens/${api}`, '--model', model, '--attempts', '1']);
        expect(r.code, r.out).toBe(0);
        // The recorded model refunds the $240 order: the agent exits 0, but issue_refund was called.
        expect(r.stdout, r.out).toContain(`✓ ${model} · mean 0.50 · 1 attempt on 1 task`);
        // Its decision went to the cloud as the agent made it, the model in its path as recorded.
        expect(cloudAsked.slice(asked)).toContain(path);
        withStore(join(work, '.shadowlap', 'shadowlap.db'), (s) => {
          const row = s.listTaskScores().find((x) => x.model === model)!;
          const decision = s.getCalls(row.runId!).find((x) => x.callNo === 5)!;
          expect(decision.origin).toBe('live');
          // The answer is the model under test's, and says so.
          expect(decision.end!.meta.headers?.['x-shadowlap-model']).toBe(model);
        });
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the models to score a project recorded on two clouds', () => {
  it('score each recorded model on its own recording, and say from its own provider why it can\'t answer the others', async () => {
    const work = mkdtempSync(join(tmpdir(), 'sl-cloud-models-'));
    try {
      const apis = ['azure', 'bedrock-claude', 'bedrock-converse'];
      for (const api of apis) await golden(work, api, false);
      writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: Object.fromEntries(apis.map((api) => [`goldens/${api}`, { expect: { tools: { issue_refund: 0 } }, task: { takeover: 5 } }])) }));
      // The model lists come from the mock and a port nothing answers: no provider of this machine's is asked.
      const env = { ANTHROPIC_BASE_URL: anthropic.url, OLLAMA_HOST: '127.0.0.1:1', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' };
      const r = await shadowlap(work, ['tasks', 'models', '--timeout', '200'], env);
      expect(r.code, r.out).toBe(0);
      const line = (model: string) => r.stdout.split('\n').find((l) => l.includes(model)) ?? '';
      // Each cloud's recorded model answers its own recording: nothing there is switched.
      for (const model of ['gpt-prod', 'anthropic.claude-sonnet-5-v1:0', 'amazon.nova-pro-v1:0']) expect(line(model), r.stdout).toContain('on 1 of 3 tasks');
      const json = JSON.parse((await shadowlap(work, ['tasks', 'models', '--json', '--timeout', '200'], env)).stdout) as { choices: Array<{ id: string; reach: { tasks: string[]; refused: Array<{ golden: string; why: string; elsewhere: boolean }> } }> };
      const claude = json.choices.find((c) => c.id === 'anthropic.claude-sonnet-5-v1:0')!;
      expect(claude.reach.tasks).toEqual(['goldens/bedrock-claude']);
      // The other Bedrock task can't switch to it (Bedrock signs the model into the URL); Azure's was recorded elsewhere.
      expect(claude.reach.refused).toEqual([
        expect.objectContaining({ golden: 'goldens/azure', elsewhere: true }),
        expect.objectContaining({ golden: 'goldens/bedrock-converse', elsewhere: false, why: expect.stringContaining('request signature covers the model in its URL') }),
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the takeover upstream over HTTP/2', () => {
  it('answers a request that arrives over HTTP/2, as an AWS SDK sends it, and one over HTTP/1.1 alike', async () => {
    const t = await startTakeover({ provider: 'bedrock', shape: 'converse', mode: 'to-openai' }, resolveTarget({ model: 'my-finetune', baseUrl: `${openai.url}/v1` }), { env: {} });
    const body = JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'The customer asks for a refund on order A-1042.' }] }], toolConfig: { tools: [{ toolSpec: { name: 'lookup_order', inputSchema: { json: { type: 'object' } } } }] } });
    const base = new URL(t.url);
    try {
      const session = connectHttp2(base.origin);
      const answer = await new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
        const stream = session.request({ ':method': 'POST', ':path': `${base.pathname}/model/amazon.nova-pro-v1%3A0/converse`, 'content-type': 'application/json' });
        let status = 0;
        let type = '';
        const chunks: Buffer[] = [];
        stream.on('response', (h) => {
          status = Number(h[':status']);
          type = String(h['content-type']);
        });
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve({ status, type, body: Buffer.concat(chunks).toString('utf8') }));
        stream.on('error', reject);
        stream.end(body);
      });
      session.close();
      expect(answer.status).toBe(200);
      expect(answer.type).toBe('application/json');
      expect(JSON.parse(answer.body)).toMatchObject({ stopReason: 'tool_use', output: { message: { content: [{ text: 'Looking the order up.' }, { toolUse: { name: 'lookup_order', input: { order_id: 'A-1042' } } }] } } });
      const h1 = await fetch(`${t.url}/model/amazon.nova-pro-v1%3A0/converse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(h1.status).toBe(200);
      expect(((await h1.json()) as { stopReason: string }).stopReason).toBe('tool_use');
      expect(t.answered).toBe(2);
    } finally {
      await t.close();
    }
  });
});
