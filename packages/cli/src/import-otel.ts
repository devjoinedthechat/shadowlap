import { isObject } from '@shadowlap/engine';
import type { Skip } from './import-capture.js';
import {
  calledToolNames,
  clean,
  maybeJson,
  traceMessageOf,
  messagesOf,
  num,
  outputOf,
  providerRequest,
  providerResponse,
  settingsOf,
  str,
  toolDefinitionsOf,
  type Trace,
  type TraceCall,
  type TraceMessage,
  type TraceModelCall,
  type TraceToolCall,
  type TraceUsage,
} from './import-trace.js';

/**
 * OpenTelemetry traces in OTLP JSON (what an OTLP/HTTP exporter sends, and what the collector's
 * file exporter writes, one object per line), read with the GenAI semantic conventions. A format
 * adapter only: import-trace.ts turns the calls into a recording.
 *
 * The conventions have moved, and instrumentations in the wild use every generation of them, so a
 * model call's messages are read from whichever the span carries:
 * - `gen_ai.input.messages` / `gen_ai.output.messages` (with `gen_ai.system_instructions` and
 *   `gen_ai.tool.definitions`), the current form;
 * - `gen_ai.prompt` / `gen_ai.completion`, as JSON on the span or on `gen_ai.content.prompt` and
 *   `gen_ai.content.completion` events, or flattened into `gen_ai.prompt.0.role`,
 *   `gen_ai.prompt.0.content`, … as OpenLLMetry writes them;
 * - the per-message events `gen_ai.system.message`, `gen_ai.user.message`, `gen_ai.assistant.message`,
 *   `gen_ai.tool.message` and `gen_ai.choice`, on the span or as log records (`resourceLogs`), which
 *   is where the official instrumentations (openai-v2, vertexai, google-genai) put them, tied to
 *   their span by its id;
 * - the `gen_ai.client.inference.operation.details` event, whose message attributes count as the span's.
 * Tool calls are `execute_tool` spans with `gen_ai.tool.name`, `gen_ai.tool.call.arguments` and
 * `gen_ai.tool.call.result` (or OpenLLMetry's `traceloop.entity.input` and `output`).
 *
 * OpenInference's conventions (Arize Phoenix, and the LlamaIndex, DSPy and smolagents
 * instrumentations) are read too: `openinference.span.kind` LLM and TOOL spans, with their messages
 * flattened under `llm.input_messages` and `llm.output_messages`, tools under `llm.tools`, and the
 * provider's own request and response in `input.value` and `output.value` where its OpenAI and
 * Anthropic instrumentations log them, which rebuild exactly.
 */

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  /** The instrumentation scope's name, e.g. `openinference.instrumentation.openai`. */
  scope: string;
  start: number | null;
  end: number | null;
  /** The start to the nanosecond, in decimal, where the source kept that. */
  startNs: string | null;
  attrs: Record<string, unknown>;
  events: SpanEvent[];
  error: string | null;
}

interface SpanEvent {
  name: string;
  attrs: Record<string, unknown>;
  /** Milliseconds, for putting a span's own events and its log records in one order. */
  time: number | null;
}

/** An OTLP `AnyValue`; plain values are taken as they are, for exporters that write attributes as an object. */
function anyValue(v: unknown): unknown {
  if (!isObject(v)) return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return num(v.intValue);
  if ('doubleValue' in v) return num(v.doubleValue);
  if ('boolValue' in v) return v.boolValue === true || v.boolValue === 'true';
  if ('arrayValue' in v) return (isObject(v.arrayValue) && Array.isArray(v.arrayValue.values) ? v.arrayValue.values : []).map(anyValue);
  if ('kvlistValue' in v) return attributes(isObject(v.kvlistValue) ? v.kvlistValue.values : []);
  if ('bytesValue' in v) return v.bytesValue;
  return undefined;
}

/** OTLP attributes (`[{ key, value }]`) as an object. Built with fromEntries, so no key reaches a prototype. */
function attributes(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return Object.fromEntries(raw.filter((a): a is Record<string, unknown> => isObject(a) && typeof a.key === 'string').map((a) => [a.key as string, anyValue(a.value)]));
  if (isObject(raw)) return Object.fromEntries(Object.entries(raw));
  return {};
}

/** Nanoseconds since the epoch (a string in OTLP JSON) as milliseconds. */
function nanosToMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v / 1e6);
  if (typeof v !== 'string' || !/^\d{1,25}$/.test(v)) return null;
  return Number(BigInt(v) / 1_000_000n);
}

/** Nanoseconds since the epoch (a string in OTLP JSON) in decimal, all of them. */
function nanos(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return `${BigInt(Math.floor(v))}`;
  if (typeof v !== 'string' || !/^\d{1,25}$/.test(v)) return null;
  return `${BigInt(v)}`;
}

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The largest index a flattened attribute may carry, at any depth. Real conversations and tool
 * call lists are far below it; an index from a file is otherwise an array length an attacker
 * chooses (`tool_calls.4294967294.name` would make a four-billion-slot array to walk).
 */
const MAX_INDEX = 1000;

/**
 * Rows of flattened attributes: `gen_ai.prompt.0.role`, `gen_ai.prompt.0.tool_calls.1.name` →
 * `[{ role, tool_calls: [, { name }] }]`, ordered by index. An attribute whose path holds an
 * index beyond {@link MAX_INDEX} is left out.
 */
function indexed(attrs: Record<string, unknown>, prefix: string): Array<Record<string, unknown>> {
  const rows = new Map<number, Record<string, unknown>>();
  const head = `${prefix}.`;
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(head)) continue;
    const path = key.slice(head.length).split('.');
    const index = /^\d{1,4}$/.test(path[0]!) ? Number(path[0]) : NaN;
    if (!(index <= MAX_INDEX) || path.length < 2 || path.some((p) => UNSAFE.has(p) || (/^\d+$/.test(p) && !(p.length <= 4 && Number(p) <= MAX_INDEX)))) continue;
    let node: Record<string, unknown> | unknown[] = rows.get(index) ?? {};
    rows.set(index, node);
    for (let i = 1; i < path.length; i++) {
      const seg = path[i]!;
      const last = i === path.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(path[i + 1]!);
      const container = node;
      if (last) container[seg] = value;
      else {
        if (typeof container[seg] !== 'object' || container[seg] === null) container[seg] = nextIsIndex ? [] : {};
        node = container[seg] as Record<string, unknown>;
      }
    }
  }
  return [...rows].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

/** An event's payload: its attributes, or a JSON body some instrumentations put in one attribute. */
function eventBody(e: Span['events'][number]): Record<string, unknown> {
  for (const key of ['body', 'event.body', 'gen_ai.event.content']) {
    const v = maybeJson(e.attrs[key]);
    if (isObject(v)) return v;
  }
  return e.attrs;
}

function inputMessages(s: Span): TraceMessage[] | null {
  const a = s.attrs;
  const system = maybeJson(a['gen_ai.system_instructions']);
  const withSystem = (list: TraceMessage[] | null) => {
    if (!list) return null;
    const text = typeof system === 'string' ? system : Array.isArray(system) ? system.map((p) => (isObject(p) ? String(p.content ?? p.text ?? '') : String(p))).join('') : '';
    return text && !list.some((m) => m.role === 'system') ? [{ role: 'system' as const, parts: [{ type: 'text' as const, text }] }, ...list] : list;
  };
  if (a['gen_ai.input.messages'] !== undefined) return withSystem(messagesOf(a['gen_ai.input.messages']));
  if (a['gen_ai.prompt'] !== undefined) return withSystem(messagesOf(a['gen_ai.prompt']));
  const promptEvent = s.events.find((e) => e.name === 'gen_ai.content.prompt');
  if (promptEvent && promptEvent.attrs['gen_ai.prompt'] !== undefined) return withSystem(messagesOf(promptEvent.attrs['gen_ai.prompt']));
  const rows = indexed(a, 'gen_ai.prompt');
  if (rows.length) return withSystem(rows.map(traceMessageOf).filter((m): m is TraceMessage => m !== null));
  const roles: Record<string, string> = { 'gen_ai.system.message': 'system', 'gen_ai.user.message': 'user', 'gen_ai.assistant.message': 'assistant', 'gen_ai.tool.message': 'tool' };
  const fromEvents = s.events
    .filter((e) => roles[e.name])
    .map((e) => {
      const body = eventBody(e);
      return traceMessageOf({ ...body, role: roles[e.name], tool_calls: maybeJson(body.tool_calls), ...(roles[e.name] === 'tool' ? { tool_call_id: body.tool_call_id ?? body.id } : {}) });
    })
    .filter((m): m is TraceMessage => m !== null);
  return fromEvents.length ? withSystem(fromEvents) : null;
}

function output(s: Span): TraceModelCall['output'] {
  const a = s.attrs;
  const finish = maybeJson(a['gen_ai.response.finish_reasons']);
  const finishReason = Array.isArray(finish) ? str(finish[0]) : str(finish);
  const withFinish = (o: TraceModelCall['output']) => (o ? { parts: o.parts, finishReason: o.finishReason ?? finishReason } : null);
  if (a['gen_ai.output.messages'] !== undefined) return withFinish(outputOf(a['gen_ai.output.messages']));
  if (a['gen_ai.completion'] !== undefined) return withFinish(outputOf(a['gen_ai.completion']));
  const completionEvent = s.events.find((e) => e.name === 'gen_ai.content.completion');
  if (completionEvent && completionEvent.attrs['gen_ai.completion'] !== undefined) return withFinish(outputOf(completionEvent.attrs['gen_ai.completion']));
  const rows = indexed(a, 'gen_ai.completion');
  if (rows.length) return withFinish(outputOf({ role: 'assistant', ...rows[0]! }));
  const choice = s.events.find((e) => e.name === 'gen_ai.choice');
  if (choice) {
    const body = eventBody(choice);
    const message = maybeJson(body.message);
    const out = outputOf({ role: 'assistant', ...(isObject(message) ? { ...message, tool_calls: maybeJson(message.tool_calls) } : {}) });
    return out ? { parts: out.parts, finishReason: str(body.finish_reason) ?? finishReason } : null;
  }
  return null;
}

function usage(a: Record<string, unknown>): TraceUsage | null {
  const input = num(a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens']);
  const out = num(a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens']);
  if (input === undefined && out === undefined) return null;
  const cacheRead = num(a['gen_ai.usage.cache_read.input_tokens'] ?? a['gen_ai.usage.cache_read_input_tokens']);
  const cacheWrite = num(a['gen_ai.usage.cache_creation.input_tokens'] ?? a['gen_ai.usage.cache_creation_input_tokens']);
  // The conventions count cached tokens as input too.
  return { input: input ?? 0, output: out ?? 0, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}), inputIncludesCache: true };
}

function tools(a: Record<string, unknown>): TraceModelCall['tools'] {
  const defined = toolDefinitionsOf(a['gen_ai.tool.definitions']);
  if (defined) return defined;
  const rows = indexed(a, 'llm.request.functions');
  return rows.length ? toolDefinitionsOf(rows.map((r) => ({ ...r, parameters: maybeJson(r.parameters) }))) : null;
}

const MODEL_OPERATIONS = new Set(['chat', 'text_completion', 'completion', 'generate_content']);

function hasMessages(s: Span): boolean {
  const a = s.attrs;
  return (
    a['gen_ai.input.messages'] !== undefined ||
    a['gen_ai.prompt'] !== undefined ||
    a['gen_ai.prompt.0.role'] !== undefined ||
    a['gen_ai.prompt.0.content'] !== undefined ||
    s.events.some((e) => e.name === 'gen_ai.content.prompt' || e.name.endsWith('.message'))
  );
}

function kindOf(s: Span): 'model' | 'tool' | 'embedding' | null {
  const a = s.attrs;
  if (typeof a['openinference.span.kind'] === 'string') {
    const kind = a['openinference.span.kind'].toUpperCase();
    return kind === 'LLM' ? 'model' : kind === 'TOOL' ? 'tool' : kind === 'EMBEDDING' ? 'embedding' : null;
  }
  const op = String(a['gen_ai.operation.name'] ?? '');
  if (op === 'execute_tool' || a['traceloop.span.kind'] === 'tool') return 'tool';
  if (op === 'embeddings' || a['llm.request.type'] === 'embedding') return 'embedding';
  if (MODEL_OPERATIONS.has(op) || a['llm.request.type'] === 'chat' || a['llm.request.type'] === 'completion') return 'model';
  if (hasMessages(s) && (a['gen_ai.request.model'] !== undefined || a['gen_ai.system'] !== undefined || a['gen_ai.provider.name'] !== undefined)) return 'model';
  if (a['gen_ai.tool.name'] !== undefined) return 'tool';
  return null;
}

/**
 * The agent a span is, by the conventions that mark one: any span naming `gen_ai.agent.name`, or
 * OpenTelemetry's `invoke_agent` operation (the OpenAI Agents SDK's instrumentations, Pydantic AI,
 * Strands and others); an OpenInference AGENT span (CrewAI, smolagents, LlamaIndex); OpenLLMetry's
 * agent spans; Pydantic AI's older `agent run`. Null for any other span.
 */
function agentOf(s: Span): string | null {
  const a = s.attrs;
  const named = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const own = named(a['gen_ai.agent.name']);
  if (own) return own;
  if (a['gen_ai.operation.name'] === 'invoke_agent') return named(s.name.replace(/^invoke_agent\b/, ''));
  if (typeof a['openinference.span.kind'] === 'string' && a['openinference.span.kind'].toUpperCase() === 'AGENT') return named(a['agent.name']) ?? named(s.name);
  if (a['traceloop.span.kind'] === 'agent') return named(a['traceloop.entity.name']) ?? named(s.name);
  if (s.name === 'agent run') return named(a['agent_name']);
  return null;
}

/** OpenLLMetry logs a decorated function's input as `{ args, kwargs }` and a chain's as `{ inputs }`. */
function entityValue(raw: unknown, key: 'inputs' | 'outputs'): unknown {
  const v = maybeJson(raw);
  if (!isObject(v)) return v;
  if (isObject(v.kwargs) && (!Array.isArray(v.args) || v.args.length === 0)) return v.kwargs;
  if (key in v) return v[key];
  return v;
}

/**
 * A span Logfire's SDK opened in a function, as `@logfire.instrument` opens one around it: the
 * function's arguments are attributes of their own, named in the span's `logfire.json_schema`, and
 * its return value is `return` (with `record_return=True`).
 */
function isLogfireFunction(s: Span): boolean {
  return typeof s.attrs['logfire.msg_template'] === 'string' && typeof s.attrs['code.function'] === 'string';
}

/**
 * The function a span of `@logfire.instrument` stands for when it kept the decorator's default
 * message, `Calling <module>.<function>` (`Calling tools.lookup_order` is `lookup_order`); null for
 * any other span, a span opened inside the function among them, which goes by a message of its own.
 */
function logfireDefaultName(s: Span): string | null {
  const fn = s.attrs['code.function'];
  const message = s.attrs['logfire.msg_template'];
  if (typeof fn !== 'string' || typeof message !== 'string' || s.name !== message) return null;
  if (message !== `Calling ${fn}` && !(message.startsWith('Calling ') && message.endsWith(`.${fn}`))) return null;
  return fn.split('.').pop() || null;
}

function logfireArguments(a: Record<string, unknown>): Record<string, unknown> {
  const schema = maybeJson(a['logfire.json_schema']);
  const named = isObject(schema) && isObject(schema.properties) ? Object.keys(schema.properties) : Object.keys(a).filter((k) => !k.startsWith('code.') && !k.startsWith('logfire.'));
  return Object.fromEntries(named.filter((k) => k !== 'return' && !UNSAFE.has(k) && a[k] !== undefined).map((k) => [k, maybeJson(a[k])]));
}

/** The tool a tool span ran, as its instrumentation names it. */
function toolNameOf(s: Span): string {
  const a = s.attrs;
  return clean(str(a['gen_ai.tool.name']) ?? str(a['tool.name']) ?? str(a['traceloop.entity.name']) ?? s.name.replace(/^execute_tool\s+/, ''), 200);
}

/** Where a call came from in its trace and when it ran: its span's id, start and end. */
function spanPlaced(s: Span): Pick<TraceToolCall, 'spanId' | 'startedAt' | 'endedAt' | 'startedAtNs'> {
  return { spanId: s.spanId, startedAt: s.start, endedAt: s.end, ...(s.startNs !== null ? { startedAtNs: s.startNs } : {}) };
}

/** A tool call out of its span; `name` when the span goes by something else (a function's message). */
function toolCall(s: Span, name = toolNameOf(s)): TraceToolCall {
  const a = s.attrs;
  const logfire = a['gen_ai.tool.call.arguments'] === undefined && a['traceloop.entity.input'] === undefined && a['input.value'] === undefined && isLogfireFunction(s);
  const args = logfire ? logfireArguments(a) : (a['gen_ai.tool.call.arguments'] ?? (a['traceloop.entity.input'] !== undefined ? entityValue(a['traceloop.entity.input'], 'inputs') : a['input.value']));
  const out = logfire ? a.return : (a['gen_ai.tool.call.result'] ?? (a['traceloop.entity.output'] !== undefined ? entityValue(a['traceloop.entity.output'], 'outputs') : a['output.value']));
  return { kind: 'tool', what: `span ${s.name}`, name, callId: str(a['gen_ai.tool.call.id']) ?? str(a['tool_call.id']), args: maybeJson(args), output: maybeJson(out), error: s.error, ...spanPlaced(s) };
}

/** OpenInference instrumentations whose `input.value` and `output.value` are the provider SDK's own request and response. */
const PROVIDER_SCOPES = /^openinference\.instrumentation\.(openai|anthropic)$/;

/** An OpenInference message (`message.role`, `message.content` or `message.contents`, `message.tool_calls`) in a shape traceMessageOf reads. */
function openInferenceMessage(row: Record<string, unknown>): Record<string, unknown> {
  const m = isObject(row.message) ? row.message : {};
  const contents = (Array.isArray(m.contents) ? m.contents : []).flatMap((c) => {
    const part = isObject(c) && isObject(c.message_content) ? c.message_content : null;
    return part && (part.type === undefined || part.type === 'text') && typeof part.text === 'string' ? [{ type: 'text', text: part.text }] : [];
  });
  const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).flatMap((t) => (isObject(t) && isObject(t.tool_call) ? [{ id: t.tool_call.id ?? '', function: isObject(t.tool_call.function) ? t.tool_call.function : {} }] : []));
  return {
    role: m.role,
    content: contents.length ? contents : m.content,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name !== undefined ? { name: m.name } : {}),
  };
}

/** A model call in OpenInference's conventions. */
function openInferenceModelCall(s: Span): TraceModelCall {
  const a = s.attrs;
  const params = maybeJson(a['llm.invocation_parameters']);
  const json = (value: unknown, type: unknown) => (type === undefined || type === 'application/json' ? maybeJson(value) : undefined);
  const input = json(a['input.value'], a['input.mime_type']);
  const raw = PROVIDER_SCOPES.test(s.scope) && isObject(input) ? providerRequest(input) : undefined;
  const response = PROVIDER_SCOPES.test(s.scope) ? providerResponse(json(a['output.value'], a['output.mime_type'])) : undefined;
  const outputs = indexed(a, 'llm.output_messages');
  const toolRows = indexed(a, 'llm.tools');
  const prompt = num(a['llm.token_count.prompt']);
  const completion = num(a['llm.token_count.completion']);
  const cacheRead = num(a['llm.token_count.prompt_details.cache_read']);
  const cacheWrite = num(a['llm.token_count.prompt_details.cache_write']);
  return {
    kind: 'model',
    what: `span ${s.name}`,
    provider: str(a['llm.provider']) ?? str(a['llm.system']),
    // The model asked for: llm.model_name is often the one that answered (a dated version of it), and
    // newer instrumentations name the one asked for apart.
    model: (raw && str(raw.model)) ?? (isObject(params) ? str(params.model) : null) ?? str(a['llm.request.model_name']) ?? str(a['llm.model_name']),
    messages: indexed(a, 'llm.input_messages')
      .map((row) => traceMessageOf(openInferenceMessage(row)))
      .filter((m): m is TraceMessage => m !== null),
    tools: toolRows.length ? toolDefinitionsOf(toolRows.map((r) => maybeJson(isObject(r.tool) ? r.tool.json_schema : undefined))) : raw ? toolDefinitionsOf(raw.tools) : null,
    settings: settingsOf(params, raw),
    stream: raw?.stream === true || (isObject(params) && params.stream === true),
    output: response ? outputOf(response) : outputs.length ? outputOf({ role: 'assistant', ...openInferenceMessage(outputs[0]!) }) : null,
    // OpenInference counts cached tokens in the prompt, as the GenAI conventions do.
    usage: prompt === undefined && completion === undefined ? null : { input: prompt ?? 0, output: completion ?? 0, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}), inputIncludesCache: true },
    error: s.error,
    ...(raw ? { rawRequest: raw } : {}),
    ...(response ? { rawResponse: response } : {}),
    responseId: response ? str(response.id) : null,
    ...spanPlaced(s),
  };
}

function modelCall(s: Span): TraceModelCall {
  const a = s.attrs;
  if (typeof a['openinference.span.kind'] === 'string') return openInferenceModelCall(s);
  return {
    kind: 'model',
    what: `span ${s.name}`,
    provider: str(a['gen_ai.provider.name']) ?? str(a['gen_ai.system']),
    model: str(a['gen_ai.request.model']) ?? str(a['gen_ai.response.model']),
    messages: inputMessages(s) ?? [],
    tools: tools(a),
    settings: settingsOf({
      temperature: a['gen_ai.request.temperature'],
      max_tokens: a['gen_ai.request.max_tokens'],
      top_p: a['gen_ai.request.top_p'],
      top_k: a['gen_ai.request.top_k'],
      stop: a['gen_ai.request.stop_sequences'],
      seed: a['gen_ai.request.seed'],
      frequency_penalty: a['gen_ai.request.frequency_penalty'],
      presence_penalty: a['gen_ai.request.presence_penalty'],
    }),
    stream: a['gen_ai.request.stream'] === true || a['llm.is_streaming'] === true,
    output: output(s),
    usage: usage(a),
    error: s.error,
    responseId: str(a['gen_ai.response.id']),
    ...spanPlaced(s),
  };
}

/** The message attributes a `gen_ai.client.inference.operation.details` event carries for its span. */
const DETAILS = ['gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions', 'gen_ai.tool.definitions'];

/** A span's attributes with what its `gen_ai.client.inference.operation.details` event carries, where the span has none of its own. */
function withDetails(attrs: Record<string, unknown>, events: SpanEvent[]): void {
  const details = events.find((e) => e.name === 'gen_ai.client.inference.operation.details');
  if (details) for (const key of DETAILS) if (attrs[key] === undefined && details.attrs[key] !== undefined) attrs[key] = details.attrs[key];
}

/**
 * GenAI events sent as log records (`resourceLogs`), by the span they belong to: `traceId/spanId`.
 * An event's name is the record's `eventName`, else its `event.name` attribute; its body joins its
 * attributes as `body`, where the per-message readers look for it.
 */
function logEventsOf(requests: unknown[]): Map<string, SpanEvent[]> {
  const out = new Map<string, SpanEvent[]>();
  for (const request of requests) {
    const resources = isObject(request) && Array.isArray(request.resourceLogs) ? request.resourceLogs : [];
    for (const rl of resources) {
      if (!isObject(rl)) continue;
      const scopes = Array.isArray(rl.scopeLogs) ? rl.scopeLogs : Array.isArray(rl.instrumentationLibraryLogs) ? rl.instrumentationLibraryLogs : [];
      for (const sl of scopes) {
        if (!isObject(sl) || !Array.isArray(sl.logRecords)) continue;
        for (const record of sl.logRecords) {
          if (!isObject(record)) continue;
          const attrs = attributes(record.attributes);
          const name = str(record.eventName) ?? str(attrs['event.name']) ?? '';
          if (!name.startsWith('gen_ai.') || typeof record.spanId !== 'string' || !record.spanId) continue;
          const key = `${clean(record.traceId, 64)}/${record.spanId}`;
          const body = anyValue(record.body);
          const event: SpanEvent = { name, attrs: { ...attrs, ...(body !== undefined ? { body } : {}) }, time: nanosToMs(record.timeUnixNano ?? record.observedTimeUnixNano) };
          // Appended in place: a copy per record is quadratic in a file's records for one span.
          const list = out.get(key);
          if (list) list.push(event);
          else out.set(key, [event]);
        }
      }
    }
  }
  return out;
}

function spansOf(payload: unknown): Span[] {
  const out: Span[] = [];
  const requests = Array.isArray(payload) ? payload : [payload];
  const logged = logEventsOf(requests);
  for (const request of requests) {
    // Grafana Tempo downloads a trace with the same content under `batches`.
    const resources = isObject(request) ? (Array.isArray(request.resourceSpans) ? request.resourceSpans : Array.isArray(request.batches) ? request.batches : null) : null;
    if (!resources) continue;
    for (const rs of resources) {
      if (!isObject(rs)) continue;
      const scopes = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : Array.isArray(rs.instrumentationLibrarySpans) ? rs.instrumentationLibrarySpans : [];
      for (const ss of scopes) {
        if (!isObject(ss) || !Array.isArray(ss.spans)) continue;
        for (const raw of ss.spans) {
          if (!isObject(raw)) continue;
          const status = isObject(raw.status) ? raw.status : {};
          const attrs = attributes(raw.attributes);
          const failed = status.code === 2 || status.code === 'STATUS_CODE_ERROR';
          const traceId = clean(raw.traceId, 64);
          const spanId = String(raw.spanId ?? '');
          const own: SpanEvent[] = (Array.isArray(raw.events) ? raw.events : []).filter(isObject).map((e) => ({ name: String(e.name ?? ''), attrs: attributes(e.attributes), time: nanosToMs(e.timeUnixNano) }));
          const fromLogs = logged.get(`${traceId}/${spanId}`) ?? [];
          // Stable, so events at the same instant keep the order they were written in.
          const events = fromLogs.length ? [...own, ...fromLogs].sort((a, b) => (a.time ?? 0) - (b.time ?? 0)) : own;
          withDetails(attrs, events);
          out.push({
            traceId,
            spanId,
            parentSpanId: String(raw.parentSpanId ?? ''),
            name: clean(raw.name),
            scope: isObject(ss.scope) ? String(ss.scope.name ?? '') : isObject(ss.instrumentationLibrary) ? String(ss.instrumentationLibrary.name ?? '') : '',
            start: nanosToMs(raw.startTimeUnixNano),
            end: nanosToMs(raw.endTimeUnixNano),
            startNs: nanos(raw.startTimeUnixNano),
            attrs,
            events,
            error: failed ? clean(str(status.message) ?? str(attrs['error.type']) ?? 'error', 500) : null,
          });
        }
      }
    }
  }
  return out;
}

/** The OTLP requests in a file: one JSON object (or an array of them), or one object per line. Traces and logs may sit in the same file or in separate ones. */
export function parseOtlpFile(contents: string): unknown[] {
  const text = contents.replace(/^\uFEFF/, '');
  try {
    const whole = JSON.parse(text) as unknown;
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    const lines = text.split('\n').filter((l) => l.trim());
    const out: unknown[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // a partly written last line of an exporter still appending
      }
    }
    if (!out.length) throw new Error('not OTLP JSON: expected an object with "resourceSpans" (or "resourceLogs"), or one per line');
    return out;
  }
}

export interface OtelRead {
  traces: Trace[];
  /** Spans in the file, of every kind. */
  spans: number;
}

/** Reads OTLP requests into one trace per trace id. Throws only when nothing in them is a span. */
export function readOtel(payloads: unknown[]): OtelRead {
  const spans = spansOf(payloads);
  if (!spans.length) throw new Error('not an OpenTelemetry trace: no spans under "resourceSpans" (or "batches", as Tempo writes it)');
  return { traces: tracesOf(spans), spans: spans.length };
}

/**
 * A span as a trace store's API returns it (Phoenix, Logfire), read as a file's span is: its
 * attributes an object, its times in milliseconds, its start to the precision the store keeps too
 * (epochNs), and its instrumentation's name where the store keeps it.
 */
export interface StoredSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  scope: string;
  start: number | null;
  end: number | null;
  startNs: string | null;
  attrs: Record<string, unknown>;
  events: Array<{ name: string; time: number | null; attrs: Record<string, unknown> }>;
  error: string | null;
}

/** Reads the spans a trace store returned into one trace per trace id, as readOtel reads a file's. */
export function readStoredSpans(stored: StoredSpan[]): OtelRead {
  const own = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !UNSAFE.has(k)));
  const spans = stored.map((s): Span => {
    const attrs = own(s.attrs);
    const events = s.events.map((e) => ({ name: e.name, attrs: own(e.attrs), time: e.time }));
    withDetails(attrs, events);
    return { traceId: clean(s.traceId, 64), spanId: s.spanId, parentSpanId: s.parentSpanId ?? '', name: clean(s.name), scope: s.scope, start: s.start, end: s.end, startNs: s.startNs, attrs, events, error: s.error === null ? null : clean(s.error, 500) };
  });
  return { traces: tracesOf(spans), spans: spans.length };
}

/** Whether a model span logged the messages it sent. */
function logsMessages(s: Span): boolean {
  if (typeof s.attrs['openinference.span.kind'] === 'string') return s.attrs['input.value'] !== undefined || indexed(s.attrs, 'llm.input_messages').length > 0;
  return (inputMessages(s)?.length ?? 0) > 0;
}

/**
 * A framework's model call, with what its client library's span says went on the wire: the request's
 * settings and streaming (Pydantic AI's span leaves out the max_tokens it sends), and its timing.
 */
function onTheWire(call: TraceModelCall, sent: Span | undefined): TraceModelCall {
  if (!sent) return call;
  const wire = modelCall(sent);
  return {
    ...call,
    model: wire.model ?? call.model,
    settings: { ...call.settings, ...wire.settings },
    stream: wire.stream || call.stream,
    usage: call.usage ?? wire.usage,
    responseId: call.responseId ?? wire.responseId,
    ...(wire.startedAt !== null ? { startedAt: wire.startedAt, ...(wire.startedAtNs !== undefined ? { startedAtNs: wire.startedAtNs } : {}) } : {}),
    endedAt: wire.endedAt ?? call.endedAt,
  };
}

/** Model and tool calls out of spans, one trace per trace id. */
function tracesOf(spans: Span[]): Trace[] {
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) {
    const list = byTrace.get(s.traceId);
    if (list) list.push(s);
    else byTrace.set(s.traceId, [s]);
  }

  const traces: Trace[] = [];
  for (const [id, list] of byTrace) {
    const kinds = new Map(list.map((s) => [s.spanId, kindOf(s)]));
    const byId = new Map(list.map((s) => [s.spanId, s]));
    // The spans above one, nearest first. The walk stops at a span already seen, so a file whose
    // parents form a loop cannot hang it.
    const above = (s: Span): Span[] => {
      const out: Span[] = [];
      const seen = new Set([s.spanId]);
      for (let parent = byId.get(s.parentSpanId); parent && !seen.has(parent.spanId); parent = byId.get(parent.parentSpanId)) {
        seen.add(parent.spanId);
        out.push(parent);
      }
      return out;
    };
    // A framework's model span wraps the client library's: keep the one closest to the wire, and
    // every model span above it is a wrapper. Unless the library's span logged no messages and the
    // framework's did (the Anthropic SDK's own span under Pydantic AI's): then the framework's span
    // keeps the call, and the library's lends it what went on the wire.
    const wire = new Map<string, Span>();
    const lent = new Set<string>();
    const wrappers = new Set<string>();
    for (const s of list) {
      if (kinds.get(s.spanId) !== 'model') continue;
      const parents = above(s);
      const framework = logsMessages(s) ? undefined : parents.find((p) => kinds.get(p.spanId) === 'model');
      if (framework && logsMessages(framework)) {
        lent.add(s.spanId);
        if (!wire.has(framework.spanId)) wire.set(framework.spanId, s);
        continue;
      }
      for (const p of parents) wrappers.add(p.spanId);
    }
    const skipped: Skip[] = [];
    // Each call by its span's place in the list, so that the calls keep the order the source listed them in.
    const found: Array<{ at: number; call: TraceCall }> = [];
    list.forEach((s, at) => {
      const kind = kinds.get(s.spanId);
      if (kind === 'embedding') skipped.push({ url: `span ${s.name}`, reason: 'an embeddings call: only model and tool calls are imported' });
      else if (kind === 'model' && !wrappers.has(s.spanId) && !lent.has(s.spanId)) found.push({ at, call: onTheWire(modelCall(s), wire.get(s.spanId)) });
      else if (kind === 'tool') found.push({ at, call: toolCall(s) });
    });
    // A span named after a tool the model asked for is that tool's call, whatever else it says, and so
    // is a function `@logfire.instrument` wrapped under its default message, by the function's name;
    // unless a tool span of that name above it holds the call already (Pydantic AI's runs the function).
    const asked = calledToolNames(found.map((f) => f.call));
    list.forEach((s, at) => {
      if (kinds.get(s.spanId) !== null) return;
      const fn = asked.has(s.name) ? null : logfireDefaultName(s);
      const name = asked.has(s.name) ? s.name : fn !== null && asked.has(fn) ? fn : null;
      if (name === null || !(s.attrs['gen_ai.tool.call.arguments'] !== undefined || s.attrs['traceloop.entity.input'] !== undefined || s.attrs['input.value'] !== undefined || isLogfireFunction(s))) return;
      if (above(s).some((p) => kinds.get(p.spanId) === 'tool' && toolNameOf(p) === name)) return;
      found.push({ at, call: fn === name ? toolCall(s, fn) : toolCall(s) });
    });
    const calls = found.sort((a, b) => a.at - b.at).map((f) => f.call);
    // `shadowlap export otel` leaves prompt text out, so its traces hold no messages to replay.
    if (!calls.some((c) => c.kind === 'model' && c.messages.length) && list.some((s) => s.attrs['shadowlap.run.id'] !== undefined || s.attrs['shadowlap.call_no'] !== undefined)) {
      skipped.push({ url: `trace ${id}`, reason: 'exported by shadowlap export otel, which carries no prompt text: share the run as a pack instead (shadowlap pack, then shadowlap unpack)' });
    }
    const parents = new Map(list.filter((s) => s.parentSpanId).map((s) => [s.spanId, s.parentSpanId]));
    const agents = new Map<string, string>();
    for (const s of list) {
      const name = agentOf(s);
      if (name !== null) agents.set(s.spanId, name);
    }
    traces.push({ id, calls, spans: list.length, skipped, parents, ...(agents.size ? { agents } : {}) });
  }
  return traces;
}
