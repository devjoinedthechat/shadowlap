import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { readLangfuse } from '../src/import-langfuse.js';
import { readLangsmith } from '../src/import-langsmith.js';
import { readLogfire } from '../src/import-logfire.js';
import { readOtel } from '../src/import-otel.js';
import { readPhoenix } from '../src/import-phoenix.js';
import { callsInOrder, epochNs, importTrace, type Trace, type TraceModelCall, type TraceToolCall } from '../src/import-trace.js';

/**
 * The order an imported run holds its calls in. A tool and the model call that reads its result often
 * start in the same millisecond, and a store lists spans in an order of its own (Phoenix 20 lists them
 * newest first). Each source's trace is read with one of its tool calls 0.3 ms from a model call, and
 * at the same instant as one, its spans listed as the source lists them and the other way round.
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/traces/${name}`, import.meta.url), 'utf8');
type Span = Record<string, unknown>;

const MS = 1_000_000n;
/** Nanoseconds since the epoch, as an ISO timestamp to the microsecond with the zone a store writes. */
const iso = (ns: bigint, zone: string) => `${new Date(Number(ns / 1_000_000_000n) * 1000).toISOString().slice(0, 19)}.${String((ns % 1_000_000_000n) / 1000n).padStart(6, '0')}${zone}`;
/** An ISO timestamp's nanoseconds since the epoch, to the digit it is written to (no zone is UTC). */
function nanos(v: unknown): bigint {
  const [, seconds, fraction = '', zone = ''] = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(.*)$/.exec(String(v))!;
  return BigInt(Date.parse(`${seconds}${zone || 'Z'}`)) * 1_000_000n + BigInt(fraction.padEnd(9, '0').slice(0, 9));
}

/** A run's calls in the order it holds them: `model`, or the tool's name. */
function recorded(trace: Trace): string[] {
  const store = Store.open(':memory:');
  const { result } = importTrace(store, trace, { source: 's', author: null });
  const calls = store.getCalls(result.run.runId).map((c) => (c.kind === 'api' ? 'model' : c.name));
  store.close();
  return calls;
}

interface Source {
  name: string;
  spans: Span[];
  id: (s: Span) => string;
  start: (s: Span) => bigint;
  withStart: (s: Span, at: bigint) => Span;
  read: (spans: Span[]) => Trace;
  /** The spans of the model call that asks for the tool, of the tool's call, and of the model call that reads its result. */
  asks: string;
  tool: string;
  reads: string;
  /** The run's calls, in the order they ran. */
  run: string[];
}

const otlp = JSON.parse(fixture('otel-genai.json')) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> };
const langfuse = JSON.parse(fixture('langfuse-trace.json')) as Span & { observations: Span[] };
const logfire = (JSON.parse(fixture('logfire-records.json')) as { data: Span[] }).data;

const sources: Source[] = [
  {
    name: 'phoenix',
    spans: (JSON.parse(fixture('phoenix-spans.json')) as { data: Span[] }).data,
    id: (s) => (s.context as { span_id: string }).span_id,
    start: (s) => nanos(s.start_time),
    withStart: (s, at) => ({ ...s, start_time: iso(at, '+00:00') }),
    read: (spans) => readPhoenix(spans, '4a2db41deabc4aec332fb9fbfa0fc3e2'),
    asks: 'e3e958a9a606c82c',
    tool: '0ab2fc71b091e387',
    reads: '69b4df0e10edaca7',
    run: ['model', 'lookup_order', 'model', 'issue_refund', 'model'],
  },
  {
    name: 'logfire, from logfire.instrument_anthropic()',
    spans: logfire.filter((r) => r.trace_id === '01a16460e2f311342463057f62b79fa9'),
    id: (s) => String(s.span_id),
    start: (s) => nanos(s.start_timestamp),
    withStart: (s, at) => ({ ...s, start_timestamp: iso(at, 'Z') }),
    read: (rows) => readLogfire(rows, '01a16460e2f311342463057f62b79fa9'),
    asks: 'a129d5eec9fb9c29',
    tool: 'd62494b35918f108',
    reads: '2ddafd4491e3a41d',
    run: ['model', 'lookup_order', 'model', 'issue_refund', 'model'],
  },
  {
    // A model call starts when the Anthropic SDK's span under Pydantic AI's does.
    name: "logfire, from Pydantic AI's instrumentation",
    spans: logfire.filter((r) => r.trace_id === '01a1645823196b3b712c68b9ad92e363'),
    id: (s) => String(s.span_id),
    start: (s) => nanos(s.start_timestamp),
    withStart: (s, at) => ({ ...s, start_timestamp: iso(at, 'Z') }),
    read: (rows) => readLogfire(rows, '01a1645823196b3b712c68b9ad92e363'),
    asks: 'eaeeb1a080099a4f',
    tool: 'a88464946a433285',
    reads: 'b73c1e24b4d264cb',
    run: ['model', 'lookup_order', 'model', 'issue_refund', 'model'],
  },
  {
    name: 'langfuse',
    spans: langfuse.observations,
    id: (s) => String(s.id),
    start: (s) => nanos(s.startTime),
    withStart: (s, at) => ({ ...s, startTime: iso(at, 'Z') }),
    read: (observations) => readLangfuse({ ...langfuse, observations }),
    asks: 'obs-gen-1',
    tool: 'obs-tool-1',
    reads: 'obs-gen-2',
    run: ['model', 'lookup_order', 'model', 'model'],
  },
  {
    name: 'langsmith',
    spans: (JSON.parse(fixture('langsmith-runs.json')) as { pages: Array<{ runs: Span[] }> }).pages.flatMap((p) => p.runs),
    id: (s) => String(s.id),
    start: (s) => nanos(s.start_time),
    withStart: (s, at) => ({ ...s, start_time: iso(at, '') }),
    read: (runs) => readLangsmith(runs, '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c'),
    asks: '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b40',
    tool: '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b41',
    reads: '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b43',
    run: ['model', 'lookup_order', 'model'],
  },
  {
    name: 'otel',
    spans: otlp.resourceSpans[0]!.scopeSpans[0]!.spans,
    id: (s) => String(s.spanId),
    start: (s) => BigInt(String(s.startTimeUnixNano)),
    withStart: (s, at) => ({ ...s, startTimeUnixNano: String(at) }),
    read: (spans) => readOtel([{ resourceSpans: [{ ...otlp.resourceSpans[0], scopeSpans: [{ ...otlp.resourceSpans[0]!.scopeSpans[0], spans }] }] }]).traces[0]!,
    asks: 'a1b2c3d4e5f60001',
    tool: 'a1b2c3d4e5f60002',
    reads: 'a1b2c3d4e5f60004',
    run: ['model', 'lookup_order', 'model'],
  },
];

/** Where the tool's call starts, and the model call's beside it: in one millisecond, 0.3 ms apart, or at one instant. */
const timings: Array<[string, (src: Source, start: (id: string) => bigint) => Map<string, bigint>]> = [
  ['0.3 ms before the model call that reads its result', (src, start) => new Map([[src.tool, (start(src.reads) / MS) * MS + 100_000n], [src.reads, (start(src.reads) / MS) * MS + 400_000n]])],
  ['0.3 ms after the model call that asked for it', (src, start) => new Map([[src.asks, (start(src.asks) / MS) * MS + 100_000n], [src.tool, (start(src.asks) / MS) * MS + 400_000n]])],
  ['at the same instant as the model call that reads its result', (src, start) => new Map([[src.tool, start(src.reads)]])],
  ['at the same instant as the model call that asked for it', (src, start) => new Map([[src.tool, start(src.asks)]])],
];

describe.each(sources)('import $name: calls that start in the same millisecond', (src) => {
  it('holds the calls in the order they ran as the trace stands', () => {
    expect(recorded(src.read(src.spans))).toEqual(src.run);
    expect(recorded(src.read([...src.spans].reverse()))).toEqual(src.run);
  });

  it.each(timings)('holds a tool call %s in the order they ran, the spans listed either way', (_, timing) => {
    const start = (id: string) => src.start(src.spans.find((s) => src.id(s) === id)!);
    const starts = timing(src, start);
    const spans = src.spans.map((s) => (starts.has(src.id(s)) ? src.withStart(s, starts.get(src.id(s))!) : s));
    expect(recorded(src.read(spans))).toEqual(src.run);
    expect(recorded(src.read([...spans].reverse()))).toEqual(src.run);
  });

  it('reads which span each one ran inside', () => {
    const tool = src.spans.find((s) => src.id(s) === src.tool)!;
    const parent = tool.parent_id ?? tool.parent_span_id ?? tool.parentObservationId ?? tool.parent_run_id ?? tool.parentSpanId;
    expect(src.read(src.spans).parents?.get(src.tool)).toBe(parent);
  });
});

/** An OTLP span with string attributes, as an exporter writes it. */
function span(spanId: string, parentSpanId: string, name: string, start: bigint, attrs: Record<string, string>): Span {
  return { traceId: '5ce0e9a56015fec5aadfa328ae398115', spanId, parentSpanId, name, startTimeUnixNano: String(start), endTimeUnixNano: String(start + 2n * MS), attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })) };
}

describe('calls that start at one instant', () => {
  const t0 = 1_790_849_800_000_000_000n;

  it('go after the call they ran inside: a tool whose run asks a model of its own', () => {
    const research = span('b0000000000000a1', 'a0000000000000a0', 'execute_tool research', t0, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'research', 'gen_ai.tool.call.id': 'call_r1', 'gen_ai.tool.call.arguments': '{"topic":"refunds"}', 'gen_ai.tool.call.result': 'Refunds take 5 days.' });
    const inner = span('c0000000000000a2', 'b0000000000000a1', 'chat gpt-4.1-mini', t0, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-4.1-mini',
      'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'Summarize the refund policy.' }] }]),
      'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Refunds take 5 days.' }], finish_reason: 'stop' }]),
    });
    const agent = span('a0000000000000a0', '', 'invoke_agent support', t0 - MS, { 'gen_ai.operation.name': 'invoke_agent' });
    for (const spans of [[inner, research, agent], [agent, research, inner]]) {
      const [trace] = readOtel([{ resourceSpans: [{ scopeSpans: [{ spans }] }] }]).traces;
      expect(recorded(trace!)).toEqual(['research', 'model']);
    }
  });

  const model = (what: string, over: Partial<TraceModelCall> = {}): TraceModelCall => ({
    kind: 'model',
    what,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Where is A-1042?' }] }],
    tools: null,
    settings: {},
    stream: false,
    output: { parts: [{ type: 'text', text: 'On its way.' }], finishReason: 'end_turn' },
    usage: null,
    error: null,
    responseId: null,
    startedAt: 1_790_849_800_000,
    endedAt: 1_790_849_800_001,
    ...over,
  });
  const tool = (what: string, over: Partial<TraceToolCall> = {}): TraceToolCall => ({ kind: 'tool', what, name: 'lookup_order', callId: null, args: { order_id: 'A-1042' }, output: { status: 'shipped' }, error: null, startedAt: 1_790_849_800_000, endedAt: 1_790_849_800_000, ...over });
  const order = (trace: Omit<Trace, 'spans' | 'skipped'>) => callsInOrder({ spans: trace.calls.length, skipped: [], ...trace }).map((c) => c.what);
  const asks = (id: string) => ({ parts: [{ type: 'tool_call' as const, id, name: 'lookup_order', arguments: { order_id: 'A-1042' } }], finishReason: 'tool_use' });
  const reading = [
    { role: 'user' as const, parts: [{ type: 'text' as const, text: 'Where is A-1042?' }] },
    { role: 'assistant' as const, parts: [{ type: 'tool_call' as const, id: 'toolu_1', name: 'lookup_order', arguments: { order_id: 'A-1042' } }] },
    { role: 'tool' as const, parts: [{ type: 'tool_result' as const, id: 'toolu_1', content: '{"status": "shipped"}' }] },
  ];

  it('go in the order one needed another: the model call that asked, the tool, the model call that read its result', () => {
    const calls = [model('reads', { messages: reading }), tool('tool'), model('asks', { output: asks('toolu_1') })];
    expect(order({ id: 't', calls })).toEqual(['asks', 'tool', 'reads']);
    // By the tool call's id where both carry one, which a different call of the same tool doesn't match.
    expect(order({ id: 't', calls: [model('reads', { messages: reading }), tool('tool', { callId: 'toolu_1' })] })).toEqual(['tool', 'reads']);
    expect(order({ id: 't', calls: [model('reads', { messages: reading }), tool('another', { callId: 'toolu_2' })] })).toEqual(['reads', 'another']);
    // By the result alone, where the request names no call for it.
    expect(order({ id: 't', calls: [model('reads', { messages: [reading[0]!, { role: 'user', parts: [{ type: 'tool_result', id: 'toolu_1', content: [{ type: 'text', text: '{"status":"shipped"}' }] }] }] }), tool('tool')] })).toEqual(['tool', 'reads']);
  });

  it('keep the order listed where nothing orders them, or two orders contradict each other', () => {
    expect(order({ id: 't', calls: [tool('first'), model('second'), tool('third', { name: 'issue_refund' })] })).toEqual(['first', 'second', 'third']);
    // The same call made twice, neither carrying an id: a model call that asks for it again with its result in hand.
    expect(order({ id: 't', calls: [model('asks again', { messages: reading, output: asks('toolu_2') }), tool('tool')] })).toEqual(['asks again', 'tool']);
    expect(order({ id: 't', calls: [tool('tool'), model('asks again', { messages: reading, output: asks('toolu_2') })] })).toEqual(['tool', 'asks again']);
    // Spans whose parents form a loop.
    expect(order({ id: 't', calls: [model('a', { spanId: 'a' }), model('b', { spanId: 'b' })], parents: new Map([['a', 'x'], ['x', 'y'], ['y', 'x']]) })).toEqual(['a', 'b']);
  });

  it('go by their start first, to the nanosecond, whatever they say of each other', () => {
    // A clock that put the tool after the model call that read its result: the starts decide, as before.
    expect(order({ id: 't', calls: [tool('tool', { startedAt: 1_790_849_800_002 }), model('reads', { messages: reading })] })).toEqual(['reads', 'tool']);
    expect(order({ id: 't', calls: [model('b', { startedAtNs: '1790849800000000002' }), model('a', { startedAtNs: '1790849800000000001' }), model('no start', { startedAt: null })] })).toEqual(['no start', 'a', 'b']);
  });
});

describe('reading a start to the precision it was written in', () => {
  it('keeps the digits Date.parse drops, and reads what epochMs reads', () => {
    expect(epochNs('2026-10-22T16:10:33.590970Z')).toBe('1792685433590970000');
    expect(epochNs('2026-10-22T15:59:25.944685+00:00')).toBe('1792684765944685000');
    // LangSmith's have no zone: they are UTC.
    expect(epochNs('2026-10-01T10:36:40.311000')).toBe('1790851000311000000');
    expect(epochNs('2026-10-01T10:36:40.311000123Z')).toBe('1790851000311000123');
    expect(epochNs('2026-10-01T12:36:40.5+02:00')).toBe('1790851000500000000');
    expect(epochNs('2026-10-01T10:36:40Z')).toBe('1790851000000000000');
    expect(epochNs(1_790_851_000_311.25)).toBe('1790851000311250000');
    expect(epochNs('not a time')).toBeNull();
    expect(epochNs(null)).toBeNull();
  });
});
