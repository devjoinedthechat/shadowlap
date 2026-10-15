import type { Skip } from './import-capture.js';
import {
  calledToolNames,
  clean,
  isObject,
  maybeJson,
  messageOf,
  messagesOf,
  num,
  outputOf,
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
 *   `gen_ai.tool.message` and `gen_ai.choice`.
 * Tool calls are `execute_tool` spans with `gen_ai.tool.name`, `gen_ai.tool.call.arguments` and
 * `gen_ai.tool.call.result` (or OpenLLMetry's `traceloop.entity.input` and `output`).
 */

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  start: number | null;
  end: number | null;
  attrs: Record<string, unknown>;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  error: string | null;
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
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  return Number(BigInt(v) / 1_000_000n);
}

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Rows of flattened attributes: `gen_ai.prompt.0.role`, `gen_ai.prompt.0.tool_calls.1.name` →
 * `[{ role, tool_calls: [, { name }] }]`, ordered by index.
 */
function indexed(attrs: Record<string, unknown>, prefix: string): Array<Record<string, unknown>> {
  const rows = new Map<number, Record<string, unknown>>();
  const head = `${prefix}.`;
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(head)) continue;
    const path = key.slice(head.length).split('.');
    const index = Number(path[0]);
    if (!Number.isInteger(index) || index < 0 || path.length < 2 || path.some((p) => UNSAFE.has(p))) continue;
    let node: Record<string, unknown> | unknown[] = rows.get(index) ?? {};
    rows.set(index, node as Record<string, unknown>);
    for (let i = 1; i < path.length; i++) {
      const seg = path[i]!;
      const last = i === path.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(path[i + 1]!);
      const container = node as Record<string, unknown>;
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
  if (rows.length) return withSystem(rows.map(messageOf).filter((m): m is TraceMessage => m !== null));
  const roles: Record<string, string> = { 'gen_ai.system.message': 'system', 'gen_ai.user.message': 'user', 'gen_ai.assistant.message': 'assistant', 'gen_ai.tool.message': 'tool' };
  const fromEvents = s.events
    .filter((e) => roles[e.name])
    .map((e) => {
      const body = eventBody(e);
      return messageOf({ ...body, role: roles[e.name], tool_calls: maybeJson(body.tool_calls), ...(roles[e.name] === 'tool' ? { tool_call_id: body.tool_call_id ?? body.id } : {}) });
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
  const op = String(a['gen_ai.operation.name'] ?? '');
  if (op === 'execute_tool' || a['traceloop.span.kind'] === 'tool') return 'tool';
  if (op === 'embeddings' || a['llm.request.type'] === 'embedding') return 'embedding';
  if (MODEL_OPERATIONS.has(op) || a['llm.request.type'] === 'chat' || a['llm.request.type'] === 'completion') return 'model';
  if (hasMessages(s) && (a['gen_ai.request.model'] !== undefined || a['gen_ai.system'] !== undefined || a['gen_ai.provider.name'] !== undefined)) return 'model';
  if (a['gen_ai.tool.name'] !== undefined) return 'tool';
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

function toolCall(s: Span): TraceToolCall {
  const a = s.attrs;
  const name = clean(str(a['gen_ai.tool.name']) ?? str(a['traceloop.entity.name']) ?? s.name.replace(/^execute_tool\s+/, ''), 200);
  const args = a['gen_ai.tool.call.arguments'] ?? (a['traceloop.entity.input'] !== undefined ? entityValue(a['traceloop.entity.input'], 'inputs') : undefined);
  const out = a['gen_ai.tool.call.result'] ?? (a['traceloop.entity.output'] !== undefined ? entityValue(a['traceloop.entity.output'], 'outputs') : undefined);
  return { kind: 'tool', what: `span ${s.name}`, name, callId: str(a['gen_ai.tool.call.id']), args: maybeJson(args), output: maybeJson(out), error: s.error, startedAt: s.start, endedAt: s.end };
}

function modelCall(s: Span): TraceModelCall {
  const a = s.attrs;
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
    startedAt: s.start,
    endedAt: s.end,
  };
}

function spansOf(payload: unknown): Span[] {
  const out: Span[] = [];
  const requests = Array.isArray(payload) ? payload : [payload];
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
          out.push({
            traceId: clean(raw.traceId, 64),
            spanId: String(raw.spanId ?? ''),
            parentSpanId: String(raw.parentSpanId ?? ''),
            name: clean(raw.name),
            start: nanosToMs(raw.startTimeUnixNano),
            end: nanosToMs(raw.endTimeUnixNano),
            attrs,
            events: (Array.isArray(raw.events) ? raw.events : []).filter(isObject).map((e) => ({ name: String(e.name ?? ''), attrs: attributes(e.attributes) })),
            error: failed ? clean(str(status.message) ?? str(attrs['error.type']) ?? 'error', 500) : null,
          });
        }
      }
    }
  }
  return out;
}

/** The OTLP requests in a file: one JSON object (or an array of them), or one object per line. */
export function parseOtlpFile(contents: string): unknown[] {
  const text = contents.replace(/^﻿/, '');
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
    if (!out.length) throw new Error('not OTLP JSON: expected an object with "resourceSpans", or one per line');
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
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);

  const traces: Trace[] = [];
  for (const [id, list] of byTrace) {
    const kinds = new Map(list.map((s) => [s.spanId, kindOf(s)]));
    // A framework's model span wraps the client library's: keep the one closest to the wire. Every
    // ancestor of a model span is a wrapper; the walk stops at a span already seen, so a file whose
    // parents form a loop cannot hang it.
    const byId = new Map(list.map((s) => [s.spanId, s]));
    const wrappers = new Set<string>();
    for (const s of list) {
      if (kinds.get(s.spanId) !== 'model') continue;
      const seen = new Set([s.spanId]);
      for (let parent = byId.get(s.parentSpanId); parent && !seen.has(parent.spanId) && !wrappers.has(parent.spanId); parent = byId.get(parent.parentSpanId)) {
        seen.add(parent.spanId);
        wrappers.add(parent.spanId);
      }
    }
    const skipped: Skip[] = [];
    const calls: TraceCall[] = [];
    for (const s of list) {
      const kind = kinds.get(s.spanId);
      if (kind === 'embedding') skipped.push({ url: `span ${s.name}`, reason: 'an embeddings call: only model and tool calls are imported' });
      else if (kind === 'model' && !wrappers.has(s.spanId)) calls.push(modelCall(s));
      else if (kind === 'tool') calls.push(toolCall(s));
    }
    // A span named after a tool the model asked for is that tool's call, whatever else it says.
    const asked = calledToolNames(calls);
    for (const s of list) {
      if (kinds.get(s.spanId) === null && asked.has(s.name) && (s.attrs['gen_ai.tool.call.arguments'] !== undefined || s.attrs['traceloop.entity.input'] !== undefined)) calls.push(toolCall(s));
    }
    // `shadowlap export otel` leaves prompt text out, so its traces hold no messages to replay.
    if (!calls.some((c) => c.kind === 'model' && c.messages.length) && list.some((s) => s.attrs['shadowlap.run.id'] !== undefined || s.attrs['shadowlap.call_no'] !== undefined)) {
      skipped.push({ url: `trace ${id}`, reason: 'exported by shadowlap export otel, which carries no prompt text: share the run as a pack instead (shadowlap pack, then shadowlap unpack)' });
    }
    traces.push({ id, calls, spans: list.length, skipped });
  }
  return { traces, spans: spans.length };
}
