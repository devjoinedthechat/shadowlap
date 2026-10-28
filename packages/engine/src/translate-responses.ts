import { openAITools, type ChatCompletion, type TranslatedRequest, type ToOpenAIOptions } from './translate.js';
import { isObject } from './is-object.js';

/**
 * OpenAI's Responses API at a takeover (E8), on OpenAI or Azure OpenAI: a recorded `responses` call
 * translated into chat completions for the model under test (the API every OpenAI-compatible server
 * speaks), and its answer translated back into a Response, or into the events a streaming client
 * reads, ending in `response.completed`.
 *
 * What carries over: the instructions, every input item (messages with their text and images,
 * function calls and their outputs), function tools, the tool choice, parallel tool calls,
 * `max_output_tokens`, temperature, `top_p` and a JSON schema for the answer. What doesn't: reasoning
 * items and the reasoning setting (only the model that reasoned can read them), built-in tools (web
 * search, file search, computer use), and a conversation kept on OpenAI's side
 * (`previous_response_id`, item references), whose turns the request doesn't carry.
 */

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

function toolId(raw: unknown, fallback: () => string): string {
  const id = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '_') : '';
  return id || fallback();
}

/** A message's content as chat parts: its text (input or output) and images; anything else is named as dropped. */
function parts(content: unknown, dropped: Set<string>): Json[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out: Json[] = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (!isObject(p)) continue;
    if ((p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    else if (p.type === 'input_image' && typeof p.image_url === 'string') out.push({ type: 'image_url', image_url: { url: p.image_url } });
    else if (p.type === 'refusal' && typeof p.refusal === 'string') out.push({ type: 'text', text: p.refusal });
    else dropped.add(`${str(p.type) || 'unknown'} parts`);
  }
  return out;
}

const textOnly = (ps: Json[]) => ps.every((p) => p.type === 'text');
const joined = (ps: Json[]) => ps.map((p) => p.text as string).join('\n');

export function responsesToOpenAIChat(input: unknown, options: ToOpenAIOptions = {}): TranslatedRequest {
  if (!isObject(input) || (input.input === undefined && input.previous_response_id === undefined)) throw new Error('not a Responses API request: it has no input');
  const dropped = new Set<string>();
  const messages: Json[] = [];
  let n = 0;
  const nextId = () => `call_shadowlap_${++n}`;
  if (typeof input.instructions === 'string' && input.instructions) messages.push({ role: 'system', content: input.instructions });
  if (input.previous_response_id !== undefined && input.previous_response_id !== null) dropped.add("the conversation kept on OpenAI's side (previous_response_id)");

  const items = typeof input.input === 'string' ? [{ role: 'user', content: input.input }] : Array.isArray(input.input) ? input.input : [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const type = item.type ?? 'message';
    if (type === 'message') {
      const ps = parts(item.content, dropped);
      if (item.role === 'system' || item.role === 'developer') {
        if (ps.length) messages.push({ role: 'system', content: joined(ps.filter((p) => p.type === 'text')) });
      } else if (item.role === 'assistant') {
        if (ps.length) messages.push({ role: 'assistant', content: joined(ps.filter((p) => p.type === 'text')) });
      } else if (ps.length) messages.push({ role: 'user', content: textOnly(ps) ? joined(ps) : ps });
    } else if (type === 'function_call') {
      const call = { id: toolId(item.call_id, nextId), type: 'function', function: { name: str(item.name), arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) } };
      // Consecutive calls (and the text the model said before them) are one assistant turn.
      const last = messages.at(-1);
      if (last && last.role === 'assistant') last.tool_calls = [...((last.tool_calls as Json[] | undefined) ?? []), call];
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (type === 'function_call_output') {
      const output = typeof item.output === 'string' ? item.output : joined(parts(item.output, dropped).filter((p) => p.type === 'text'));
      messages.push({ role: 'tool', tool_call_id: toolId(item.call_id, nextId), content: output });
    } else if (type === 'reasoning') dropped.add('reasoning items');
    else if (type === 'item_reference') dropped.add("items kept on OpenAI's side");
    else dropped.add(`${str(type)} items`);
  }

  const out: Json = { model: options.model ?? null, messages };
  const tools = openAITools(input);
  if (tools.length) out.tools = tools;
  for (const t of Array.isArray(input.tools) ? input.tools : []) if (isObject(t) && t.type !== 'function') dropped.add(`the ${str(t.type)} tool`);
  const choice = input.tool_choice;
  if (tools.length) {
    if (choice === 'auto' || choice === 'none' || choice === 'required') out.tool_choice = choice;
    else if (isObject(choice) && choice.type === 'function' && typeof choice.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.name } };
    if (typeof input.parallel_tool_calls === 'boolean') out.parallel_tool_calls = input.parallel_tool_calls;
  }
  if (typeof input.max_output_tokens === 'number') out[options.maxTokensField ?? 'max_tokens'] = input.max_output_tokens;
  if (typeof input.temperature === 'number') out.temperature = input.temperature;
  if (typeof input.top_p === 'number') out.top_p = input.top_p;
  const format = isObject(input.text) && isObject(input.text.format) ? input.text.format : null;
  if (format?.type === 'json_schema') out.response_format = { type: 'json_schema', json_schema: { name: str(format.name) || 'answer', schema: format.schema ?? {}, ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}) } };
  else if (format?.type === 'json_object') out.response_format = { type: 'json_object' };
  if (input.reasoning !== undefined && input.reasoning !== null) dropped.add('the reasoning setting');
  return { body: out, dropped: [...dropped] };
}

// ---- the answer: a chat completion as a Response ----

export interface ResponseObject {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'incomplete';
  incomplete_details: { reason: 'max_output_tokens' | 'content_filter' } | null;
  error: null;
  model: string;
  output: Array<
    | { type: 'message'; id: string; status: 'completed'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations: [] }> }
    | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string; status: 'completed' }
  >;
  parallel_tool_calls: boolean;
  tool_choice: unknown;
  tools: unknown[];
  usage: { input_tokens: number; input_tokens_details: { cached_tokens: number }; output_tokens: number; output_tokens_details: { reasoning_tokens: number }; total_tokens: number };
  metadata: Record<string, unknown>;
  text: { format: { type: 'text' } };
}

/** A chat completion as the Response a Responses client parses, echoing the request's tools and choice. */
export function chatCompletionToResponse(c: ChatCompletion, options: { model: string; request?: Json }): ResponseObject {
  const choice = c.choices[0];
  const base = c.id.replace(/[^A-Za-z0-9_-]/g, '_');
  const output: ResponseObject['output'] = [];
  const text = choice?.message.content ?? '';
  if (text.trim()) output.push({ type: 'message', id: `msg_${base}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  (choice?.message.tool_calls ?? []).forEach((tc, i) => output.push({ type: 'function_call', id: `fc_${base}_${i + 1}`, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: 'completed' }));
  const finish = choice?.finish_reason;
  const cut = finish === 'length' ? 'max_output_tokens' : finish === 'content_filter' ? 'content_filter' : null;
  const cached = c.usage.prompt_tokens_details?.cached_tokens ?? 0;
  const req = options.request ?? {};
  return {
    id: `resp_${base}`,
    object: 'response',
    created_at: c.created,
    status: cut ? 'incomplete' : 'completed',
    incomplete_details: cut ? { reason: cut } : null,
    error: null,
    model: options.model,
    output,
    parallel_tool_calls: typeof req.parallel_tool_calls === 'boolean' ? req.parallel_tool_calls : true,
    tool_choice: req.tool_choice ?? 'auto',
    tools: Array.isArray(req.tools) ? req.tools : [],
    usage: { input_tokens: c.usage.prompt_tokens, input_tokens_details: { cached_tokens: cached }, output_tokens: c.usage.completion_tokens, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: c.usage.prompt_tokens + c.usage.completion_tokens },
    metadata: {},
    text: { format: { type: 'text' } },
  };
}

/**
 * A Response as the server-sent events a streaming client reads: created and in progress, each output
 * item added with its text or arguments as one delta and done, then `response.completed` with the
 * whole Response, every event numbered.
 */
export function responseEvents(r: ResponseObject): string {
  const events: Json[] = [];
  const pending = { ...r, status: 'in_progress', incomplete_details: null, output: [], usage: null };
  events.push({ type: 'response.created', response: pending });
  events.push({ type: 'response.in_progress', response: pending });
  r.output.forEach((item, output_index) => {
    if (item.type === 'message') {
      const text = item.content[0]?.text ?? '';
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', content: [] } });
      events.push({ type: 'response.content_part.added', item_id: item.id, output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      events.push({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: text, logprobs: [] });
      events.push({ type: 'response.output_text.done', item_id: item.id, output_index, content_index: 0, text, logprobs: [] });
      events.push({ type: 'response.content_part.done', item_id: item.id, output_index, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
    } else {
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, arguments: '', status: 'in_progress' } });
      events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments });
      events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments });
    }
    events.push({ type: 'response.output_item.done', output_index, item });
  });
  events.push({ type: r.status === 'completed' ? 'response.completed' : 'response.incomplete', response: r });
  return events.map((e, i) => `event: ${e.type as string}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join('');
}
