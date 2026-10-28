import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal MCP server over Streamable HTTP for the proxy tests, as the 2025-06-18 transport
 * describes it: every message is a POST, a session id comes with the answer to `initialize` and must
 * come back on every request after it, notifications are accepted with 202, `tools/list` answers
 * over an event stream (with a log notification first), and `tools/call` with JSON. Like the
 * reference SDK servers, it refuses an `initialize` that names a session it doesn't know. A batch
 * (2025-03-26) is answered with an array. Results carry a call counter, so a replayed result is told
 * apart from a live one, and `calls` lists what ran. The tool `flaky` fails at the HTTP level, and
 * `cut` breaks its answer off part way through, the connection gone.
 *
 * With `{ streams: true }` it also offers the transport's standalone stream: a GET in a session
 * opens an event stream that stays open and carries the server's own messages (`notify()` sends
 * one, with an event id), and `tools/call` answers over an event stream, a progress notification
 * before the result.
 */
export interface FakeMcpHttpServer {
  url: string;
  /** Every request, in order: method (HTTP), JSON-RPC method, and the headers that matter. */
  seen: Array<{ http: string; method: string | null; session: string | null; protocol: string | null; authorization: string | null; team: string | null }>;
  /** Tool calls that actually ran on the server. */
  calls: Array<{ name: string; arguments: unknown }>;
  /** The params of every `initialize`, in order. */
  initParams: unknown[];
  /** Ends every session, as a server that restarted would. */
  forgetSessions(): void;
  /** Leaves the event stream of a tools/list open after its answer, as a careless server might. */
  keepStreamsOpen(): void;
  /** With `streams`: sends a message on every open GET stream, and resolves once one was open to take it. */
  notify(message: unknown): Promise<void>;
  /** GET streams that are open now. */
  openStreams(): number;
  close(): Promise<void>;
}

const tools = [
  { name: 'read_note', description: 'reads', inputSchema: { type: 'object', properties: { id: { type: 'number' } } }, annotations: { readOnlyHint: true } },
  { name: 'send_note', description: 'sends', inputSchema: { type: 'object', properties: { to: { type: 'string' } } }, annotations: { destructiveHint: false } },
  { name: 'boom', description: 'fails', inputSchema: { type: 'object' } },
];

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (c: Buffer) => (text += c.toString()));
    req.on('end', () => resolve(text));
  });
}

type Message = { id?: number | string; method?: string; params?: { name?: string; arguments?: unknown } };

export async function startFakeMcpHttpServer(options: { streams?: boolean } = {}): Promise<FakeMcpHttpServer> {
  const streams = new Set<import('node:http').ServerResponse>();
  let eventId = 0;
  const seen: FakeMcpHttpServer['seen'] = [];
  const calls: FakeMcpHttpServer['calls'] = [];
  const initParams: unknown[] = [];
  const sessions = new Set<string>();
  let nextSession = 1;
  let n = 0;
  let keepOpen = false;

  /** The answer to one tools/call, or null for a call that fails at the HTTP level. */
  const call = (message: Message): unknown => {
    n++;
    calls.push({ name: String(message.params?.name), arguments: message.params?.arguments });
    if (message.params?.name === 'boom') return { jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'boom failed', data: { n } } };
    return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `${message.params?.name}:${JSON.stringify(message.params?.arguments)}:${n}` }] } };
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const header = (name: string) => {
        const v = req.headers[name];
        return typeof v === 'string' ? v : null;
      };
      const text = req.method === 'POST' ? await body(req) : '';
      const parsed = text ? (JSON.parse(text) as Message | Message[]) : null;
      const message = Array.isArray(parsed) ? null : parsed;
      seen.push({ http: req.method ?? '', method: Array.isArray(parsed) ? 'batch' : (message?.method ?? null), session: header('mcp-session-id'), protocol: header('mcp-protocol-version'), authorization: header('authorization'), team: header('x-team') });

      if (req.method === 'GET') {
        if (!options.streams) return void res.writeHead(405).end();
        if (!sessions.has(header('mcp-session-id') ?? '')) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': open\n\n');
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (req.method === 'DELETE') {
        sessions.delete(header('mcp-session-id') ?? '');
        return void res.writeHead(200).end();
      }
      if (!String(req.headers.accept ?? '').includes('text/event-stream')) return void res.writeHead(406).end('the client must accept text/event-stream');
      const json = (status: number, value: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...extra });
        res.end(JSON.stringify(value));
      };
      const session = header('mcp-session-id');
      if (message?.method === 'initialize') {
        // As the SDK servers do: a new session starts only from an initialize that names none.
        if (session) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } });
        initParams.push(message.params);
        const id = `session-${nextSession++}`;
        sessions.add(id);
        return json(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1' } } }, { 'mcp-session-id': id });
      }
      if (!session) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: no session id' } });
      if (!sessions.has(session)) return json(404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
      if (Array.isArray(parsed)) {
        const answers = parsed.filter((m) => m.id !== undefined).map((m) => (m.method === 'tools/call' ? call(m) : { jsonrpc: '2.0', id: m.id, result: m.method === 'tools/list' ? { tools } : {} }));
        return answers.length ? json(200, answers) : void res.writeHead(202).end();
      }
      if (message?.id === undefined) return void res.writeHead(202).end();
      if (message.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing tools' } })}\n\n`);
        res.write(`event: message\nid: 1\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } })}\n\n`);
        if (!keepOpen) res.end();
        return;
      }
      if (message.method === 'tools/call') {
        if (message.params?.name === 'flaky') return void res.writeHead(500, { 'content-type': 'text/plain' }).end('upstream exploded');
        if (message.params?.name === 'cut') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
          res.write('{"jsonrpc":"2.0","id":');
          return void setTimeout(() => res.destroy(), 20);
        }
        if (options.streams) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write(`id: ${++eventId}\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: message.id, progress: 1, total: 2 } })}\n\n`);
          res.write(`id: ${++eventId}\ndata: ${JSON.stringify(call(message))}\n\n`);
          return void res.end();
        }
        return json(200, call(message));
      }
      return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    seen,
    calls,
    initParams,
    forgetSessions: () => sessions.clear(),
    keepStreamsOpen: () => {
      keepOpen = true;
    },
    notify: async (message: unknown) => {
      for (let i = 0; i < 100 && streams.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
      for (const res of streams) res.write(`id: ${++eventId}\ndata: ${JSON.stringify(message)}\n\n`);
    },
    openStreams: () => streams.size,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
