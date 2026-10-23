import { canonicalize, safeLine, type Store } from '@shadowlap/engine';
import { append, ImportWriter, writeImport, type CapturedCall, type ImportOptions, type ImportResult, type Skip } from './import-capture.js';

/**
 * Building a recording out of a trace: OpenTelemetry spans, a Langfuse trace, LangSmith runs.
 *
 * A trace is not a capture. It keeps what its instrumentation logged — the messages, the model
 * settings, tool outputs when someone logged them, rarely the tool definitions — not the bytes that
 * crossed the network. So each source is read into the neutral calls below, and every model call is
 * rebuilt as the request its provider's SDK would have sent and the response it would have got,
 * then written through the same {@link ImportWriter} as a capture, with the same fingerprints.
 *
 * Replay matches a model call on its whole request. When the trace kept everything the agent sends
 * (LangSmith's wrapped clients log the request itself), a replay of your code is served from it;
 * when it left something out (tool definitions, a setting), the replay forks at the first model call
 * that differs and runs live from there, with writes fenced, which is still a faithful start.
 *
 * Tool calls replay only when the trace kept their arguments and their output. A tool whose every
 * call was kept is covered (`tool:<name>` in `meta.covers`); any other tool runs live on replay, and
 * its calls are left out rather than stored as calls a replay would never reach.
 */

// ---------------------------------------------------------------------------------------------- the neutral shape

export type Part =
  | { type: 'text'; text: string }
  /** `argumentsText`: the arguments exactly as the model wrote them, when the source kept that string (OpenAI's wire form). */
  | { type: 'tool_call'; id: string; name: string; arguments: unknown; argumentsText?: string }
  | { type: 'tool_result'; id: string; name?: string; content: unknown };

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TraceMessage {
  role: Role;
  parts: Part[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ModelSettings {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  stop?: string[];
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface TraceUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Whether `input` counts cached tokens too, as OpenTelemetry and LangSmith report it. */
  inputIncludesCache: boolean;
}

export interface TraceModelCall {
  kind: 'model';
  /** The span, observation or run it came from, for messages. */
  what: string;
  /** The provider or system the source named (`openai`, `anthropic`, `gcp.gemini`, …), if any. */
  provider: string | null;
  model: string | null;
  messages: TraceMessage[];
  tools: ToolDefinition[] | null;
  settings: ModelSettings;
  stream: boolean;
  output: { parts: Part[]; finishReason: string | null } | null;
  usage: TraceUsage | null;
  error: string | null;
  /** The request in the provider's own shape, when the source logged it whole (LangSmith's wrapped clients). */
  rawRequest?: Record<string, unknown>;
  /** The response in the provider's own shape, when the source logged it whole. */
  rawResponse?: Record<string, unknown>;
  responseId: string | null;
  /** Milliseconds since the epoch, as the store keeps a call's start. */
  startedAt: number | null;
  endedAt: number | null;
  /** The start to the precision the source kept it, in nanoseconds since the epoch ({@link epochNs}), which puts the calls in order. */
  startedAtNs?: string;
  /** The span, observation or run's id at the source. */
  spanId?: string;
}

export interface TraceToolCall {
  kind: 'tool';
  what: string;
  name: string;
  callId: string | null;
  /** The arguments as logged, or undefined when the source didn't keep them. */
  args: unknown;
  /** The output as logged, or undefined when the source didn't keep it. */
  output: unknown;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  startedAtNs?: string;
  spanId?: string;
}

export type TraceCall = TraceModelCall | TraceToolCall;

export interface Trace {
  /** The trace's id at its source. */
  id: string;
  /** Model and tool calls, in the order the source listed them: {@link callsInOrder} puts them in the order they ran. */
  calls: TraceCall[];
  /** Spans, observations or runs read, of every kind. */
  spans: number;
  /** Spans that looked like model or tool calls and could not be read, with the reason. */
  skipped: Skip[];
  /** The span, observation or run each one ran inside, by id, where the source names one. */
  parents?: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------------------------- reading what sources log

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON string parsed, or the value as it is. */
export function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return v;
  }
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * A name, id or message out of a trace, fit to print: a trace is a file from anywhere, and what it
 * names ends up in a terminal and the dashboard. Control characters are escaped and the length bounded.
 */
export function clean(v: unknown, max = 300): string {
  return safeLine(typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)).slice(0, max);
}

/** An ISO timestamp (LangSmith's have no zone: they are UTC) or epoch milliseconds. */
export function epochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || !v) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Epoch milliseconds, which may hold a fraction, as nanoseconds in decimal. */
function msToNs(ms: number): string {
  const whole = Math.floor(ms);
  return `${BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6))}`;
}

/**
 * What {@link epochMs} reads, to the precision it was written in, as nanoseconds since the epoch in
 * decimal. Date.parse keeps milliseconds, and the stores keep more (Phoenix, Logfire and LangSmith,
 * microseconds): a tool and the model call that reads its result often start in the same millisecond.
 */
export function epochNs(v: unknown): string | null {
  const ms = epochMs(v);
  if (ms === null) return null;
  const fraction = typeof v === 'string' ? /^(.*:\d\d)\.(\d+)(.*)$/.exec(v) : null;
  const seconds = fraction ? epochMs(`${fraction[1]}${fraction[3]}`) : null;
  if (!fraction || seconds === null) return msToNs(ms);
  return `${BigInt(seconds) * 1_000_000n + BigInt(fraction[2]!.slice(0, 9).padEnd(9, '0'))}`;
}

/** Where a call came from in its trace and when it ran: the id of its span, observation or run, and its start and end as the source wrote them. */
export function placed(id: unknown, start: unknown, end: unknown): Pick<TraceToolCall, 'spanId' | 'startedAt' | 'endedAt' | 'startedAtNs'> {
  const spanId = str(id);
  const ns = epochNs(start);
  return { ...(spanId ? { spanId } : {}), startedAt: epochMs(start), endedAt: epochMs(end), ...(ns !== null ? { startedAtNs: ns } : {}) };
}

/** Text out of whatever a source put in a content field: a string, text blocks, or anything else as JSON. */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((b) => (typeof b === 'string' ? b : isObject(b) && typeof b.text === 'string' ? b.text : isObject(b) && typeof b.content === 'string' ? b.content : ''))
      .join('');
  }
  if (v === null || v === undefined) return '';
  return JSON.stringify(v);
}

function roleOf(raw: unknown): Role | null {
  switch (typeof raw === 'string' ? raw.toLowerCase() : '') {
    case 'system':
    case 'developer':
      return 'system';
    case 'user':
    case 'human':
      return 'user';
    case 'assistant':
    case 'ai':
    case 'model':
      return 'assistant';
    case 'tool':
    case 'function':
    case 'tool_message':
      return 'tool';
    default:
      return null;
  }
}

/** LangChain serializes a message as `{ lc: 1, type: 'constructor', id: [..., 'AIMessage'], kwargs }`. */
function unwrapLangchain(m: Record<string, unknown>): Record<string, unknown> {
  if (m.lc === 1 && m.type === 'constructor' && Array.isArray(m.id) && isObject(m.kwargs)) {
    const cls = String(m.id[m.id.length - 1] ?? '');
    const type = /^Human/.test(cls) ? 'human' : /^AI/.test(cls) ? 'ai' : /^System/.test(cls) ? 'system' : /^Tool/.test(cls) ? 'tool' : /^Function/.test(cls) ? 'function' : /^Chat/.test(cls) ? String(m.kwargs.role ?? 'user') : '';
    return { ...m.kwargs, type: m.kwargs.type ?? type };
  }
  return m;
}

/** A tool call in any of the shapes sources log: OpenAI's, LangChain's, Anthropic's, Gemini's, OpenTelemetry's. */
function toolCallOf(raw: unknown): Part | null {
  if (!isObject(raw)) return null;
  // The model wrote the arguments as a string; the agent sends that string back, byte for byte.
  const text = (v: unknown) => (typeof v === 'string' && isObject(maybeJson(v)) ? { argumentsText: v } : {});
  if (isObject(raw.function)) {
    const name = str(raw.function.name);
    return name ? { type: 'tool_call', id: String(raw.id ?? ''), name, arguments: maybeJson(raw.function.arguments ?? {}), ...text(raw.function.arguments) } : null;
  }
  if (raw.type === 'tool_use' || raw.type === 'tool_call' || 'args' in raw || 'arguments' in raw || 'input' in raw) {
    const name = str(raw.name);
    if (!name) return null;
    const args = raw.args ?? raw.arguments ?? raw.input ?? {};
    return { type: 'tool_call', id: String(raw.id ?? ''), name, arguments: maybeJson(args), ...text(args) };
  }
  if (isObject(raw.functionCall)) {
    const name = str(raw.functionCall.name);
    return name ? { type: 'tool_call', id: String(raw.functionCall.id ?? ''), name, arguments: raw.functionCall.args ?? {} } : null;
  }
  return null;
}

/** The parts of one content value: text and tool blocks, from a string or a list of blocks. */
function partsOfContent(content: unknown, role: Role): Part[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return content === null || content === undefined ? [] : [{ type: 'text', text: textOf(content) }];
  const parts: Part[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) parts.push({ type: 'text', text: block });
      continue;
    }
    if (!isObject(block)) continue;
    const type = block.type;
    if ((type === 'text' || type === 'input_text' || type === 'output_text' || type === undefined) && typeof (block.text ?? block.content) === 'string' && !block.functionCall && !block.functionResponse) {
      parts.push({ type: 'text', text: String(block.text ?? block.content) });
    } else if (type === 'tool_result' || type === 'tool_call_response' || isObject(block.functionResponse)) {
      const fr = isObject(block.functionResponse) ? block.functionResponse : null;
      parts.push({
        type: 'tool_result',
        id: String(block.tool_use_id ?? block.id ?? fr?.id ?? ''),
        ...(str(block.name ?? fr?.name) ? { name: String(block.name ?? fr?.name) } : {}),
        content: fr ? fr.response : (block.content ?? block.response ?? block.result ?? ''),
      });
    } else {
      const call = toolCallOf(block);
      if (call && (role === 'assistant' || type === 'tool_use' || type === 'tool_call' || block.functionCall)) parts.push(call);
    }
  }
  return parts;
}

/** One message in any of the shapes sources log, or null when it is not one. */
export function messageOf(raw: unknown): TraceMessage | null {
  if (typeof raw === 'string') return { role: 'user', parts: [{ type: 'text', text: raw }] };
  if (!isObject(raw)) return null;
  const m = unwrapLangchain(raw);
  const role = roleOf(m.role ?? m.type);
  if (!role) return null;
  const parts = partsOfContent(m.parts ?? m.content, role);
  if (role === 'assistant') {
    const additional = isObject(m.additional_kwargs) ? m.additional_kwargs : {};
    const calls = Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : Array.isArray(additional.tool_calls) ? additional.tool_calls : [];
    const known = new Set(parts.filter((p) => p.type === 'tool_call').map((p) => (p as { id: string }).id));
    for (const c of calls) {
      const call = toolCallOf(c);
      if (call && call.type === 'tool_call' && !(call.id && known.has(call.id))) parts.push(call);
    }
    const legacy = isObject(m.function_call) ? m.function_call : isObject(additional.function_call) ? additional.function_call : null;
    if (legacy && !calls.length) {
      const call = toolCallOf({ function: legacy });
      if (call) parts.push(call);
    }
  }
  if (role === 'tool') {
    if (parts.some((p) => p.type === 'tool_result')) return { role, parts: parts.filter((p) => p.type === 'tool_result') };
    return { role, parts: [{ type: 'tool_result', id: String(m.tool_call_id ?? m.id ?? ''), ...(str(m.name) ? { name: String(m.name) } : {}), content: m.content ?? textOf(m.parts) }] };
  }
  return { role, parts };
}

/**
 * The input messages of a model call, out of whatever the source logged: a list of messages (or
 * LangChain's batch of lists), an object holding one, Gemini contents, or a bare prompt string.
 */
export function messagesOf(raw: unknown): TraceMessage[] | null {
  raw = maybeJson(raw);
  if (typeof raw === 'string') return raw ? [{ role: 'user', parts: [{ type: 'text', text: raw }] }] : null;
  let list: unknown[] | null = null;
  if (Array.isArray(raw)) list = raw;
  else if (isObject(raw)) {
    if (Array.isArray(raw.messages)) list = raw.messages;
    else if (Array.isArray(raw.contents)) list = raw.contents;
    else if (Array.isArray(raw.prompts) && typeof raw.prompts[0] === 'string') list = [raw.prompts[0]];
    else if (typeof raw.prompt === 'string') list = [raw.prompt];
    else if (typeof raw.input === 'string') list = [raw.input];
  }
  if (!list) return null;
  // LangChain logs a batch: one list of messages per prompt. A model call is one of them.
  if (list.length && Array.isArray(list[0])) list = list[0] as unknown[];
  const out: TraceMessage[] = [];
  if (isObject(raw) && !Array.isArray(raw) && (typeof raw.system === 'string' || Array.isArray(raw.system))) {
    out.push({ role: 'system', parts: [{ type: 'text', text: textOf(raw.system) }] });
  }
  for (const m of list) {
    const msg = messageOf(m);
    if (msg) out.push(msg);
  }
  return out.length ? out : null;
}

/** The answer of a model call, out of a provider response, a LangChain result, a message, a list of messages or text. */
export function outputOf(raw: unknown): TraceModelCall['output'] {
  raw = maybeJson(raw);
  if (typeof raw === 'string') return { parts: raw ? [{ type: 'text', text: raw }] : [], finishReason: null };
  if (Array.isArray(raw)) {
    for (const m of raw) {
      const out = outputOf(m);
      if (out) return out;
    }
    return null;
  }
  if (!isObject(raw)) return null;
  // OpenAI Chat Completions.
  if (Array.isArray(raw.choices) && isObject(raw.choices[0])) {
    const choice = raw.choices[0];
    const msg = messageOf({ role: 'assistant', ...(isObject(choice.message) ? choice.message : { content: choice.text ?? '' }) });
    return { parts: msg?.parts ?? [], finishReason: str(choice.finish_reason) };
  }
  // Anthropic Messages.
  if (raw.type === 'message' && Array.isArray(raw.content)) return { parts: partsOfContent(raw.content, 'assistant'), finishReason: str(raw.stop_reason) };
  // Gemini.
  if (Array.isArray(raw.candidates) && isObject(raw.candidates[0])) {
    const c = raw.candidates[0];
    return { parts: partsOfContent(isObject(c.content) ? c.content.parts : [], 'assistant'), finishReason: str(c.finishReason) };
  }
  // LangChain LLMResult.
  if (Array.isArray(raw.generations)) {
    const first = Array.isArray(raw.generations[0]) ? raw.generations[0][0] : raw.generations[0];
    if (!isObject(first)) return null;
    const info = isObject(first.generation_info) ? first.generation_info : {};
    const msg = isObject(first.message) ? messageOf({ type: 'ai', ...unwrapLangchain(first.message) }) : null;
    const meta = msg && isObject(first.message) && isObject(unwrapLangchain(first.message).response_metadata) ? (unwrapLangchain(first.message).response_metadata as Record<string, unknown>) : {};
    return { parts: msg?.parts.length ? msg.parts : typeof first.text === 'string' && first.text ? [{ type: 'text', text: first.text }] : [], finishReason: str(info.finish_reason ?? meta.finish_reason ?? meta.stop_reason) };
  }
  // A wrapped output: `{ output: … }`, as some tracers log it.
  if ('output' in raw && Object.keys(raw).length === 1) return outputOf(raw.output);
  // A message: OpenAI's, LangChain's, OpenTelemetry's.
  const msg = messageOf({ role: 'assistant', ...unwrapLangchain(raw) });
  if (msg && (msg.role === 'assistant' || msg.role === 'user')) return { parts: msg.parts, finishReason: str(raw.finish_reason ?? raw.stop_reason) };
  return null;
}

/** Tool definitions in OpenAI's, Anthropic's, Gemini's or OpenTelemetry's shape. */
export function toolDefinitionsOf(raw: unknown): ToolDefinition[] | null {
  raw = maybeJson(raw);
  if (!Array.isArray(raw)) return null;
  const out: ToolDefinition[] = [];
  for (const t of raw) {
    if (!isObject(t)) continue;
    if (Array.isArray(t.functionDeclarations)) {
      for (const f of t.functionDeclarations) if (isObject(f) && str(f.name)) out.push({ name: String(f.name), ...(str(f.description) ? { description: String(f.description) } : {}), ...(f.parameters !== undefined ? { parameters: f.parameters } : {}) });
      continue;
    }
    const f = isObject(t.function) ? t.function : t;
    const name = str(f.name);
    if (!name) continue;
    const parameters = f.parameters ?? f.input_schema ?? f.inputSchema;
    out.push({ name, ...(str(f.description) ? { description: String(f.description) } : {}), ...(parameters !== undefined ? { parameters } : {}) });
  }
  return out.length ? out : null;
}

/** Model settings out of an object of request parameters, in any provider's spelling. */
export function settingsOf(...sources: unknown[]): ModelSettings {
  const s: ModelSettings = {};
  for (const raw of sources) {
    if (!isObject(raw)) continue;
    const pick = (...keys: string[]) => {
      for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k];
      return undefined;
    };
    const set = <K extends keyof ModelSettings>(key: K, v: ModelSettings[K] | undefined) => {
      if (v !== undefined && s[key] === undefined) s[key] = v;
    };
    set('temperature', num(pick('temperature', 'ls_temperature')));
    set('maxTokens', num(pick('max_tokens', 'maxTokens', 'max_output_tokens', 'maxOutputTokens', 'max_completion_tokens', 'ls_max_tokens')));
    set('topP', num(pick('top_p', 'topP')));
    set('topK', num(pick('top_k', 'topK')));
    set('seed', num(pick('seed')));
    set('frequencyPenalty', num(pick('frequency_penalty', 'frequencyPenalty')));
    set('presencePenalty', num(pick('presence_penalty', 'presencePenalty')));
    const stop = maybeJson(pick('stop', 'stop_sequences', 'stopSequences', 'ls_stop'));
    if (Array.isArray(stop) && stop.every((x) => typeof x === 'string') && stop.length) set('stop', stop as string[]);
    else if (typeof stop === 'string' && stop) set('stop', [stop]);
  }
  return s;
}

/**
 * The request a source logged as a call's input, when it is the provider's own request (LangSmith's
 * wrapped clients, OpenInference's OpenAI and Anthropic instrumentations): a model and plain role
 * messages. LangChain's serialized messages are not a provider's, nor is a request whose content
 * blocks were logged as text: an instrumentation that logs with `json.dumps(…, default=str)` turns
 * the SDK's own blocks, which an agent passes back as it got them, into `ToolUseBlock(id=…)`.
 */
export function providerRequest(inputs: Record<string, unknown>): Record<string, unknown> | undefined {
  const messages = inputs.messages;
  if (typeof inputs.model !== 'string' || !Array.isArray(messages) || Array.isArray(messages[0])) return undefined;
  if (!messages.every((m) => isObject(m) && typeof m.role === 'string')) return undefined;
  if (messages.some((m) => Array.isArray((m as Record<string, unknown>).content) && ((m as Record<string, unknown>).content as unknown[]).some((block) => !isObject(block)))) return undefined;
  return inputs;
}

/** The response a source logged as a call's output, when it is the provider's own response. */
export function providerResponse(outputs: unknown): Record<string, unknown> | undefined {
  if (!isObject(outputs)) return undefined;
  if (Array.isArray(outputs.choices) || (outputs.type === 'message' && Array.isArray(outputs.content)) || Array.isArray(outputs.candidates)) return outputs;
  return undefined;
}

/** The tool names a model call asked for, so a span named after one can be read as that tool's call. */
export function calledToolNames(calls: TraceCall[]): Set<string> {
  const names = new Set<string>();
  for (const c of calls) if (c.kind === 'model') for (const p of c.output?.parts ?? []) if (p.type === 'tool_call') names.add(p.name);
  return names;
}

// ---------------------------------------------------------------------------------------------- rebuilding requests and responses

export type Dialect = 'anthropic' | 'openai' | 'gemini';

/**
 * Which wire format to rebuild a call in: the provider the source names, else the model's family.
 * OpenAI's is the default, because most other servers speak it.
 */
export function dialectOf(provider: string | null, model: string | null): Dialect {
  const p = (provider ?? '').toLowerCase();
  const m = (model ?? '').toLowerCase();
  if (/anthropic|claude/.test(p)) return 'anthropic';
  if (/gemini|google|vertex/.test(p)) return /claude/.test(m) ? 'anthropic' : 'gemini';
  if (/bedrock|aws/.test(p)) return /claude|anthropic/.test(m) ? 'anthropic' : 'openai';
  if (p) return 'openai';
  if (/claude/.test(m)) return 'anthropic';
  if (/gemini/.test(m)) return 'gemini';
  return 'openai';
}

const HOSTS: Record<Dialect, string> = { anthropic: 'api.anthropic.com', openai: 'api.openai.com', gemini: 'generativelanguage.googleapis.com' };

/** Client options the wrapped SDK calls accept that never reach the wire. */
const CLIENT_ONLY = ['extra_headers', 'extra_query', 'extra_body', 'timeout', 'max_retries'];

const argsText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? {}));
const resultText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));

function systemText(messages: TraceMessage[]): string | null {
  const texts = messages.filter((m) => m.role === 'system').map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
  return texts.length ? texts.join('\n\n') : null;
}

function openaiMessages(messages: TraceMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    const text = m.parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
    if (m.role === 'system') out.push({ role: 'system', content: text });
    else if (m.role === 'assistant') {
      const calls = m.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
      out.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argumentsText ?? argsText(c.arguments) } })) } : {}) });
    } else {
      // A tool result is its own message in this dialect, wherever the source put it.
      for (const p of m.parts) if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.id, content: resultText(p.content) });
      if (m.role === 'user' && (text || !m.parts.some((p) => p.type === 'tool_result'))) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

function anthropicMessages(messages: TraceMessage[]): unknown[] {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') {
      const content = m.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : p.type === 'tool_call' ? { type: 'tool_use', id: p.id, name: p.name, input: isObject(p.arguments) ? p.arguments : {} } : null)).filter(Boolean);
      out.push({ role: 'assistant', content });
      continue;
    }
    const blocks = m.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : p.type === 'tool_result' ? { type: 'tool_result', tool_use_id: p.id, content: resultText(p.content) } : null)).filter(Boolean) as Array<Record<string, unknown>>;
    const prev = out[out.length - 1];
    // Consecutive tool results go back to the model as one user turn, which the API requires.
    if (m.role === 'tool' && prev?.role === 'user' && Array.isArray(prev.content) && prev.content.every((b) => isObject(b) && b.type === 'tool_result')) {
      append(prev.content as unknown[], blocks);
      continue;
    }
    out.push({ role: 'user', content: blocks.length === 1 && blocks[0]!.type === 'text' ? blocks[0]!.text : blocks });
  }
  return out;
}

function geminiParts(m: TraceMessage, names: Map<string, string>): unknown[] {
  return m.parts.map((p) => {
    if (p.type === 'text') return { text: p.text };
    if (p.type === 'tool_call') return { functionCall: { name: p.name, args: isObject(p.arguments) ? p.arguments : {} } };
    const response = isObject(p.content) ? p.content : { output: p.content };
    return { functionResponse: { name: p.name ?? names.get(p.id) ?? '', response } };
  });
}

function geminiContents(messages: TraceMessage[]): unknown[] {
  const names = new Map<string, string>();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool_call' && p.id) names.set(p.id, p.name);
  return messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m, names) }));
}

interface Rebuilt {
  path: string;
  /** The query string the client adds (Gemini streams with `?alt=sse`). */
  search: string;
  body: Record<string, unknown>;
}

/** The request a provider SDK would have sent for this call. */
export function rebuildRequest(c: TraceModelCall, dialect: Dialect): Rebuilt {
  const s = c.settings;
  const model = c.model ?? (typeof c.rawRequest?.model === 'string' ? c.rawRequest.model : 'unknown');
  if (c.rawRequest) {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.rawRequest)) if (!CLIENT_ONLY.includes(k) && v !== undefined) body[k] = v;
    if (dialect === 'gemini') {
      const { model: m, ...rest } = body;
      return { path: `/v1beta/models/${encodeURIComponent(String(m ?? model))}:${c.stream ? 'streamGenerateContent' : 'generateContent'}`, search: c.stream ? '?alt=sse' : '', body: rest };
    }
    return { path: dialect === 'anthropic' ? '/v1/messages' : '/v1/chat/completions', search: '', body };
  }
  if (dialect === 'anthropic') {
    const system = systemText(c.messages);
    return {
      path: '/v1/messages',
      search: '',
      body: {
        model,
        ...(s.maxTokens !== undefined ? { max_tokens: s.maxTokens } : {}),
        ...(system !== null ? { system } : {}),
        messages: anthropicMessages(c.messages),
        ...(c.tools ? { tools: c.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.parameters ?? { type: 'object', properties: {} } })) } : {}),
        ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
        ...(s.topP !== undefined ? { top_p: s.topP } : {}),
        ...(s.topK !== undefined ? { top_k: s.topK } : {}),
        ...(s.stop ? { stop_sequences: s.stop } : {}),
        ...(c.stream ? { stream: true } : {}),
      },
    };
  }
  if (dialect === 'gemini') {
    const system = systemText(c.messages);
    const generationConfig = {
      ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
      ...(s.maxTokens !== undefined ? { maxOutputTokens: s.maxTokens } : {}),
      ...(s.topP !== undefined ? { topP: s.topP } : {}),
      ...(s.topK !== undefined ? { topK: s.topK } : {}),
      ...(s.stop ? { stopSequences: s.stop } : {}),
      ...(s.seed !== undefined ? { seed: s.seed } : {}),
    };
    return {
      path: `/v1beta/models/${encodeURIComponent(model)}:${c.stream ? 'streamGenerateContent' : 'generateContent'}`,
      search: c.stream ? '?alt=sse' : '',
      body: {
        contents: geminiContents(c.messages),
        ...(system !== null ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        ...(c.tools ? { tools: [{ functionDeclarations: c.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.parameters !== undefined ? { parameters: t.parameters } : {}) })) }] } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      },
    };
  }
  return {
    path: '/v1/chat/completions',
    search: '',
    body: {
      model,
      messages: openaiMessages(c.messages),
      ...(c.tools ? { tools: c.tools.map((t) => ({ type: 'function', function: { name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.parameters !== undefined ? { parameters: t.parameters } : {}) } })) } : {}),
      ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
      ...(s.maxTokens !== undefined ? { max_tokens: s.maxTokens } : {}),
      ...(s.topP !== undefined ? { top_p: s.topP } : {}),
      ...(s.stop ? { stop: s.stop } : {}),
      ...(s.seed !== undefined ? { seed: s.seed } : {}),
      ...(s.frequencyPenalty !== undefined ? { frequency_penalty: s.frequencyPenalty } : {}),
      ...(s.presencePenalty !== undefined ? { presence_penalty: s.presencePenalty } : {}),
      ...(c.stream ? { stream: true } : {}),
    },
  };
}

type Finish = 'stop' | 'tool' | 'length' | 'filter';

function finishOf(reason: string | null, parts: Part[]): Finish {
  const r = (reason ?? '').toLowerCase();
  if (/tool|function/.test(r)) return 'tool';
  if (/length|max_tokens|max_output/.test(r)) return 'length';
  if (/filter|safety|refusal/.test(r)) return 'filter';
  if (!r && parts.some((p) => p.type === 'tool_call')) return 'tool';
  return 'stop';
}

function usageNumbers(u: TraceUsage | null): { uncached: number; total: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (!u) return null;
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const uncached = u.inputIncludesCache ? Math.max(0, u.input - cacheRead - cacheWrite) : u.input;
  return { uncached, total: uncached + cacheRead + cacheWrite, output: u.output, cacheRead, cacheWrite };
}

const sse = (events: Array<[string | null, unknown]>, sep = '\n\n') => events.map(([event, data]) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}${sep}`).join('');

/** The response the provider would have sent for this call: JSON, or an event stream when the call streamed. */
export function rebuildResponse(c: TraceModelCall, dialect: Dialect, n: number, request: Record<string, unknown>): { contentType: string; bytes: Buffer } {
  const parts = c.output?.parts ?? [];
  const finish = finishOf(c.output?.finishReason ?? null, parts);
  const model = c.model ?? (typeof request.model === 'string' ? request.model : 'unknown');
  const usage = usageNumbers(c.usage);
  const text = parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
  const calls = parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
  const created = Math.floor((c.startedAt ?? Date.now()) / 1000);

  if (!c.stream && c.rawResponse) return { contentType: 'application/json', bytes: Buffer.from(JSON.stringify(c.rawResponse), 'utf8') };

  if (dialect === 'anthropic') {
    const id = c.responseId ?? `msg_imported_${String(n).padStart(4, '0')}`;
    const content = parts.filter((p) => p.type !== 'tool_result').map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'tool_use', id: (p as { id: string }).id || `toolu_imported_${n}`, name: (p as { name: string }).name, input: isObject((p as { arguments: unknown }).arguments) ? (p as { arguments: unknown }).arguments : {} }));
    const stopReason = { stop: 'end_turn', tool: 'tool_use', length: 'max_tokens', filter: 'refusal' }[finish];
    const u = usage ? { input_tokens: usage.uncached, output_tokens: usage.output, ...(c.usage?.cacheRead !== undefined ? { cache_read_input_tokens: usage.cacheRead } : {}), ...(c.usage?.cacheWrite !== undefined ? { cache_creation_input_tokens: usage.cacheWrite } : {}) } : { input_tokens: 0, output_tokens: 0 };
    const message = { id, type: 'message', role: 'assistant', model, content, stop_reason: stopReason, stop_sequence: null, usage: u };
    if (!c.stream) return { contentType: 'application/json', bytes: Buffer.from(JSON.stringify(message), 'utf8') };
    const events: Array<[string, unknown]> = [['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...u, output_tokens: 1 } } }]];
    content.forEach((block, index) => {
      if (block.type === 'text') {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: (block as { text: string }).text } }]);
      } else {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } }]);
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify((block as { input: unknown }).input) } }]);
      }
      events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    });
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: u.output_tokens } }]);
    events.push(['message_stop', { type: 'message_stop' }]);
    return { contentType: 'text/event-stream; charset=utf-8', bytes: Buffer.from(sse(events), 'utf8') };
  }

  if (dialect === 'gemini') {
    const finishReason = { stop: 'STOP', tool: 'STOP', length: 'MAX_TOKENS', filter: 'SAFETY' }[finish];
    const body = {
      candidates: [{ content: { role: 'model', parts: [...(text ? [{ text }] : []), ...calls.map((p) => ({ functionCall: { name: p.name, args: isObject(p.arguments) ? p.arguments : {} } }))] }, finishReason, index: 0 }],
      ...(usage ? { usageMetadata: { promptTokenCount: usage.total, candidatesTokenCount: usage.output, totalTokenCount: usage.total + usage.output, ...(c.usage?.cacheRead !== undefined ? { cachedContentTokenCount: usage.cacheRead } : {}) } } : {}),
      modelVersion: model,
      ...(c.responseId ? { responseId: c.responseId } : {}),
    };
    if (!c.stream) return { contentType: 'application/json', bytes: Buffer.from(JSON.stringify(body), 'utf8') };
    return { contentType: 'text/event-stream', bytes: Buffer.from(sse([[null, body]], '\r\n\r\n'), 'utf8') };
  }

  const id = c.responseId ?? `chatcmpl-imported-${n}`;
  const finishReason = { stop: 'stop', tool: 'tool_calls', length: 'length', filter: 'content_filter' }[finish];
  const toolCalls = calls.map((p, i) => ({ id: p.id || `call_imported_${n}_${i}`, type: 'function', function: { name: p.name, arguments: p.argumentsText ?? argsText(p.arguments) } }));
  const u = usage ? { prompt_tokens: usage.total, completion_tokens: usage.output, total_tokens: usage.total + usage.output, ...(c.usage?.cacheRead !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cacheRead } } : {}) } : null;
  if (!c.stream) {
    const body = { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), refusal: null }, finish_reason: finishReason, logprobs: null }], ...(u ? { usage: u } : {}) };
    return { contentType: 'application/json', bytes: Buffer.from(JSON.stringify(body), 'utf8') };
  }
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({ id, object: 'chat.completion.chunk', created, model, choices, ...extra });
  const events: Array<[null, unknown]> = [[null, chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])]];
  if (text) events.push([null, chunk([{ index: 0, delta: { content: text }, finish_reason: null }])]);
  toolCalls.forEach((t, index) => events.push([null, chunk([{ index: 0, delta: { tool_calls: [{ index, ...t }] }, finish_reason: null }])]));
  events.push([null, chunk([{ index: 0, delta: {}, finish_reason: finishReason }])]);
  const wantsUsage = isObject(request.stream_options) && request.stream_options.include_usage === true;
  if (u && wantsUsage) events.push([null, chunk([], { usage: u })]);
  events.push([null, '[DONE]']);
  return { contentType: 'text/event-stream; charset=utf-8', bytes: Buffer.from(sse(events), 'utf8') };
}

/** A model call as the captured call a capture importer would have produced. */
export function capturedFromTrace(c: TraceModelCall, n: number): { call: CapturedCall; dialect: Dialect } {
  const dialect = dialectOf(c.provider, c.model ?? (typeof c.rawRequest?.model === 'string' ? c.rawRequest.model : null));
  const req = rebuildRequest(c, dialect);
  const res = rebuildResponse(c, dialect, n, req.body);
  return {
    dialect,
    call: {
      url: `https://${HOSTS[dialect]}${req.path}${req.search}`,
      method: 'POST',
      // A trace keeps what was asked, not the headers the client sent it with, such as the API version
      // an Anthropic client names: the call names none, and a replay matches it whatever version the
      // agent's SDK names.
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: req.body,
      status: 200,
      responseHeaders: { 'content-type': res.contentType },
      responseBytes: res.bytes,
      ...(c.startedAt !== null ? { startedAt: c.startedAt } : {}),
      ...(c.startedAt !== null && c.endedAt !== null ? { timeMs: Math.max(0, c.endedAt - c.startedAt) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------- putting calls in order

/** A tool call's arguments, when the trace kept them as an object (a JSON object string counts). */
function argsObject(args: unknown): Record<string, unknown> | null {
  const v = maybeJson(args);
  return isObject(v) ? v : null;
}

/** Where a call goes by its start: nanoseconds since the epoch, or before every other call when the source kept no start. */
function startOf(c: TraceCall): bigint {
  if (c.startedAtNs !== undefined && /^-?\d{1,30}$/.test(c.startedAtNs)) return BigInt(c.startedAtNs);
  return c.startedAt === null || !Number.isFinite(c.startedAt) ? 0n : BigInt(msToNs(c.startedAt));
}

/**
 * A tool's arguments, output or result as a key, however the source wrote it: JSON text as the value
 * it holds, text blocks as their text. Null for a value with no such key (nested past what JSON reads).
 */
function valueKey(name: string, v: unknown): string | null {
  if (Array.isArray(v) && v.length && v.every((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string')) v = v.map((b) => (b as { text: string }).text).join('');
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      // text, not JSON
    }
  }
  try {
    return `${name}\u0000${canonicalize(v)}`;
  } catch {
    return null;
  }
}

/**
 * The tool calls and results among a model call's messages, or in its answer, as a tool call is
 * found among them: by its id, else by its name with its arguments or with its output. A result that
 * names no tool goes by the name of the call it answers, or by none.
 */
interface Exchanges {
  ids: Set<string>;
  calls: Set<string>;
  results: Set<string>;
  /** The calls and results that carry no id: a tool call with an id is found among these by the rest. */
  callsWithoutId: Set<string>;
  resultsWithoutId: Set<string>;
}

function exchangesOf(parts: Part[]): Exchanges {
  const x: Exchanges = { ids: new Set(), calls: new Set(), results: new Set(), callsWithoutId: new Set(), resultsWithoutId: new Set() };
  const names = new Map<string, string>();
  for (const p of parts) if (p.type === 'tool_call' && p.id) names.set(p.id, p.name);
  for (const p of parts) {
    if (p.type === 'text') continue;
    const key = p.type === 'tool_call' ? valueKey(p.name, argsObject(p.arguments) ?? p.arguments) : valueKey(p.name ?? names.get(p.id) ?? '', p.content);
    if (p.id) x.ids.add(p.id);
    if (key === null) continue;
    (p.type === 'tool_call' ? x.calls : x.results).add(key);
    if (!p.id) (p.type === 'tool_call' ? x.callsWithoutId : x.resultsWithoutId).add(key);
  }
  return x;
}

/** What a tool call is found by among exchanges: its id, its name with its arguments, its name (or none) with its output. */
interface ToolKeys {
  id: string | null;
  call: string | null;
  results: string[];
}

function toolKeys(t: TraceToolCall): ToolKeys {
  const args = argsObject(t.args);
  const results = t.output === undefined ? [] : [valueKey(t.name, t.output), valueKey('', t.output)];
  return { id: t.callId || null, call: args ? valueKey(t.name, args) : null, results: results.filter((r): r is string => r !== null) };
}

/** Whether a tool call is among the exchanges: by its id where both carry one, else by its name with its arguments or its output. */
function holds(x: Exchanges, k: ToolKeys): boolean {
  const has = (calls: Set<string>, results: Set<string>) => (k.call !== null && calls.has(k.call)) || k.results.some((r) => results.has(r));
  return k.id !== null ? x.ids.has(k.id) || has(x.callsWithoutId, x.resultsWithoutId) : has(x.calls, x.results);
}

/** The most calls that started at one instant to put in the order they needed each other; past it, they keep the order listed. */
const MOST_TIED = 1000;

/**
 * Calls that started at one instant, in the order one needed another: the call another ran inside
 * goes first, a model call before the tool call it asked for, and a tool call before the model call
 * whose request carries its result. Otherwise, and where two say opposite things, they keep the
 * order listed.
 */
function inOrderOfNeed(tied: TraceCall[], within: (c: TraceCall) => TraceCall | undefined): TraceCall[] {
  const index = new Map(tied.map((c, i) => [c, i]));
  // The calls that go after each one.
  const after = tied.map(() => new Set<number>());
  tied.forEach((c, i) => {
    const outer = within(c);
    const o = outer && index.get(outer);
    if (o !== undefined && o !== i) after[o]!.add(i);
  });
  if (tied.some((c) => c.kind === 'tool')) {
    const models = tied.flatMap((c, i) => {
      if (c.kind !== 'model') return [];
      const sent = c.messages.length || !c.rawRequest ? c.messages : (messagesOf(c.rawRequest) ?? []);
      return [{ i, sent: exchangesOf(sent.flatMap((m) => m.parts)), asked: exchangesOf(c.output?.parts ?? []) }];
    });
    tied.forEach((t, i) => {
      if (t.kind !== 'tool' || !models.length) return;
      const keys = toolKeys(t);
      for (const m of models) {
        if (holds(m.asked, keys)) after[m.i]!.add(i);
        if (holds(m.sent, keys)) after[i]!.add(m.i);
      }
    });
  }
  for (let a = 0; a < tied.length; a++) {
    for (const b of after[a]!) {
      if (after[b]!.has(a)) {
        after[a]!.delete(b);
        after[b]!.delete(a);
      }
    }
  }
  const waiting = tied.map(() => 0);
  for (const next of after) for (const b of next) waiting[b]!++;
  const done = tied.map(() => false);
  const out: TraceCall[] = [];
  while (out.length < tied.length) {
    // The first listed that waits on nothing; in a loop of needs, the first listed left.
    let i = waiting.findIndex((w, j) => w === 0 && !done[j]);
    if (i < 0) i = done.indexOf(false);
    done[i] = true;
    out.push(tied[i]!);
    for (const b of after[i]!) waiting[b]!--;
  }
  return out;
}

/**
 * A trace's calls in the order they ran: by their start to the precision the source kept it, since a
 * tool and the model call that reads its result often start in the same millisecond; calls that
 * started at the same instant in the order they needed each other ({@link inOrderOfNeed}), else as listed.
 */
export function callsInOrder(trace: Trace): TraceCall[] {
  const keyed = trace.calls.map((call, listed) => ({ call, listed, at: startOf(call) }));
  keyed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.listed - b.listed));
  // The call each one ran inside: the nearest span above it that is a call. The walk stops at a span
  // already seen, so parents that form a loop cannot hang it.
  const bySpan = new Map<string, TraceCall>();
  for (const c of trace.calls) if (c.spanId) bySpan.set(c.spanId, c);
  const within = (c: TraceCall): TraceCall | undefined => {
    if (!c.spanId || !trace.parents) return undefined;
    const seen = new Set([c.spanId]);
    for (let p = trace.parents.get(c.spanId); p !== undefined && !seen.has(p); p = trace.parents.get(p)) {
      const outer = bySpan.get(p);
      if (outer) return outer;
      seen.add(p);
    }
    return undefined;
  };
  const out: TraceCall[] = [];
  for (let i = 0, j = 1; i < keyed.length; i = j++) {
    while (j < keyed.length && keyed[j]!.at === keyed[i]!.at) j++;
    const tied = keyed.slice(i, j).map((k) => k.call);
    append(out, tied.length > 1 && tied.length <= MOST_TIED ? inOrderOfNeed(tied, within) : tied);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- writing a trace

const toolKept = (t: TraceToolCall) => argsObject(t.args) !== null && (t.output !== undefined || t.error !== null);

export interface TraceImport {
  result: ImportResult;
  /** Model calls found, imported, with settings and with tool definitions; tool calls found and kept. */
  counts: { modelCalls: number; modelCallsImported: number; withSettings: number; withToolDefinitions: number; toolCalls: number; toolCallsKept: number };
  /** Imported model calls by the wire format they were rebuilt in. */
  dialects: Record<string, number>;
}

/** Writes one trace as a partial recording: its model calls, and the tool calls whose every call it kept. */
export function importTrace(store: Store, trace: Trace, opts: ImportOptions): TraceImport {
  const calls = callsInOrder(trace);
  const tools = calls.filter((c): c is TraceToolCall => c.kind === 'tool');
  // Grouped in place and looked up in a set: a trace is a file from anywhere, and copying per call
  // or scanning a list per call would be quadratic in its size.
  const byName = new Map<string, TraceToolCall[]>();
  for (const t of tools) {
    const list = byName.get(t.name);
    if (list) list.push(t);
    else byName.set(t.name, [t]);
  }
  const covered = [...byName].filter(([, list]) => list.every(toolKept)).map(([name]) => name);
  const coveredSet = new Set(covered);

  const startedAt = calls.find((c) => c.startedAt !== null)?.startedAt ?? Date.now();
  const writer = new ImportWriter(store, { ...opts, startedAt, covers: ['api', ...covered.map((name) => `tool:${name}` as const)] });
  // A failure part way deletes the run it started.
  return writeImport(writer, () => writeTrace(writer, trace, calls, tools, coveredSet));
}

function writeTrace(writer: ImportWriter, trace: Trace, calls: readonly TraceCall[], tools: readonly TraceToolCall[], coveredSet: ReadonlySet<string>): TraceImport {
  append(writer.skipped, trace.skipped);
  const counts = { modelCalls: 0, modelCallsImported: 0, withSettings: 0, withToolDefinitions: 0, toolCalls: tools.length, toolCallsKept: tools.filter(toolKept).length };
  const dialects: Record<string, number> = {};
  let n = 0;
  for (const c of calls) {
    if (c.kind === 'tool') {
      if (!coveredSet.has(c.name)) continue;
      writer.tool({
        name: c.name,
        args: argsObject(c.args),
        outcome: c.error !== null && c.output === undefined ? 'error' : 'ok',
        ...(c.error !== null && c.output === undefined ? { error: { name: 'Error', message: c.error } } : { result: c.output }),
        ...(c.startedAt !== null ? { startedAt: c.startedAt } : {}),
        ...(c.startedAt !== null && c.endedAt !== null ? { timeMs: Math.max(0, c.endedAt - c.startedAt) } : {}),
      });
      continue;
    }
    counts.modelCalls++;
    const answered = !!c.rawResponse || !!c.output?.parts.length;
    // A call that failed where it ran left no answer to serve; on replay it runs live.
    const unkept = !answered && c.error !== null ? `the model call failed at its source (${c.error.slice(0, 200)})` : !c.rawRequest && !c.messages.length ? 'the trace kept no input messages for this model call' : !answered ? 'the trace kept no output for this model call' : null;
    if (unkept) {
      writer.skipped.push({ url: c.what, reason: unkept });
      continue;
    }
    const { call, dialect } = capturedFromTrace(c, ++n);
    if (!writer.api(call)) continue;
    counts.modelCallsImported++;
    dialects[dialect] = (dialects[dialect] ?? 0) + 1;
    if (c.rawRequest || Object.keys(c.settings).length) counts.withSettings++;
    if (c.tools || (c.rawRequest && Array.isArray(c.rawRequest.tools))) counts.withToolDefinitions++;
  }
  return { result: writer.finish(), counts, dialects };
}
