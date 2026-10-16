import { encodeEventStreamFrame } from './eventstream.js';
import { openAITools, type ChatCompletion, type TranslatedRequest, type ToOpenAIOptions } from './translate.js';

/**
 * Amazon Bedrock's Converse API at a takeover (E8): a recorded `converse` or `converse-stream` call
 * translated into the OpenAI chat shape for the model under test, and its answer translated back
 * into what the AWS SDK parses: a Converse response, or the event stream `converse-stream` sends.
 *
 * What carries over: the system prompt, every message, images, tool definitions, tool calls and
 * their results (errors included), the tool choice, `maxTokens`, temperature, `topP` and stop
 * sequences. What doesn't: reasoning blocks (only the model that wrote them can read them),
 * documents, videos, guardrail content and fields only one model family takes
 * (`additionalModelRequestFields`).
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** A tool id as the other side accepts it: letters, digits, `_` and `-`. */
function toolId(raw: unknown, fallback: () => string): string {
  const id = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '_') : '';
  return id || fallback();
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** A Converse image block as a data URL, or null when it carries no bytes (an S3 location). */
function imageUrl(image: unknown): string | null {
  if (!isObject(image) || !isObject(image.source) || typeof image.source.bytes !== 'string') return null;
  return `data:${IMAGE_TYPES[str(image.format)] ?? 'image/png'};base64,${image.source.bytes}`;
}

/** What a tool result says, as text: its text and JSON parts, in order. */
function resultText(content: unknown, dropped: Set<string>): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const c of content) {
    if (!isObject(c)) continue;
    if (typeof c.text === 'string') out.push(c.text);
    else if (c.json !== undefined) out.push(JSON.stringify(c.json));
    else if (c.image !== undefined) out.push('[image]');
    else dropped.add('documents in tool results');
  }
  return out.join('\n');
}

export function converseToOpenAIChat(input: unknown, options: ToOpenAIOptions = {}): TranslatedRequest {
  if (!isObject(input) || !Array.isArray(input.messages)) throw new Error('not a Bedrock Converse request: it has no messages');
  const dropped = new Set<string>();
  const messages: Json[] = [];
  let n = 0;
  const nextId = () => `call_shadowlap_${++n}`;

  const system = (Array.isArray(input.system) ? input.system : []).flatMap((b) => (isObject(b) && typeof b.text === 'string' ? [b.text] : []));
  if (system.length) messages.push({ role: 'system', content: system.join('\n') });

  for (const m of input.messages) {
    if (!isObject(m) || !Array.isArray(m.content)) continue;
    if (m.role === 'assistant') {
      const text: string[] = [];
      const calls: Json[] = [];
      for (const b of m.content) {
        if (!isObject(b)) continue;
        if (typeof b.text === 'string') text.push(b.text);
        else if (isObject(b.toolUse)) calls.push({ id: toolId(b.toolUse.toolUseId, nextId), type: 'function', function: { name: str(b.toolUse.name), arguments: JSON.stringify(b.toolUse.input ?? {}) } });
        else if (b.reasoningContent !== undefined) dropped.add('reasoning blocks');
        else if (b.cachePoint === undefined) dropped.add(`${Object.keys(b)[0] ?? 'unknown'} blocks`);
      }
      const content = text.join('\n');
      if (!content && !calls.length) continue;
      messages.push({ role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results first (each must follow the assistant message that called it), then what else it says.
    const parts: Json[] = [];
    for (const b of m.content) {
      if (!isObject(b)) continue;
      if (isObject(b.toolResult)) {
        const text = resultText(b.toolResult.content, dropped);
        messages.push({ role: 'tool', tool_call_id: toolId(b.toolResult.toolUseId, nextId), content: b.toolResult.status === 'error' ? `Error: ${text}` : text });
      } else if (typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
      else if (b.image !== undefined) {
        const url = imageUrl(b.image);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
        else dropped.add('images kept in S3');
      } else if (b.cachePoint === undefined) dropped.add(`${Object.keys(b)[0] ?? 'unknown'} blocks`);
    }
    if (!parts.length) continue;
    messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text as string).join('\n') : parts });
  }

  const out: Json = { model: options.model ?? null, messages };
  const tools = openAITools(input);
  if (tools.length) out.tools = tools;
  const toolConfig = isObject(input.toolConfig) ? input.toolConfig : {};
  const listed = Array.isArray(toolConfig.tools) ? toolConfig.tools : [];
  if (listed.some((t) => isObject(t) && !isObject(t.toolSpec) && t.cachePoint === undefined)) dropped.add('system tools');
  const choice = toolConfig.toolChoice;
  if (isObject(choice) && tools.length) {
    if (choice.auto !== undefined) out.tool_choice = 'auto';
    else if (choice.any !== undefined) out.tool_choice = 'required';
    else if (isObject(choice.tool) && typeof choice.tool.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.tool.name } };
  }
  const cfg = isObject(input.inferenceConfig) ? input.inferenceConfig : {};
  if (typeof cfg.maxTokens === 'number') out[options.maxTokensField ?? 'max_tokens'] = cfg.maxTokens;
  if (typeof cfg.temperature === 'number') out.temperature = cfg.temperature;
  if (typeof cfg.topP === 'number') out.top_p = cfg.topP;
  if (Array.isArray(cfg.stopSequences) && cfg.stopSequences.length) out.stop = cfg.stopSequences.filter((s) => typeof s === 'string');
  if (input.additionalModelRequestFields !== undefined) dropped.add('additionalModelRequestFields');
  if (input.guardrailConfig !== undefined) dropped.add('the guardrail');
  return { body: out, dropped: [...dropped] };
}

// ---- the answer: a chat completion as a Converse response ----

export type ConverseStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'content_filtered';

export interface ConverseResponse {
  output: { message: { role: 'assistant'; content: Array<{ text: string } | { toolUse: { toolUseId: string; name: string; input: unknown } }> } };
  stopReason: ConverseStopReason;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadInputTokens?: number };
  metrics: { latencyMs: number };
}

/** A local reasoning model's `<think>…</think>` preamble: thinking, which the agent's side doesn't take. */
const THINK = /^\s*<think>[\s\S]*?<\/think>\s*/;

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { arguments: raw };
  }
}

/** A chat completion as the Converse response the AWS SDK parses. A tool call always stops with `tool_use`. */
export function chatCompletionToConverse(c: ChatCompletion, options: { latencyMs?: number } = {}): ConverseResponse {
  const choice = c.choices[0];
  const content: ConverseResponse['output']['message']['content'] = [];
  const text = (choice?.message.content ?? '').replace(THINK, '');
  if (text.trim()) content.push({ text });
  let n = 0;
  for (const tc of choice?.message.tool_calls ?? []) content.push({ toolUse: { toolUseId: toolId(tc.id, () => `tooluse_shadowlap_${++n}`), name: tc.function.name, input: parseArguments(tc.function.arguments) } });
  const hasTools = content.some((b) => 'toolUse' in b);
  const finish = choice?.finish_reason;
  const stopReason: ConverseStopReason = hasTools ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'content_filtered' : 'end_turn';
  const cached = c.usage.prompt_tokens_details?.cached_tokens ?? 0;
  const input = Math.max(0, c.usage.prompt_tokens - cached);
  return {
    output: { message: { role: 'assistant', content } },
    stopReason,
    usage: { inputTokens: input, outputTokens: c.usage.completion_tokens, totalTokens: input + cached + c.usage.completion_tokens, ...(cached ? { cacheReadInputTokens: cached } : {}) },
    metrics: { latencyMs: options.latencyMs ?? 0 },
  };
}

/** AWS event stream header bytes: each a string header. */
export function eventStreamHeaders(headers: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const h = Buffer.alloc(1 + n.length + 1 + 2);
    h.writeUInt8(n.length, 0);
    n.copy(h, 1);
    h.writeUInt8(7, 1 + n.length);
    h.writeUInt16BE(v.length, 2 + n.length);
    parts.push(h, v);
  }
  return Buffer.concat(parts);
}

/** One event of an AWS event stream, as `converse-stream` and `invoke-with-response-stream` send them. */
export function awsEvent(type: string, payload: unknown): Buffer {
  return encodeEventStreamFrame(eventStreamHeaders({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }), Buffer.from(JSON.stringify(payload), 'utf8'));
}

/** A Converse response as the event stream `converse-stream` answers with. */
export function converseStreamBody(r: ConverseResponse): Buffer {
  const frames: Buffer[] = [awsEvent('messageStart', { role: 'assistant' })];
  r.output.message.content.forEach((block, i) => {
    if ('text' in block) {
      frames.push(awsEvent('contentBlockDelta', { contentBlockIndex: i, delta: { text: block.text } }));
    } else {
      frames.push(awsEvent('contentBlockStart', { contentBlockIndex: i, start: { toolUse: { toolUseId: block.toolUse.toolUseId, name: block.toolUse.name } } }));
      frames.push(awsEvent('contentBlockDelta', { contentBlockIndex: i, delta: { toolUse: { input: JSON.stringify(block.toolUse.input ?? {}) } } }));
    }
    frames.push(awsEvent('contentBlockStop', { contentBlockIndex: i }));
  });
  frames.push(awsEvent('messageStop', { stopReason: r.stopReason }));
  frames.push(awsEvent('metadata', { usage: r.usage, metrics: r.metrics }));
  return Buffer.concat(frames);
}
