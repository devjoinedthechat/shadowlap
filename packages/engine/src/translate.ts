/**
 * Another provider at the takeover. A recording holds each model request in its provider's shape,
 * and `--model k:<model>` only changes the `model` field, which works while the new model speaks the
 * same API. Scoring a local or fine-tuned model (an OpenAI-compatible server such as Ollama or vLLM)
 * on an Anthropic recording needs more: from the takeover call on, the conversation is translated
 * into the OpenAI chat shape, and the answer is translated back into the shape the agent's SDK
 * expects, so the agent never knows. The other direction (an OpenAI chat recording answered by an
 * Anthropic model) is the same mapping reversed.
 *
 * What carries over: the system prompt, every message, tool definitions, tool calls and their
 * results, images, the stop reason and usage. What doesn't: thinking blocks (they are bound to the
 * model that wrote them, and another model can't read them), server-side tools such as web search,
 * and sampling options one API has and the other lacks. `dropped` names what a request lost.
 *
 * The same goes for the clouds that serve these models (E8): Claude through Vertex AI (`rawPredict`)
 * or Amazon Bedrock (`invoke`) speaks Anthropic's messages; Azure OpenAI's deployments, and Vertex
 * AI's and Gemini's OpenAI-compatible endpoints, speak OpenAI's chat; Bedrock's Converse API and
 * Gemini's generateContent (on the Gemini API or Vertex AI) translate through translate-converse.ts
 * and translate-gemini.ts. Each answer goes back as that cloud sends it, streamed or not.
 */

/**
 * The shape of a recorded model call's request and answer: Anthropic's messages, OpenAI's chat
 * completions, Bedrock's Converse API, or Gemini's generateContent.
 */
export type ChatShape = 'anthropic' | 'openai-chat' | 'converse' | 'gemini';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** A Bedrock model id from a call's path, decoded: `anthropic.claude-sonnet-5-v1:0`, an inference profile, or an ARN. */
function bedrockModel(path: string): string | null {
  const m = /\/model\/([^/]+)\//.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/** The API a recorded model call spoke, from its provider and endpoint; null for one that can't be translated. */
export function chatShapeOf(provider: string | null | undefined, callName: string): ChatShape | null {
  const path = callName.replace(/^[A-Z]+\s+/, '').split('?')[0] ?? '';
  if (provider === 'anthropic' && /\/v1\/messages$/.test(path)) return 'anthropic';
  // Claude on Vertex AI, and through Bedrock's InvokeModel (its id names the model family).
  if (provider === 'vertex' && /\/publishers\/anthropic\/models\/[^/:]+:(stream)?rawPredict$/i.test(path)) return 'anthropic';
  if (provider === 'bedrock' && /\/invoke(-with-response-stream)?$/.test(path) && /(^|[.:/])anthropic\./.test(bedrockModel(path) ?? '')) return 'anthropic';
  // OpenAI's chat completions, and the clouds that speak them: Azure's deployments, Vertex AI's and Gemini's OpenAI-compatible endpoints.
  if ((provider === 'openai' || provider === 'azure' || provider === 'vertex' || provider === 'gemini') && /\/chat\/completions$/.test(path)) return 'openai-chat';
  if (provider === 'bedrock' && /\/converse(-stream)?$/.test(path)) return 'converse';
  if ((provider === 'gemini' || provider === 'vertex') && /:(stream)?generateContent$/i.test(path)) return 'gemini';
  return null;
}

/** Why a call's API can't be carried to another provider, for the message that refuses it. */
export function untranslatable(provider: string | null | undefined, callName: string): string {
  const path = callName.replace(/^[A-Z]+\s+/, '').split('?')[0] ?? '';
  if (/\/responses$/.test(path)) return 'it uses the OpenAI Responses API';
  if (provider === 'bedrock' && /\/invoke(-with-response-stream)?$/.test(path)) return `it asks ${bedrockModel(path) ?? 'a model'} through Bedrock's InvokeModel, whose body only Claude's is known to be (use the Converse API for other models)`;
  if (provider === 'vertex' && /:(stream)?rawPredict$/i.test(path)) return "it asks a partner model on Vertex AI whose body isn't Anthropic's";
  if (provider === 'bedrock') return 'it is a Bedrock request that asks no model for an answer';
  if (provider === 'vertex') return 'it is a Vertex AI request that asks no model for an answer';
  if (provider === 'azure') return 'it uses an Azure OpenAI API other than chat completions';
  const what = provider ?? 'non-chat';
  return `it is ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} request (${path})`;
}

// ---- tool definitions ----

export interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters: Json };
}

const EMPTY_SCHEMA: Json = { type: 'object', properties: {} };

/**
 * The tool definitions of any provider's request as OpenAI function tools: Anthropic's
 * `input_schema`, OpenAI's own, Responses' flat functions, Gemini's `functionDeclarations` and
 * Bedrock Converse's `toolSpec`. Server-side tools (web search, code execution) have no definition
 * to carry and are left out.
 */
export function openAITools(body: unknown): OpenAITool[] {
  if (!isObject(body)) return [];
  const out: OpenAITool[] = [];
  const add = (name: unknown, description: unknown, parameters: unknown) => {
    if (typeof name !== 'string' || !name) return;
    out.push({ type: 'function', function: { name, ...(typeof description === 'string' && description ? { description } : {}), parameters: isObject(parameters) ? parameters : EMPTY_SCHEMA } });
  };
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (!isObject(t)) continue;
    if (isObject(t.function)) {
      add(t.function.name, t.function.description, t.function.parameters);
    } else if (t.type === 'function') {
      add(t.name, t.description, t.parameters);
    } else if (Array.isArray(t.functionDeclarations)) {
      for (const f of t.functionDeclarations) if (isObject(f)) add(f.name, f.description, f.parameters ?? f.parametersJsonSchema);
    } else if (typeof t.name === 'string' && (t.type === undefined || t.type === 'custom') && t.input_schema !== undefined) {
      add(t.name, t.description, t.input_schema);
    }
  }
  const converse = isObject(body.toolConfig) && Array.isArray(body.toolConfig.tools) ? body.toolConfig.tools : [];
  for (const t of converse) if (isObject(t) && isObject(t.toolSpec)) add(t.toolSpec.name, t.toolSpec.description, isObject(t.toolSpec.inputSchema) ? t.toolSpec.inputSchema.json : undefined);
  return out;
}

// ---- Anthropic → OpenAI chat ----

export interface TranslatedRequest {
  body: Json;
  /** What the other API has no place for, once each: `thinking blocks`, `top_k`, `the web_search tool`. */
  dropped: string[];
}

export interface ToOpenAIOptions {
  /** The model to ask; defaults to the request's own. */
  model?: string;
  /** api.openai.com's reasoning models take `max_completion_tokens`; other servers take `max_tokens`. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : isObject(b) && (b.type === 'text' || b.type === undefined) && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

function imageUrl(source: unknown): string | null {
  if (!isObject(source)) return null;
  if (source.type === 'base64' && typeof source.data === 'string') return `data:${str(source.media_type) || 'image/png'};base64,${source.data}`;
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  return null;
}

/** A tool_use id as the other side accepts it: letters, digits, `_` and `-`. */
function toolId(raw: unknown, fallback: () => string): string {
  const id = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '_') : '';
  return id || fallback();
}

export function anthropicToOpenAIChat(input: unknown, options: ToOpenAIOptions = {}): TranslatedRequest {
  if (!isObject(input) || !Array.isArray(input.messages)) throw new Error('not an Anthropic Messages request: it has no messages');
  const dropped = new Set<string>();
  const messages: Json[] = [];
  let n = 0;
  const nextId = () => `call_shadowlap_${++n}`;

  const system = typeof input.system === 'string' ? input.system : textOf(input.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const m of input.messages) {
    if (!isObject(m)) continue;
    if (m.role === 'system') {
      // An instruction injected as a system message (`--inject`) stays one.
      const text = textOf(m.content);
      if (text) messages.push({ role: 'system', content: text });
      continue;
    }
    const blocks: unknown[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text: string[] = [];
      const calls: Json[] = [];
      for (const b of blocks) {
        if (!isObject(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string') text.push(b.text);
        else if (b.type === 'tool_use') calls.push({ id: toolId(b.id, nextId), type: 'function', function: { name: str(b.name), arguments: JSON.stringify(b.input ?? {}) } });
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') dropped.add('thinking blocks');
        else dropped.add(`${str(b.type)} blocks`);
      }
      const content = text.join('\n');
      if (!content && !calls.length) continue;
      messages.push({ role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results become tool messages, which must directly follow the assistant
    // message that called them, so they go first; anything else the turn says follows as user content.
    const parts: Json[] = [];
    for (const b of blocks) {
      if (!isObject(b)) continue;
      if (b.type === 'tool_result') {
        const inner = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : isObject(c) && c.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n') : str(b.content);
        messages.push({ role: 'tool', tool_call_id: toolId(b.tool_use_id, nextId), content: b.is_error === true ? `Error: ${inner}` : inner });
      } else if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') {
        const url = imageUrl(b.source);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
        else dropped.add('image blocks without data');
      } else dropped.add(`${str(b.type)} blocks`);
    }
    if (!parts.length) continue;
    messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text as string).join('\n') : parts });
  }

  const out: Json = { model: options.model ?? input.model, messages };
  const tools: OpenAITool[] = [];
  for (const t of Array.isArray(input.tools) ? input.tools : []) {
    if (!isObject(t)) continue;
    if (t.input_schema !== undefined && typeof t.name === 'string' && (t.type === undefined || t.type === 'custom')) {
      tools.push({ type: 'function', function: { name: t.name, ...(typeof t.description === 'string' && t.description ? { description: t.description } : {}), parameters: isObject(t.input_schema) ? t.input_schema : EMPTY_SCHEMA } });
    } else dropped.add(`the ${str(t.name) || str(t.type)} tool`);
  }
  if (tools.length) out.tools = tools;
  if (isObject(input.tool_choice)) {
    const c = input.tool_choice;
    if (c.type === 'auto') out.tool_choice = 'auto';
    else if (c.type === 'any') out.tool_choice = 'required';
    else if (c.type === 'none') out.tool_choice = 'none';
    else if (c.type === 'tool' && typeof c.name === 'string') out.tool_choice = { type: 'function', function: { name: c.name } };
    if (c.disable_parallel_tool_use === true && tools.length) out.parallel_tool_calls = false;
  }
  if (typeof input.max_tokens === 'number') out[options.maxTokensField ?? 'max_tokens'] = input.max_tokens;
  if (typeof input.temperature === 'number') out.temperature = input.temperature;
  if (typeof input.top_p === 'number') out.top_p = input.top_p;
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length) out.stop = input.stop_sequences;
  if (input.top_k !== undefined) dropped.add('top_k');
  if (input.thinking !== undefined) dropped.add('the thinking setting');
  return { body: out, dropped: [...dropped] };
}

// ---- OpenAI chat answer → Anthropic message ----

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseArguments(raw: unknown): unknown {
  if (isObject(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : { value: parsed };
  } catch {
    // A model that wrote broken JSON still made the call; the agent gets what it wrote.
    return { arguments: raw };
  }
}

/** A local reasoning model's `<think>…</think>` preamble: thinking, which the other side doesn't take. */
const THINK = /^\s*<think>[\s\S]*?<\/think>\s*/;

export function openAIChatToAnthropicMessage(completion: unknown, options: { model: string }): AnthropicMessage {
  if (!isObject(completion) || !Array.isArray(completion.choices)) throw new Error('not a chat completion: it has no choices');
  const choice = completion.choices.find(isObject);
  const message = choice && isObject(choice.message) ? choice.message : {};
  const content: AnthropicMessage['content'] = [];
  const text = typeof message.content === 'string' ? message.content.replace(THINK, '') : textOf(message.content);
  if (text.trim()) content.push({ type: 'text', text });
  let n = 0;
  for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isObject(tc) || !isObject(tc.function)) continue;
    content.push({ type: 'tool_use', id: toolId(tc.id, () => `toolu_shadowlap_${Date.now().toString(36)}_${++n}`), name: str(tc.function.name), input: parseArguments(tc.function.arguments) });
  }
  const finish = choice ? choice.finish_reason : null;
  const hasTools = content.some((b) => b.type === 'tool_use');
  // A server that reports "stop" after calling a tool would end an agent's loop, which reads the stop reason.
  const stop_reason: AnthropicMessage['stop_reason'] = hasTools ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn';
  const u = isObject(completion.usage) ? completion.usage : {};
  const cached = isObject(u.prompt_tokens_details) ? num(u.prompt_tokens_details.cached_tokens) : 0;
  const id = typeof completion.id === 'string' ? completion.id.replace(/[^A-Za-z0-9_-]/g, '_') : Date.now().toString(36);
  return {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    model: options.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: Math.max(0, num(u.prompt_tokens) - cached), output_tokens: num(u.completion_tokens), cache_creation_input_tokens: 0, cache_read_input_tokens: cached },
  };
}

/**
 * The events an Anthropic message streams as, each `[event, data]`: text and tool calls as the
 * deltas the SDKs assemble, thinking with its signature, and any other block (a server tool's call or
 * result) whole at its start. Bedrock's `invoke-with-response-stream` carries the same events.
 */
export function anthropicEventList<M extends { content: unknown[]; usage?: unknown; stop_reason?: unknown }>(m: M): Array<[string, Json]> {
  const usage = isObject(m.usage) ? m.usage : { input_tokens: 0, output_tokens: 0 };
  const output = num(usage.output_tokens);
  const events: Array<[string, Json]> = [];
  events.push(['message_start', { type: 'message_start', message: { ...m, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: Math.min(1, output) } } }]);
  m.content.forEach((block, index) => {
    if (!isObject(block)) return;
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: str(block.text) } }]);
    } else if (block.type === 'tool_use') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }]);
    } else if (block.type === 'thinking') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: str(block.thinking) } }]);
      if (typeof block.signature === 'string' && block.signature) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: block }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: m.stop_reason ?? null, stop_sequence: (m as { stop_sequence?: unknown }).stop_sequence ?? null }, usage: { output_tokens: output } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}

/** An Anthropic message as the server-sent events the SDK reads when it asked to stream. */
export function anthropicMessageEvents<M extends { content: unknown[]; usage?: unknown; stop_reason?: unknown }>(m: M): string {
  return anthropicEventList(m)
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

// ---- OpenAI chat → Anthropic ----

export function openAIChatToAnthropic(input: unknown, options: { model?: string; defaultMaxTokens?: number } = {}): TranslatedRequest {
  if (!isObject(input) || !Array.isArray(input.messages)) throw new Error('not a chat completions request: it has no messages');
  const dropped = new Set<string>();
  const system: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: Json[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: Json[]) => {
    if (!blocks.length) return;
    const last = turns.at(-1);
    // Anthropic alternates roles: consecutive tool results and user text are one user turn.
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  let n = 0;
  const nextId = () => `toolu_shadowlap_${++n}`;
  for (const m of input.messages) {
    if (!isObject(m)) continue;
    if (m.role === 'system' || m.role === 'developer') {
      const text = textOf(m.content);
      if (text) system.push(text);
      continue;
    }
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: toolId(m.tool_call_id, nextId), content: textOf(m.content) }]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Json[] = [];
      const text = typeof m.content === 'string' ? m.content : textOf(m.content);
      if (text.trim()) blocks.push({ type: 'text', text });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!isObject(tc) || !isObject(tc.function)) continue;
        blocks.push({ type: 'tool_use', id: toolId(tc.id, nextId), name: str(tc.function.name), input: parseArguments(tc.function.arguments) });
      }
      if (m.reasoning_content !== undefined) dropped.add('reasoning');
      push('assistant', blocks);
      continue;
    }
    const blocks: Json[] = [];
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!isObject(p)) continue;
        if (p.type === 'text' && typeof p.text === 'string') blocks.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url' && isObject(p.image_url) && typeof p.image_url.url === 'string') {
          const data = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url);
          blocks.push({ type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url: p.image_url.url } });
        } else dropped.add(`${str(p.type)} parts`);
      }
    }
    push('user', blocks);
  }
  const out: Json = {
    model: options.model ?? input.model,
    max_tokens: typeof input.max_completion_tokens === 'number' ? input.max_completion_tokens : typeof input.max_tokens === 'number' ? input.max_tokens : (options.defaultMaxTokens ?? 4096),
    messages: turns,
  };
  if (system.length) out.system = system.join('\n\n');
  const tools = Array.isArray(input.tools) ? input.tools.filter(isObject).flatMap((t) => (isObject(t.function) && typeof t.function.name === 'string' ? [{ name: t.function.name, ...(typeof t.function.description === 'string' && t.function.description ? { description: t.function.description } : {}), input_schema: isObject(t.function.parameters) ? t.function.parameters : EMPTY_SCHEMA }] : [])) : [];
  if (tools.length) out.tools = tools;
  const choice = input.tool_choice;
  if (choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (choice === 'required') out.tool_choice = { type: 'any' };
  else if (choice === 'none') out.tool_choice = { type: 'none' };
  else if (isObject(choice) && isObject(choice.function) && typeof choice.function.name === 'string') out.tool_choice = { type: 'tool', name: choice.function.name };
  if (input.parallel_tool_calls === false && tools.length) out.tool_choice = { ...(isObject(out.tool_choice) ? out.tool_choice : { type: 'auto' }), disable_parallel_tool_use: true };
  // Anthropic's temperature runs from 0 to 1, OpenAI's to 2.
  if (typeof input.temperature === 'number') out.temperature = Math.min(1, Math.max(0, input.temperature));
  if (typeof input.top_p === 'number') out.top_p = input.top_p;
  if (typeof input.stop === 'string') out.stop_sequences = [input.stop];
  else if (Array.isArray(input.stop) && input.stop.length) out.stop_sequences = input.stop.filter((s) => typeof s === 'string');
  for (const k of ['frequency_penalty', 'presence_penalty', 'logit_bias', 'seed', 'response_format', 'n', 'logprobs']) if (input[k] !== undefined && input[k] !== null) dropped.add(k);
  return { body: out, dropped: [...dropped] };
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: 0; message: { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; refusal: null }; finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter'; logprobs: null }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details: { cached_tokens: number } };
}

/** An Anthropic message as a chat completion, the shape an OpenAI client parses. Thinking is left out. */
export function anthropicMessageToOpenAIChat(message: unknown, options: { model: string }): ChatCompletion {
  if (!isObject(message) || !Array.isArray(message.content)) throw new Error('not an Anthropic message: it has no content');
  const text: string[] = [];
  const calls: NonNullable<ChatCompletion['choices'][0]['message']['tool_calls']> = [];
  let n = 0;
  for (const b of message.content) {
    if (!isObject(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') text.push(b.text);
    else if (b.type === 'tool_use') calls.push({ id: toolId(b.id, () => `call_shadowlap_${++n}`), type: 'function', function: { name: str(b.name), arguments: JSON.stringify(b.input ?? {}) } });
  }
  const reason = message.stop_reason;
  const finish_reason = calls.length ? 'tool_calls' : reason === 'max_tokens' ? 'length' : reason === 'refusal' ? 'content_filter' : 'stop';
  const u = isObject(message.usage) ? message.usage : {};
  const cached = num(u.cache_read_input_tokens);
  const prompt = num(u.input_tokens) + cached + num(u.cache_creation_input_tokens);
  return {
    id: `chatcmpl-${typeof message.id === 'string' ? message.id : Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text.length ? text.join('\n') : null, ...(calls.length ? { tool_calls: calls } : {}), refusal: null }, finish_reason, logprobs: null }],
    usage: { prompt_tokens: prompt, completion_tokens: num(u.output_tokens), total_tokens: prompt + num(u.output_tokens), prompt_tokens_details: { cached_tokens: cached } },
  };
}

/**
 * Any OpenAI-compatible server's answer as a chat completion, ready to be put in another shape: its
 * text without a local reasoning model's `<think>…</think>` preamble, its tool calls with their
 * arguments as written, and `tool_calls` as the finish reason whenever it called one (a server that
 * says "stop" after a tool call would end the agent's loop).
 */
export function chatCompletionOf(answer: unknown, options: { model: string }): ChatCompletion {
  if (!isObject(answer) || !Array.isArray(answer.choices)) throw new Error('not a chat completion: it has no choices');
  const choice = answer.choices.find(isObject);
  const message = choice && isObject(choice.message) ? choice.message : {};
  const text = (typeof message.content === 'string' ? message.content : textOf(message.content)).replace(THINK, '');
  let n = 0;
  const calls: NonNullable<ChatCompletion['choices'][0]['message']['tool_calls']> = [];
  for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isObject(tc) || !isObject(tc.function)) continue;
    const args = tc.function.arguments;
    calls.push({ id: toolId(tc.id, () => `call_shadowlap_${++n}`), type: 'function', function: { name: str(tc.function.name), arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) } });
  }
  const finish = choice?.finish_reason;
  const finish_reason = calls.length ? 'tool_calls' : finish === 'length' ? 'length' : finish === 'content_filter' ? 'content_filter' : 'stop';
  const u = isObject(answer.usage) ? answer.usage : {};
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const cached = isObject(u.prompt_tokens_details) ? num(u.prompt_tokens_details.cached_tokens) : 0;
  return {
    id: typeof answer.id === 'string' && answer.id ? answer.id : `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: typeof answer.created === 'number' ? answer.created : Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text.trim() ? text : null, ...(calls.length ? { tool_calls: calls } : {}), refusal: null }, finish_reason, logprobs: null }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } },
  };
}

/** A chat completion as the `data:` chunks a streaming OpenAI client reads, ending in `[DONE]`. */
export function chatCompletionChunks(c: ChatCompletion, options: { includeUsage?: boolean } = {}): string {
  const base = { id: c.id, object: 'chat.completion.chunk', created: c.created, model: c.model };
  const chunk = (delta: Json, finish: string | null = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });
  const choice = c.choices[0];
  const events: unknown[] = [chunk({ role: 'assistant', content: '', refusal: null })];
  if (choice?.message.content) events.push(chunk({ content: choice.message.content }));
  (choice?.message.tool_calls ?? []).forEach((tc, index) => {
    events.push(chunk({ tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }));
    events.push(chunk({ tool_calls: [{ index, function: { arguments: tc.function.arguments } }] }));
  });
  events.push(chunk({}, choice?.finish_reason ?? 'stop'));
  if (options.includeUsage) events.push({ ...base, choices: [], usage: c.usage });
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

// ---- errors ----

/** The message in an error body from either API, or an OpenAI-compatible server's plain `{ error: "…" }`. */
export function errorMessage(body: unknown, fallback: string): string {
  if (isObject(body)) {
    if (typeof body.error === 'string') return body.error;
    if (isObject(body.error) && typeof body.error.message === 'string') return body.error.message;
    if (typeof body.message === 'string') return body.message;
  }
  return typeof body === 'string' && body.trim() ? body.trim().slice(0, 500) : fallback;
}

const ANTHROPIC_ERROR_TYPES: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error' };

/** An error as the API a client speaks reports one, so its SDK raises its usual error type. */
const GOOGLE_STATUS: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 501: 'UNIMPLEMENTED', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' };
const AWS_ERRORS: Record<number, string> = { 400: 'ValidationException', 401: 'AccessDeniedException', 403: 'AccessDeniedException', 404: 'ResourceNotFoundException', 408: 'ModelTimeoutException', 424: 'ModelErrorException', 429: 'ThrottlingException', 503: 'ServiceUnavailableException' };

/** The error type an AWS client reads from `x-amzn-errortype`, for a status. */
export function awsErrorType(status: number): string {
  return AWS_ERRORS[status] ?? (status >= 500 ? 'InternalServerException' : 'ValidationException');
}

/**
 * An error as the API a client speaks reports one, so its SDK raises its usual error type: Anthropic's
 * and OpenAI's bodies, Google's `{ error: { code, message, status } }`, and AWS's top-level message
 * (its type goes in the `x-amzn-errortype` header, `awsErrorType`). Bedrock's InvokeModel of Claude
 * is an Anthropic shape on AWS: give `aws` for its errors.
 */
export function errorBody(shape: ChatShape | 'aws', status: number, message: string): Json {
  if (shape === 'converse' || shape === 'aws') return { message };
  if (shape === 'gemini') return { error: { code: status, message, status: GOOGLE_STATUS[status] ?? (status >= 500 ? 'INTERNAL' : 'FAILED_PRECONDITION') } };
  if (shape === 'anthropic') return { type: 'error', error: { type: ANTHROPIC_ERROR_TYPES[status] ?? (status >= 500 ? 'api_error' : 'invalid_request_error'), message } };
  return { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code: null } };
}
