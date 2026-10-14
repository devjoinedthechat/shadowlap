import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { tool } from '@shadowlap/sdk';
import { startMockOpenAI, toolCall, turn, type MockServer } from '@shadowlap-testing/mock-openai';
import { Sidecar } from '../src/index.js';

/**
 * The OpenAI-compatible path end to end: the official `openai` SDK (streaming Chat Completions with
 * tool calls) → sidecar → scripted mock. Record, clean replay, fork with the write fenced.
 * The same route serves Ollama, vLLM, OpenRouter and other OpenAI-compatible servers.
 */

const TURNS = [
  turn('Let me look that up.', { tool_calls: [toolCall('search_web', { query: 'shadowlap' })] }),
  turn(null, { tool_calls: [toolCall('send_email', { to: 'team@example.com', body: 'summary' })] }),
  turn('Done: replay works for OpenAI-compatible APIs too.'),
];

let mock: MockServer;
let store: Store;
let sidecar: Sidecar;
let client: OpenAI;
let sent = 0;

const searchWeb = tool('search_web', { effect: 'read' }, async ({ query }: { query: string }) => ({ results: [`${query} #1`, `${query} #2`] }));
const sendEmail = tool('send_email', { effect: 'write' }, async ({ to }: { to: string }) => {
  sent++;
  return { sent: true, to };
});

interface AgentResult {
  finalText: string;
  modelCalls: number;
  toolErrors: string[];
}

async function runAgent(system: string): Promise<AgentResult> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: 'Research Shadowlap and email the team.' },
  ];
  const tools: OpenAI.ChatCompletionTool[] = [
    { type: 'function', function: { name: 'search_web', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
    { type: 'function', function: { name: 'send_email', parameters: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } } } },
  ];
  let modelCalls = 0;
  const toolErrors: string[] = [];
  for (let i = 0; i < 10; i++) {
    const stream = await client.chat.completions.create({ model: 'gpt-mock', messages, tools, stream: true, stream_options: { include_usage: true } });
    modelCalls++;
    let content = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      content += choice.delta.content ?? '';
      for (const tc of choice.delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        cur.args += tc.function?.arguments ?? '';
        calls.set(tc.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (finish !== 'tool_calls' || calls.size === 0) return { finalText: content, modelCalls, toolErrors };
    const toolCalls = [...calls.values()];
    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) });
    for (const c of toolCalls) {
      const args = JSON.parse(c.args) as never;
      try {
        const result = c.name === 'search_web' ? await searchWeb(args) : await sendEmail(args);
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
      } catch (err) {
        toolErrors.push(`${c.name}: ${(err as Error).name}`);
        messages.push({ role: 'tool', tool_call_id: c.id, content: `error: ${(err as Error).message}` });
      }
    }
  }
  throw new Error('agent did not finish');
}

beforeAll(async () => {
  mock = await startMockOpenAI({ script: (ctx) => ({ turn: TURNS[ctx.assistantTurns] ?? turn('(no scripted turn)') }) });
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store, upstreams: { openai: mock.url } });
  client = new OpenAI({ apiKey: 'sk-test', baseURL: sidecar.envFor().OPENAI_BASE_URL, maxRetries: 2 });
});

afterAll(async () => {
  await sidecar.close();
  await mock.close();
  store.close();
});

describe('OpenAI-compatible provider', () => {
  let parent: string;

  it('records a streaming tool-calling run', async () => {
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    process.env.SHADOWLAP_URL = sidecar.url;
    process.env.SHADOWLAP_RUN_ID = run.runId;
    const result = await runAgent('You are helpful.');
    const { summary } = sidecar.endRun(run.runId, 'completed');
    parent = run.runId;
    expect(result.modelCalls).toBe(3);
    expect(sent).toBe(1);
    expect(summary.byKind).toMatchObject({ api: 3, tool: 2 });
    expect(mock.requests).toHaveLength(3);
    const api = store.getCalls(run.runId).filter((c) => c.kind === 'api');
    expect(api[0]!.name).toBe('POST /v1/chat/completions');
    expect(api.every((c) => (c.end?.meta.usage?.inputTokens ?? 0) > 0)).toBe(true);
    expect(mock.requests[0]!.headers.authorization).toBe('Bearer sk-test'); // forwarded upstream…
    expect(JSON.stringify(store.getCalls(run.runId))).not.toContain('sk-test'); // …never stored
  });

  it('replays with zero upstream requests', async () => {
    const before = mock.requests.length;
    const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command: { argv: ['agent'], cwd: '.' } });
    process.env.SHADOWLAP_RUN_ID = run.runId;
    const result = await runAgent('You are helpful.');
    const { summary } = sidecar.endRun(run.runId, 'completed');
    expect(summary.divergence).toBeNull();
    expect(summary.byOrigin.replayed).toBe(5);
    expect(mock.requests).toHaveLength(before);
    expect(sent).toBe(1);
    expect(result.finalText).toContain('Done');
  });

  it('forks on a changed system prompt and blocks the write', async () => {
    const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command: { argv: ['agent'], cwd: '.' } });
    process.env.SHADOWLAP_RUN_ID = run.runId;
    const result = await runAgent('You are terse.');
    const { summary } = sidecar.endRun(run.runId, 'completed');
    delete process.env.SHADOWLAP_URL;
    delete process.env.SHADOWLAP_RUN_ID;
    expect(summary.divergence).toMatchObject({ type: 'request_changed', callNo: 1, name: 'POST /v1/chat/completions' });
    expect(summary.divergence?.diff).toEqual([{ path: '$.messages[0].content', op: 'changed', before: 'You are helpful.', after: 'You are terse.' }]);
    expect(summary.byOrigin.blocked).toBe(1);
    expect(result.toolErrors).toEqual(['send_email: ShadowlapWriteBlocked']);
    expect(sent).toBe(1);
  });
});
