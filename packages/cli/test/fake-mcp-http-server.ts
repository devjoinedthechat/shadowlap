import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal MCP server over Streamable HTTP for the proxy tests, as the 2025-06-18 transport
 * describes it: every message is a POST, a session id comes with the answer to `initialize` and must
 * come back on every request after it, notifications are accepted with 202, `tools/list` answers
 * over an event stream (with a log notification first), and `tools/call` with JSON. Results carry a
 * call counter, so a replayed result is told apart from a live one, and `calls` lists what ran.
 */
export interface FakeMcpHttpServer {
  url: string;
  /** Every request, in order: method (HTTP), JSON-RPC method, and the headers that matter. */
  seen: Array<{ http: string; method: string | null; session: string | null; protocol: string | null; authorization: string | null; team: string | null }>;
  /** Tool calls that actually ran on the server. */
  calls: Array<{ name: string; arguments: unknown }>;
  /** Ends every session, as a server that restarted would. */
  forgetSessions(): void;
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

export async function startFakeMcpHttpServer(): Promise<FakeMcpHttpServer> {
  const seen: FakeMcpHttpServer['seen'] = [];
  const calls: FakeMcpHttpServer['calls'] = [];
  const sessions = new Set<string>();
  let nextSession = 1;
  let n = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const header = (name: string) => {
        const v = req.headers[name];
        return typeof v === 'string' ? v : null;
      };
      const text = req.method === 'POST' ? await body(req) : '';
      const message = text ? (JSON.parse(text) as { id?: number | string; method?: string; params?: { name?: string; arguments?: unknown } }) : null;
      seen.push({ http: req.method ?? '', method: message?.method ?? null, session: header('mcp-session-id'), protocol: header('mcp-protocol-version'), authorization: header('authorization'), team: header('x-team') });

      if (req.method === 'GET') return void res.writeHead(405).end();
      if (req.method === 'DELETE') {
        sessions.delete(header('mcp-session-id') ?? '');
        return void res.writeHead(200).end();
      }
      if (!String(req.headers.accept ?? '').includes('text/event-stream')) return void res.writeHead(406).end('the client must accept text/event-stream');
      const json = (status: number, value: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...extra });
        res.end(JSON.stringify(value));
      };
      if (message?.method === 'initialize') {
        const id = `session-${nextSession++}`;
        sessions.add(id);
        return json(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1' } } }, { 'mcp-session-id': id });
      }
      const session = header('mcp-session-id');
      if (!session) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: no session id' } });
      if (!sessions.has(session)) return json(404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
      if (message?.id === undefined) return void res.writeHead(202).end();
      if (message.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing tools' } })}\n\n`);
        res.write(`event: message\nid: 1\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } })}\n\n`);
        return void res.end();
      }
      if (message.method === 'tools/call') {
        n++;
        calls.push({ name: String(message.params?.name), arguments: message.params?.arguments });
        if (message.params?.name === 'boom') return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'boom failed', data: { n } } });
        return json(200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `${message.params?.name}:${JSON.stringify(message.params?.arguments)}:${n}` }] } });
      }
      return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    seen,
    calls,
    forgetSessions: () => sessions.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
