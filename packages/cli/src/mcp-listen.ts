import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import type { Effect } from '@shadowlap/engine';
import { isObject, messageOf } from '@shadowlap/engine';
// A request's body, whole or not at all (body.ts in the engine).
import { BodyTooLarge, readBody } from '@shadowlap/engine';
import { ancestorsOf, findRegistration, lookupDirs, peerProcess, registeredRuns, type SidecarLookup, type SidecarTarget } from './agent-registry.js';
import { STOP_SIGNALS } from './agent-signals.js';
import { signalExit } from './exit-codes.js';
import { isLoopbackHost } from './loopback.js';
import { idKey, isRequest, isToolCall, refuseBatch, ToolCalls, type JsonRpcId, type JsonRpcMessage, type LiveCall, type McpOrigin, type ProxySidecar } from './mcp-calls.js';
import { discoverSidecar, type DiscoverySkip } from './mcp-sidecar.js';

/**
 * `shadowlap mcp --url <server> --listen <address>`: the remote server, served over Streamable HTTP
 * on a loopback address, for an agent whose MCP client speaks HTTP; each session records into the run
 * its client belongs to.
 */

/**
 * Where `--listen` serves: a loopback address and a port. `8931`, `127.0.0.1:8931`, `localhost:8931`
 * and `[::1]:8931` are accepted; any other host is refused, since the proxy sends the `--header`
 * values it holds to the server for whoever reaches it.
 */
export function listenAddress(raw: string): { host: string; port: number } {
  const m = /^(?:(\[[^\]]+\]|[^:]+):)?(\d{1,5})$/.exec(raw.trim());
  const port = m ? Number(m[2]) : NaN;
  if (!m || !(port >= 0 && port <= 65535)) throw new Error(`--listen expects <host>:<port> on this machine, such as 127.0.0.1:8931, not "${raw}"`);
  const host = (m[1] ?? '127.0.0.1').replace(/^\[|\]$/g, '');
  if (!isLoopbackHost(host)) throw new Error(`--listen: ${host} is not this machine; the proxy serves on a loopback address only (127.0.0.1, localhost or ::1)`);
  return { host, port };
}

export interface McpListenOptions {
  /** The loopback address and port to serve on (port 0 picks one). */
  host: string;
  port: number;
  /** The server's MCP endpoint, e.g. `https://mcp.example.com/mcp`. */
  url: string;
  /** Sent with every request to the server, e.g. `{ authorization: 'Bearer …' }`. Never recorded. */
  headers?: Record<string, string>;
  /**
   * The sidecar a session records into, asked when the session starts (the client's `initialize`),
   * with the client's end of its connection: a long-running proxy serves one run after another.
   */
  sidecar: (client: ClientEnd) => ProxySidecar | Promise<ProxySidecar>;
  /** Effects by tool name; wins over the server's annotations. */
  effects?: Record<string, Effect>;
  log?: (line: string) => void;
}

export interface McpListener {
  /** The endpoint agents connect to: `http://<host>:<port>/mcp`. */
  url: string;
  close(): Promise<void>;
}

/** A client's connection to the listener, as the session's run is found from it: the client's port, and the listener's. */
export interface ClientEnd {
  port: number | undefined;
  serverPort: number | undefined;
}

/** The headers of the server's answer that the client needs: what it is, the session, and how to sign in. */
const RELAYED_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control', 'www-authenticate', 'retry-after'];
/** The client's headers that go on to the server, besides `--header`'s. */
const FORWARDED_HEADERS = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'authorization'];
const MAX_BODY = 32 * 1024 * 1024;

/** A session as the proxy keeps it: the run it records into, with the server's tools as it learned them. */
interface ServedSession {
  calls: ToolCalls;
}

/**
 * Serves the remote MCP server at `--url` over Streamable HTTP on a loopback address, for agents
 * whose MCP client speaks HTTP rather than stdio. Each message passes on to the server as the client
 * sent it, in the client's own session (the server's `Mcp-Session-Id`, which the client keeps), and
 * the answer comes back as the server gave it, JSON or an event stream, event ids and all. The
 * client's GET stream for the server's own messages and its DELETE pass through the same way.
 * `tools/call` is the exception, as in the other modes: the recording answers it, or a write after a
 * fork is refused or stubbed here, without reaching the server; otherwise the server's answer is
 * recorded as it goes back.
 *
 * Requests must name this address in `Host`, and a browser's `Origin` must be this address too, so a
 * web page can't reach the server through the proxy (DNS rebinding).
 */
export async function startMcpListener(o: McpListenOptions): Promise<McpListener> {
  const upstream = new URL(o.url);
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const origin: McpOrigin = { transport: 'http', server: upstream.host };
  const sessions = new Map<string, ServedSession>();
  const open = new Set<{ destroy(): void }>();

  // As in the stdio mode: the guard leaves the proxy's own connection to its server alone.
  const allowGuard = (globalThis as Record<symbol, ((target: string) => void) | undefined>)[Symbol.for('shadowlap.guard.allow')];
  if (typeof allowGuard === 'function') allowGuard(`${upstream.hostname.replace(/^\[|\]$/g, '')}:${upstream.port || (upstream.protocol === 'https:' ? '443' : '80')}`);

  const newSession = async (req: IncomingMessage): Promise<ServedSession> => ({ calls: new ToolCalls(await o.sidecar({ port: req.socket.remotePort, serverPort: req.socket.localPort }), o.effects, o.log, origin) });

  const server: Server = createServer((req, res) => {
    void serve(req, res).catch((err: unknown) => {
      o.log?.(`could not serve a request: ${messageOf(err)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = o.host.includes(':') ? `[${o.host}]` : o.host;
  const endpoint = `http://${shown}:${port}/mcp`;
  const hosts = new Set([`${shown}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].map((h) => h.toLowerCase()));

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return void res.writeHead(403, { 'content-type': 'text/plain' }).end(`shadowlap mcp serves ${endpoint} only, not the host ${host || '(none)'}`);
    const from = req.headers.origin;
    if (from !== undefined && from !== 'null' && !hosts.has(from.replace(/^https?:\/\//i, '').toLowerCase())) return void res.writeHead(403, { 'content-type': 'text/plain' }).end(`shadowlap mcp refuses requests from ${from}`);
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') return void res.writeHead(404, { 'content-type': 'text/plain' }).end(`the MCP endpoint is ${endpoint}`);
    if (req.method === 'POST') return post(req, res);
    if (req.method === 'GET' || req.method === 'DELETE') return pass(req, res);
    res.writeHead(405, { allow: 'GET, POST, DELETE' }).end();
  }

  /** The headers of a request to the server: the client's that matter, then `--header`'s, which win. */
  function upstreamHeaders(req: IncomingMessage, length?: number): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const name of FORWARDED_HEADERS) {
      const v = req.headers[name];
      if (typeof v === 'string') out[name] = v;
    }
    Object.assign(out, o.headers);
    if (length !== undefined) out['content-length'] = String(length);
    return out;
  }

  function relayHead(res: ServerResponse, from: IncomingMessage): void {
    const headers: OutgoingHttpHeaders = {};
    for (const name of RELAYED_HEADERS) {
      const v = from.headers[name];
      if (v !== undefined) headers[name] = v;
    }
    res.writeHead(from.statusCode ?? 502, headers);
  }

  /** A request to the server, its answer handed to `answered`; null when the server can't be reached. */
  function ask(method: string, req: IncomingMessage, body: Buffer | null, answered: (res: IncomingMessage) => void, failed: (err: Error) => void): ClientRequest | null {
    let out: ClientRequest;
    try {
      out = send(upstream, { method, headers: upstreamHeaders(req, body?.length) }, (r) => {
        open.delete(out);
        answered(r);
      });
    } catch (err) {
      failed(err as Error);
      return null;
    }
    open.add(out);
    out.on('error', (err) => {
      open.delete(out);
      failed(err);
    });
    out.end(body ?? undefined);
    return out;
  }

  /** GET (the server's own stream) and DELETE (the end of a session): passed through as they are. */
  function pass(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      const sid = req.headers['mcp-session-id'];
      const out = ask(
        req.method!,
        req,
        null,
        (r) => {
          if (req.method === 'DELETE' && typeof sid === 'string' && (r.statusCode ?? 500) < 300) sessions.delete(sid);
          relayHead(res, r);
          r.pipe(res);
          r.on('end', resolve);
          r.on('error', resolve);
        },
        (err) => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(`could not reach the MCP server at ${upstream.host}: ${err.message}`);
          resolve();
        },
      );
      // The client leaving ends the server's stream for it.
      res.on('close', () => {
        out?.destroy();
        resolve();
      });
    });
  }

  async function post(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req, { limit: MAX_BODY });
    } catch (err) {
      // Over the limit it is said; a client that left mid-message has no one to answer.
      if (err instanceof BodyTooLarge) res.writeHead(413, { 'content-type': 'text/plain' }).end('the message is too large');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return rpcAnswer(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
    const initialize = isRequest(parsed) && parsed.method === 'initialize';
    // A session starts at the client's initialize, with the run active then; a session id the proxy
    // hasn't seen (it was restarted) starts one too.
    let session = initialize ? undefined : sessions.get(sid);
    if (!session) {
      session = await newSession(req);
      if (!initialize) sessions.set(sid, session);
    }
    const { calls } = session;

    if (Array.isArray(parsed) && !calls.transparent && parsed.some(isToolCall)) {
      // As in the other modes: a batch with a tools/call can't be recorded or fenced. Its other
      // messages still reach the server, one at a time; its requests are answered with errors.
      for (const item of parsed.filter((m) => !isRequest(m))) await forwardOne(req, Buffer.from(JSON.stringify(item), 'utf8'));
      return rpcAnswer(res, 200, refuseBatch(parsed));
    }
    const m = isObject(parsed) ? (parsed as JsonRpcMessage) : null;
    let live: LiveCall | undefined;
    if (isRequest(m) && m.method === 'tools/call') {
      const route = await calls.route(m);
      if ('answer' in route) return rpcAnswer(res, 200, route.answer);
      live = route.live;
    }
    const id = isRequest(m) ? m.id : null;
    const method = isRequest(m) ? m.method : null;
    let settled = false;
    /** The request's own answer: what it teaches, and the end of a recorded call. */
    const onMessage = async (msg: unknown) => {
      for (const one of Array.isArray(msg) ? msg : [msg]) {
        if (!isObject(one) || id === null || one.method !== undefined || one.id === undefined || one.id === null || idKey(one.id as JsonRpcId) !== idKey(id)) continue;
        settled = true;
        if (method === 'tools/list') calls.learn(one.result);
        if (live) await calls.complete(live, one);
      }
    };
    const unanswered = async (why: string) => {
      if (settled || !live) return;
      settled = true;
      await calls.complete(live, { error: { code: -32000, message: why } });
    };

    await new Promise<void>((resolve) => {
      const out = ask(
        'POST',
        req,
        body,
        (r) => {
          const status = r.statusCode ?? 502;
          const type = String(r.headers['content-type'] ?? '');
          // The server names the session in its answer to initialize; later requests carry it.
          const given = r.headers['mcp-session-id'];
          if (initialize) sessions.set(typeof given === 'string' ? given : '', session);
          relayHead(res, r);
          if (status >= 400 || status === 202 || status === 204 || !/^(application\/json|text\/event-stream)/i.test(type)) {
            // An HTTP error, an accepted notification, or something that isn't MCP: as it came.
            void readAll(r).then(async (bytes) => {
              if (status >= 400) await unanswered(`the MCP server answered ${status}${bytes.length ? `: ${bytes.toString('utf8').slice(0, 300)}` : ''}`);
              res.end(bytes);
              resolve();
            });
            return;
          }
          if (/^application\/json/i.test(type)) {
            void readAll(r).then(async (bytes) => {
              try {
                await onMessage(JSON.parse(bytes.toString('utf8')));
              } catch {
                o.log?.(`the server sent something that is not JSON: ${bytes.toString('utf8').slice(0, 200)}`);
              }
              await unanswered('the MCP server ended its response without an answer');
              res.end(bytes);
              resolve();
            });
            return;
          }
          // An event stream: each event goes on to the client as it arrives, once what it answers
          // is recorded, so the client sees the answer only after the recording holds it.
          let chain: Promise<void> = Promise.resolve();
          const events = new RawEventStream((raw, data) => {
            chain = chain.then(async () => {
              if (data) {
                try {
                  await onMessage(JSON.parse(data));
                } catch {
                  o.log?.(`the server sent an event that is not JSON: ${data.slice(0, 200)}`);
                }
              }
              res.write(raw);
            });
          });
          r.setEncoding('utf8');
          r.on('data', (chunk: string) => events.push(chunk));
          const end = () => {
            chain = chain.then(async () => {
              await unanswered('the MCP server ended its response without an answer');
              res.end();
              resolve();
            });
          };
          r.on('end', end);
          r.on('error', end);
        },
        (err) => {
          void unanswered(`could not reach the MCP server at ${upstream.host}: ${err.message}`).then(() => {
            rpcAnswer(res, 502, { jsonrpc: '2.0', id, error: { code: -32000, message: `could not reach the MCP server at ${upstream.host}: ${err.message}` } });
            resolve();
          });
        },
      );
      // The client went away before the answer: the server's request goes too, and a recorded
      // call ends as the client saw it end.
      res.on('close', () => {
        if (res.writableFinished) return;
        out?.destroy();
        void unanswered('the client closed the connection before the answer').then(resolve);
      });
    });
  }

  /** One message of a refused batch, sent on by itself; its answer is dropped, as in the other modes. */
  function forwardOne(req: IncomingMessage, body: Buffer): Promise<void> {
    return new Promise((resolve) => {
      ask('POST', req, body, (r) => void readAll(r).then(() => resolve()), () => resolve());
    });
  }

  return {
    url: endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of open) r.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The events of a stream, each with the text it was sent as (to pass on unchanged) and its data. */
class RawEventStream {
  private buf = '';
  constructor(private readonly onEvent: (raw: string, data: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) return;
      const raw = this.buf.slice(0, m.index + m[0].length);
      const event = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      this.onEvent(raw, data);
    }
  }
}

function rpcAnswer(res: ServerResponse, status: number, message: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message));
}

function readAll(res: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * The run a session of a listener started on its own belongs to, found when the session starts: the
 * run registered for the client's process or one of its ancestors (agent-registry.ts), which every
 * agent a Shadowlap command starts has, whichever folder it runs in and however many run at once.
 * Where the system won't say which process connected, the one run active for this user decides: the
 * runs registered for agents running now, and the folder's `.shadowlap/active.json`. `none` when no
 * run is found for the session, and `unusable` when several could be its own.
 */
export function sessionRun(client: ClientEnd, cwd: string, skip: DiscoverySkip = () => {}, o: { home?: string | null } = {}): SidecarLookup {
  const home = o.home === undefined ? {} : { home: o.home };
  const pid = client.port !== undefined && client.serverPort !== undefined ? peerProcess(client.port, client.serverPort, skip) : null;
  const chain = pid !== null ? ancestorsOf(pid, skip) : null;
  if (chain) return findRegistration(chain, lookupDirs(cwd, o.home), skip) ?? { kind: 'none' };
  const runs = new Map<string, { target: SidecarTarget; from: string }>();
  for (const r of registeredRuns({ cwd, ...home, skip })) runs.set(r.target.runId, r);
  const active = discoverSidecar({}, cwd, skip);
  if (active && !runs.has(active.runId)) runs.set(active.runId, { target: active, from: join(cwd, '.shadowlap', 'active.json') });
  const all = [...runs.values()];
  if (all.length === 1) return { kind: 'sidecar', target: all[0]!.target, from: all[0]!.from };
  if (all.length > 1) return { kind: 'unusable', reason: `${all.length} Shadowlap runs are active (${all.map((r) => r.target.runId.slice(0, 10)).join(', ')}), and which one this session's client belongs to can't be told` };
  return { kind: 'none' };
}

/**
 * The sidecar a session of a listener started on its own records into: its run's (sessionRun), or,
 * with none found, or several it can't tell apart, one that refuses writes, since this could be a
 * replay, and passes reads through unrecorded. Said on the log, a line a session.
 */
export function sessionSidecar(client: ClientEnd, cwd: string, log: (line: string) => void, o: { home?: string | null } = {}): ProxySidecar {
  const run = sessionRun(client, cwd, log, o);
  if (run.kind === 'sidecar') {
    log(`a session started: recording into run ${run.target.runId}`);
    return run.target;
  }
  const why = run.kind === 'unusable' ? run.reason : 'no Shadowlap run is active for it';
  log(`a session started that can't be recorded (${why}): write tools are refused, read tools pass through unrecorded`);
  return { unusable: why };
}

/**
 * `shadowlap mcp --url <server> --listen <address>`: the server, served over Streamable HTTP for
 * agents whose MCP client speaks HTTP, until the proxy is stopped. Started by a Shadowlap command
 * (or under one), every session records into that command's run. Started on its own, it serves one
 * run after another: each session records into the run its client belongs to (sessionRun). A
 * session with no run found, or one it can't tell among several, can't be recorded, and this could
 * be a replay: its writes are refused and its reads pass through unrecorded. Resolves with the exit
 * code for the signal that stopped it.
 */
export async function listen(url: URL, at: { host: string; port: number }, headers: Record<string, string>, effects: Record<string, Effect>, found: SidecarLookup, log: (line: string) => void): Promise<number> {
  const cwd = process.cwd();
  const sidecar = (client: ClientEnd): ProxySidecar => (found.kind === 'sidecar' ? found.target : found.kind === 'unusable' ? { unusable: found.reason } : sessionSidecar(client, cwd, log));
  if (found.kind === 'none') log('started on its own: each session records into the run of the Shadowlap command its client belongs to, and refuses writes when it has none');
  const listener = await startMcpListener({ host: at.host, port: at.port, url: url.href, headers, sidecar, effects, log });
  log(`serving ${url.host} at ${listener.url}`);
  return new Promise((resolve) => {
    const stop = (signal: NodeJS.Signals) => void listener.close().then(() => resolve(signalExit(signal)));
    for (const s of STOP_SIGNALS) process.once(s, stop);
  });
}
