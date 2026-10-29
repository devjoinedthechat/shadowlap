import { isObject } from './is-object.js';
/**
 * Model requests, normalized for display: the conversation a model call sent, as turns of typed
 * blocks, whatever the provider's shape (Anthropic messages, OpenAI Chat Completions and Responses
 * input, Gemini contents).
 */

export type TurnBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | { type: 'tool_call'; name: string; input: unknown; id?: string }
  | { type: 'tool_result'; content: string; id?: string; name?: string; isError?: boolean }
  | { type: 'other'; label: string };

export interface Turn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  blocks: TurnBlock[];
}

export interface Conversation {
  turns: Turn[];
  model: string | null;
  /** Tools offered to the model, by name. */
  tools: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v, null, 2));

function parseArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Anthropic content (a string or blocks); also the shape of OpenAI content-part arrays. */
function contentBlocks(content: unknown): TurnBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return content === undefined || content === null ? [] : [{ type: 'text', text: str(content) }];
  const out: TurnBlock[] = [];
  for (const b of content) {
    if (typeof b === 'string') {
      out.push({ type: 'text', text: b });
      continue;
    }
    if (!isObject(b)) continue;
    // Bedrock Converse blocks are keyed by kind instead of carrying a type.
    if (b.type === undefined) {
      if (typeof b.text === 'string') out.push({ type: 'text', text: b.text });
      else if (isObject(b.toolUse)) out.push({ type: 'tool_call', name: str(b.toolUse.name), input: b.toolUse.input ?? {}, ...(typeof b.toolUse.toolUseId === 'string' ? { id: b.toolUse.toolUseId } : {}) });
      else if (isObject(b.toolResult)) {
        const inner = Array.isArray(b.toolResult.content) ? b.toolResult.content.map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : isObject(c) && c.json !== undefined ? str(c.json) : '')).join('\n') : '';
        out.push({ type: 'tool_result', content: inner, ...(typeof b.toolResult.toolUseId === 'string' ? { id: b.toolResult.toolUseId } : {}), ...(b.toolResult.status === 'error' ? { isError: true } : {}) });
      } else if (isObject(b.reasoningContent)) out.push({ type: 'thinking', text: isObject(b.reasoningContent.reasoningText) ? str(b.reasoningContent.reasoningText.text) : '' });
      else if (b.image || b.document || b.video) out.push({ type: 'other', label: b.image ? 'image' : b.document ? 'document' : 'video' });
      else if (b.cachePoint) continue;
      else out.push({ type: 'other', label: Object.keys(b)[0] ?? 'block' });
      continue;
    }
    switch (b.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        out.push({ type: 'text', text: str(b.text) });
        break;
      case 'thinking':
        out.push({ type: 'thinking', text: str(b.thinking) });
        break;
      case 'redacted_thinking':
        out.push({ type: 'thinking', text: '', redacted: true });
        break;
      case 'tool_use':
      case 'server_tool_use':
        out.push({ type: 'tool_call', name: str(b.name), input: b.input ?? {}, ...(typeof b.id === 'string' ? { id: b.id } : {}) });
        break;
      case 'tool_result': {
        const inner = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : isObject(c) ? `[${str(c.type)}]` : str(c))).join('\n') : str(b.content);
        out.push({ type: 'tool_result', content: inner, ...(typeof b.tool_use_id === 'string' ? { id: b.tool_use_id } : {}), ...(b.is_error === true ? { isError: true } : {}) });
        break;
      }
      case 'image':
      case 'image_url':
      case 'input_image':
        out.push({ type: 'other', label: 'image' });
        break;
      case 'document':
      case 'file':
      case 'input_file':
        out.push({ type: 'other', label: 'document' });
        break;
      default:
        out.push({ type: 'other', label: str(b.type) || 'block' });
    }
  }
  return out;
}

function anthropic(body: Record<string, unknown>): Turn[] {
  const turns: Turn[] = [];
  if (body.system !== undefined) turns.push({ role: 'system', blocks: contentBlocks(body.system) });
  for (const m of body.messages as unknown[]) {
    if (!isObject(m)) continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    const blocks = contentBlocks(m.content);
    // A user turn made only of tool results reads as the tools answering.
    turns.push({ role: role === 'user' && blocks.length > 0 && blocks.every((b) => b.type === 'tool_result') ? 'tool' : role, blocks });
  }
  return turns;
}

function openaiChat(messages: unknown[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (!isObject(m)) continue;
    const blocks = contentBlocks(m.content);
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!isObject(tc) || !isObject(tc.function)) continue;
        blocks.push({ type: 'tool_call', name: str(tc.function.name), input: parseArgs(tc.function.arguments), ...(typeof tc.id === 'string' ? { id: tc.id } : {}) });
      }
    }
    if (m.role === 'tool') {
      turns.push({ role: 'tool', blocks: [{ type: 'tool_result', content: blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n'), ...(typeof m.tool_call_id === 'string' ? { id: m.tool_call_id } : {}), ...(typeof m.name === 'string' ? { name: m.name } : {}) }] });
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' || m.role === 'developer' ? 'system' : 'user';
    turns.push({ role, blocks });
  }
  return turns;
}

function openaiResponses(body: Record<string, unknown>): Turn[] {
  const turns: Turn[] = [];
  if (typeof body.instructions === 'string') turns.push({ role: 'system', blocks: [{ type: 'text', text: body.instructions }] });
  if (typeof body.input === 'string') {
    turns.push({ role: 'user', blocks: [{ type: 'text', text: body.input }] });
    return turns;
  }
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!isObject(item)) continue;
    if (item.type === 'function_call') turns.push({ role: 'assistant', blocks: [{ type: 'tool_call', name: str(item.name), input: parseArgs(item.arguments), ...(typeof item.call_id === 'string' ? { id: item.call_id } : {}) }] });
    else if (item.type === 'function_call_output') turns.push({ role: 'tool', blocks: [{ type: 'tool_result', content: str(item.output), ...(typeof item.call_id === 'string' ? { id: item.call_id } : {}) }] });
    else if (item.type === 'reasoning') turns.push({ role: 'assistant', blocks: [{ type: 'thinking', text: Array.isArray(item.summary) ? item.summary.map((s) => (isObject(s) ? str(s.text) : '')).join('\n') : '' }] });
    else {
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' || item.role === 'developer' ? 'system' : 'user';
      turns.push({ role, blocks: contentBlocks(item.content) });
    }
  }
  return turns;
}

function geminiBlocks(parts: unknown[]): TurnBlock[] {
  const out: TurnBlock[] = [];
  for (const p of parts) {
    if (!isObject(p)) continue;
    if (typeof p.text === 'string') out.push(p.thought === true ? { type: 'thinking', text: p.text } : { type: 'text', text: p.text });
    else if (isObject(p.functionCall)) out.push({ type: 'tool_call', name: str(p.functionCall.name), input: p.functionCall.args ?? {} });
    else if (isObject(p.functionResponse)) out.push({ type: 'tool_result', name: str(p.functionResponse.name), content: str(p.functionResponse.response) });
    else if (p.inlineData || p.fileData) out.push({ type: 'other', label: 'file' });
  }
  return out;
}

function gemini(body: Record<string, unknown>): Turn[] {
  const turns: Turn[] = [];
  const sys = body.systemInstruction;
  if (isObject(sys) && Array.isArray(sys.parts)) turns.push({ role: 'system', blocks: geminiBlocks(sys.parts) });
  else if (typeof sys === 'string') turns.push({ role: 'system', blocks: [{ type: 'text', text: sys }] });
  for (const c of body.contents as unknown[]) {
    if (!isObject(c)) continue;
    const blocks = geminiBlocks(Array.isArray(c.parts) ? c.parts : []);
    const role = c.role === 'model' ? 'assistant' : blocks.length > 0 && blocks.every((b) => b.type === 'tool_result') ? 'tool' : 'user';
    turns.push({ role, blocks });
  }
  return turns;
}

function toolNames(body: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (!isObject(t)) continue;
    if (typeof t.name === 'string') names.push(t.name);
    else if (isObject(t.function) && typeof t.function.name === 'string') names.push(t.function.name);
    else if (Array.isArray(t.functionDeclarations)) for (const f of t.functionDeclarations) if (isObject(f) && typeof f.name === 'string') names.push(f.name);
  }
  // Bedrock Converse: toolConfig.tools[].toolSpec.name
  const converse = isObject(body.toolConfig) && Array.isArray(body.toolConfig.tools) ? body.toolConfig.tools : [];
  for (const t of converse) if (isObject(t) && isObject(t.toolSpec) && typeof t.toolSpec.name === 'string') names.push(t.toolSpec.name);
  return names;
}

/** The conversation in a model request, or null when the body is not a conversation. */
export function normalizeConversation(body: unknown, pathModel?: string | null): Conversation | null {
  if (!isObject(body)) return null;
  let turns: Turn[] | null = null;
  if (Array.isArray(body.contents)) turns = gemini(body);
  else if (Array.isArray(body.messages)) {
    // Anthropic keeps system outside messages and uses typed blocks; OpenAI chat puts roles like "tool" inside.
    const openaiShaped = body.system === undefined && (body.messages as unknown[]).some((m) => isObject(m) && (m.role === 'tool' || m.role === 'developer' || Array.isArray(m.tool_calls) || (m.role === 'system' && typeof m.content === 'string')));
    turns = openaiShaped ? openaiChat(body.messages as unknown[]) : anthropic(body);
  } else if (body.input !== undefined) turns = openaiResponses(body);
  if (!turns) return null;
  return { turns, model: typeof body.model === 'string' ? body.model : (pathModel ?? null), tools: toolNames(body) };
}
