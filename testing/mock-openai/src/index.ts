import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted fake of the OpenAI Chat Completions API, close enough to the real wire format for the
 * official SDK's streaming client: `data:` chunks, a final usage chunk when `stream_options.include_usage`
 * is set, and `data: [DONE]`. It also answers the Responses API, as JSON or as its stream of events,
 * keeping what it answered on its side as OpenAI does: a request may continue a response it made
 * (`previous_response_id`) or a conversation (`conversation`, made with `POST /v1/conversations`),
 * and one that names a response this server never made, or made with `store: false`, is refused as
 * OpenAI refuses it. And it answers embeddings, so an agent that mixes them can be recorded, and lists
 * its models as the Models API does. It knows nothing about Shadowlap.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Turn {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: 'stop' | 'tool_calls';
  usage: { prompt_tokens: number; completion_tokens: number };
}

export interface ChatRequest {
  model: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
  tools?: unknown[];
}

export interface ScriptContext {
  request: ChatRequest;
  requestNo: number;
  assistantTurns: number;
}

export type ScriptResult = { turn: Turn } | { status: number; body: unknown; headers?: Record<string, string> };
export type Script = (ctx: ScriptContext) => ScriptResult;

export interface MockServer {
  url: string;
  requests: Array<{ headers: Record<string, string>; body: ChatRequest }>;
  /** Requests to the Responses API and to embeddings, with their paths. */
  otherRequests: Array<{ path: string; headers: Record<string, string>; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** A Responses API request (`POST /v1/responses`), as far as the mock reads it. */
export interface ResponsesRequest {
  model: string;
  input: string | Array<Record<string, unknown>>;
  instructions?: string;
  stream?: boolean;
  [key: string]: unknown;
}

/**
 * Scripts the Responses API: a turn becomes an output message and function calls. Unscripted, it
 * answers "ok". `context` is what the model reads: the turns of the response or conversation the
 * request continues, kept on this server's side, then the request's own input.
 */
export type ResponsesScript = (ctx: { request: ResponsesRequest; requestNo: number; context: Array<Record<string, unknown>> }) => ScriptResult;

/** A request's input as items: a string is one user message. */
const inputItems = (input: unknown): Array<Record<string, unknown>> => (typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? (input as Array<Record<string, unknown>>) : []);

let n = 0;
export const turn = (content: string | null, opts: Partial<Turn> = {}): Turn => ({
  content,
  finish_reason: opts.tool_calls?.length ? 'tool_calls' : 'stop',
  usage: { prompt_tokens: 500 + ++n, completion_tokens: 20 },
  ...opts,
});
export const toolCall = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `call_${name}_${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function split(s: string, parts: number): string[] {
  if (!s) return [];
  const size = Math.max(1, Math.ceil(s.length / parts));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/**
 * A Response as the events a streaming client reads: created and in progress, each output item added
 * with its text in a few deltas or its arguments, and done, then `response.completed`.
 */
function responseEvents(response: Record<string, unknown>, output: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const pending = { ...response, status: 'in_progress', output: [], usage: null };
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', response: pending },
    { type: 'response.in_progress', response: pending },
  ];
  output.forEach((item, output_index) => {
    if (item.type === 'message') {
      const text = ((item.content as Array<{ text: string }>)[0]?.text ?? '') as string;
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', content: [] } });
      events.push({ type: 'response.content_part.added', item_id: item.id, output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      for (const delta of split(text, 3)) events.push({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta, logprobs: [] });
      events.push({ type: 'response.output_text.done', item_id: item.id, output_index, content_index: 0, text, logprobs: [] });
      events.push({ type: 'response.content_part.done', item_id: item.id, output_index, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
    } else {
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, arguments: '', status: 'in_progress' } });
      for (const delta of split(item.arguments as string, 2)) events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta });
      events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments });
    }
    events.push({ type: 'response.output_item.done', output_index, item });
  });
  events.push({ type: 'response.completed', response });
  return events;
}

export const DEFAULT_MODELS = ['gpt-5', 'gpt-5-mini'];

/** A model as `GET /v1/models` lists it. */
export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/**
 * `models`: what `GET /v1/models` lists, in this order (default: gpt-5 and gpt-5-mini); `GET
 * /v1/models/<id>` answers one of them. `root`: a path the API is served under, as a gateway serves
 * OpenAI's (`/api` for OpenRouter's `/api/v1`, `/openai` for Bedrock's `/openai/v1`); a request
 * outside it is not found.
 */
export async function startMockOpenAI(opts: { script: Script; responses?: ResponsesScript; models?: string[]; root?: string }): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const otherRequests: MockServer['otherRequests'] = [];
  let requestNo = 0;
  // What this server keeps on its side, as OpenAI does: each stored response's whole context (the
  // turns it continued, its input, its output), and each conversation's items. Ids are this server's
  // own, so another one (another key, another organization) knows none of them.
  const own = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const kept = new Map<string, Array<Record<string, unknown>>>();
  const conversations = new Map<string, Array<Record<string, unknown>>>();
  const listed = (opts.models ?? DEFAULT_MODELS).map((id, i): ModelInfo => ({ id, object: 'model', created: 1_788_220_800 - i * 86_400, owned_by: 'system' }));
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      if (opts.root) {
        if (!url.pathname.startsWith(`${opts.root}/`)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `mock: nothing outside ${opts.root}: ${url.pathname}`, type: 'invalid_request_error' } }));
          return;
        }
        url.pathname = url.pathname.slice(opts.root.length);
      }
      // ---- The Models API ----
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/models/'))) {
        const id = url.pathname.startsWith('/v1/models/') ? decodeURIComponent(url.pathname.slice('/v1/models/'.length)) : null;
        const found = id === null ? null : listed.find((m) => m.id === id);
        const [status, body] = id === null ? [200, { object: 'list', data: listed }] : found ? [200, found] : [404, { error: { message: `The model '${id}' does not exist`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } }];
        const bytes = Buffer.from(JSON.stringify(body));
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
        res.end(bytes);
        return;
      }
      // ---- Conversations ----
      if (req.method === 'POST' && url.pathname === '/v1/conversations') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>;
        const id = `conv_${own}_${conversations.size + 1}`;
        conversations.set(id, inputItems(body.items));
        const bytes = Buffer.from(JSON.stringify({ id, object: 'conversation', created_at: 1_700_000_000, metadata: body.metadata ?? {} }));
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
        res.end(bytes);
        return;
      }
      // ---- Embeddings and the Responses API ----
      if (req.method === 'POST' && (url.pathname === '/v1/embeddings' || url.pathname === '/v1/responses')) {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        otherRequests.push({ path: url.pathname, headers, body });
        requestNo++;
        const send = (status: number, value: unknown) => {
          const bytes = Buffer.from(JSON.stringify(value));
          res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
          res.end(bytes);
        };
        if (url.pathname === '/v1/embeddings') {
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          return send(200, { object: 'list', data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2, 0.3] })), model: body.model, usage: { prompt_tokens: 4, total_tokens: 4 } });
        }
        // The turns it continues, kept on this side: a response, or a conversation.
        const previous = typeof body.previous_response_id === 'string' ? body.previous_response_id : null;
        const conversation = typeof body.conversation === 'string' ? body.conversation : typeof (body.conversation as { id?: unknown } | undefined)?.id === 'string' ? (body.conversation as { id: string }).id : null;
        if (previous !== null && !kept.has(previous)) return send(400, { error: { message: `Previous response with id '${previous}' not found.`, type: 'invalid_request_error', param: 'previous_response_id', code: 'previous_response_not_found' } });
        if (conversation !== null && !conversations.has(conversation)) return send(404, { error: { message: `Conversation with id '${conversation}' not found.`, type: 'invalid_request_error', param: 'conversation', code: null } });
        const context = [...(previous !== null ? kept.get(previous)! : conversation !== null ? conversations.get(conversation)! : []), ...inputItems(body.input)];
        const result = opts.responses ? opts.responses({ request: body as ResponsesRequest, requestNo, context }) : { turn: turn('ok') };
        if (!('turn' in result)) return send(result.status, result.body);
        const t = result.turn;
        const output: Array<Record<string, unknown>> = [];
        if (t.content) output.push({ type: 'message', id: `msg_${own}_${requestNo}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: t.content, annotations: [] }] });
        (t.tool_calls ?? []).forEach((tc, i) => output.push({ type: 'function_call', id: `fc_${own}_${requestNo}_${i}`, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: 'completed' }));
        const usage = { input_tokens: t.usage.prompt_tokens, output_tokens: t.usage.completion_tokens, total_tokens: t.usage.prompt_tokens + t.usage.completion_tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
        const response = { id: `resp_${own}_${requestNo}`, object: 'response', created_at: 1_700_000_000 + requestNo, status: 'completed', model: body.model, output, usage, parallel_tool_calls: true, tool_choice: body.tool_choice ?? 'auto', tools: body.tools ?? [], previous_response_id: previous, ...(conversation !== null ? { conversation: { id: conversation } } : {}) };
        if (body.store !== false) kept.set(response.id, [...context, ...output]);
        if (conversation !== null) conversations.get(conversation)!.push(...inputItems(body.input), ...output);
        if (!body.stream) return send(200, response);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const [i, e] of responseEvents(response, output).entries()) {
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
          if (res.destroyed) return;
          res.write(`event: ${e.type as string}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`);
        }
        res.end();
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${url.pathname}`, type: 'invalid_request_error' } }));
        return;
      }
      const body = JSON.parse((await readBody(req)).toString('utf8')) as ChatRequest;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      requests.push({ headers, body });
      requestNo++;
      const result = opts.script({ request: body, requestNo, assistantTurns: body.messages.filter((m) => m.role === 'assistant').length });
      if (!('turn' in result)) {
        const bytes = Buffer.from(JSON.stringify(result.body));
        res.writeHead(result.status, { 'content-type': 'application/json', 'content-length': String(bytes.length), ...(result.headers ?? {}) });
        res.end(bytes);
        return;
      }
      const t = result.turn;
      const id = `chatcmpl-mock-${requestNo}`;
      const created = 1_700_000_000 + requestNo;
      if (!body.stream) {
        const message = { role: 'assistant', content: t.content, ...(t.tool_calls ? { tool_calls: t.tool_calls } : {}), refusal: null };
        const bytes = Buffer.from(JSON.stringify({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message, finish_reason: t.finish_reason, logprobs: null }], usage: { ...t.usage, total_tokens: t.usage.prompt_tokens + t.usage.completion_tokens } }));
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
        res.end(bytes);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], usage: null });
      const events: unknown[] = [chunk({ role: 'assistant', content: '', refusal: null })];
      for (const piece of split(t.content ?? '', 3)) events.push(chunk({ content: piece }));
      (t.tool_calls ?? []).forEach((tc, index) => {
        events.push(chunk({ tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }));
        for (const piece of split(tc.function.arguments, 2)) events.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
      });
      events.push(chunk({}, t.finish_reason));
      if (body.stream_options?.include_usage) events.push({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: { ...t.usage, total_tokens: t.usage.prompt_tokens + t.usage.completion_tokens } });
      for (const e of events) {
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    otherRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// A scripted judge, for Shadowlap's judge checks (judge.ts).
export { judgeQuestion, judgeTurn, withJudge, type JudgeDecision, type JudgeQuestion } from './judge.js';
