import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable, Writable } from 'node:stream';
import type { Effect } from '@shadowlap/engine';
import { isObject } from '@shadowlap/engine';
import { isLoopbackHost } from './loopback.js';
import { idKey, isRequest, isToolCall, lines, refuseBatch, ToolCalls, type JsonRpcId, type JsonRpcMessage, type LiveCall, type ProxySidecar } from './mcp-calls.js';

/**
 * `shadowlap mcp --url <server>`: the proxy in front of a remote MCP server, reached over Streamable
 * HTTP, for a client that speaks stdio. Each message is a POST, answered with JSON or an event stream,
 * in the session the server names in `Mcp-Session-Id`.
 */

export interface McpHttpProxyOptions {
  /** From and to the MCP client (the agent). */
  clientIn: Readable;
  clientOut: Writable;
  /** The server's MCP endpoint, e.g. `https://mcp.example.com/mcp`. */
  url: string;
  /** Sent with every request, e.g. `{ authorization: 'Bearer …' }`. Never recorded. */
  headers?: Record<string, string>;
  sidecar: ProxySidecar;
  /** Effects by tool name; wins over the server's annotations. */
  effects?: Record<string, Effect>;
  log?: (line: string) => void;
}

/** Headers the proxy sets itself on every request. */
const MANAGED_HEADERS = new Set(['accept', 'content-type', 'content-length', 'host', 'mcp-session-id', 'mcp-protocol-version', 'connection', 'transfer-encoding']);

/**
 * `Name: value` flags into headers, with `$NAME` and `${NAME}` taken from the environment, so a token
 * can stay in the client config's env block and off the command line; `$$` is a `$` itself. `$NAME`
 * is for a client that fills in `${…}` itself, from its own environment, before it starts the proxy
 * (Claude Code does, in .mcp.json): written so, it reaches the proxy untouched.
 */
export function parseHeaderFlags(flags: string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const i = f.indexOf(':');
    const name = i > 0 ? f.slice(0, i).trim().toLowerCase() : '';
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new Error(`--header expects <name>: <value>, got "${f}"`);
    if (MANAGED_HEADERS.has(name)) throw new Error(`--header: ${name} is set by the proxy itself`);
    const value = f
      .slice(i + 1)
      .trim()
      .replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole: string, braced: string | undefined, bare: string | undefined) => {
        if (whole === '$$') return '$';
        const v = (braced ?? bare)!;
        const found = env[v];
        if (found === undefined) throw new Error(`--header ${name}: ${braced ? `\${${v}}` : `$${v}`} is not set in the environment (a $ itself is written $$)`);
        return found;
      });
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new Error(`--header ${name}: the value has a character a header can't carry (a line break, say)`);
    out[name] = value;
  }
  return out;
}

/**
 * The server's URL, checked: http(s), no credentials in it, and https when headers would cross the
 * network, unless `allowHttp` says the network in between is trusted.
 */
export function mcpServerUrl(raw: string, withHeaders: boolean, allowHttp = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--url needs the server's MCP endpoint, such as https://mcp.example.com/mcp, not "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`--url: an MCP server is reached over https, not ${url.protocol}`);
  if (url.username || url.password) throw new Error('--url: leave credentials out of the URL; pass them with --header');
  if (withHeaders && url.protocol === 'http:' && !allowHttp && !isLoopbackHost(url.hostname)) {
    throw new Error(`--url: use https for ${url.host}: the headers would cross the network in the clear. http is accepted for this machine, or with --allow-http on a network you trust`);
  }
  return url;
}

/** The JSON-RPC messages in an event stream, as each event completes. */
class EventStream {
  private buf = '';
  constructor(private readonly onMessage: (data: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) return;
      const event = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) this.onMessage(data);
    }
  }
}

/** A request in flight: one of the client's, or one the proxy sends itself to start a new session. */
type Pending = { method: string; live?: LiveCall; internal?: (m: JsonRpcMessage) => void };

/**
 * Starts the Streamable HTTP proxy. Messages from the client are sent in order, each as a POST; a
 * response arrives as JSON or as an event stream that may carry the server's own requests and
 * notifications before it. The session id the server gives in its answer to `initialize` goes with
 * every later request, with the protocol version it agreed. Server-initiated messages outside any
 * request come on a GET stream, opened once the session starts, when the server offers one.
 *
 * When the server ends the session (404 to a request that carried it), the proxy does what the
 * transport asks of a client: it starts a new session with the client's own `initialize`, and sends
 * the request again in it. The client, which speaks stdio, never sees a session at all.
 */
export function startMcpHttpProxy(o: McpHttpProxyOptions): { done: Promise<number> } {
  const url = new URL(o.url);
  const calls = new ToolCalls(o.sidecar, o.effects, o.log, { transport: 'http', server: url.host });
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let stream: ClientRequest | null = null;
  let listening = false;
  let closed = false;
  /** The client's `initialize`, to start a new session with when the server ends this one. */
  let initialize: { params: unknown } | null = null;
  /** The last new session started for the client: null when it started, else why it couldn't. */
  let restarting: Promise<string | null> | null = null;
  /** Set while a new session starts: messages for the session wait for it. */
  let starting: Promise<string | null> | null = null;
  let internalIds = 0;
  const inFlight = new Set<{ destroy(): void }>();
  const toClient = (message: unknown) => {
    if (!closed) o.clientOut.write(JSON.stringify(message) + '\n');
  };

  // `shadowlap run`'s network guard would report this proxy's own connection to its server as
  // traffic Shadowlap doesn't record; the calls it carries are recorded here.
  const allowGuard = (globalThis as Record<symbol, ((target: string) => void) | undefined>)[Symbol.for('shadowlap.guard.allow')];
  if (typeof allowGuard === 'function') allowGuard(`${url.hostname.replace(/^\[|\]$/g, '')}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`);

  /** The headers of a request; the session's own only for a request inside it (never `initialize`). */
  function headers(extra: Record<string, string>, inSession: boolean): Record<string, string> {
    return {
      ...o.headers,
      ...extra,
      ...(inSession && sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(inSession && protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    };
  }

  const pending = new Map<string, Pending>();

  /** Ends a request that got no answer: the client gets an error, and a recorded call ends with it, so a replay serves the same failure. */
  async function settle(id: JsonRpcId, message: string): Promise<void> {
    const p = pending.get(idKey(id));
    if (!p) return;
    pending.delete(idKey(id));
    const error = { code: -32000, message };
    if (p.internal) return p.internal({ jsonrpc: '2.0', id, error });
    if (p.live) await calls.complete(p.live, { error });
    if (!closed) toClient({ jsonrpc: '2.0', id, error });
  }

  /**
   * A message from the server, or a batch of them: a response to a pending request settles it;
   * everything goes on to the client as it came, except the answers to the proxy's own requests.
   */
  async function fromServer(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      o.log?.(`the server sent something that is not JSON: ${raw.slice(0, 200)}`);
      return;
    }
    const relayed: unknown[] = [];
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      const m = isObject(msg) ? (msg as JsonRpcMessage) : null;
      if (m && m.id !== undefined && m.id !== null && m.method === undefined) {
        const p = pending.get(idKey(m.id));
        if (p) {
          pending.delete(idKey(m.id));
          if (p.method === 'initialize' && isObject(m.result) && typeof m.result.protocolVersion === 'string') protocolVersion = m.result.protocolVersion;
          if (p.method === 'tools/list') calls.learn(m.result);
          if (p.internal) {
            p.internal(m);
            continue;
          }
          if (p.live) await calls.complete(p.live, m);
        }
      }
      relayed.push(msg);
    }
    if (!Array.isArray(parsed)) relayed.forEach(toClient);
    else if (relayed.length) toClient(relayed);
  }

  /**
   * The server answered 404 to a request sent in session `sentWith`: that session is over. Starts a
   * new one if it is still the current one, else waits for the one already starting. Resolves with
   * null when there is a session to send the request again in, else why there isn't.
   */
  function sessionEnded(sentWith: string): Promise<string | null> {
    if (sessionId === sentWith) {
      sessionId = null;
      protocolVersion = null;
      stream?.destroy();
      stream = null;
      listening = false;
      o.log?.('the server ended the MCP session; starting a new one');
      const next = restart();
      restarting = next;
      starting = next;
      void next.then(() => {
        if (starting === next) starting = null;
      });
    }
    if (sessionId) return Promise.resolve(null);
    return restarting ?? Promise.resolve('the MCP session has ended (the server answered 404); initialize again');
  }

  /** A new session, started the way the client started the last one. */
  async function restart(): Promise<string | null> {
    if (!initialize) return 'the MCP session has ended (the server answered 404); initialize again';
    const id = `shadowlap-session-${++internalIds}`;
    const answer = await new Promise<JsonRpcMessage>((resolve) => {
      pending.set(idKey(id), { method: 'initialize', internal: resolve });
      void forward(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: initialize!.params }), { id, method: 'initialize' }, { retried: true, internal: true });
    });
    if (answer.error || !sessionId) return `the MCP session has ended, and the server didn't start a new one${answer.error ? `: ${answer.error.message}` : ''}`;
    await forward(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), { method: 'notifications/initialized' }, { retried: true, internal: true });
    listen();
    return null;
  }

  /**
   * POSTs one message and relays what comes back. Resolves when the response has been read. A
   * message for the session waits while a new session starts, so it goes out in that one; the
   * proxy's own messages that start it (`internal`) don't.
   */
  function forward(raw: string, m: JsonRpcMessage | null, o2: { retried?: boolean; internal?: boolean } = {}): Promise<void> {
    const id = isRequest(m) ? m.id : null;
    const isInitialize = m?.method === 'initialize';
    if (starting && !isInitialize && !o2.internal) return starting.then(() => forward(raw, m, o2));
    const sentWith = isInitialize ? null : sessionId;
    return new Promise<void>((resolve) => {
      const failed = (err: Error) => {
        void (id !== null ? settle(id, `could not reach the MCP server at ${url.host}: ${err.message}`) : Promise.resolve()).then(resolve);
      };
      const body = Buffer.from(raw, 'utf8');
      let req: ClientRequest;
      try {
        req = send(url, { method: 'POST', headers: headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(body.length) }, !isInitialize) }, (res) => {
          inFlight.delete(req);
          if (res.statusCode === 404 && sentWith !== null) {
            res.resume();
            void sessionEnded(sentWith)
              .then((problem) => {
                if (problem === null && !o2.retried && !closed) return forward(raw, m, { retried: true });
                if (id !== null) return settle(id, problem ?? 'the MCP server ended the session again before answering');
              })
              .then(() => resolve());
            return;
          }
          // The server names the session in its answer to initialize; the transport allows visible ASCII only.
          const sid = res.headers['mcp-session-id'];
          if (isInitialize && typeof sid === 'string' && /^[\x21-\x7e]{1,1024}$/.test(sid)) sessionId = sid;
          void relay(res, id).then(resolve);
        });
      } catch (err) {
        // A header Node refuses to send, say: answered, so the client and this loop go on.
        return failed(err as Error);
      }
      inFlight.add(req);
      req.on('error', (err) => {
        inFlight.delete(req);
        failed(err);
      });
      req.end(body);
    });
  }

  async function relay(res: IncomingMessage, id: JsonRpcId | null): Promise<void> {
    const status = res.statusCode ?? 502;
    const type = String(res.headers['content-type'] ?? '');
    if (status === 202 || status === 204) return void res.resume();
    if (status >= 400) {
      const text = await readText(res);
      if (id !== null) await settle(id, `the MCP server answered ${status}${text ? `: ${text.slice(0, 300)}` : ''}`);
      return;
    }
    if (/text\/event-stream/i.test(type)) {
      res.setEncoding('utf8');
      let chain: Promise<void> = Promise.resolve();
      // The answer ends the request's stream; a server that keeps it open after answering holds nothing up.
      const answered = () => id !== null && !pending.has(idKey(id));
      const events = new EventStream((data) => {
        chain = chain.then(() => fromServer(data)).then(() => void (answered() && res.destroy()));
      });
      await new Promise<void>((done) => {
        res.on('data', (chunk: string) => events.push(chunk));
        res.on('end', done);
        res.on('error', done);
        res.on('close', done);
      });
      await chain;
    } else {
      const text = await readText(res);
      if (text.trim()) await fromServer(text);
    }
    // A request whose stream ended without its answer gets an error, so the client isn't left waiting.
    if (id !== null && pending.has(idKey(id))) await settle(id, 'the MCP server ended its response without an answer');
  }

  /** The server's own messages outside any request, when it offers a GET stream for them. */
  function listen(): void {
    if (listening || !sessionId || closed) return;
    listening = true;
    let req: ClientRequest;
    try {
      req = send(url, { method: 'GET', headers: headers({ accept: 'text/event-stream' }, true) }, (res) => {
        if (res.statusCode !== 200 || !/text\/event-stream/i.test(String(res.headers['content-type'] ?? ''))) return void res.resume();
        res.setEncoding('utf8');
        let chain: Promise<void> = Promise.resolve();
        const events = new EventStream((data) => {
          chain = chain.then(() => fromServer(data));
        });
        res.on('data', (chunk: string) => events.push(chunk));
      });
    } catch {
      return;
    }
    stream = req;
    inFlight.add(req);
    req.on('error', () => inFlight.delete(req));
    req.end();
  }

  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => (resolveDone = resolve));
  let chain: Promise<void> = Promise.resolve();

  // Client → server, in order. A notification or a response is delivered before the next message
  // is read, so the server sees `notifications/initialized` before the requests that follow it; a
  // request is sent and its answer relayed whenever it arrives, so a long tool call holds nothing up
  // (a `notifications/cancelled` for it included). `initialize` is awaited: its answer brings the
  // session id every later message carries.
  lines(
    o.clientIn,
    async (msg, raw) => {
      if (Array.isArray(msg) && !calls.transparent && msg.some(isToolCall)) {
        // The rest of the batch still reaches the server, one message at a time.
        for (const item of msg) if (!isRequest(item)) await forward(JSON.stringify(item), isObject(item) ? (item) : null);
        const errors = refuseBatch(msg);
        if (errors.length) toClient(errors);
        return;
      }
      const m = isObject(msg) ? (msg as JsonRpcMessage) : null;
      if (isRequest(m) && m.method === 'tools/call') {
        const route = await calls.route(m);
        if ('answer' in route) return toClient(route.answer);
        pending.set(idKey(m.id), { method: 'tools/call', ...(route.live ? { live: route.live } : {}) });
      } else if (isRequest(m)) {
        pending.set(idKey(m.id), { method: m.method });
        if (m.method === 'initialize') {
          // The client starts a session (again): the old one's stream goes, and its params are kept to start the next one with.
          initialize = { params: m.params };
          stream?.destroy();
          stream = null;
          listening = false;
        }
      }
      const sent = forward(raw, m);
      if (!isRequest(m) || m.method === 'initialize') await sent;
      else chain = chain.then(() => sent);
      if (m && m.method === 'notifications/initialized') listen();
    },
    () => {
      void (async () => {
        await chain;
        closed = true;
        for (const req of inFlight) req.destroy();
        // Ends the session, as a client leaving should; the server may not support it.
        if (sessionId) {
          await new Promise<void>((resolve) => {
            const req = send(url, { method: 'DELETE', headers: headers({}, true), timeout: 2000 }, (res) => {
              res.resume();
              resolve();
            });
            req.on('error', () => resolve());
            req.on('timeout', () => {
              req.destroy();
              resolve();
            });
            req.end();
          });
        }
        resolveDone(0);
      })();
    },
  );
  return { done };
}

function readText(res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => (text += c));
    res.on('end', () => resolve(text));
    res.on('error', () => resolve(text));
  });
}
