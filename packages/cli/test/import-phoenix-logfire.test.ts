import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiRequest, Store } from '@shadowlap/engine';
import { fetchLogfireRecords, logfireHost, readLogfire } from '../src/import-logfire.js';
import { fetchPhoenixSpans, phoenixHostFromEnv, readPhoenix } from '../src/import-phoenix.js';
import { importTrace, providerRequest, type TraceModelCall, type TraceToolCall } from '../src/import-trace.js';

/**
 * The Phoenix and Logfire importers. The fixtures are what the real tools gave for one run of a refund
 * agent on the Anthropic SDK (order A-1042, refunded $240): Phoenix 20 answering its REST API for the
 * trace OpenInference's Anthropic instrumentation sent it, once from an agent that passes the request's
 * blocks back as plain dicts and once as the SDK's own objects; and the spans the Logfire SDK wrote,
 * with `logfire.instrument_anthropic()` and with Pydantic AI's instrumentation, as rows of the
 * `records` table its query API reads.
 */

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/traces/${name}`, import.meta.url), 'utf8')) as { data: Array<Record<string, unknown>> };
const PHOENIX_TRACE = '4a2db41deabc4aec332fb9fbfa0fc3e2';
const PHOENIX_SDK_OBJECTS = '3e4096353fce83a482ccbf37d3f1291c';
const LOGFIRE_ANTHROPIC = '01a16460e2f311342463057f62b79fa9';
const LOGFIRE_PYDANTIC_AI = '01a1645823196b3b712c68b9ad92e363';
const logfireRows = (trace: string) => fixture('logfire-records.json').data.filter((r) => r.trace_id === trace);

const models = (calls: Array<TraceModelCall | TraceToolCall>) => calls.filter((c): c is TraceModelCall => c.kind === 'model').sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
const tools = (calls: Array<TraceModelCall | TraceToolCall>) => calls.filter((c): c is TraceToolCall => c.kind === 'tool').sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
const turns = (c: TraceModelCall) => c.messages.map((m) => `${m.role}:${m.parts.map((p) => p.type).join('+')}`);

describe('import phoenix: OpenInference spans from its REST API', () => {
  it('reads LLM spans as model calls, rebuilt from the request the Anthropic instrumentation logged, and TOOL spans as tool calls', () => {
    const trace = readPhoenix(fixture('phoenix-spans.json').data, PHOENIX_TRACE);
    expect(trace).toMatchObject({ id: PHOENIX_TRACE, spans: 6, skipped: [] });
    const calls = models(trace.calls);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      // The model the agent asked for, not the one that answered (llm.model_name).
      expect(c).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', settings: { maxTokens: 1024 }, stream: false });
      expect(c.rawRequest).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 1024, system: 'You are a support agent. Follow the refund policy.' });
      expect(c.rawResponse).toMatchObject({ type: 'message', role: 'assistant' });
      expect(c.tools?.map((t) => t.name)).toEqual(['lookup_order', 'issue_refund']);
    }
    expect(calls.map((c) => c.output?.parts.map((p) => (p.type === 'tool_call' ? p.name : p.type)))).toEqual([['text', 'lookup_order'], ['text', 'issue_refund'], ['text']]);
    expect(tools(trace.calls).map((t) => [t.name, t.args, t.output])).toEqual([
      ['lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', total: 240, status: 'delivered' }],
      ['issue_refund', { order_id: 'A-1042', amount: 240 }, { refunded: 240, order_id: 'A-1042' }],
    ]);
  });

  it('rebuilds from the logged messages where the instrumentation logged the SDK\'s blocks as text', () => {
    const calls = models(readPhoenix(fixture('phoenix-spans-sdk-objects.json').data, PHOENIX_SDK_OBJECTS).calls);
    // The first request carries no blocks of the SDK's; the later ones logged `ToolUseBlock(id=…)`.
    expect(calls.map((c) => c.rawRequest !== undefined)).toEqual([true, false, false]);
    expect(calls.map((c) => c.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5']);
    expect(turns(calls[2])).toEqual(['system:text', 'user:text', 'assistant:text+tool_call', 'user:text', 'assistant:text+tool_call', 'user:text']);
    expect(JSON.stringify(calls)).not.toContain('ToolUseBlock(');
  });

  it('writes the trace as a run the dashboard and replay read, with each tool call that kept its output', () => {
    const store = Store.open(':memory:');
    const trace = readPhoenix(fixture('phoenix-spans.json').data, PHOENIX_TRACE);
    const { result, counts } = importTrace(store, trace, { source: 'phoenix:4a2db41d', labels: ['phoenix'], author: null });
    expect(counts).toMatchObject({ modelCalls: 3, modelCallsImported: 3, withToolDefinitions: 3, toolCalls: 2, toolCallsKept: 2 });
    expect(store.getCalls(result.run.runId).map((c) => (c.kind === 'api' ? 'model' : c.name))).toEqual(['model', 'lookup_order', 'model', 'issue_refund', 'model']);
    // The request the instrumentation logged holds no API version, nor does the call: a replay matches it whatever version the agent's SDK names.
    expect(store.getCalls(result.run.runId).filter((c) => c.kind === 'api').map((c) => c.meta.fingerprintHeaders)).toEqual([{}, {}, {}]);
    store.close();
  });
});

describe('import logfire: spans from its query API', () => {
  it('reads the GenAI spans logfire.instrument_anthropic() writes, and the functions @logfire.instrument wrapped as tool calls', () => {
    const trace = readLogfire(logfireRows(LOGFIRE_ANTHROPIC), LOGFIRE_ANTHROPIC);
    expect(trace).toMatchObject({ spans: 6, skipped: [] });
    const calls = models(trace.calls);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', settings: { maxTokens: 1024 }, tools: [{ name: 'lookup_order' }, { name: 'issue_refund' }] });
    // The system prompt comes from gen_ai.system_instructions; the conversation as Logfire logged it.
    expect(turns(calls[0])).toEqual(['system:text', 'user:text']);
    expect(tools(trace.calls).map((t) => [t.name, t.args, t.output])).toEqual([
      ['lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', total: 240, status: 'delivered' }],
      ['issue_refund', { order_id: 'A-1042', amount: 240 }, { refunded: 240, order_id: 'A-1042' }],
    ]);
  });

  it('reads back the blocks an agent handed back as the Anthropic SDK returned them, which Logfire logs as the SDK prints them', () => {
    // The agent passed reply.content back, and Logfire logged each block as str() of it.
    expect(JSON.stringify(logfireRows(LOGFIRE_ANTHROPIC))).toContain("ToolUseBlock(id='toolu_lookup_order_39', caller=None, input={'order_id': 'A-1042'}");
    const trace = readLogfire(logfireRows(LOGFIRE_ANTHROPIC), LOGFIRE_ANTHROPIC);
    const calls = models(trace.calls);
    expect(turns(calls[2])).toEqual(['system:text', 'user:text', 'assistant:text+tool_call', 'user:tool_result', 'assistant:text+tool_call', 'user:tool_result']);
    expect(JSON.stringify(calls)).not.toMatch(/TextBlock\(|ToolUseBlock\(/);
    const store = Store.open(':memory:');
    const { result } = importTrace(store, trace, { source: 'logfire:01a16460', labels: ['logfire'], author: null });
    const [, second] = store.getCalls(result.run.runId).filter((c) => c.kind === 'api');
    // The request the agent's SDK sent: the blocks as the API answered them, each tool result after the call it answers.
    expect((loadApiRequest(store, second.requestRef!) as { messages: unknown }).messages).toEqual([
      { role: 'user', content: 'Customer asks for a refund of order A-1042.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking up the order.' }, { type: 'tool_use', id: 'toolu_lookup_order_39', name: 'lookup_order', input: { order_id: 'A-1042' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_lookup_order_39', content: '{"order_id": "A-1042", "total": 240, "status": "delivered"}' }] },
    ]);
    store.close();
  });

  it("keeps Pydantic AI's call, with what the Anthropic SDK's own span says went on the wire", () => {
    const trace = readLogfire(logfireRows(LOGFIRE_PYDANTIC_AI), LOGFIRE_PYDANTIC_AI);
    // Ten spans: the agent's, each model request's, the SDK's request under each, and each tool's.
    expect(trace.spans).toBe(10);
    const calls = models(trace.calls);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      // Pydantic AI's span logs the conversation; the SDK's span under it the max_tokens and streaming it sent.
      expect(c).toMatchObject({ model: 'claude-sonnet-5', settings: { maxTokens: 128000 }, stream: true });
      expect(c.messages.length).toBeGreaterThan(1);
    }
    expect(turns(calls[2])).toEqual(['system:text', 'user:text', 'assistant:text+tool_call', 'user:tool_result', 'assistant:text+tool_call', 'user:tool_result']);
    expect(tools(trace.calls).map((t) => [t.name, t.callId])).toEqual([['lookup_order', 'toolu_lookup_order_11'], ['issue_refund', 'toolu_issue_refund_13']]);
  });

  it('reads JSON columns that arrive as text too', () => {
    const rows = logfireRows(LOGFIRE_ANTHROPIC).map((r) => ({ ...r, attributes: JSON.stringify(r.attributes), otel_events: JSON.stringify(r.otel_events) }));
    expect(models(readLogfire(rows, LOGFIRE_ANTHROPIC).calls)).toHaveLength(3);
  });

  it("reads a function @logfire.instrument wrapped under its default message as the tool of the function's name", () => {
    // `@logfire.instrument()` with no message names the span `Calling <module>.<function>`.
    const rows = logfireRows(LOGFIRE_ANTHROPIC).map((r) => {
      const a = r.attributes as Record<string, unknown>;
      if (a['code.function'] !== r.span_name) return r;
      const message = `Calling agent_common.${String(a['code.function'])}`;
      return { ...r, span_name: message, attributes: { ...a, 'logfire.msg_template': message } };
    });
    const kept = [
      ['lookup_order', { order_id: 'A-1042' }, { order_id: 'A-1042', total: 240, status: 'delivered' }],
      ['issue_refund', { order_id: 'A-1042', amount: 240 }, { refunded: 240, order_id: 'A-1042' }],
    ];
    expect(tools(readLogfire(rows, LOGFIRE_ANTHROPIC).calls).map((t) => [t.name, t.args, t.output])).toEqual(kept);
    // A span opened inside the function goes by a message of its own: it is no call of the tool.
    const fn = rows.find((r) => r.span_name === 'Calling agent_common.lookup_order')!;
    const inner = { ...fn, span_id: 'f00df00df00df00d', parent_span_id: fn.span_id, span_name: 'reading the orders table', attributes: { 'code.function': 'lookup_order', 'logfire.msg_template': 'reading the orders table' } };
    expect(tools(readLogfire([...rows, inner], LOGFIRE_ANTHROPIC).calls).map((t) => [t.name, t.args, t.output])).toEqual(kept);
  });

  it("takes Pydantic AI's tool call once when the function it runs is instrumented too", () => {
    const rows = logfireRows(LOGFIRE_PYDANTIC_AI);
    const tool = rows.find((r) => r.span_name === 'execute_tool lookup_order')!;
    const fn = (message: string) => ({
      ...tool,
      span_id: 'f00df00df00df00e',
      parent_span_id: tool.span_id,
      span_name: message,
      otel_scope_name: 'logfire',
      attributes: { 'code.function': 'lookup_order', 'logfire.msg_template': message, 'logfire.json_schema': { type: 'object', properties: { order_id: {} } }, order_id: 'A-1042' },
    });
    for (const message of ['Calling tools.lookup_order', 'lookup_order']) {
      expect(tools(readLogfire([...rows, fn(message)], LOGFIRE_PYDANTIC_AI).calls).map((t) => [t.name, t.callId]), message).toEqual([['lookup_order', 'toolu_lookup_order_11'], ['issue_refund', 'toolu_issue_refund_13']]);
    }
  });
});

describe('a request logged with its blocks as text is not the provider\'s', () => {
  it('reads plain requests, and not one whose content blocks are strings', () => {
    expect(providerRequest({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })).toBeDefined();
    expect(providerRequest({ model: 'claude-sonnet-5', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] })).toBeDefined();
    expect(providerRequest({ model: 'claude-sonnet-5', messages: [{ role: 'assistant', content: ["ToolUseBlock(id='toolu_1', name='lookup_order')"] }] })).toBeUndefined();
  });
});

describe('reading Phoenix and Logfire', () => {
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

  it("finds Phoenix where its own client does, and Logfire's region in the read token", () => {
    expect(phoenixHostFromEnv({ PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix.internal:6006/v1/traces' })).toEqual({ host: 'http://phoenix.internal:6006', from: 'PHOENIX_COLLECTOR_ENDPOINT' });
    expect(phoenixHostFromEnv({ PHOENIX_ENDPOINT: 'https://app.phoenix.arize.com/s/acme', PHOENIX_BASE_URL: 'http://ignored' })).toEqual({ host: 'https://app.phoenix.arize.com/s/acme', from: 'PHOENIX_ENDPOINT' });
    expect(phoenixHostFromEnv({})).toBeUndefined();
    expect(logfireHost('pylf_v1_eu_donotstore7a1c')).toBe('https://logfire-eu.pydantic.dev');
    expect(logfireHost('pylf_v1_us_donotstore7a1c')).toBe('https://logfire-us.pydantic.dev');
    // A token from before regions is a US one.
    expect(logfireHost('donotstore7a1c')).toBe('https://logfire-us.pydantic.dev');
  });

  it("fetches a trace's spans from Phoenix a page at a time, with the API key, and asks for no order the API doesn't take", async () => {
    const spans = fixture('phoenix-spans.json').data;
    const seen: string[] = [];
    const host = await listen((req) => {
      seen.push(`${req.url} ${req.headers.authorization}`);
      const cursor = new URL(req.url!, 'http://x').searchParams.get('cursor');
      return { status: 200, body: cursor ? { data: spans.slice(4), next_cursor: null } : { data: spans.slice(0, 4), next_cursor: 'U3Bhbjo0' } };
    });
    const got = await fetchPhoenixSpans(PHOENIX_TRACE, { host, apiKey: 'phx-key', project: 'support-agent' });
    expect(got).toHaveLength(6);
    expect(seen).toEqual([
      `/v1/projects/support-agent/spans?trace_id=${PHOENIX_TRACE}&limit=1000 Bearer phx-key`,
      `/v1/projects/support-agent/spans?trace_id=${PHOENIX_TRACE}&limit=1000&cursor=U3Bhbjo0 Bearer phx-key`,
    ]);
    // Phoenix lists the spans as it keeps them (newest first, here); the run is in the order they started.
    const store = Store.open(':memory:');
    const { result } = importTrace(store, readPhoenix(got, PHOENIX_TRACE), { source: 'phoenix:4a2db41d', labels: ['phoenix'], author: null });
    expect(store.getCalls(result.run.runId).map((c) => (c.kind === 'api' ? 'model' : c.name))).toEqual(['model', 'lookup_order', 'model', 'issue_refund', 'model']);
    store.close();
  });

  it('refuses a trace of more spans than it reads, rather than import part of one', async () => {
    let pages = 0;
    const host = await listen(() => {
      pages++;
      const data = Array.from({ length: 1000 }, (_, i) => ({ context: { trace_id: PHOENIX_TRACE, span_id: `${pages}-${i}` }, name: 'step', span_kind: 'CHAIN' }));
      return { status: 200, body: { data, next_cursor: `page-${pages + 1}` } };
    });
    await expect(fetchPhoenixSpans(PHOENIX_TRACE, { host, apiKey: null, project: 'default' })).rejects.toThrow('the trace has more than 20000 spans, more than an import reads from Phoenix: export it as OTLP JSON and use shadowlap import otel');
    expect(pages).toBe(20);
  });

  it('says why Phoenix refused, or why it has nothing to give', async () => {
    const refused = await listen(() => ({ status: 401, body: 'Unauthorized' }));
    await expect(fetchPhoenixSpans(PHOENIX_TRACE, { host: refused, apiKey: null, project: 'default' })).rejects.toThrow(/asks for an API key \(401\): set PHOENIX_API_KEY/);
    await expect(fetchPhoenixSpans(PHOENIX_TRACE, { host: refused, apiKey: 'phx-secret', project: 'default' })).rejects.toThrow(/refused the API key \(401\): check PHOENIX_API_KEY/);
    const noProject = await listen(() => ({ status: 404, body: 'Not Found' }));
    await expect(fetchPhoenixSpans(PHOENIX_TRACE, { host: noProject, apiKey: null, project: 'refunds' })).rejects.toThrow(/has no project refunds: give the trace's project with --project/);
    const empty = await listen(() => ({ status: 200, body: { data: [], next_cursor: null } }));
    await expect(fetchPhoenixSpans(PHOENIX_TRACE, { host: empty, apiKey: null, project: 'default' })).rejects.toThrow(/has no trace 4a2db41d\w+ in project default/);
    // A Phoenix older than 13.9 ignores the filter and lists the project's spans.
    const other = { context: { trace_id: 'f'.repeat(32), span_id: '1'.repeat(16) }, name: 'x', span_kind: 'LLM' };
    const old = await listen(() => ({ status: 200, body: { data: [other], next_cursor: null } }));
    await expect(fetchPhoenixSpans(PHOENIX_TRACE, { host: old, apiKey: null, project: 'default' })).rejects.toThrow(/older than 13\.9/);
    const notPhoenix = await listen(() => ({ status: 200, body: { hello: 'world' } }));
    await expect(fetchPhoenixSpans(PHOENIX_TRACE, { host: notPhoenix, apiKey: null, project: 'default' })).rejects.toThrow(/not a list of spans: is http:\/\/127\.0\.0\.1:\d+ Phoenix's address/);
  });

  it("queries a trace's spans from Logfire with the read token, from the start it is given", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const host = await listen((req, body) => {
      // As Logfire's own query client sends it: the token alone, with no scheme.
      expect(`${req.method} ${req.url} ${req.headers.authorization}`).toBe('POST /v2/query pylf_v1_us_test');
      const q = JSON.parse(body) as Record<string, unknown>;
      bodies.push(q);
      return { status: 200, body: { schema: { fields: [] }, data: logfireRows(LOGFIRE_ANTHROPIC) } };
    });
    const since = new Date('2026-09-22T00:00:00Z');
    expect(await fetchLogfireRecords(LOGFIRE_ANTHROPIC, { host, token: 'pylf_v1_us_test', since })).toHaveLength(6);
    expect(bodies[0]).toMatchObject({ min_timestamp: '2026-09-22T00:00:00.000Z', limit: 10_000 });
    expect(bodies[0].sql).toContain(`FROM records WHERE trace_id = '${LOGFIRE_ANTHROPIC}' AND kind = 'span' ORDER BY start_timestamp`);
  });

  it('says why Logfire refused, or had no such trace since the start given, without the token', async () => {
    const refused = await listen(() => ({ status: 401, body: { detail: 'Invalid read token' } }));
    const err = await fetchLogfireRecords(LOGFIRE_ANTHROPIC, { host: refused, token: 'pylf_v1_us_secret', since: new Date() }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/refused the read token \(401\): check LOGFIRE_READ_TOKEN/);
    expect((err as Error).message).not.toContain('pylf_v1_us_secret');
    const busy = await listen(() => ({ status: 429, body: {} }));
    await expect(fetchLogfireRecords(LOGFIRE_ANTHROPIC, { host: busy, token: 't', since: new Date() })).rejects.toThrow(/query budget/);
    const empty = await listen(() => ({ status: 200, body: { schema: { fields: [] }, data: [] } }));
    await expect(fetchLogfireRecords(LOGFIRE_ANTHROPIC, { host: empty, token: 't', since: new Date('2026-10-01T00:00:00Z') })).rejects.toThrow(/no trace 01a16460\w+ that started since 2026-10-01: for an older one, give --since/);
    // Only a trace id ever goes into the query.
    await expect(fetchLogfireRecords("x' OR '1'='1", { host: empty, token: 't', since: new Date() })).rejects.toThrow(/not a trace id/);
  });
});
