import { canonicalize } from './canonical.js';
import { sha256 } from './ids.js';
import { stripKeysDeep } from './normalize.js';
import type { SerializedError } from './types.js';

/**
 * Interventions in the provider's own wire format. `--inject`, `--set` and `--model` change one
 * model request and the ones after it, and each provider spells a conversation, a sampling setting
 * and a model differently: Anthropic and OpenAI chat put turns in `messages`, the Responses API in
 * `input`, Gemini in `contents` with its settings under `generationConfig`, Bedrock Converse in
 * `messages` of untyped blocks with its settings under `inferenceConfig`; Gemini, Vertex, Bedrock
 * and Azure name the model in the path. A change a shape can't carry is refused with the reason,
 * never sent as something the provider ignores or rejects later.
 *
 * Everything here is a pure function of a request body; the sidecar applies it before the request
 * is fingerprinted, stored or forwarded, so the fork's recording holds exactly what was sent, and
 * the CLI runs the same checks against the recorded request before anything starts.
 */

export type RequestShape = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini' | 'converse' | 'other';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What kind of request a model call sends, from its provider, its path (without the query) and its body. */
export function requestShape(provider: string | null | undefined, path: string, body: unknown): RequestShape {
  if (!isObject(body)) return 'other';
  const p = path.split('?')[0] ?? '';
  if (/\/model\/[^/]+\/converse(-stream)?$/.test(p)) return 'converse';
  if (Array.isArray(body.contents)) return 'gemini';
  if (/\/responses$/.test(p) && (typeof body.input === 'string' || Array.isArray(body.input))) return 'openai-responses';
  if (Array.isArray(body.messages)) {
    // Claude speaks the Messages API everywhere: on Vertex and Bedrock the body names its version.
    if (provider === 'anthropic' || body.anthropic_version !== undefined) return 'anthropic';
    if (provider === 'openai' || provider === 'azure' || provider === 'bedrock' || provider === 'vertex') return 'openai-chat';
    return body.system !== undefined ? 'anthropic' : 'openai-chat';
  }
  return 'other';
}

/** Human names for the shapes, for refusals. */
export const SHAPE_NAMES: Record<RequestShape, string> = {
  anthropic: 'the Anthropic Messages API',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'the OpenAI Responses API',
  gemini: 'Gemini',
  converse: 'Bedrock Converse',
  other: 'a request that is not a conversation',
};

// ---- the model ----

const segment = (s: string) => s.replace(/[%/?#\s]/g, (c) => encodeURIComponent(c));

/** Where a call names its model: Gemini and Vertex `models/<model>:`, Bedrock `/model/<id>/`, Azure `deployments/<name>/`. */
export function modelInRequest(provider: string | null | undefined, path: string, body: unknown): { where: 'path' | 'body'; model: string } | null {
  const p = path.split('?')[0] ?? '';
  if (provider === 'bedrock') {
    const m = /\/model\/([^/]+)\//.exec(p);
    if (m) return { where: 'path', model: safeDecode(m[1]!) };
  }
  if (provider === 'gemini' || provider === 'vertex') {
    const m = /\/models\/([^/:]+):/.exec(p);
    if (m) return { where: 'path', model: safeDecode(m[1]!) };
  }
  if (provider === 'azure') {
    const m = /\/deployments\/([^/]+)\//.exec(p);
    if (m) return { where: 'path', model: safeDecode(m[1]!) };
  }
  if (isObject(body) && typeof body.model === 'string') return { where: 'body', model: body.model };
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export type Refusal = { refused: string };
export const refused = (r: unknown): r is Refusal => isObject(r) && typeof r.refused === 'string';

/**
 * Switches the model of one request: in the path where the provider names it there (an Azure
 * deployment, a Bedrock model id or inference profile, a Gemini or Vertex model), otherwise the
 * body's `model`. A body that also carries `model` gets it in both places, so they never disagree.
 */
export function switchModel(provider: string | null | undefined, path: string, body: unknown, model: string): { path: string; body: unknown } | Refusal {
  const at = modelInRequest(provider, path, body);
  if (!at) return { refused: 'the request names no model, in its path or its body' };
  let nextPath = path;
  if (at.where === 'path') {
    if (provider === 'bedrock') nextPath = path.replace(/\/model\/[^/]+\//, () => `/model/${encodeURIComponent(model)}/`);
    else if (provider === 'azure') nextPath = path.replace(/\/deployments\/[^/]+\//, () => `/deployments/${encodeURIComponent(model)}/`);
    else nextPath = path.replace(/\/models\/[^/:]+:/, () => `/models/${segment(model)}:`);
  }
  const next = isObject(body) ? { ...body } : body;
  if (isObject(next) && (at.where === 'body' || typeof next.model === 'string')) next.model = model;
  return { path: nextPath, body: next };
}

// ---- request fields ----

const GEMINI_TOP = new Set(['contents', 'tools', 'toolConfig', 'tool_config', 'safetySettings', 'safety_settings', 'systemInstruction', 'system_instruction', 'generationConfig', 'generation_config', 'cachedContent', 'cached_content', 'labels']);
/** Common spellings of sampling settings, to Gemini's generationConfig. Its own names pass through. */
const GEMINI_CONFIG: Record<string, string> = {
  temperature: 'temperature',
  top_p: 'topP',
  topP: 'topP',
  top_k: 'topK',
  topK: 'topK',
  max_tokens: 'maxOutputTokens',
  max_output_tokens: 'maxOutputTokens',
  max_completion_tokens: 'maxOutputTokens',
  maxOutputTokens: 'maxOutputTokens',
  stop: 'stopSequences',
  stop_sequences: 'stopSequences',
  stopSequences: 'stopSequences',
  seed: 'seed',
  candidate_count: 'candidateCount',
  candidateCount: 'candidateCount',
  presence_penalty: 'presencePenalty',
  presencePenalty: 'presencePenalty',
  frequency_penalty: 'frequencyPenalty',
  frequencyPenalty: 'frequencyPenalty',
  response_mime_type: 'responseMimeType',
  responseMimeType: 'responseMimeType',
  response_schema: 'responseSchema',
  responseSchema: 'responseSchema',
  thinking_config: 'thinkingConfig',
  thinkingConfig: 'thinkingConfig',
  response_logprobs: 'responseLogprobs',
  responseLogprobs: 'responseLogprobs',
  logprobs: 'logprobs',
};
const CONVERSE_TOP = new Set(['messages', 'system', 'inferenceConfig', 'toolConfig', 'guardrailConfig', 'additionalModelRequestFields', 'promptVariables', 'additionalModelResponseFieldPaths', 'requestMetadata', 'performanceConfig']);
const CONVERSE_INFERENCE: Record<string, string> = {
  temperature: 'temperature',
  max_tokens: 'maxTokens',
  max_output_tokens: 'maxTokens',
  max_completion_tokens: 'maxTokens',
  maxTokens: 'maxTokens',
  top_p: 'topP',
  topP: 'topP',
  stop: 'stopSequences',
  stop_sequences: 'stopSequences',
  stopSequences: 'stopSequences',
};
const RESPONSES_ALIASES: Record<string, string> = { max_tokens: 'max_output_tokens', max_completion_tokens: 'max_output_tokens' };

/** `stop` takes a string or a list elsewhere; stop sequences are always a list on Gemini and Converse. */
const asList = (v: unknown) => (typeof v === 'string' ? [v] : v);

/**
 * Where each field goes in this shape, as dotted paths: `temperature` is `generationConfig.temperature`
 * on Gemini and `inferenceConfig.temperature` on Converse, `max_tokens` is `max_output_tokens` on the
 * Responses API. A dotted key is a path already (`additionalModelRequestFields.top_k`) and goes
 * where it says. A field a shape has no place for is refused with where to put it instead.
 */
export function placeFields(shape: RequestShape, fields: Record<string, unknown>): Array<{ path: string[]; value: unknown }> | Refusal {
  const out: Array<{ path: string[]; value: unknown }> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key.includes('.')) {
      const path = key.split('.');
      if (path.some((p) => !p)) return { refused: `"${key}" is not a field path` };
      out.push({ path, value });
      continue;
    }
    switch (shape) {
      case 'gemini':
        if (GEMINI_TOP.has(key)) out.push({ path: [key], value });
        else if (GEMINI_CONFIG[key]) out.push({ path: ['generationConfig', GEMINI_CONFIG[key]!], value: GEMINI_CONFIG[key] === 'stopSequences' ? asList(value) : value });
        else return { refused: `Gemini has no request field "${key}": sampling settings go in generationConfig (temperature, topP, topK, maxOutputTokens, stopSequences, seed); set any other by its path, such as generationConfig.${key}` };
        break;
      case 'converse':
        if (CONVERSE_TOP.has(key)) out.push({ path: [key], value });
        else if (CONVERSE_INFERENCE[key]) out.push({ path: ['inferenceConfig', CONVERSE_INFERENCE[key]!], value: CONVERSE_INFERENCE[key] === 'stopSequences' ? asList(value) : value });
        else if (key === 'top_k' || key === 'topK') out.push({ path: ['additionalModelRequestFields', 'top_k'], value });
        else return { refused: `Bedrock Converse has no request field "${key}": sampling settings go in inferenceConfig (temperature, maxTokens, topP, stopSequences) and the model's own in additionalModelRequestFields; set one by its path, such as additionalModelRequestFields.${key}` };
        break;
      case 'openai-responses':
        out.push({ path: [RESPONSES_ALIASES[key] ?? key], value });
        break;
      case 'other':
        return { refused: 'the request is not a conversation (an embeddings call, or a model\'s native body), so it has no sampling settings to change' };
      default:
        out.push({ path: [key], value });
    }
  }
  return out;
}

/** A copy of `body` with the fields set where `placeFields` says. */
export function setRequestFields(shape: RequestShape, body: unknown, fields: Record<string, unknown>): { body: Record<string, unknown> } | Refusal {
  if (!isObject(body)) return { refused: 'the request body is not a JSON object' };
  const placed = placeFields(shape, fields);
  if (refused(placed)) return placed;
  const next: Record<string, unknown> = { ...body };
  for (const { path, value } of placed) {
    let node = next;
    for (const key of path.slice(0, -1)) {
      const child = node[key];
      const copy = isObject(child) ? { ...child } : {};
      node[key] = copy;
      node = copy;
    }
    node[path[path.length - 1]!] = value;
  }
  return { body: next };
}

// ---- an injected instruction ----

export type InjectAs = 'system' | 'user';

/**
 * Where an injection landed in the request it was made in, so every later request of the same
 * conversation gets it at the same place. `insert` adds a message at `index`; `extend` adds a block to
 * the message at `index`. `prefix` fingerprints the history before that place (the extended message
 * included, as the agent sent it): a later request carries the injection only when it starts with that
 * same history, so another conversation, another sub-agent's or a stateful continuation that sends only
 * new turns (a Responses `previous_response_id`) is left as it is.
 */
export interface InjectionPlace {
  mode: 'insert' | 'extend';
  index: number;
  prefix: string;
}

/** The turns of a request, whatever the shape calls them; a Responses `input` string is one user turn. */
function turnsOf(shape: RequestShape, body: Record<string, unknown>): unknown[] | null {
  if (shape === 'gemini') return Array.isArray(body.contents) ? body.contents : null;
  if (shape === 'openai-responses') return typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : null;
  if (shape === 'other') return null;
  return Array.isArray(body.messages) ? body.messages : null;
}

const prefixHash = (turns: unknown[], n: number) => sha256(canonicalize(stripKeysDeep(turns.slice(0, n), ['cache_control'])));

const roleOf = (shape: RequestShape, turn: unknown): string | null => {
  if (!isObject(turn)) return null;
  // Gemini's role defaults to user; a Responses item that is not a message (a function call or its output) has none.
  if (shape === 'gemini') return typeof turn.role === 'string' ? turn.role : 'user';
  if (shape === 'openai-responses' && turn.type !== undefined && turn.type !== 'message') return null;
  return typeof turn.role === 'string' ? turn.role : null;
};

/**
 * Where an instruction goes in this request, or why it can't go in. As `user`, it joins the user turn
 * the request ends with: a block appended to the last user message (Anthropic, Gemini and Converse put
 * tool results in a user turn, so that is the turn the model answers next), or, where the request ends
 * on tool output (OpenAI chat and Responses), a user message of its own after it. As `system`, it is a
 * system message at the end of the conversation, which Gemini and Converse can't express: they take
 * system instructions only ahead of the conversation.
 */
export function placeInjection(shape: RequestShape, body: unknown, as: InjectAs): InjectionPlace | Refusal {
  if (!isObject(body)) return { refused: 'the request body is not a JSON object' };
  if (shape === 'other') return { refused: 'the request is not a conversation (an embeddings call, or a model\'s native body), so there is no turn to add an instruction to' };
  const turns = turnsOf(shape, body);
  if (!turns) return { refused: `the request has no ${shape === 'gemini' ? 'contents' : shape === 'openai-responses' ? 'input' : 'messages'} to add an instruction to` };
  if (as === 'system') {
    if (shape === 'gemini') return { refused: 'Gemini takes system instructions only in systemInstruction, ahead of the conversation, so there is no system message to add at a later turn. Inject it into the user turn instead: --inject-as user (the default)' };
    if (shape === 'converse') return { refused: 'Bedrock Converse takes system prompts only in system, ahead of the conversation, and its messages are user and assistant turns, so there is no system message to add at a later turn. Inject it into the user turn instead: --inject-as user (the default)' };
    return { mode: 'insert', index: turns.length, prefix: prefixHash(turns, turns.length) };
  }
  // OpenAI chat and Responses carry tool output as turns of their own: after them comes a new user turn.
  if (shape === 'openai-chat' || shape === 'openai-responses') {
    const last = turns.length - 1;
    if (last >= 0 && roleOf(shape, turns[last]) === 'user') return { mode: 'extend', index: last, prefix: prefixHash(turns, last + 1) };
    return { mode: 'insert', index: turns.length, prefix: prefixHash(turns, turns.length) };
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    if (roleOf(shape, turns[i]) === 'user') return { mode: 'extend', index: i, prefix: prefixHash(turns, i + 1) };
  }
  return { mode: 'insert', index: turns.length, prefix: prefixHash(turns, turns.length) };
}

/** The message an `insert` adds, in the shape's own form. */
function injectedTurn(shape: RequestShape, text: string, as: InjectAs): Record<string, unknown> {
  if (shape === 'gemini') return { role: 'user', parts: [{ text }] };
  if (shape === 'converse') return { role: 'user', content: [{ text }] };
  if (shape === 'anthropic' && as === 'user') return { role: 'user', content: [{ type: 'text', text }] };
  return { role: as, content: text };
}

/** `content` with the text added: a block in the shape's form, or, for a plain string, the text after a blank line. */
function extendContent(shape: RequestShape, content: unknown, text: string): unknown {
  if (shape === 'anthropic') {
    const block = { type: 'text', text };
    return typeof content === 'string' ? [{ type: 'text', text: content }, block] : Array.isArray(content) ? [...content, block] : [block];
  }
  // OpenAI-compatible servers don't all take content parts; a string stays a string.
  if (typeof content === 'string') return content ? `${content}\n\n${text}` : text;
  const part = shape === 'openai-responses' ? { type: 'input_text', text } : shape === 'converse' ? { text } : { type: 'text', text };
  return Array.isArray(content) ? [...content, part] : [part];
}

/**
 * The request with the instruction at `place`, or null when the request does not continue the
 * conversation the injection was made in (its history before `place` differs).
 */
export function applyInjection(shape: RequestShape, body: unknown, text: string, as: InjectAs, place: InjectionPlace): Record<string, unknown> | null {
  if (!isObject(body)) return null;
  const turns = turnsOf(shape, body);
  if (!turns) return null;
  const n = place.mode === 'extend' ? place.index + 1 : place.index;
  if (turns.length < n || prefixHash(turns, n) !== place.prefix) return null;
  const next = turns.map((t) => t);
  if (place.mode === 'insert') {
    next.splice(place.index, 0, injectedTurn(shape, text, as));
  } else {
    const turn = next[place.index] as Record<string, unknown>;
    next[place.index] = shape === 'gemini' ? { ...turn, parts: [...(Array.isArray(turn.parts) ? turn.parts : []), { text }] } : { ...turn, content: extendContent(shape, turn.content, text) };
  }
  if (shape === 'gemini') return { ...body, contents: next };
  if (shape === 'openai-responses') {
    // A string input was one user turn; extended, it stays a string.
    if (typeof body.input === 'string') return { ...body, input: place.mode === 'extend' ? (next[0] as { content: string }).content : next };
    return { ...body, input: next };
  }
  return { ...body, messages: next };
}

// ---- a planted instruction in a tool result ----

/**
 * A recorded tool result with text added, as an attacker would leave an instruction in what a tool
 * reads: after a string result, or after the longest string inside a structured one (a page body, an
 * email, a snippet: the text the model reads most of). Everything else in the result stays as recorded.
 */
export function plantInResult(result: unknown, text: string): { result: unknown; at: string } | Refusal {
  const join = (s: string) => (s && !/\s$/.test(s) ? `${s}\n\n${text}` : `${s}${text}`);
  if (typeof result === 'string') return { result: join(result), at: '$' };
  let best: { path: Array<string | number>; length: number } | null = null;
  const walk = (v: unknown, path: Array<string | number>) => {
    if (typeof v === 'string') {
      if (!best || v.length > best.length) best = { path, length: v.length };
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(result, []);
  const found = best as { path: Array<string | number>; length: number } | null;
  if (!found) return { refused: 'its recorded result holds no text to add to; give the whole result you want with --override instead' };
  const copy = structuredClone(result) as Record<string | number, unknown>;
  let node: Record<string | number, unknown> = copy;
  for (const key of found.path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = found.path[found.path.length - 1]!;
  node[last] = join(node[last] as string);
  return { result: copy, at: '$' + found.path.map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_]\w*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('') };
}

// ---- a failing tool ----

/** `--fail-at <call>=timeout|error[:message]|<status>` on a tool call: what the agent gets instead of the tool's result. */
export type ToolFailure = { kind: 'timeout' } | { kind: 'error'; message?: string } | { kind: 'status'; status: number };

/** `timeout`, `error`, `error:connection reset`, `500`. Statuses are 4xx or 5xx, which an HTTP service could answer. */
export function parseToolFailure(value: string): ToolFailure | { error: string } {
  const v = value.trim();
  if (v === 'timeout') return { kind: 'timeout' };
  if (v === 'error') return { kind: 'error' };
  if (v.startsWith('error:')) {
    const message = v.slice('error:'.length).trim();
    return message ? { kind: 'error', message } : { kind: 'error' };
  }
  if (/^\d{3}$/.test(v)) {
    const status = Number(v);
    if (status < 400 || status > 599) return { error: `${status} is not a failure status; use 4xx or 5xx (500 server error, 503 unavailable, 429 rate limited)` };
    return { kind: 'status', status };
  }
  return { error: `expected timeout, error, error:<message> or an HTTP status such as 500, got "${value}"` };
}

export function formatToolFailure(f: ToolFailure): string {
  return f.kind === 'status' ? String(f.status) : f.kind === 'error' && f.message ? `error:${f.message}` : f.kind;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * The error a failed tool raises in the agent, as the SDKs receive it. Its wording is what a real
 * failure of that kind says, because the agent often hands the message to the model as the tool's
 * answer, and a message naming Shadowlap would tell the model it is being tested. The recording
 * says what really happened: the call is stored as injected by `--fail-at`.
 */
export function toolFailureError(tool: string, f: ToolFailure): SerializedError {
  if (f.kind === 'timeout') return { name: 'TimeoutError', message: `${tool} timed out`, code: 'ETIMEDOUT', data: { injected: 'timeout' } };
  if (f.kind === 'error') return { name: 'Error', message: f.message ?? `${tool} failed`, data: { injected: 'error' } };
  return { name: 'HTTPError', message: `HTTP ${f.status}${STATUS_TEXT[f.status] ? ` ${STATUS_TEXT[f.status]}` : ''}`, data: { injected: 'status', status: f.status } };
}
