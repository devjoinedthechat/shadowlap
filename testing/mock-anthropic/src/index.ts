import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted fake of the Anthropic Messages API. It speaks the real wire format (JSON and the
 * streaming SSE event sequence) closely enough for the official SDK's stream accumulator, and it
 * lets tests inject failures. It lists its models as the Models API does, so a model picker that
 * asks it has something to offer. It knows nothing about Shadowlap.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
/** Extended thinking: the model's reasoning before it answers, with the signature that vouches for it. */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}
export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface MockMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  stream?: boolean;
  system?: unknown;
  tools?: unknown[];
  // `system` appears here too: `shadowlap replay --inject` adds an instruction as a message.
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: unknown }>;
}

export interface ScriptContext {
  request: MessagesRequest;
  /** 1-based count of requests this server has seen. */
  requestNo: number;
  /** Assistant turns already in the conversation. */
  assistantTurns: number;
  headers: Record<string, string>;
}

export type ScriptResult = ({ message: MockMessage } | { status: number; body: unknown; headers?: Record<string, string> }) & {
  /** Wait this long before answering, ms: one request slower than the rest, as a model can be. */
  delayMs?: number;
};
export type Script = (ctx: ScriptContext) => ScriptResult;

export interface MockOptions {
  script: Script;
  /** Delay before each streamed event, ms. Defaults to a small random jitter to exercise concurrency. */
  eventDelayMs?: () => number;
  /** The models `GET /v1/models` lists, in this order. Default: claude-sonnet-5 and claude-haiku-4-5. */
  models?: string[];
}

export const DEFAULT_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5'];

/** A model as `GET /v1/models` lists it. */
export interface ModelInfo {
  type: 'model';
  id: string;
  display_name: string;
  created_at: string;
}

/** `claude-haiku-4-5` as the API names it: "Claude Haiku 4.5". */
function displayName(id: string): string {
  const words = id.split('-');
  const name = words.filter((w) => !/^\d+$/.test(w)).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  // A dated snapshot's date is no part of its name.
  const version = words.filter((w) => /^\d{1,2}$/.test(w)).join('.');
  return [...name, ...(version ? [version] : [])].join(' ');
}

/** What the Models API answers for a path under `/v1/models`, paged as it pages: `limit`, `after_id`, `before_id`. */
function modelsAnswer(ids: readonly string[], url: URL): { status: number; body: unknown } {
  const info = ids.map((id, i): ModelInfo => ({ type: 'model', id, display_name: displayName(id), created_at: new Date(Date.UTC(2026, 8, 1) - i * 86_400_000).toISOString().replace('.000Z', 'Z') }));
  const one = /^\/v1\/models\/(.+)$/.exec(url.pathname);
  if (one) {
    const found = info.find((m) => m.id === decodeURIComponent(one[1]!));
    return found ? { status: 200, body: found } : { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: `model: ${decodeURIComponent(one[1]!)}` } } };
  }
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
  const after = url.searchParams.get('after_id');
  const before = url.searchParams.get('before_id');
  let start = 0;
  let end = info.length;
  if (after !== null) start = info.findIndex((m) => m.id === after) + 1;
  if (before !== null) end = Math.max(0, info.findIndex((m) => m.id === before));
  const page = before !== null && after === null ? info.slice(Math.max(start, end - limit), end) : info.slice(start, Math.min(end, start + limit));
  const more = before !== null && after === null ? end - limit > start : start + limit < end;
  return { status: 200, body: { data: page, has_more: more, first_id: page[0]?.id ?? null, last_id: page.at(-1)?.id ?? null } };
}

export interface RecordedRequest {
  headers: Record<string, string>;
  body: MessagesRequest;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

let ids = 0;
export function message(content: ContentBlock[], opts: { stop_reason?: MockMessage['stop_reason']; input_tokens?: number; output_tokens?: number; model?: string } = {}): MockMessage {
  ids++;
  return {
    id: `msg_mock_${String(ids).padStart(4, '0')}`,
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-opus-5',
    content,
    stop_reason: opts.stop_reason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: opts.input_tokens ?? 1000 + ids * 7, output_tokens: opts.output_tokens ?? 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

export const text = (t: string): TextBlock => ({ type: 'text', text: t });
export const toolUse = (name: string, input: Record<string, unknown>, id?: string): ToolUseBlock => ({ type: 'tool_use', id: id ?? `toolu_${name}_${++ids}`, name, input });
/** A thinking block. The signature is opaque, as the API's is; the mock never checks one it is sent back. */
export const thinking = (t: string, signature?: string): ThinkingBlock => ({ type: 'thinking', thinking: t, signature: signature ?? Buffer.from(`mock-signature-${++ids}`).toString('base64') });

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

function splitInto(s: string, parts: number): string[] {
  if (s.length === 0) return [''];
  const size = Math.max(1, Math.ceil(s.length / parts));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** The streaming event sequence for a message, as [event, data] pairs. */
export function sseEvents(m: MockMessage): Array<[string, unknown]> {
  const events: Array<[string, unknown]> = [];
  events.push(['message_start', { type: 'message_start', message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } } }]);
  events.push(['ping', { type: 'ping' }]);
  m.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      for (const piece of splitInto(block.text, 3)) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }]);
    } else if (block.type === 'thinking') {
      // As the API streams it: the reasoning in pieces, then its signature in one delta of its own.
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
      for (const piece of splitInto(block.thinking, 3)) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      for (const piece of splitInto(JSON.stringify(block.input), 3)) {
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } }]);
      }
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: m.usage.output_tokens } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startMockAnthropic(opts: MockOptions): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const delay = opts.eventDelayMs ?? (() => Math.floor(Math.random() * 4));
  let requestNo = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/models/'))) {
        const { status, body } = modelsAnswer(opts.models ?? DEFAULT_MODELS, url);
        const bytes = Buffer.from(JSON.stringify(body));
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
        res.end(bytes);
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `mock: no route ${req.method!} ${url.pathname}` } }));
        return;
      }
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8')) as MessagesRequest;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      requests.push({ headers, body });
      requestNo++;
      const assistantTurns = body.messages.filter((m) => m.role === 'assistant').length;
      const result = opts.script({ request: body, requestNo, assistantTurns, headers });
      if (result.delayMs) {
        await sleep(result.delayMs);
        if (res.destroyed) return;
      }

      if (!('message' in result)) {
        const bytes = Buffer.from(JSON.stringify(result.body));
        res.writeHead(result.status, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'request-id': `req_mock_${requestNo}`, ...(result.headers ?? {}) });
        res.end(bytes);
        return;
      }

      if (!body.stream) {
        const bytes = Buffer.from(JSON.stringify(result.message));
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'request-id': `req_mock_${requestNo}` });
        res.end(bytes);
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'request-id': `req_mock_${requestNo}` });
      res.flushHeaders();
      for (const [event, data] of sseEvents(result.message)) {
        await sleep(delay());
        if (res.destroyed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// A scripted judge, for Shadowlap's judge checks (judge.ts).
export { judgeAnswer, judgeQuestion, judgeRequests, withJudge, type JudgeDecision, type JudgeQuestion } from './judge.js';
// Injection tests: a model that obeys (or quotes, or is steered by) what a tool result tells it.
export { DEFENCE, obeyPlanted, type ObeyOptions } from './obey.js';
