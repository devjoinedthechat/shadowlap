import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadApiRequest, Store } from '@shadowlap/engine';
import { traceStoreHost } from '../src/import-fetch.js';
import { fetchLangfuseTrace, langfusePage, PAGE_LINK_MS, readLangfuse } from '../src/import-langfuse.js';
import { fetchLangsmithRuns, readLangsmith } from '../src/import-langsmith.js';
import { parseOtlpFile, readOtel } from '../src/import-otel.js';
import { dialectOf, importTrace, messagesOf, outputOf, type Trace } from '../src/import-trace.js';
import { times, timesOf } from '../../engine/test/timing.js';

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
    expect(trace.id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(trace.calls.map((c) => `${c.kind}:${c.kind === 'tool' ? c.name : c.model}`)).toEqual(['model:claude-haiku-4-5', 'tool:lookup_order', 'model:claude-haiku-4-5']);
  });

  it('rebuilds each model call as the Anthropic request its SDK sent, and the response it got', () => {
    const store = open();
    const { result, counts, dialects } = importTrace(store, otel('otel-genai.json').traces[0], { source: '/tmp/otel-genai.json', labels: ['otel'] });
    expect(dialects).toEqual({ anthropic: 2 });
    expect(counts).toEqual({ modelCalls: 2, modelCallsImported: 2, withSettings: 2, withToolDefinitions: 2, toolCalls: 1, toolCallsKept: 1 });
    expect(result.run.meta).toMatchObject({ covers: ['api', 'tool:lookup_order'], labels: ['imported', 'otel'], imported: { from: '/tmp/otel-genai.json' } });

    const [first, tool, second] = callsOf(store, result.run.runId);
    expect(first.name).toBe('POST /v1/messages');
    // A trace keeps no API version, so the call names none: a replay matches it whatever version the agent's SDK names.
    expect(first.meta.fingerprintHeaders).toEqual({});
    expect(first.request).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      temperature: 0,
      system: 'You are a support agent. Look the order up before you answer.',
      tools: [{ name: 'lookup_order', description: 'Look an order up by its id.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } }],
      messages: [{ role: 'user', content: 'Where is my order A-1042?' }],
    });
    expect(JSON.parse(first.response as string)).toMatchObject({ id: 'msg_01A', type: 'message', content: [{ type: 'tool_use', id: 'toolu_01A', name: 'lookup_order', input: { order_id: 'A-1042' } }], stop_reason: 'tool_use' });
    expect(first.end.meta).toMatchObject({ usage: { inputTokens: 412, outputTokens: 38 }, stopReason: 'tool_use', model: 'claude-haiku-4-5', latencyMs: 900 });

    // The tool call is stored as the SDK records one, so the agent's own call matches it on replay.
    expect(tool).toMatchObject({ kind: 'tool', name: 'lookup_order', request: { args: { order_id: 'A-1042' } }, response: { result: { order_id: 'A-1042', amount: 240, status: 'delivered' } } });

    expect(second.request.messages).toEqual([
      { role: 'user', content: 'Where is my order A-1042?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01A', name: 'lookup_order', input: { order_id: 'A-1042' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: '{"order_id":"A-1042","amount":240,"status":"delivered"}' }] },
    ]);
    expect(JSON.parse(second.response as string).content).toEqual([{ type: 'text', text: 'Order A-1042 was delivered; it cost $240.' }]);
    store.close();
  });
});

describe('import otel: OpenLLMetry and the older conventions', () => {
  it('reads flattened gen_ai.prompt attributes, keeps the span closest to the wire, and skips embeddings', () => {
    const [trace] = otel('otel-openllmetry.json').traces;
    // ChatOpenAI.chat wraps the client's openai.chat span for the same call: one call, not two.
    expect(trace.calls.filter((c) => c.kind === 'model').map((c) => c.what)).toEqual(['span openai.chat', 'span openai.chat']);
    expect(trace.skipped).toEqual([{ url: 'span openai.embeddings', reason: 'an embeddings call: only model and tool calls are imported' }]);

    const store = open();
    const { result, counts } = importTrace(store, trace, { source: 'otel-openllmetry.json', labels: ['otel'] });
    expect(counts).toMatchObject({ modelCalls: 2, modelCallsImported: 2, withToolDefinitions: 2, toolCalls: 1, toolCallsKept: 1 });
    expect(result.run.meta?.covers).toEqual(['api', 'tool:lookup_order']);
    const [first, tool, second] = callsOf(store, result.run.runId);
    expect(first.name).toBe('POST /v1/chat/completions');
    expect(first.request).toEqual({
      model: 'gpt-4.1-mini',
      temperature: 0.2,
      max_tokens: 256,
      tools: [{ type: 'function', function: { name: 'lookup_order', description: 'Look an order up.', parameters: { type: 'object', properties: { order_id: { type: 'string' } } } } }],
      messages: [
        { role: 'system', content: 'You are a refunds agent.' },
        { role: 'user', content: 'Refund order B-7, please.' },
      ],
    });
    // The arguments as the model wrote them, which is what the agent sends back.
    expect(JSON.parse(first.response as string).choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_9x', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id": "B-7"}' } }] } });
    expect(first.end.meta.usage).toEqual({ inputTokens: 96, outputTokens: 18 });
    // OpenLLMetry logs a decorated function's arguments as { args, kwargs }.
    expect(tool.request).toEqual({ args: { order_id: 'B-7' } });
    expect((second.request.messages as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_9x', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id": "B-7"}' } }] },
      { role: 'tool', tool_call_id: 'call_9x', content: '{"order_id": "B-7", "amount": 40}' },
    ]);
    expect(JSON.parse(second.response as string).choices[0].message.content).toBe('Refunded $40 for order B-7.');
    store.close();
  });

  it('reads the per-message events and the content events, one trace per run, from one request per line', () => {
    const read = otel('otel-events.jsonl');
    expect(read.traces.map((t) => t.id)).toEqual(['6c9f00aa11bb22cc33dd44ee55ff6677', '7d0a11bb22cc33dd44ee55ff66778899']);
    const store = open();

    const events = importTrace(store, read.traces[0], { source: 'otel-events.jsonl' });
    const [call] = callsOf(store, events.result.run.runId);
    expect(call.request.messages).toEqual([
      { role: 'system', content: 'Classify the alert.' },
      { role: 'user', content: 'disk 91% on db-2' },
    ]);
    expect(JSON.parse(call.response as string).choices[0]).toMatchObject({ message: { content: 'warning' }, finish_reason: 'stop' });

    // Gemini's dialect, and a call that failed where it ran: it left nothing to serve, so it runs live.
    const gemini = importTrace(store, read.traces[1], { source: 'otel-events.jsonl' });
    const [g] = callsOf(store, gemini.result.run.runId);
    expect(g.name).toBe('POST /v1beta/models/gemini-2.5-flash:generateContent');
    expect(g.request).toEqual({ contents: [{ role: 'user', parts: [{ text: 'Is 91% disk urgent?' }] }] });
    expect(JSON.parse(g.response as string)).toMatchObject({ candidates: [{ content: { role: 'model', parts: [{ text: 'Not yet.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4 } });
    expect(gemini.result.skipped).toEqual([{ url: 'span chat gemini-2.5-flash', reason: 'the model call failed at its source (429 RESOURCE_EXHAUSTED)' }]);
    store.close();
  });

  it('reads the events the official instrumentations send as log records, tied to their spans', () => {
    const read = otel('otel-logs.jsonl');
    expect(read.traces).toHaveLength(1);
    const store = open();
    const { result, counts } = importTrace(store, read.traces[0], { source: 'otel-logs.jsonl' });
    expect(counts).toMatchObject({ modelCalls: 2, modelCallsImported: 2 });
    const [first, second] = callsOf(store, result.run.runId);
    expect(first.request).toEqual({
      model: 'gpt-4.1-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a billing assistant. Look invoices up before you explain a charge.' },
        { role: 'user', content: 'Why was I charged twice for invoice 7?' },
      ],
    });
    expect(JSON.parse(first.response as string)).toMatchObject({ id: 'chatcmpl-Bx81', choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_inv7', function: { name: 'get_invoice', arguments: '{"invoice_id": 7}' } }] } }] });
    expect((second.request.messages as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_inv7', type: 'function', function: { name: 'get_invoice', arguments: '{"invoice_id": 7}' } }] },
      { role: 'tool', tool_call_id: 'call_inv7', content: '{"invoice_id": 7, "lines": [{"amount": 49, "kind": "charge"}, {"amount": 49, "kind": "authorization hold"}]}' },
    ]);
    expect(JSON.parse(second.response as string).choices[0].message.content).toBe('You were charged once. The second line is an authorization hold, which drops off within 3 days.');
    store.close();
  });

  it('reads the messages of an inference details event as the span\'s own', () => {
    const value = (v: unknown): unknown =>
      typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(value) } } : { kvlistValue: { values: Object.entries(v as object).map(([key, x]) => ({ key, value: value(x) })) } };
    const read = readOtel([
      { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'a1', spanId: 's1', name: 'chat claude-haiku-4-5', attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }, { key: 'gen_ai.provider.name', value: { stringValue: 'anthropic' } }, { key: 'gen_ai.request.model', value: { stringValue: 'claude-haiku-4-5' } }] }] }] }] },
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    traceId: 'a1',
                    spanId: 's1',
                    eventName: 'gen_ai.client.inference.operation.details',
                    attributes: [
                      { key: 'gen_ai.input.messages', value: value([{ role: 'user', parts: [{ type: 'text', content: 'Is invoice 7 paid?' }] }]) },
                      { key: 'gen_ai.output.messages', value: value([{ role: 'assistant', parts: [{ type: 'text', content: 'Yes, on Oct 2.' }], finish_reason: 'stop' }]) },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const [call] = read.traces[0].calls;
    expect(call).toMatchObject({ kind: 'model', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Is invoice 7 paid?' }] }], output: { parts: [{ type: 'text', text: 'Yes, on Oct 2.' }] } });
  });

  it('reads a trace downloaded from Grafana Tempo, which calls resourceSpans batches', () => {
    const exported = JSON.parse(fixture('otel-genai.json')) as { resourceSpans: unknown[] };
    const read = readOtel([{ batches: exported.resourceSpans }]);
    expect(read.traces[0].calls).toHaveLength(3);
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
    expect(read.traces[0].calls).toHaveLength(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('ignores a flattened attribute whose index no conversation reaches, rather than building an array that long', () => {
    const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const far = [attr('gen_ai.prompt.0.tool_calls.4294967294.name', 'x'), attr('gen_ai.prompt.4294967294.role', 'user'), attr('gen_ai.prompt.99999999999999999999.content', 'far'), attr('gen_ai.completion.0.tool_calls.1001.name', 'y')];
    const file = (reaching: boolean) => [
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 't',
                    spanId: 's',
                    name: 'openai.chat',
                    attributes: [attr('llm.request.type', 'chat'), attr('gen_ai.system', 'openai'), attr('gen_ai.prompt.0.role', 'user'), attr('gen_ai.prompt.0.content', 'hi'), ...(reaching ? far : []), attr('gen_ai.completion.0.content', 'hello')],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const [withFar, without] = [file(true), file(false)];
    const read = readOtel(withFar);
    expect(read.traces[0].calls[0]).toMatchObject({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], output: { parts: [{ type: 'text', text: 'hello' }] } });
    expect(readOtel(without).traces[0].calls[0]).toEqual(read.traces[0].calls[0]);
    // Held against this machine, not a number of milliseconds: one and a half to three times what the
    // span takes without them, on Node 22 and 24 alike, where building an array four billion long takes
    // far longer.
    const t = timesOf({ withFar: () => readOtel(withFar), without: () => readOtel(without) });
    expect(t.withFar, `the indexes far off took ${times(t.withFar, t.without)} the span without them`).toBeLessThan(20 * t.without);
  });

  it('reads a trace of many spans, and many log records for one span, in time that grows with the file', () => {
    // A file from anywhere: 100,000 spans in one trace, and as many GenAI log records for one span.
    // Grouping them by copying a list per entry took seconds here and minutes at a few times this.
    const n = 100_000;
    const spans: Array<Record<string, unknown>> = Array.from({ length: n }, (_, i) => ({ traceId: 't', spanId: `s${i}`, name: 'step' }));
    spans[0] = { traceId: 't', spanId: 's0', name: 'chat', attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }] };
    const logRecords = Array.from({ length: n }, () => ({ traceId: 't', spanId: 's0', eventName: 'gen_ai.user.message', body: { kvlistValue: { values: [{ key: 'content', value: { stringValue: 'hi' } }] } } }));
    const docs = [{ resourceSpans: [{ scopeSpans: [{ spans }] }] }, { resourceLogs: [{ scopeLogs: [{ logRecords }] }] }];
    const read = readOtel(docs);
    expect(read.spans).toBe(n);
    const [call] = read.traces[0].calls;
    expect(call).toMatchObject({ kind: 'model' });
    expect((call as { messages: unknown[] }).messages).toHaveLength(n);
    // Held against this machine, not a number of milliseconds: 1.5 to 2.5 times what a copy of the file
    // takes (written out and parsed again), on Node 22 and 24 alike. Copying a list per entry took 21
    // seconds, over a hundred times that: under 20 times leaves room for both and fails it.
    const t = timesOf({ read: () => readOtel(docs), copy: () => JSON.parse(JSON.stringify(docs)) }, { rounds: 2 });
    expect(t.read, `reading the trace took ${times(t.read, t.copy)} a copy of it`).toBeLessThan(20 * t.copy);
  });
});

describe("import otel: OpenInference's conventions (Arize Phoenix)", () => {
  it('rebuilds a call exactly from the request and response the OpenAI instrumentation logged', () => {
    const read = otel('otel-openinference.json');
    const [trace] = read.traces;
    // The agent's own span and its tool's come from another scope than the client's; time puts them in order.
    const ordered = [...trace.calls].sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0));
    expect(ordered.map((c) => `${c.kind}:${c.kind === 'tool' ? c.name : c.model}`)).toEqual(['model:gpt-4.1-mini', 'tool:lookup_order', 'model:gpt-4.1-mini']);
    const store = open();
    const { result, counts } = importTrace(store, trace, { source: 'otel-openinference.json', labels: ['otel'] });
    expect(counts).toEqual({ modelCalls: 2, modelCallsImported: 2, withSettings: 2, withToolDefinitions: 2, toolCalls: 1, toolCallsKept: 1 });
    expect(result.run.meta?.covers).toEqual(['api', 'tool:lookup_order']);
    const logged = JSON.parse(fixture('otel-openinference.json')) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }> }> }> };
    const value = (span: number, key: string) => JSON.parse(logged.resourceSpans[0].scopeSpans[0].spans[span].attributes.find((x) => x.key === key)!.value.stringValue!);
    const [first, tool, second] = callsOf(store, result.run.runId);
    expect(first.request).toEqual(value(0, 'input.value'));
    expect(JSON.parse(first.response as string)).toEqual(value(0, 'output.value'));
    expect(tool.request).toEqual({ args: { order_id: 'B-7' } });
    expect(tool.response).toEqual({ result: { order_id: 'B-7', amount: 40, status: 'delivered' } });
    expect(second.request).toEqual(value(1, 'input.value'));
    expect(second.end.meta.usage).toMatchObject({ inputTokens: 151, outputTokens: 14 });
    store.close();
  });

  it('rebuilds from the flattened messages and tools when the request itself was not logged', () => {
    const doc = JSON.parse(fixture('otel-openinference.json')) as { resourceSpans: Array<{ scopeSpans: Array<{ scope: { name: string }; spans: Array<{ attributes: Array<{ key: string }> }> }> }> };
    // As the LlamaIndex instrumentation writes it: no provider request in input.value.
    doc.resourceSpans[0].scopeSpans[0].scope.name = 'openinference.instrumentation.llama_index';
    const [trace] = readOtel([doc]).traces;
    const store = open();
    const { result } = importTrace(store, trace, { source: 'phoenix.json' });
    const [first, , second] = callsOf(store, result.run.runId);
    expect(first.request).toEqual({
      model: 'gpt-4.1-mini',
      temperature: 0,
      tools: [{ type: 'function', function: { name: 'lookup_order', description: 'Look an order up by its id.', parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } } }],
      messages: [
        { role: 'system', content: 'You are a refunds agent. Look an order up before you refund it.' },
        { role: 'user', content: 'Refund order B-7, please.' },
      ],
    });
    expect(JSON.parse(first.response as string).choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_b7', function: { name: 'lookup_order', arguments: '{"order_id": "B-7"}' } }] } });
    expect((second.request.messages as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_b7', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id": "B-7"}' } }] },
      { role: 'tool', tool_call_id: 'call_b7', content: '{"order_id":"B-7","amount":40,"status":"delivered"}' },
    ]);
    store.close();
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
    expect(trace.id).toBe('abc\\x1b]0;pwned\\x07');
    const store = open();
    const { result } = importTrace(store, trace, { source: 's' });
    expect(result.skipped).toEqual([{ url: 'span chat \\x1b[2J', reason: 'the model call failed at its source (failed\\n\\x1b[31mred)' }]);
    expect(trace.calls.find((c) => c.kind === 'tool')).toMatchObject({ name: 'look\\x1b[0mup' });
    store.close();
  });
});

describe('import langfuse', () => {
  const trace = JSON.parse(fixture('langfuse-trace.json')) as Record<string, unknown>;

  it('reads generations as model calls and tool observations, or spans named after a tool, as tool calls, in the order the trace lists them', () => {
    const read = readLangfuse(trace);
    expect(read.spans).toBe(7);
    expect(read.calls.map((c) => `${c.kind}:${c.kind === 'tool' ? c.name : c.what}`)).toEqual([
      'model:generation OpenAI-generation',
      'tool:lookup_order',
      'model:generation OpenAI-generation',
      'tool:create_replacement',
      'model:generation OpenAI-generation',
    ]);
  });

  it('imports what the trace kept: the tool with its output replays, the one without runs live', () => {
    const store = open();
    const { result, counts } = importTrace(store, { ...readLangfuse(trace), id: '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07' }, { source: 'langfuse:7f3a9c2e', labels: ['langfuse'] });
    expect(counts).toEqual({ modelCalls: 3, modelCallsImported: 3, withSettings: 3, withToolDefinitions: 3, toolCalls: 2, toolCallsKept: 1 });
    expect(result.run.meta?.covers).toEqual(['api', 'tool:lookup_order']);
    const calls = callsOf(store, result.run.runId);
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['api:POST /v1/chat/completions', 'tool:lookup_order', 'api:POST /v1/chat/completions', 'api:POST /v1/chat/completions']);
    expect(calls[0].request).toMatchObject({ model: 'gpt-4.1-mini', temperature: 0, max_tokens: 512 });
    expect((calls[0].request.tools as unknown[]).length).toBe(2);
    expect(calls[3].request.messages).toHaveLength(6);
    expect(JSON.parse(calls[3].response as string).choices[0].message.content).toBe("I'm sorry it arrived broken. A replacement ships today as S-5531.");
    expect(calls[0].end.meta.usage).toEqual({ inputTokens: 812, outputTokens: 25 });
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
    expect(first.request).toEqual({
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
    expect(JSON.parse(first.response as string)).toMatchObject({ content: [{ type: 'tool_use', id: 'toolu_01X', name: 'lookup_order', input: { order_id: 'A-1042' } }], stop_reason: 'tool_use' });
    // The ToolMessage's content is what the model saw.
    expect(tool).toMatchObject({ request: { args: { order_id: 'A-1042' } }, response: { result: { order_id: 'A-1042', status: 'delivered' } } });
    expect((second.request.messages as unknown[]).slice(1)).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01X', name: 'lookup_order', input: { order_id: 'A-1042' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01X', content: '{"order_id": "A-1042", "status": "delivered"}' }] },
    ]);
    // LangChain counts cached input as input; Anthropic reports it apart.
    expect(second.end.meta.usage).toEqual({ inputTokens: 128, outputTokens: 12, cacheReadInputTokens: 384, cacheCreationInputTokens: 0 });
    store.close();
  });

  it('keeps the request and response a wrapped client logged, exactly', () => {
    const wrapped = (JSON.parse(fixture('langsmith-wrapped.json')) as { pages: Array<{ runs: Array<Record<string, unknown>> }> }).pages[0].runs;
    const store = open();
    const { result } = importTrace(store, readLangsmith(wrapped, '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a9999'), { source: 'langsmith:0192f4c1' });
    const [call] = callsOf(store, result.run.runId);
    expect(call.request).toEqual({ messages: [{ role: 'system', content: 'Answer in one word.' }, { role: 'user', content: 'Capital of France?' }], model: 'gpt-4.1-mini', temperature: 0, max_tokens: 16 });
    expect(JSON.parse(call.response as string)).toEqual(wrapped[0].outputs);
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

  it("reads an assistant's blocks logged as the text the Anthropic SDK prints for them as the blocks, and nothing else", () => {
    const tool = "ToolUseBlock(id='toolu_1', caller=None, input={'order_id': 'A-1042'}, name='lookup_order', type='tool_use', toolset_name=None)";
    const logged = [
      { type: 'text', content: "TextBlock(citations=None, text='Looking it up.', type='text')" },
      { type: 'text', content: tool },
      // A block the conversation holds no part for, as one logged as an object.
      { type: 'text', content: "ThinkingBlock(signature='c2ln', thinking='The order first.', type='thinking')" },
    ];
    expect(messagesOf([{ role: 'assistant', parts: logged }])).toEqual([{ role: 'assistant', parts: [{ type: 'text', text: 'Looking it up.' }, { type: 'tool_call', id: 'toolu_1', name: 'lookup_order', arguments: { order_id: 'A-1042' } }] }]);
    expect(messagesOf({ messages: [{ role: 'assistant', content: [tool] }] })).toEqual([{ role: 'assistant', parts: [{ type: 'tool_call', id: 'toolu_1', name: 'lookup_order', arguments: { order_id: 'A-1042' } }] }]);
    // A user's text is the user's, and text that is not one printed block, whole, with what it must hold, is text.
    expect(messagesOf([{ role: 'user', content: [{ type: 'text', text: tool }] }])).toEqual([{ role: 'user', parts: [{ type: 'text', text: tool }] }]);
    for (const text of [`${tool} and more`, `Called ${tool}`, "TextBlock(citations=None, text='cut short", "TextBlock(citations=None, text=None, type='text')", "ToolUseBlock(id='toolu_1', input=['A-1042'], name='lookup_order', type='tool_use')"]) {
      expect(messagesOf([{ role: 'assistant', content: [{ type: 'text', text }] }])).toEqual([{ role: 'assistant', parts: [{ type: 'text', text }] }]);
    }
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
    expect(call.request).toMatchObject({ stream: true });
    expect(call.end.meta.headers?.['content-type']).toMatch(/text\/event-stream/);
    expect(call.response).toContain('event: message_stop');
    expect(call.end.meta).toMatchObject({ usage: { inputTokens: 10, outputTokens: 2 }, stopReason: 'end_turn' });
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
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it('accepts https anywhere and http on this machine only, and never a URL with credentials in it', () => {
    expect(traceStoreHost('https://langfuse.example.com/', 'Langfuse')).toBe('https://langfuse.example.com');
    expect(traceStoreHost('http://127.0.0.1:3000', 'Langfuse')).toBe('http://127.0.0.1:3000');
    expect(traceStoreHost('https://ls.example.com/api/v1?x=1', 'LangSmith')).toBe('https://ls.example.com/api/v1');
    expect(() => traceStoreHost('http://langfuse.internal:3000', 'Langfuse')).toThrow(/use https.*--allow-http/);
    expect(traceStoreHost('http://langfuse.internal:3000', 'Langfuse', { allowHttp: true })).toBe('http://langfuse.internal:3000');
    expect(traceStoreHost('http://127.0.0.2:3000', 'Langfuse')).toBe('http://127.0.0.2:3000');
    expect(traceStoreHost('http://[::1]:3000', 'Langfuse')).toBe('http://[::1]:3000');
    expect(() => traceStoreHost('https://pk:sk@cloud.langfuse.com', 'Langfuse')).toThrow(/credentials/);
    expect(() => traceStoreHost('ftp://x', 'Langfuse')).toThrow(/https/);
    expect(() => traceStoreHost('cloud.langfuse.com', 'Langfuse')).toThrow(/needs a URL/);
  });

  it('names what gave a refused address: --host, or the variable that held it, whose value it never repeats', () => {
    const refusal = (raw: string, from?: string) => {
      try {
        traceStoreHost(raw, 'Phoenix', from ? { from } : {});
      } catch (err) {
        return (err as Error).message;
      }
      return null;
    };
    expect(refusal('https://ops:hunter2@phoenix.example.com')).toBe('--host: leave credentials out of the URL; the keys come from the environment');
    expect(refusal('https://ops:hunter2@phoenix.example.com', 'PHOENIX_COLLECTOR_ENDPOINT')).toBe('PHOENIX_COLLECTOR_ENDPOINT: leave credentials out of the URL; the keys come from the environment');
    expect(refusal('http://phoenix.internal:6006', 'PHOENIX_BASE_URL')).toMatch(/^PHOENIX_BASE_URL: use https for phoenix\.internal:6006: /);
    expect(refusal('phoenix internal', '--host')).toBe('--host: Phoenix needs a URL such as http://localhost:6006 or https://app.phoenix.arize.com/s/your-space, not "phoenix internal"');
    expect(refusal('http://ops:hunter2@phoenix internal:6006', 'PHOENIX_ENDPOINT')).toBe('PHOENIX_ENDPOINT: Phoenix needs a URL such as http://localhost:6006 or https://app.phoenix.arize.com/s/your-space');
  });

  it("fetches a Langfuse trace's observations from the Observations API v2 a page at a time, with input and output sent as JSON text", async () => {
    const full = JSON.parse(fixture('langfuse-trace.json')) as { observations: Array<Record<string, unknown>> };
    // As the v2 API sends them: newest first, the JSON fields as text.
    const text = (v: unknown) => (v && typeof v === 'object' ? JSON.stringify(v) : v);
    const rows = full.observations.map((o) => ({ ...o, input: JSON.stringify(o.input ?? null), output: JSON.stringify(o.output ?? null), modelParameters: text(o.modelParameters), metadata: text(o.metadata) })).reverse();
    const seen: string[] = [];
    const host = await listen((req) => {
      seen.push(`${req.method} ${req.url}`);
      // The trace itself, asked for once more for its page in Langfuse.
      if (req.url === '/api/public/traces/7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07') return { status: 200, body: full };
      const cursor = new URL(req.url!, 'http://x').searchParams.get('cursor');
      return { status: 200, body: cursor ? { data: rows.slice(4), meta: { cursor: null } } : { data: rows.slice(0, 4), meta: { cursor: 'c-2' } } };
    });
    const trace = await fetchLangfuseTrace('7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07', { host, publicKey: 'pk-lf-1', secretKey: 'sk-lf-2' });
    expect(seen).toEqual([
      'GET /api/public/v2/observations?traceId=7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07&fields=core%2Cbasic%2Cio%2Cmodel%2Cusage%2Cmetadata&limit=1000',
      'GET /api/public/v2/observations?traceId=7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07&fields=core%2Cbasic%2Cio%2Cmodel%2Cusage%2Cmetadata&limit=1000&cursor=c-2',
      'GET /api/public/traces/7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07',
    ]);
    // In the order they started, each as the trace endpoint gives it, with the trace's page.
    expect(trace).toEqual({ id: '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07', observations: full.observations.map((o) => ({ ...o, input: o.input ?? null, output: o.output ?? null })), htmlPath: '/project/cm1shopproject/traces/7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07' });
    const read = readLangfuse(trace, host);
    expect(read.calls.filter((c) => c.kind === 'model')).toHaveLength(3);
    expect(read.url).toBe(`${host}/project/cm1shopproject/traces/7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07`);
  });

  it("keeps a Langfuse trace's page only on the host the API answered from, and imports a trace whose page doesn't answer", async () => {
    const at = 'https://cloud.langfuse.com';
    expect(langfusePage(at, '/project/cm1/traces/7f3a')).toBe('https://cloud.langfuse.com/project/cm1/traces/7f3a');
    expect(langfusePage('https://ops.example.com/langfuse', '/project/cm1/traces/7f3a')).toBe('https://ops.example.com/langfuse/project/cm1/traces/7f3a');
    for (const path of ['javascript:alert(1)', 'https://evil.example/project/cm1', '@evil.example/project/cm1', 'project/cm1/traces/7f3a', 42, null]) expect(langfusePage(at, path), String(path)).toBeUndefined();
    expect(readLangfuse({ id: '7f3a', observations: [], htmlPath: '/project/cm1/traces/7f3a' }).url).toBeUndefined();
    const full = JSON.parse(fixture('langfuse-trace.json')) as { observations: Array<Record<string, unknown>> };
    const host = await listen((req) => (req.url!.startsWith('/api/public/v2/') ? { status: 200, body: { data: full.observations, meta: { cursor: null } } } : { status: 500, body: { message: 'Internal Server Error' } }));
    const trace = await fetchLangfuseTrace('7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07', { host, publicKey: 'pk-lf-1', secretKey: 'sk-lf-2' });
    expect(trace.htmlPath).toBeUndefined();
    const read = readLangfuse(trace, host);
    expect(read.calls.filter((c) => c.kind === 'model')).toHaveLength(3);
    expect(read.url).toBeUndefined();
  });

  it("gives the trace's page a few seconds at most, and imports the trace without it when it takes longer", async () => {
    const id = '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07';
    const full = JSON.parse(fixture('langfuse-trace.json')) as { observations: Array<Record<string, unknown>> };
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    // Each request with the time limit it was given; the page answers only once that is up.
    const asked: Array<[string, number]> = [];
    const fake = (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      asked.push([url.pathname, timeout.mock.calls.at(-1)![0]]);
      if (url.pathname.startsWith('/api/public/v2/')) return Response.json({ data: full.observations, meta: { cursor: null } });
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error)));
    }) as unknown as typeof fetch;
    try {
      const keys = { host: 'https://cloud.langfuse.com', publicKey: 'pk-lf-1', secretKey: 'sk-lf-2', fetch: fake };
      const quick = await fetchLangfuseTrace(id, { ...keys, timeoutMs: 50 });
      expect(quick.htmlPath).toBeUndefined();
      expect((quick.observations as unknown[]).length).toBe(full.observations.length);
      // A request's whole time limit for the observations, and for the page no more than a few seconds.
      expect(asked).toEqual([
        ['/api/public/v2/observations', 50],
        [`/api/public/traces/${id}`, 50],
      ]);
      expect(PAGE_LINK_MS).toBeLessThanOrEqual(5_000);
      asked.length = 0;
      const answered = (async (input: string) => {
        const url = new URL(input);
        asked.push([url.pathname, timeout.mock.calls.at(-1)![0]]);
        return url.pathname.startsWith('/api/public/v2/') ? Response.json({ data: full.observations, meta: { cursor: null } }) : Response.json({ id, htmlPath: `/project/cm1/traces/${id}` });
      }) as unknown as typeof fetch;
      expect((await fetchLangfuseTrace(id, { ...keys, fetch: answered })).htmlPath).toBe(`/project/cm1/traces/${id}`);
      expect(asked.map(([, ms]) => ms)).toEqual([30_000, PAGE_LINK_MS]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('fetches a Langfuse trace with the project keys from a Langfuse without the v2 API, and its observations when the trace lists ids only', async () => {
    const full = JSON.parse(fixture('langfuse-trace.json')) as { observations: unknown[] };
    const seen: string[] = [];
    const host = await listen((req) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      if (req.url!.startsWith('/api/public/v2/')) return { status: 404, body: { message: 'Not Found' } };
      if (req.url === '/api/public/traces/7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07') return { status: 200, body: { ...full, observations: ['obs-gen-1', 'obs-tool-1'] } };
      const page = Number(new URL(req.url!, 'http://x').searchParams.get('page'));
      return { status: 200, body: { data: full.observations.slice((page - 1) * 4, page * 4), meta: { page, limit: 100, totalItems: 7, totalPages: 2 } } };
    });
    const trace = await fetchLangfuseTrace('7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07', { host, publicKey: 'pk-lf-1', secretKey: 'sk-lf-2' });
    expect((trace.observations as unknown[]).length).toBe(7);
    const basic = `Basic ${Buffer.from('pk-lf-1:sk-lf-2').toString('base64')}`;
    expect(seen).toEqual([
      `GET /api/public/v2/observations?traceId=7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07&fields=core%2Cbasic%2Cio%2Cmodel%2Cusage%2Cmetadata&limit=1000 ${basic}`,
      `GET /api/public/traces/7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07 ${basic}`,
      `GET /api/public/observations?traceId=7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07&page=1&limit=100 ${basic}`,
      `GET /api/public/observations?traceId=7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07&page=2&limit=100 ${basic}`,
    ]);
  });

  it('says why Langfuse refused, without the keys', async () => {
    const host = await listen(() => ({ status: 401, body: { message: 'Invalid credentials' } }));
    const err = await fetchLangfuseTrace('abc', { host, publicKey: 'pk-lf-1', secretKey: 'sk-lf-secret' }).catch((e: unknown) => e);
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

describe('import: the agents a trace names', () => {
  type OtlpSpan = { spanId: string; parentSpanId?: string; name: string; attributes: Array<{ key: string; value: { stringValue: string } }> };

  it('keeps on each model call the agent spans it ran inside, outermost first, for reading only', () => {
    const doc = JSON.parse(fixture('otel-genai.json')) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> };
    const spans = doc.resourceSpans[0]!.scopeSpans[0]!.spans;
    const support = spans.find((s) => s.spanId === '00f067aa0ba902b7')!;
    const agent = (spanId: string, parentSpanId: string, name: string): OtlpSpan => ({
      ...support,
      spanId,
      parentSpanId,
      name: `invoke_agent ${name}`,
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
        { key: 'gen_ai.agent.name', value: { stringValue: name } },
      ],
    });
    // A supervisor runs the support agent, then hands the second model call to billing.
    support.parentSpanId = 'b0b0b0b0b0b00001';
    spans.push(agent('b0b0b0b0b0b00001', '', 'supervisor'), agent('b0b0b0b0b0b00002', 'b0b0b0b0b0b00001', 'billing'));
    spans.find((s) => s.spanId === 'a1b2c3d4e5f60004')!.parentSpanId = 'b0b0b0b0b0b00002';
    const store = open();
    const { result } = importTrace(store, readOtel(parseOtlpFile(JSON.stringify(doc))).traces[0]!, { source: '/tmp/agents.json', labels: [] });
    const calls = store.getCalls(result.run.runId);
    expect(calls.map((c) => [c.kind, c.meta.agent])).toEqual([
      ['api', 'supervisor/support'],
      ['tool', undefined],
      ['api', 'supervisor/billing'],
    ]);
    // Never a scope: a replay matches the agent's calls as it sends them, with no scope of its own.
    expect(calls.every((c) => c.meta.scope === undefined)).toBe(true);
    store.close();
  });

  it("reads Langfuse's AGENT observations as the agent of the generations under them", () => {
    const trace = JSON.parse(fixture('langfuse-trace.json')) as { observations: Array<Record<string, unknown>> };
    trace.observations.find((o) => o.id === 'obs-agent-span')!.type = 'AGENT';
    const store = open();
    const { result } = importTrace(store, readLangfuse(trace), { source: 'langfuse', labels: [] });
    expect(store.getCalls(result.run.runId).filter((c) => c.kind === 'api').map((c) => c.meta.agent)).toEqual(['support-agent', 'support-agent', 'support-agent']);
    store.close();
  });

  it('names no agent where no span is one', () => {
    const store = open();
    const { result } = importTrace(store, readLangfuse(JSON.parse(fixture('langfuse-trace.json')) as Record<string, unknown>), { source: 'langfuse', labels: [] });
    expect(store.getCalls(result.run.runId).some((c) => c.meta.agent !== undefined)).toBe(false);
    store.close();
  });
});
