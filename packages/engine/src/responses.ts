import { eventStreamMessages } from './eventstream.js';
import { isJudgeCall } from './judge-scope.js';
import { parseSse } from './sse.js';
import type { StoreOf } from './store.js';
import type { CallRecord } from './types.js';

/**
 * Model responses, normalized for display: whatever the provider, a response becomes ordered
 * blocks (text, tool calls, thinking) plus a stop reason. A streamed response also becomes a list
 * of timed deltas, so the browser can play it back at its recorded pacing without knowing any
 * provider's event format.
 */

import { applyDeltas, type Block, type Delta } from './deltas.js';

export { applyDeltas, type Block, type Delta } from './deltas.js';

export interface NormalizedResponse {
  kind: 'sse' | 'json' | 'text' | 'empty';
  blocks: Block[];
  stopReason: string | null;
  /** Streamed responses only: the reconstruction, event by event, with ms since the first byte. */
  deltas: Delta[];
  events: number;
  /** The body as received, for the raw view (SSE text or pretty JSON), capped. */
  raw: string;
}

const RAW_CAP = 512 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJsonText(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ---- Anthropic ----

/** Tool calls Anthropic makes itself: its server tools (web search, web fetch, code execution) and the MCP connector's. */
const HOSTED_ANTHROPIC = new Set(['server_tool_use', 'mcp_tool_use']);

function anthropicDeltas(events: Array<{ data: unknown }>, at: (i: number) => number): Delta[] {
  const out: Delta[] = [];
  events.forEach((e, i) => {
    const d = e.data;
    if (!isObject(d)) return;
    const t = at(i);
    const index = typeof d.index === 'number' ? d.index : 0;
    if (d.type === 'content_block_start' && isObject(d.content_block)) {
      const cb = d.content_block;
      const hosted = HOSTED_ANTHROPIC.has(String(cb.type));
      const block = cb.type === 'tool_use' || hosted ? 'tool_call' : cb.type === 'thinking' || cb.type === 'redacted_thinking' ? 'thinking' : 'text';
      out.push({ t, op: 'start', index, block, ...(typeof cb.name === 'string' ? { name: cb.name } : {}), ...(hosted ? { hosted: true as const } : {}) });
      if (typeof cb.text === 'string' && cb.text) out.push({ t, op: 'append', index, text: cb.text });
    } else if (d.type === 'content_block_delta' && isObject(d.delta)) {
      const text = d.delta.text ?? d.delta.partial_json ?? d.delta.thinking;
      if (typeof text === 'string' && text) out.push({ t, op: 'append', index, text });
    } else if (d.type === 'message_delta' && isObject(d.delta) && typeof d.delta.stop_reason === 'string') {
      out.push({ t, op: 'stop', reason: d.delta.stop_reason });
    }
  });
  return out;
}

function anthropicJson(body: Record<string, unknown>): { blocks: Block[]; stopReason: string | null } | null {
  if (!Array.isArray(body.content)) return null;
  const blocks: Block[] = [];
  for (const c of body.content) {
    if (!isObject(c)) continue;
    if (c.type === 'text' && typeof c.text === 'string') blocks.push({ type: 'text', text: c.text });
    else if (c.type === 'thinking' && typeof c.thinking === 'string') blocks.push({ type: 'thinking', text: c.thinking });
    else if (c.type === 'tool_use' || HOSTED_ANTHROPIC.has(String(c.type))) blocks.push({ type: 'tool_call', name: String(c.name ?? 'tool'), input: c.input ?? {}, ...(typeof c.id === 'string' ? { id: c.id } : {}), ...(c.type !== 'tool_use' ? { hosted: true as const } : {}) });
  }
  return { blocks, stopReason: typeof body.stop_reason === 'string' ? body.stop_reason : null };
}

/**
 * A Responses API item for a tool OpenAI defines and runs itself, or has the client run as it
 * defines it, as a tool call: named for the tool (`web_search`, `file_search`, `code_interpreter`,
 * `image_generation`, `local_shell`, `shell`, `apply_patch`), a computer use action by its kind
 * (`computer.click`, `computer.screenshot`), an MCP server's tool by its own name. Null for any other item.
 */
function hostedItem(item: Record<string, unknown>): { name: string; input: unknown } | null {
  const action: Record<string, unknown> = isObject(item.action) ? item.action : {};
  switch (item.type) {
    case 'web_search_call':
      return { name: 'web_search', input: action };
    case 'file_search_call':
      return { name: 'file_search', input: { queries: Array.isArray(item.queries) ? item.queries : [] } };
    case 'code_interpreter_call':
      return { name: 'code_interpreter', input: { code: typeof item.code === 'string' ? item.code : '' } };
    case 'image_generation_call':
      // Its result is the image itself: what it was asked for is all a decision holds.
      return { name: 'image_generation', input: typeof item.revised_prompt === 'string' ? { prompt: item.revised_prompt } : {} };
    case 'computer_call':
      return { name: `computer.${typeof action.type === 'string' ? action.type : 'action'}`, input: action };
    case 'local_shell_call':
      return { name: 'local_shell', input: action };
    case 'shell_call':
      return { name: 'shell', input: action };
    case 'apply_patch_call':
      return { name: 'apply_patch', input: isObject(item.operation) ? item.operation : {} };
    case 'mcp_call':
      return { name: String(item.name ?? 'mcp'), input: typeof item.arguments === 'string' ? parseJsonText(item.arguments) : (item.arguments ?? {}) };
    default:
      return null;
  }
}

// ---- OpenAI Chat Completions and Responses ----

function openaiDeltas(events: Array<{ data: unknown }>, at: (i: number) => number): Delta[] {
  const out: Delta[] = [];
  const started = new Map<string, number>();
  let next = 0;
  const slot = (key: string, block: 'text' | 'thinking' | 'tool_call', t: number, name?: string, hosted?: true) => {
    let i = started.get(key);
    if (i === undefined) {
      i = next++;
      started.set(key, i);
      out.push({ t, op: 'start', index: i, block, ...(name ? { name } : {}), ...(hosted ? { hosted } : {}) });
    }
    return i;
  };
  events.forEach((e, n) => {
    const d = e.data;
    if (!isObject(d)) return;
    const t = at(n);
    // Chat Completions chunks
    if (Array.isArray(d.choices)) {
      for (const ch of d.choices) {
        if (!isObject(ch)) continue;
        const delta = isObject(ch.delta) ? ch.delta : null;
        if (delta && typeof delta.content === 'string' && delta.content) out.push({ t, op: 'append', index: slot('text', 'text', t), text: delta.content });
        if (delta && typeof delta.reasoning_content === 'string' && delta.reasoning_content) out.push({ t, op: 'append', index: slot('reasoning', 'thinking', t), text: delta.reasoning_content });
        if (delta && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!isObject(tc)) continue;
            const fn = isObject(tc.function) ? tc.function : {};
            const i = slot(`tool${String(tc.index ?? 0)}`, 'tool_call', t, typeof fn.name === 'string' ? fn.name : undefined);
            if (typeof fn.arguments === 'string' && fn.arguments) out.push({ t, op: 'append', index: i, text: fn.arguments });
          }
        }
        if (typeof ch.finish_reason === 'string') out.push({ t, op: 'stop', reason: ch.finish_reason });
      }
      return;
    }
    // Responses API events
    if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') out.push({ t, op: 'append', index: slot(`text${String(d.output_index ?? 0)}`, 'text', t), text: d.delta });
    else if (d.type === 'response.reasoning_summary_text.delta' && typeof d.delta === 'string') out.push({ t, op: 'append', index: slot(`reasoning${String(d.output_index ?? 0)}`, 'thinking', t), text: d.delta });
    else if (d.type === 'response.output_item.added' && isObject(d.item) && (d.item.type === 'function_call' || d.item.type === 'custom_tool_call')) slot(`fn${String(d.output_index ?? 0)}`, 'tool_call', t, typeof d.item.name === 'string' ? d.item.name : undefined);
    else if ((d.type === 'response.function_call_arguments.delta' || d.type === 'response.custom_tool_call_input.delta') && typeof d.delta === 'string') out.push({ t, op: 'append', index: slot(`fn${String(d.output_index ?? 0)}`, 'tool_call', t), text: d.delta });
    else if (d.type === 'response.output_item.done' && isObject(d.item)) {
      // A built-in tool's call arrives whole, once it is done.
      const hosted = hostedItem(d.item);
      if (hosted) out.push({ t, op: 'append', index: slot(`hosted${String(d.output_index ?? 0)}`, 'tool_call', t, hosted.name, true), text: JSON.stringify(hosted.input) });
    }
    else if (d.type === 'response.completed' && isObject(d.response)) out.push({ t, op: 'stop', reason: typeof d.response.status === 'string' ? d.response.status : 'completed' });
  });
  return out;
}

function openaiJson(body: Record<string, unknown>): { blocks: Block[]; stopReason: string | null } | null {
  if (Array.isArray(body.choices)) {
    const ch = (body.choices as unknown[])[0];
    if (!isObject(ch) || !isObject(ch.message)) return { blocks: [], stopReason: null };
    const m = ch.message;
    const blocks: Block[] = [];
    if (typeof m.reasoning_content === 'string' && m.reasoning_content) blocks.push({ type: 'thinking', text: m.reasoning_content });
    if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!isObject(tc) || !isObject(tc.function)) continue;
        blocks.push({ type: 'tool_call', name: String(tc.function.name ?? 'tool'), input: typeof tc.function.arguments === 'string' ? parseJsonText(tc.function.arguments) : tc.function.arguments, ...(typeof tc.id === 'string' ? { id: tc.id } : {}) });
      }
    }
    return { blocks, stopReason: typeof ch.finish_reason === 'string' ? ch.finish_reason : null };
  }
  if (Array.isArray(body.output)) {
    const blocks: Block[] = [];
    for (const item of body.output) {
      if (!isObject(item)) continue;
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) if (isObject(c) && typeof c.text === 'string') blocks.push({ type: 'text', text: c.text });
      } else if (item.type === 'function_call') {
        blocks.push({ type: 'tool_call', name: String(item.name ?? 'tool'), input: typeof item.arguments === 'string' ? parseJsonText(item.arguments) : item.arguments, ...(typeof item.call_id === 'string' ? { id: item.call_id } : {}) });
      } else if (item.type === 'custom_tool_call') {
        // A tool of the agent's own that takes free text rather than JSON arguments.
        blocks.push({ type: 'tool_call', name: String(item.name ?? 'tool'), input: item.input ?? '', ...(typeof item.call_id === 'string' ? { id: item.call_id } : {}) });
      } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        const text = item.summary.map((s) => (isObject(s) && typeof s.text === 'string' ? s.text : '')).join('\n');
        if (text) blocks.push({ type: 'thinking', text });
      } else {
        const hosted = hostedItem(item);
        if (hosted) blocks.push({ type: 'tool_call', name: hosted.name, input: hosted.input, ...(typeof item.call_id === 'string' ? { id: item.call_id } : typeof item.id === 'string' ? { id: item.id } : {}), hosted: true });
      }
    }
    return { blocks, stopReason: typeof body.status === 'string' ? body.status : null };
  }
  return null;
}

// ---- Amazon Bedrock Converse ----

/** ConverseStream events: text, reasoning and tool-use deltas by content block index. */
function converseDeltas(events: Array<{ type: string | null; payload: Record<string, unknown> | null }>, at: (i: number) => number): Delta[] {
  const out: Delta[] = [];
  const started = new Map<number, number>();
  let next = 0;
  const slot = (block: number, kind: 'text' | 'thinking' | 'tool_call', t: number, name?: string) => {
    let i = started.get(block);
    if (i === undefined) {
      i = next++;
      started.set(block, i);
      out.push({ t, op: 'start', index: i, block: kind, ...(name ? { name } : {}) });
    }
    return i;
  };
  events.forEach(({ payload: p }, n) => {
    if (!p) return;
    const t = at(n);
    const block = typeof p.contentBlockIndex === 'number' ? p.contentBlockIndex : 0;
    if (isObject(p.start) && isObject(p.start.toolUse)) slot(block, 'tool_call', t, String(p.start.toolUse.name ?? 'tool'));
    if (isObject(p.delta)) {
      const d = p.delta;
      if (typeof d.text === 'string') out.push({ t, op: 'append', index: slot(block, 'text', t), text: d.text });
      else if (isObject(d.toolUse) && typeof d.toolUse.input === 'string') out.push({ t, op: 'append', index: slot(block, 'tool_call', t), text: d.toolUse.input });
      else if (isObject(d.reasoningContent) && typeof d.reasoningContent.text === 'string') out.push({ t, op: 'append', index: slot(block, 'thinking', t), text: d.reasoningContent.text });
    }
    if (typeof p.stopReason === 'string') out.push({ t, op: 'stop', reason: p.stopReason });
  });
  return out;
}

function converseJson(body: Record<string, unknown>): { blocks: Block[]; stopReason: string | null } | null {
  if (!isObject(body.output) || !isObject(body.output.message) || !Array.isArray(body.output.message.content)) return null;
  const blocks: Block[] = [];
  for (const c of body.output.message.content) {
    if (!isObject(c)) continue;
    if (typeof c.text === 'string') blocks.push({ type: 'text', text: c.text });
    else if (isObject(c.toolUse)) blocks.push({ type: 'tool_call', name: String(c.toolUse.name ?? 'tool'), input: c.toolUse.input ?? {}, ...(typeof c.toolUse.toolUseId === 'string' ? { id: c.toolUse.toolUseId } : {}) });
    else if (isObject(c.reasoningContent) && isObject(c.reasoningContent.reasoningText) && typeof c.reasoningContent.reasoningText.text === 'string') blocks.push({ type: 'thinking', text: c.reasoningContent.reasoningText.text });
  }
  return { blocks, stopReason: typeof body.stopReason === 'string' ? body.stopReason : null };
}

// ---- Gemini ----

function geminiParts(parts: unknown[], push: (b: Block) => void): void {
  for (const p of parts) {
    if (!isObject(p)) continue;
    if (typeof p.text === 'string') push(p.thought === true ? { type: 'thinking', text: p.text } : { type: 'text', text: p.text });
    else if (isObject(p.functionCall)) push({ type: 'tool_call', name: String(p.functionCall.name ?? 'tool'), input: p.functionCall.args ?? {} });
  }
}

function geminiDeltas(events: Array<{ data: unknown }>, at: (i: number) => number): Delta[] {
  const out: Delta[] = [];
  let next = 0;
  let textIndex = -1;
  let thoughtIndex = -1;
  events.forEach((e, n) => {
    const d = e.data;
    if (!isObject(d) || !Array.isArray(d.candidates)) return;
    const c = (d.candidates as unknown[])[0];
    if (!isObject(c)) return;
    const t = at(n);
    const parts = isObject(c.content) && Array.isArray(c.content.parts) ? c.content.parts : [];
    geminiParts(parts, (b) => {
      if (b.type === 'tool_call') {
        const i = next++;
        out.push({ t, op: 'start', index: i, block: 'tool_call', name: b.name }, { t, op: 'append', index: i, text: JSON.stringify(b.input) });
      } else if (b.type === 'thinking') {
        if (thoughtIndex < 0) out.push({ t, op: 'start', index: (thoughtIndex = next++), block: 'thinking' });
        out.push({ t, op: 'append', index: thoughtIndex, text: b.text });
      } else {
        if (textIndex < 0) out.push({ t, op: 'start', index: (textIndex = next++), block: 'text' });
        out.push({ t, op: 'append', index: textIndex, text: b.text });
      }
    });
    if (typeof c.finishReason === 'string') out.push({ t, op: 'stop', reason: c.finishReason });
  });
  return out;
}

function geminiJson(body: Record<string, unknown>): { blocks: Block[]; stopReason: string | null } | null {
  if (!Array.isArray(body.candidates)) return null;
  const c = (body.candidates as unknown[])[0];
  const blocks: Block[] = [];
  if (isObject(c) && isObject(c.content) && Array.isArray(c.content.parts)) geminiParts(c.content.parts, (b) => blocks.push(b));
  return { blocks, stopReason: isObject(c) && typeof c.finishReason === 'string' ? c.finishReason : null };
}

// ---- Vercel's AI Gateway: the AI SDK's own language-model results and stream parts ----

/** A finish reason as the AI SDK's spec gives it: `{ unified, raw }` from version 3 on, a string before. */
function gatewayFinish(v: unknown): string | null {
  if (typeof v === 'string') return v;
  return isObject(v) && typeof v.unified === 'string' ? v.unified : null;
}

/** A tool call as the spec gives it: its input is JSON text. One the provider runs itself is hosted. */
function gatewayToolCall(c: Record<string, unknown>): Block {
  return { type: 'tool_call', name: String(c.toolName ?? 'tool'), input: typeof c.input === 'string' ? parseJsonText(c.input) : (c.input ?? {}), ...(typeof c.toolCallId === 'string' ? { id: c.toolCallId } : {}), ...(c.providerExecuted === true ? { hosted: true as const } : {}) };
}

/** A generate result: `content` (text, reasoning, tool calls) and `finishReason`; Anthropic's has `stop_reason` instead. */
function gatewayJson(body: Record<string, unknown>): { blocks: Block[]; stopReason: string | null } | null {
  if (!Array.isArray(body.content) || !('finishReason' in body) || 'stop_reason' in body) return null;
  const blocks: Block[] = [];
  for (const c of body.content) {
    if (!isObject(c)) continue;
    if (c.type === 'text' && typeof c.text === 'string') blocks.push({ type: 'text', text: c.text });
    else if (c.type === 'reasoning' && typeof c.text === 'string') blocks.push({ type: 'thinking', text: c.text });
    else if (c.type === 'tool-call') blocks.push(gatewayToolCall(c));
  }
  return { blocks, stopReason: gatewayFinish(body.finishReason) };
}

/** The spec's stream parts, `text-delta`, `tool-call`, `finish` and the rest, each an event's data. */
const GATEWAY_PARTS = new Set(['stream-start', 'response-metadata', 'text-start', 'text-delta', 'text-end', 'reasoning-start', 'reasoning-delta', 'reasoning-end', 'tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call', 'tool-result', 'finish']);

/**
 * A stream of parts: text and reasoning by their `id`, and each tool call whole, as the `tool-call`
 * part gives it after the `tool-input-*` parts that streamed its input (read once, from that part).
 */
function gatewayDeltas(events: Array<{ data: unknown }>, at: (i: number) => number): Delta[] {
  const out: Delta[] = [];
  const open = new Map<string, number>();
  let next = 0;
  events.forEach((e, n) => {
    const d = e.data;
    if (!isObject(d) || typeof d.type !== 'string') return;
    const t = at(n);
    const kind = d.type.startsWith('reasoning-') ? 'thinking' : 'text';
    const key = `${kind}:${String(d.id ?? '')}`;
    if (d.type === 'text-delta' || d.type === 'reasoning-delta') {
      if (!open.has(key)) {
        open.set(key, next);
        out.push({ t, op: 'start', index: next++, block: kind });
      }
      if (typeof d.delta === 'string') out.push({ t, op: 'append', index: open.get(key)!, text: d.delta });
    } else if (d.type === 'tool-call') {
      const call = gatewayToolCall(d);
      if (call.type !== 'tool_call') return;
      const i = next++;
      out.push({ t, op: 'start', index: i, block: 'tool_call', name: call.name, ...(call.hosted ? { hosted: true as const } : {}) }, { t, op: 'append', index: i, text: JSON.stringify(call.input) });
    } else if (d.type === 'finish') {
      const reason = gatewayFinish(d.finishReason);
      if (reason) out.push({ t, op: 'stop', reason });
    }
  });
  return out;
}

// ----

/**
 * The wire format of a stream, read from its events. The provider id only breaks a tie: Vertex AI
 * streams Anthropic's events for Claude and Gemini's for Gemini, and Gemini's OpenAI-compatible
 * endpoint streams OpenAI's chunks, all under one id each.
 */
function streamStyle(events: Array<{ data: unknown }>, provider: string | undefined): 'anthropic' | 'gemini' | 'openai' | 'gateway' {
  for (const { data } of events) {
    if (!isObject(data)) continue;
    if (typeof data.type === 'string') {
      if (data.type.startsWith('message') || data.type.startsWith('content_block')) return 'anthropic';
      if (data.type.startsWith('response.')) return 'openai';
      if (GATEWAY_PARTS.has(data.type)) return 'gateway';
    }
    if (Array.isArray(data.candidates)) return 'gemini';
    if (Array.isArray(data.choices)) return 'openai';
  }
  return provider === 'anthropic' || provider === 'gemini' ? provider : 'openai';
}

export function normalizeResponse(bytes: Buffer | null, contentType: string | undefined, chunks: Array<[number, number]> = [], provider?: string): NormalizedResponse {
  if (!bytes || bytes.length === 0) return { kind: 'empty', blocks: [], stopReason: null, deltas: [], events: 0, raw: '' };
  const text = bytes.toString('utf8');
  const raw = text.length > RAW_CAP ? `${text.slice(0, RAW_CAP)}\n… ${text.length - RAW_CAP} more characters` : text;
  if (contentType?.includes('vnd.amazon.eventstream')) {
    // Bedrock streams are binary frames. InvokeModel's carry the model's own events (Anthropic's for
    // Claude); ConverseStream's carry Converse events.
    const messages = [...eventStreamMessages(bytes)];
    const at = (i: number) => chunks[Math.min(i, chunks.length - 1)]?.[1] ?? i * 20;
    const deltas = messages.some((m) => typeof m.payload?.type === 'string') ? anthropicDeltas(messages.map((m) => ({ data: m.payload })), at) : converseDeltas(messages, at);
    const decoded = messages.map((m) => JSON.stringify({ event: m.type, ...m.payload })).join('\n');
    return { kind: 'sse', ...applyDeltas(deltas), deltas, events: messages.length, raw: decoded.length > RAW_CAP ? `${decoded.slice(0, RAW_CAP)}\n…` : decoded };
  }
  if (contentType?.includes('text/event-stream')) {
    const events = parseSse(bytes);
    const at = (i: number) => chunks[Math.min(i, chunks.length - 1)]?.[1] ?? i * 20;
    const style = streamStyle(events, provider);
    const deltas = style === 'anthropic' ? anthropicDeltas(events, at) : style === 'gemini' ? geminiDeltas(events, at) : style === 'gateway' ? gatewayDeltas(events, at) : openaiDeltas(events, at);
    return { kind: 'sse', ...applyDeltas(deltas), deltas, events: events.length, raw };
  }
  const parsed = parseJsonText(text);
  if (isObject(parsed)) {
    const normalized = gatewayJson(parsed) ?? anthropicJson(parsed) ?? openaiJson(parsed) ?? geminiJson(parsed) ?? converseJson(parsed) ?? { blocks: [], stopReason: null };
    return { kind: 'json', ...normalized, deltas: [], events: 0, raw: JSON.stringify(parsed, null, 2).slice(0, RAW_CAP) };
  }
  return { kind: 'text', blocks: [], stopReason: null, deltas: [], events: 0, raw };
}

/**
 * The text of the agent's last model response among `calls`: '' when it had no text, null without a
 * readable one. A judge's verdict is never the agent's answer: its calls are passed over.
 */
export function finalAnswer(store: StoreOf<'recording'>, calls: CallRecord[]): string | null {
  const last = [...calls].reverse().find((c) => c.kind === 'api' && c.end?.responseRef && !isJudgeCall(c));
  if (!last?.end?.responseRef) return null;
  try {
    const provider = last.end.meta.provider ?? last.meta.provider;
    const r = normalizeResponse(store.getBlob(last.end.responseRef), last.end.meta.headers?.['content-type'], last.end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
    return r.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  } catch {
    return null;
  }
}
