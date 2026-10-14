import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted fake of the OpenAI Chat Completions API, close enough to the real wire format for the
 * official SDK's streaming client: `data:` chunks, a final usage chunk when `stream_options.include_usage`
 * is set, and `data: [DONE]`. It knows nothing about Shadowlap.
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
  close(): Promise<void>;
}

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

export async function startMockOpenAI(opts: { script: Script }): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  let requestNo = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mock');
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
