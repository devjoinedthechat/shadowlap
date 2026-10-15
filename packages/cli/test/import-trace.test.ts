import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiRequest, Store } from '@shadowlap/engine';
import { traceStoreHost } from '../src/import-fetch.js';
import { fetchLangfuseTrace, readLangfuse } from '../src/import-langfuse.js';
import { fetchLangsmithRuns, readLangsmith } from '../src/import-langsmith.js';
import { parseOtlpFile, readOtel } from '../src/import-otel.js';
import { dialectOf, importTrace, messagesOf, outputOf, type Trace } from '../src/import-trace.js';

/**
 * Traces as their sources write them: OTLP JSON in each generation of the GenAI conventions, a
 * Langfuse trace with its observations, and LangSmith runs from a LangChain agent and from a
 * wrapped client. The fixtures in fixtures/traces are shaped like real exports and API answers.
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/traces/${name}`, import.meta.url), 'utf8');
const otel = (name: string) => readOtel(parseOtlpFile(fixture(name)));
const open = () => Store.open(':memory:');

/** A run's calls, with each model call's request and response as JSON. */
function callsOf(store: Store, runId: string) {
  return store.getCalls(runId).map((c) => ({
    callNo: c.callNo,
    kind: c.kind,
    name: c.name,
    request: (c.kind === 'api' ? loadApiRequest(store, c.requestRef!) : store.getJson(c.requestRef!)) as Record<string, unknown>,
    response: c.kind === 'api' ? store.getBlob(c.end!.responseRef!)!.toString('utf8') : store.getJson(c.end!.responseRef!),
    meta: c.meta,
    end: c.end!,
  }));
}

describe('import otel: the current GenAI conventions', () => {
  it('reads model calls and tool calls, and nothing else, from one trace', () => {
    const read = otel('otel-genai.json');
    expect(read.spans).toBe(5);
    expect(read.traces).toHaveLength(1);
    const [trace] = read.traces;
    expect(trace!.id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(trace!.calls.map((c) => `${c.kind}:${c.kind === 'tool' ? c.name : c.model}`)).toEqual(['model:claude-haiku-4-5', 'tool:lookup_order', 'model:claude-haiku-4-5']);
  });

  it('rebuilds each model call as the Anthropic request its SDK sent, and the response it got', () => {
    const store = open();
    const { result, counts, dialects } = importTrace(store, otel('otel-genai.json').traces[0]!, { source: '/tmp/otel-genai.json', labels: ['otel'] });
    expect(dialects).toEqual({ anthropic: 2 });
    expect(counts).toEqual({ modelCalls: 2, modelCallsImported: 2, withSettings: 2, withToolDefinitions: 2, toolCalls: 1, toolCallsKept: 1 });
    expect(result.run.meta).toMatchObject({ covers: ['api', 'tool:lookup_order'], labels: ['imported', 'otel'], imported: { from: '/tmp/otel-genai.json' } });

    const [first, tool, second] = callsOf(store, result.run.runId);
    expect(first!.name).toBe('POST /v1/messages');
    expect(first!.meta.fingerprintHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
    expect(first!.request).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      temperature: 0,
      system: 'You are a support agent. Look the order up before you answer.',
      tools: [{ name: 'lookup_order', description: 'Look an order up by its id.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } }],
      messages: [{ role: 'user', content: 'Where is my order A-1042?' }],
    });
    expect(JSON.parse(first!.response as string)).toMatchObject({ id: 'msg_01A', type: 'message', content: [{ type: 'tool_use', id: 'toolu_01A', name: 'lookup_order', input: { order_id: 'A-1042' } }], stop_reason: 'tool_use' });
    expect(first!.end.meta).toMatchObject({ usage: { inputTokens: 412, outputTokens: 38 }, stopReason: 'tool_use', model: 'claude-haiku-4-5', latencyMs: 900 });

    // The tool call is stored as the SDK records one, so the agent's own call matches it on replay.
    expect(tool).toMatchObject({ kind: 'tool', name: 'lookup_order', request: { args: { order_id: 'A-1042' } }, response: { result: { order_id: 'A-1042', amount: 240, status: 'delivered' } } });

    expect(second!.request.messages).toEqual([
      { role: 'user', content: 'Where is my order A-1042?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01A', name: 'lookup_order', input: { order_id: 'A-1042' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: '{"order_id":"A-1042","amount":240,"status":"delivered"}' }] },
    ]);
    expect(JSON.parse(second!.response as string).content).toEqual([{ type: 'text', text: 'Order A-1042 was delivered; it cost $240.' }]);
    store.close();
  });
});

describe('import otel: OpenLLMetry and the older conventions', () => {
  it('reads flattened gen_ai.prompt attributes, keeps the span closest to the wire, and skips embeddings', () => {
    const [trace] = otel('otel-openllmetry.json').traces;
    // ChatOpenAI.chat wraps the client's openai.chat span for the same call: one call, not two.
    expect(trace!.calls.filter((c) => c.kind === 'model').map((c) => c.what)).toEqual(['span openai.chat', 'span openai.chat']);
    expect(trace!.skipped).toEqual([{ url: 'span openai.embeddings', reason: 'an embeddings call: only model and tool calls are imported' }]);

    const store = open();
    const { result, counts } = importTrace(store, trace!, { source: 'otel-openllmetry.json', labels: ['otel'] });
    expect(counts).toMatchObject({ modelCalls: 2, modelCallsImported: 2, withToolDefinitions: 2, toolCalls: 1, toolCallsKept: 1 });
    expect(result.run.meta?.covers).toEqual(['api', 'tool:lookup_order']);
    const [first, tool, second] = callsOf(store, result.run.runId);
    expect(first!.name).toBe('POST /v1/chat/completions');
    expect(first!.request).toEqual({
      model: 'gpt-4.1-mini',
      temperature: 0.2,
      max_tokens: 256,
      tools: [{ type: 'function', function: { name: 'lookup_order', description: 'Look an order up.', parameters: { type: 'object', properties: { order_id: { type: 'string' } } } } }],
      messages: [
        { role: 'system', content: 'You are a refunds agent.' },
        { role: 'user', content: 'Refund order B-7, please.' },
      ],
    });
    expect(JSON.parse(first!.response as string).choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_9x', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"B-7"}' } }] } });
    expect(first!.end.meta.usage).toEqual({ inputTokens: 96, outputTokens: 18 });
    // OpenLLMetry logs a decorated function's arguments as { args, kwargs }.
    expect(tool!.request).toEqual({ args: { order_id: 'B-7' } });
    expect((second!.request.messages as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_9x', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"B-7"}' } }] },
      { role: 'tool', tool_call_id: 'call_9x', content: '{"order_id": "B-7", "amount": 40}' },
    ]);
    expect(JSON.parse(second!.response as string).choices[0].message.content).toBe('Refunded $40 for order B-7.');
    store.close();
  });

  it('reads the per-message events and the content events, one trace per run, from one request per line', () => {
    const read = otel('otel-events.jsonl');
    expect(read.traces.map((t) => t.id)).toEqual(['6c9f00aa11bb22cc33dd44ee55ff6677', '7d0a11bb22cc33dd44ee55ff66778899']);
    const store = open();

    const events = importTrace(store, read.traces[0]!, { source: 'otel-events.jsonl' });
    const [call] = callsOf(store, events.result.run.runId);
    expect(call!.request.messages).toEqual([
      { role: 'system', content: 'Classify the alert.' },
      { role: 'user', content: 'disk 91% on db-2' },
    ]);
    expect(JSON.parse(call!.response as string).choices[0]).toMatchObject({ message: { content: 'warning' }, finish_reason: 'stop' });

    // Gemini's dialect, and a call that failed where it ran: it left nothing to serve, so it runs live.
    const gemini = importTrace(store, read.traces[1]!, { source: 'otel-events.jsonl' });
    const [g] = callsOf(store, gemini.result.run.runId);
    expect(g!.name).toBe('POST /v1beta/models/gemini-2.5-flash:generateContent');
    expect(g!.request).toEqual({ contents: [{ role: 'user', parts: [{ text: 'Is 91% disk urgent?' }] }] });
    expect(JSON.parse(g!.response as string)).toMatchObject({ candidates: [{ content: { role: 'model', parts: [{ text: 'Not yet.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4 } });
    expect(gemini.result.skipped).toEqual([{ url: 'span chat gemini-2.5-flash', reason: 'the model call failed at its source (429 RESOURCE_EXHAUSTED)' }]);
    store.close();
  });

  it('refuses a file with no spans, survives a parent loop, and reads attributes without touching prototypes', () => {
    expect(() => readOtel(parseOtlpFile('{"resourceSpans":[]}'))).toThrow(/no spans/);
    expect(() => parseOtlpFile('not json\nat all')).toThrow(/not OTLP JSON/);
    const span = (spanId: string, parentSpanId: string) => ({
      traceId: 't',
      spanId,
      parentSpanId,
      name: 'chat',
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: '__proto__', value: { kvlistValue: { values: [{ key: 'polluted', value: { boolValue: true } }] } } },
        { key: 'gen_ai.prompt.0.__proto__.polluted', value: { boolValue: true } },
      ],
    });
    const read = readOtel([{ resourceSpans: [{ scopeSpans: [{ spans: [span('a', 'b'), span('b', 'a')] }] }] }]);
    expect(read.traces[0]!.calls).toHaveLength(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('a trace is a file from anywhere', () => {
  it('escapes what it names before a terminal shows it', () => {
    const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const read = readOtel([
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  { traceId: 'abc\u001b]0;pwned\u0007', spanId: '1', name: 'chat \u001b[2J', status: { code: 2, message: 'failed\n\u001b[31mred' }, attributes: [attr('gen_ai.operation.name', 'chat'), attr('gen_ai.input.messages', '[{"role":"user","content":"hi"}]')] },
                  { traceId: 'abc\u001b]0;pwned\u0007', spanId: '2', name: 'execute_tool x', attributes: [attr('gen_ai.operation.name', 'execute_tool'), attr('gen_ai.tool.name', 'look\u001b[0mup')] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const [trace] = read.traces;
    expect(trace!.id).toBe('abc\\x1b]0;pwned\\x07');
    const store = open();
    const { result } = importTrace(store, trace!, { source: 's' });
    expect(result.skipped).toEqual([{ url: 'span chat \\x1b[2J', reason: 'the model call failed at its source (failed\\n\\x1b[31mred)' }]);
    expect(trace!.calls.find((c) => c.kind === 'tool')).toMatchObject({ name: 'look\\x1b[0mup' });
    store.close();
  });
});

describe('import langfuse', () => {
  const trace = JSON.parse(fixture('langfuse-trace.json')) as Record<string, unknown>;

  it('reads generations as model calls and tool observations, or spans named after a tool, as tool calls', () => {
    const read = readLangfuse(trace);
    expect(read.spans).toBe(7);
    expect(read.calls.map((c) => `${c.kind}:${c.kind === 'tool' ? c.name : c.what}`)).toEqual([
      'model:generation OpenAI-generation',
      'tool:lookup_order',
      'model:generation OpenAI-generation',
      'model:generation OpenAI-generation',
      'tool:create_replacement',
    ]);
  });

  it('imports what the trace kept: the tool with its output replays, the one without runs live', () => {
    const store = open();
    const { result, counts } = importTrace(store, { ...readLangfuse(trace), id: '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07' }, { source: 'langfuse:7f3a9c2e', labels: ['langfuse'] });
    expect(counts).toEqual({ modelCalls: 3, modelCallsImported: 3, withSettings: 3, withToolDefinitions: 3, toolCalls: 2, toolCallsKept: 1 });
    expect(result.run.meta?.covers).toEqual(['api', 'tool:lookup_order']);
    const calls = callsOf(store, result.run.runId);
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['api:POST /v1/chat/completions', 'tool:lookup_order', 'api:POST /v1/chat/completions', 'api:POST /v1/chat/completions']);
    expect(calls[0]!.request).toMatchObject({ model: 'gpt-4.1-mini', temperature: 0, max_tokens: 512 });
    expect((calls[0]!.request.tools as unknown[]).length).toBe(2);
    expect(calls[3]!.request.messages).toHaveLength(6);
    expect(JSON.parse(calls[3]!.response as string).choices[0].message.content).toBe("I'm sorry it arrived broken. A replacement ships today as S-5531.");
    expect(calls[0]!.end.meta.usage).toEqual({ inputTokens: 812, outputTokens: 25 });
    store.close();
  });
});

describe('import langsmith', () => {
  const pages = (JSON.parse(fixture('langsmith-runs.json')) as { pages: Array<{ runs: Array<Record<string, unknown>> }> }).pages;
  const runs = pages.flatMap((p) => p.runs);

  it('reads LangChain llm runs as Anthropic calls, with the tool definitions and settings LangChain logged', () => {
    const store = open();
    const { result, counts, dialects } = importTrace(store, readLangsmith(runs, '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c'), { source: 'langsmith:0192f4c1', labels: ['langsmith'] });
    expect(dialects).toEqual({ anthropic: 2 });
    expect(counts).toEqual({ modelCalls: 2, modelCallsImported: 2, withSettings: 2, withToolDefinitions: 2, toolCalls: 2, toolCallsKept: 1 });
    // create_replacement logged its arguments as Python text, so it can't match and runs live.
    expect(result.run.meta?.covers).toEqual(['api', 'tool:lookup_order']);
    const [first, tool, second] = callsOf(store, result.run.runId);
    expect(first!.request).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      temperature: 0,
      system: 'You are a support agent.',
      messages: [{ role: 'user', content: 'My blender arrived broken. Order A-1042.' }],
      tools: [
        { name: 'lookup_order', description: 'Look an order up by its id.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
        { name: 'create_replacement', description: 'Ship a replacement for an order.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
      ],
    });
    expect(JSON.parse(first!.response as string)).toMatchObject({ content: [{ type: 'tool_use', id: 'toolu_01X', name: 'lookup_order', input: { order_id: 'A-1042' } }], stop_reason: 'tool_use' });
    // The ToolMessage's content is what the model saw.
    expect(tool).toMatchObject({ request: { args: { order_id: 'A-1042' } }, response: { result: { order_id: 'A-1042', status: 'delivered' } } });
    expect((second!.request.messages as unknown[]).slice(1)).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01X', name: 'lookup_order', input: { order_id: 'A-1042' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01X', content: '{"order_id": "A-1042", "status": "delivered"}' }] },
    ]);
    // LangChain counts cached input as input; Anthropic reports it apart.
    expect(second!.end.meta.usage).toEqual({ inputTokens: 128, outputTokens: 12, cacheReadInputTokens: 384, cacheCreationInputTokens: 0 });
    store.close();
  });

  it('keeps the request and response a wrapped client logged, exactly', () => {
    const wrapped = (JSON.parse(fixture('langsmith-wrapped.json')) as { pages: Array<{ runs: Array<Record<string, unknown>> }> }).pages[0]!.runs;
    const store = open();
    const { result } = importTrace(store, readLangsmith(wrapped, '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a9999'), { source: 'langsmith:0192f4c1' });
    const [call] = callsOf(store, result.run.runId);
    expect(call!.request).toEqual({ messages: [{ role: 'system', content: 'Answer in one word.' }, { role: 'user', content: 'Capital of France?' }], model: 'gpt-4.1-mini', temperature: 0, max_tokens: 16 });
    expect(JSON.parse(call!.response as string)).toEqual(wrapped[0]!.outputs);
    store.close();
  });
});

describe('reading what traces log', () => {
  it('normalizes messages from every shape sources use', () => {
    expect(messagesOf('hi')).toEqual([{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]);
    expect(messagesOf({ system: 'be brief', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })).toEqual([
      { role: 'system', parts: [{ type: 'text', text: 'be brief' }] },
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(messagesOf({ contents: [{ role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] }, { role: 'user', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }] }] })).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: '', name: 'f', arguments: { a: 1 } }] },
      { role: 'user', parts: [{ type: 'tool_result', id: '', name: 'f', content: { ok: true } }] },
    ]);
    expect(outputOf({ generations: [[{ text: 'plain' }]] })).toEqual({ parts: [{ type: 'text', text: 'plain' }], finishReason: null });
    expect(outputOf(null)).toBeNull();
  });

  it('rebuilds in the dialect the source names, else the model family, else OpenAI', () => {
    expect(dialectOf('anthropic', null)).toBe('anthropic');
    expect(dialectOf('aws.bedrock', 'anthropic.claude-haiku-4-5')).toBe('anthropic');
    expect(dialectOf('gcp.vertex_ai', 'gemini-2.5-pro')).toBe('gemini');
    expect(dialectOf('az.ai.openai', 'gpt-4o')).toBe('openai');
    expect(dialectOf('groq', 'llama-3.3-70b')).toBe('openai');
    expect(dialectOf(null, 'claude-opus-5')).toBe('anthropic');
    expect(dialectOf(null, null)).toBe('openai');
  });

  it('streams a rebuilt response when the call streamed, so the agent can parse it', () => {
    const store = open();
    const trace: Trace = {
      id: 't',
      spans: 1,
      skipped: [],
      calls: [{ kind: 'model', what: 'x', provider: 'anthropic', model: 'claude-haiku-4-5', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], tools: null, settings: { maxTokens: 64 }, stream: true, output: { parts: [{ type: 'text', text: 'hello' }], finishReason: 'end_turn' }, usage: { input: 10, output: 2, inputIncludesCache: false }, error: null, responseId: null, startedAt: 1, endedAt: 5 }],
    };
    const { result } = importTrace(store, trace, { source: 's' });
    const [call] = callsOf(store, result.run.runId);
    expect(call!.request).toMatchObject({ stream: true });
    expect(call!.end.meta.headers?.['content-type']).toMatch(/text\/event-stream/);
    expect(call!.response).toContain('event: message_stop');
    expect(call!.end.meta).toMatchObject({ usage: { inputTokens: 10, outputTokens: 2 }, stopReason: 'end_turn' });
    store.close();
  });
});

describe('reading a trace store', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });
  const listen = async (handler: (req: IncomingMessage, body: string) => { status: number; body: unknown }) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const out = handler(req, body);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };

  it('accepts https anywhere and http on this machine only, and never a URL with credentials in it', () => {
    expect(traceStoreHost('https://langfuse.example.com/', 'Langfuse')).toBe('https://langfuse.example.com');
    expect(traceStoreHost('http://127.0.0.1:3000', 'Langfuse')).toBe('http://127.0.0.1:3000');
    expect(traceStoreHost('https://ls.example.com/api/v1?x=1', 'LangSmith')).toBe('https://ls.example.com/api/v1');
    expect(() => traceStoreHost('http://langfuse.internal:3000', 'Langfuse')).toThrow(/use https/);
    expect(() => traceStoreHost('https://pk:sk@cloud.langfuse.com', 'Langfuse')).toThrow(/credentials/);
    expect(() => traceStoreHost('ftp://x', 'Langfuse')).toThrow(/https/);
    expect(() => traceStoreHost('cloud.langfuse.com', 'Langfuse')).toThrow(/needs a URL/);
  });

  it('fetches a Langfuse trace with the project keys, and its observations when the trace lists ids only', async () => {
    const full = JSON.parse(fixture('langfuse-trace.json')) as { observations: unknown[] };
    const seen: string[] = [];
    const host = await listen((req) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      if (req.url === '/api/public/traces/7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07') return { status: 200, body: { ...full, observations: ['obs-gen-1', 'obs-tool-1'] } };
      const page = Number(new URL(req.url!, 'http://x').searchParams.get('page'));
      return { status: 200, body: { data: full.observations.slice((page - 1) * 4, page * 4), meta: { page, limit: 100, totalItems: 7, totalPages: 2 } } };
    });
    const trace = await fetchLangfuseTrace('7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07', { host, publicKey: 'pk-lf-1', secretKey: 'sk-lf-2' });
    expect((trace.observations as unknown[]).length).toBe(7);
    const basic = `Basic ${Buffer.from('pk-lf-1:sk-lf-2').toString('base64')}`;
    expect(seen).toEqual([
      `GET /api/public/traces/7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07 ${basic}`,
      `GET /api/public/observations?traceId=7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07&page=1&limit=100 ${basic}`,
      `GET /api/public/observations?traceId=7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07&page=2&limit=100 ${basic}`,
    ]);
  });

  it('says why Langfuse refused, without the keys', async () => {
    const host = await listen(() => ({ status: 401, body: { message: 'Invalid credentials' } }));
    const err = await fetchLangfuseTrace('abc', { host, publicKey: 'pk-lf-1', secretKey: 'sk-lf-secret' }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/refused the keys \(401\).*LANGFUSE_PUBLIC_KEY/);
    expect((err as Error).message).not.toContain('sk-lf-secret');
    const missing = await listen(() => ({ status: 404, body: {} }));
    await expect(fetchLangfuseTrace('abc', { host: missing, publicKey: 'p', secretKey: 's' })).rejects.toThrow(/has no trace abc on 127\.0\.0\.1/);
  });

  it('fetches every page of a LangSmith trace with the API key', async () => {
    const pages = (JSON.parse(fixture('langsmith-runs.json')) as { pages: Array<{ runs: unknown[]; cursors: unknown }> }).pages;
    const bodies: Array<Record<string, unknown>> = [];
    const host = await listen((req, body) => {
      expect(req.headers['x-api-key']).toBe('lsv2_pt_test');
      expect(`${req.method} ${req.url}`).toBe('POST /runs/query');
      const parsed = JSON.parse(body) as Record<string, unknown>;
      bodies.push(parsed);
      return { status: 200, body: parsed.cursor === 'cursor-page-2' ? pages[1] : pages[0] };
    });
    const runs = await fetchLangsmithRuns('0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c', { host, apiKey: 'lsv2_pt_test' });
    expect(runs).toHaveLength(5);
    expect(bodies).toEqual([
      { trace: '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c', limit: 100 },
      { trace: '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c', limit: 100, cursor: 'cursor-page-2' },
    ]);
  });

  it('says when LangSmith refuses the key or has no such trace', async () => {
    const refused = await listen(() => ({ status: 401, body: { detail: 'Invalid token' } }));
    await expect(fetchLangsmithRuns('abc', { host: refused, apiKey: 'lsv2_secret' })).rejects.toThrow(/refused the key \(401\).*LANGSMITH_API_KEY/);
    const empty = await listen(() => ({ status: 200, body: { runs: [], cursors: { next: null } } }));
    await expect(fetchLangsmithRuns('abc', { host: empty, apiKey: 'k' })).rejects.toThrow(/no runs for trace abc/);
  });
});
