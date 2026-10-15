import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Effect, SerializedError } from '@shadowlap/engine';

/**
 * `shadowlap mcp`: a proxy in front of an MCP server, which the agent's MCP client starts instead of
 * the server and talks to over stdio exactly as it would to the server. Two kinds of server:
 *
 * - `shadowlap mcp -- <command>` starts a local server and speaks stdio to it;
 * - `shadowlap mcp --url <server>` speaks Streamable HTTP to a remote one: each message is a POST,
 *   answered with JSON or an event stream, in the session the server names in `Mcp-Session-Id`.
 *
 * Either way, `tools/call` requests go through the sidecar like SDK tool calls (recorded, replayed,
 * blocked or stubbed); every other message passes through untouched. Effects come from the server's
 * tool annotations (`readOnlyHint` → read, otherwise write), overridden by `--effect name=read` or
 * the `mcp.effects` config. A call the recording answers never reaches the server, and a write
 * after a fork is refused or stubbed here, so a remote write never runs again on replay.
 */
export interface SidecarTarget {
  url: string;
  runId: string;
}

/** The sidecar only ever listens on loopback; anything else is not a Shadowlap sidecar. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type DiscoverySkip = (reason: string) => void;

/**
 * The sidecar to use: the environment (set by `shadowlap run`) first, else the file `shadowlap run`
 * leaves in the working directory while it is active, because MCP clients often start servers
 * with a minimal environment that drops SHADOWLAP_URL. The file lives in a directory a cloned
 * repository could have committed, so it is trusted only when it points at loopback, belongs to
 * this user, is not a symbolic link, and names a process that is still running.
 */
export function discoverSidecar(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), skip: DiscoverySkip = () => {}): SidecarTarget | null {
  if (env.SHADOWLAP_URL && env.SHADOWLAP_RUN_ID) {
    if (isLoopbackUrl(env.SHADOWLAP_URL)) return { url: env.SHADOWLAP_URL.replace(/\/$/, ''), runId: env.SHADOWLAP_RUN_ID };
    skip(`SHADOWLAP_URL ${env.SHADOWLAP_URL} is not a loopback address; ignoring it`);
  }
  const file = join(cwd, '.shadowlap', 'active.json');
  if (!existsSync(file)) return null;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return (skip(`${file} is not a regular file; ignoring it`), null);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return (skip(`${file} belongs to another user; ignoring it`), null);
    const j = JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown; runId?: unknown; pid?: unknown };
    if (typeof j.url !== 'string' || typeof j.runId !== 'string' || typeof j.pid !== 'number') return (skip(`${file} is incomplete; ignoring it`), null);
    if (!isLoopbackUrl(j.url)) return (skip(`${file} points at ${j.url}, which is not loopback; ignoring it`), null);
    if (!processAlive(j.pid)) return (skip(`${file} is left over from a run that has ended; ignoring it`), null);
    return { url: j.url.replace(/\/$/, ''), runId: j.runId };
  } catch {
    return (skip(`${file} is unreadable; ignoring it`), null);
  }
}

type JsonRpcId = string | number;
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown } & Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
}

type ResolveResponse =
  | { origin: 'replayed'; callNo: number; outcome: 'ok'; result: unknown }
  | { origin: 'replayed'; callNo: number; outcome: 'error'; error: SerializedError }
  | { origin: 'live'; callNo: number }
  | { origin: 'blocked'; callNo: number; outcome: 'error'; error: SerializedError }
  | { origin: 'stubbed'; callNo: number };

interface McpTool {
  name: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } & Record<string, unknown>;
}

export function effectFromAnnotations(annotations: McpTool['annotations']): Effect {
  return annotations?.readOnlyHint === true ? 'read' : 'write';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idKey = (id: JsonRpcId) => `${typeof id}:${String(id)}`;

async function post<T>(target: SidecarTarget, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${target.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shadowlap-run': target.runId, 'user-agent': 'shadowlap-mcp' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sidecar ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Feeds newline-delimited messages to `handler`, one at a time, in order. */
function lines(stream: Readable, handler: (msg: unknown, raw: string) => Promise<void> | void, onEnd: () => void): void {
  let buf = '';
  let chain: Promise<void> = Promise.resolve();
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      chain = chain.then(() => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = undefined;
        }
        return handler(msg, line);
      });
    }
  });
  stream.on('end', () => {
    if (buf.trim()) {
      const line = buf;
      buf = '';
      chain = chain.then(() => handler(undefined, line));
    }
    chain = chain.then(onEnd);
  });
}

/** A `tools/call` sent on to the server, to complete in the recording when its answer comes back. */
interface LiveCall {
  callNo: number;
  name: string;
  started: number;
}

/**
 * What both proxies do with tool calls: learn each tool's effect from `tools/list`, ask the sidecar
 * about each `tools/call`, answer the ones the recording or the fork policy answers, and record the
 * server's answer to the rest.
 */
class ToolCalls {
  private readonly tools = new Map<string, { effect: Effect; implHash: string }>();
  private sidecar: SidecarTarget | null;

  constructor(
    sidecar: SidecarTarget | null,
    private readonly effects: Record<string, Effect> | undefined,
    private readonly log: ((line: string) => void) | undefined,
  ) {
    this.sidecar = sidecar;
  }

  /** Learns effects and schemas from a `tools/list` result (one page of it). */
  learn(result: unknown): void {
    if (!isObject(result) || !Array.isArray(result.tools)) return;
    for (const t of result.tools as McpTool[]) {
      if (isObject(t) && typeof t.name === 'string') this.tools.set(t.name, { effect: effectFromAnnotations(t.annotations), implHash: createHash('sha256').update(JSON.stringify(t.inputSchema ?? null)).digest('hex') });
    }
  }

  /**
   * Routes a `tools/call`: `answer` is the response to give the client here; otherwise the request
   * goes to the server, and `live` is set when its answer is to be recorded.
   */
  async route(m: JsonRpcMessage & { id: JsonRpcId }): Promise<{ answer: unknown } | { forward: true; live?: LiveCall }> {
    if (!this.sidecar) return { forward: true };
    const name = typeof m.params?.name === 'string' ? m.params.name : '';
    const args = m.params?.arguments ?? {};
    const known = this.tools.get(name);
    const effect: Effect = this.effects?.[name] ?? known?.effect ?? 'write';
    let r: ResolveResponse;
    try {
      r = await post<ResolveResponse>(this.sidecar, '/v1/calls/resolve', { kind: 'tool', name, effect, args, ...(known ? { implHash: known.implHash } : {}) });
    } catch (err) {
      this.log?.(`sidecar unreachable, passing tools/call through unrecorded: ${err instanceof Error ? err.message : String(err)}`);
      this.sidecar = null;
      return { forward: true };
    }
    switch (r.origin) {
      case 'replayed':
        return { answer: r.outcome === 'ok' ? { jsonrpc: '2.0', id: m.id, result: r.result } : { jsonrpc: '2.0', id: m.id, error: rpcError(r.error) } };
      case 'blocked':
        // The model sees the refusal as a tool error and can carry on, as an SDK agent would after ShadowlapWriteBlocked.
        return { answer: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.error.message }], isError: true } } };
      case 'stubbed': {
        const result = { content: [{ type: 'text', text: `${name} was not executed: write tools are stubbed after the fork (shadowlap replay --writes stub).` }], isError: false };
        await post(this.sidecar, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result, latencyMs: 0 });
        return { answer: { jsonrpc: '2.0', id: m.id, result } };
      }
      case 'live':
        return { forward: true, live: { callNo: r.callNo, name, started: Date.now() } };
    }
  }

  /** Records the server's answer to a call sent on. */
  async complete(call: LiveCall, m: JsonRpcMessage): Promise<void> {
    if (!this.sidecar) return;
    const latencyMs = Date.now() - call.started;
    const body = m.error
      ? { outcome: 'error', error: { name: 'JsonRpcError', message: m.error.message, code: String(m.error.code), ...(m.error.data !== undefined ? { data: m.error.data } : {}) }, latencyMs }
      : { outcome: 'ok', result: m.result ?? null, latencyMs };
    try {
      await post(this.sidecar, `/v1/calls/${call.callNo}/complete`, body);
    } catch (err) {
      this.log?.(`could not record the result of ${call.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function rpcError(e: SerializedError): JsonRpcError {
  const code = e.code !== undefined ? Number(e.code) : NaN;
  return { code: Number.isFinite(code) ? code : -32000, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) };
}

export interface McpProxyOptions {
  /** From and to the MCP client (the agent). */
  clientIn: Readable;
  clientOut: Writable;
  server: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  /** Without a sidecar the proxy is transparent. */
  sidecar: SidecarTarget | null;
  /** Effects by tool name; wins over the server's annotations. */
  effects?: Record<string, Effect>;
  log?: (line: string) => void;
}

export function startMcpProxy(o: McpProxyOptions): { child: ChildProcess; done: Promise<number> } {
  const child = spawn(o.server.command, o.server.args, { stdio: ['pipe', 'pipe', 'inherit'], env: o.server.env ?? process.env });
  const pending = new Map<string, { method: string; live?: LiveCall }>();
  const calls = new ToolCalls(o.sidecar, o.effects, o.log);
  const toServer = (raw: string) => {
    child.stdin.write(raw + '\n');
  };
  const toClient = (raw: string) => {
    o.clientOut.write(raw + '\n');
  };

  // Client → server. tools/call is resolved through the sidecar; everything else passes through.
  lines(
    o.clientIn,
    async (msg, raw) => {
      const m = isObject(msg) ? (msg as JsonRpcMessage) : null;
      if (!m || m.id === undefined || m.id === null || typeof m.method !== 'string') return toServer(raw);
      if (m.method !== 'tools/call') {
        pending.set(idKey(m.id), { method: m.method });
        return toServer(raw);
      }
      const route = await calls.route(m as JsonRpcMessage & { id: JsonRpcId });
      if ('answer' in route) return toClient(JSON.stringify(route.answer));
      pending.set(idKey(m.id), { method: m.method, ...(route.live ? { live: route.live } : {}) });
      return toServer(raw);
    },
    () => child.stdin.end(),
  );

  // Server → client. Responses to tools/call complete the recorded call first; tools/list responses teach the effects.
  lines(
    child.stdout!,
    async (msg, raw) => {
      const m = isObject(msg) ? (msg as JsonRpcMessage) : null;
      if (!m || m.id === undefined || m.id === null || m.method !== undefined) return toClient(raw);
      const p = pending.get(idKey(m.id));
      if (!p) return toClient(raw);
      pending.delete(idKey(m.id));
      if (p.method === 'tools/list') calls.learn(m.result);
      if (p.live) await calls.complete(p.live, m);
      toClient(raw);
    },
    () => {},
  );

  const done = new Promise<number>((resolve) => {
    child.on('error', (err) => {
      o.log?.(`failed to start ${o.server.command}: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  return { child, done };
}

// ---------------------------------------------------------------------------------------------- Streamable HTTP

export interface McpHttpProxyOptions {
  /** From and to the MCP client (the agent). */
  clientIn: Readable;
  clientOut: Writable;
  /** The server's MCP endpoint, e.g. `https://mcp.example.com/mcp`. */
  url: string;
  /** Sent with every request, e.g. `{ authorization: 'Bearer …' }`. Never recorded. */
  headers?: Record<string, string>;
  /** Without a sidecar the proxy is transparent. */
  sidecar: SidecarTarget | null;
  /** Effects by tool name; wins over the server's annotations. */
  effects?: Record<string, Effect>;
  log?: (line: string) => void;
}

/** Headers the proxy sets itself on every request. */
const MANAGED_HEADERS = new Set(['accept', 'content-type', 'content-length', 'host', 'mcp-session-id', 'mcp-protocol-version', 'connection', 'transfer-encoding']);

/** `Name: value` flags into headers, with `${NAME}` taken from the environment, so a token can stay in the client config's env block. */
export function parseHeaderFlags(flags: string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const i = f.indexOf(':');
    const name = i > 0 ? f.slice(0, i).trim().toLowerCase() : '';
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new Error(`--header expects <name>: <value>, got "${f}"`);
    if (MANAGED_HEADERS.has(name)) throw new Error(`--header: ${name} is set by the proxy itself`);
    const value = f.slice(i + 1).trim().replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v: string) => {
      const found = env[v];
      if (found === undefined) throw new Error(`--header ${name}: \${${v}} is not set in the environment`);
      return found;
    });
    if (/[\r\n\0]/.test(value)) throw new Error(`--header ${name}: the value has a line break in it`);
    out[name] = value;
  }
  return out;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The server's URL, checked: http(s), no credentials in it, and https when headers would cross the network. */
export function mcpServerUrl(raw: string, withHeaders: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--url needs the server's MCP endpoint, such as https://mcp.example.com/mcp, not "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`--url: an MCP server is reached over https, not ${url.protocol}`);
  if (url.username || url.password) throw new Error('--url: leave credentials out of the URL; pass them with --header');
  if (withHeaders && url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) throw new Error(`--url: use https for ${url.host}: the headers would cross the network in the clear (http is accepted for this machine only)`);
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

/**
 * Starts the Streamable HTTP proxy. Messages from the client are sent in order, each as a POST; a
 * response arrives as JSON or as an event stream that may carry the server's own requests and
 * notifications before it. The session id the server gives at `initialize` goes with every later
 * request, with the protocol version it agreed. Server-initiated messages outside any request come
 * on a GET stream, opened once the session starts, when the server offers one.
 */
export function startMcpHttpProxy(o: McpHttpProxyOptions): { done: Promise<number> } {
  const url = new URL(o.url);
  const calls = new ToolCalls(o.sidecar, o.effects, o.log);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let listening = false;
  let closed = false;
  const inFlight = new Set<{ destroy(): void }>();
  const toClient = (message: unknown) => {
    if (!closed) o.clientOut.write(JSON.stringify(message) + '\n');
  };
  const failure = (id: JsonRpcId, message: string, code = -32000) => toClient({ jsonrpc: '2.0', id, error: { code, message } });

  // `shadowlap run`'s network guard would report this proxy's own connection to its server as
  // traffic Shadowlap doesn't record; the calls it carries are recorded here.
  const allowGuard = (globalThis as Record<symbol, unknown>)[Symbol.for('shadowlap.guard.allow')];
  if (typeof allowGuard === 'function') allowGuard(`${url.hostname.replace(/^\[|\]$/g, '')}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`);

  function headers(extra: Record<string, string>): Record<string, string> {
    return {
      ...o.headers,
      ...extra,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    };
  }

  /** A message from the server: a response to a pending request settles it; anything else goes to the client. */
  const pending = new Map<string, { method: string; live?: LiveCall }>();
  async function fromServer(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      o.log?.(`the server sent something that is not JSON: ${raw.slice(0, 200)}`);
      return;
    }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      const m = isObject(msg) ? (msg as JsonRpcMessage) : null;
      if (m && m.id !== undefined && m.id !== null && m.method === undefined) {
        const p = pending.get(idKey(m.id));
        if (p) {
          pending.delete(idKey(m.id));
          if (p.method === 'initialize' && isObject(m.result) && typeof m.result.protocolVersion === 'string') protocolVersion = m.result.protocolVersion;
          if (p.method === 'tools/list') calls.learn(m.result);
          if (p.live) await calls.complete(p.live, m);
        }
      }
      toClient(msg);
    }
  }

  /** POSTs one message and relays what comes back. Resolves when the response has been read. */
  function forward(raw: string, m: JsonRpcMessage | null): Promise<void> {
    const id = m && m.id !== undefined && m.id !== null && typeof m.method === 'string' ? m.id : null;
    return new Promise<void>((resolve) => {
      const body = Buffer.from(raw, 'utf8');
      const req = send(url, { method: 'POST', headers: headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(body.length) }) }, (res) => {
        inFlight.delete(req);
        const sid = res.headers['mcp-session-id'];
        if (typeof sid === 'string' && sid) sessionId = sid;
        void relay(res, id).then(resolve);
      });
      inFlight.add(req);
      req.on('error', (err) => {
        inFlight.delete(req);
        if (id !== null && !closed) {
          pending.delete(idKey(id));
          failure(id, `could not reach the MCP server at ${url.host}: ${err.message}`);
        }
        resolve();
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
      if (id !== null) {
        pending.delete(idKey(id));
        // A server ends a session with 404; the client starts a new one by initializing again.
        const why = status === 404 && sessionId ? 'the MCP session has ended (the server answered 404); initialize again' : `the MCP server answered ${status}${text ? `: ${text.slice(0, 300)}` : ''}`;
        failure(id, why);
      }
      return;
    }
    if (/text\/event-stream/i.test(type)) {
      res.setEncoding('utf8');
      let chain: Promise<void> = Promise.resolve();
      // The answer ends the request's stream; a server that keeps it open after answering holds nothing up.
      const answered = () => id !== null && !pending.has(idKey(id));
      const events = new EventStream((data) => (chain = chain.then(() => fromServer(data)).then(() => void (answered() && res.destroy()))));
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
    if (id !== null && pending.has(idKey(id))) {
      pending.delete(idKey(id));
      failure(id, 'the MCP server ended its response without an answer');
    }
  }

  /** The server's own messages outside any request, when it offers a GET stream for them. */
  function listen(): void {
    if (listening || !sessionId || closed) return;
    listening = true;
    const req = send(url, { method: 'GET', headers: headers({ accept: 'text/event-stream' }) }, (res) => {
      if (res.statusCode !== 200 || !/text\/event-stream/i.test(String(res.headers['content-type'] ?? ''))) return void res.resume();
      res.setEncoding('utf8');
      let chain: Promise<void> = Promise.resolve();
      const events = new EventStream((data) => (chain = chain.then(() => fromServer(data))));
      res.on('data', (chunk: string) => events.push(chunk));
    });
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
      const m = isObject(msg) ? (msg as JsonRpcMessage) : null;
      const isRequest = !!m && m.id !== undefined && m.id !== null && typeof m.method === 'string';
      if (isRequest && m!.method === 'tools/call') {
        const route = await calls.route(m as JsonRpcMessage & { id: JsonRpcId });
        if ('answer' in route) return toClient(route.answer);
        pending.set(idKey(m!.id!), { method: 'tools/call', ...(route.live ? { live: route.live } : {}) });
      } else if (isRequest) pending.set(idKey(m!.id!), { method: m!.method! });
      const sent = forward(raw, m);
      if (!isRequest || m!.method === 'initialize') await sent;
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
            const req = send(url, { method: 'DELETE', headers: headers({}), timeout: 2000 }, (res) => {
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

/** `name=effect` flags into a map. */
export function parseEffectFlags(flags: string[]): Record<string, Effect> {
  const out: Record<string, Effect> = {};
  for (const f of flags) {
    const i = f.indexOf('=');
    const name = i > 0 ? f.slice(0, i) : '';
    const effect = f.slice(i + 1);
    if (!name || (effect !== 'pure' && effect !== 'read' && effect !== 'write')) throw new Error(`--effect expects <tool>=<pure|read|write>, got "${f}"`);
    out[name] = effect;
  }
  return out;
}

/**
 * `shadowlap mcp`: the proxy in front of a local server (`argv`) or a remote one (`--url`), with the
 * sidecar of the run that is active, if any. Resolves with the exit code.
 */
export async function runMcp(argv: string[], flags: { url?: string; header: string[]; effect: string[] }, effectsFromConfig: Record<string, Effect> | undefined): Promise<number> {
  if (flags.url && argv.length) throw new Error('give the server as a command after -- or as --url, not both');
  if (!flags.url && !argv.length) throw new Error('give the MCP server: shadowlap mcp -- <server command>, or shadowlap mcp --url <server>');
  if (!flags.url && flags.header.length) throw new Error('--header is for a server reached with --url');
  const effects = { ...effectsFromConfig, ...parseEffectFlags(flags.effect) };
  const log = (line: string) => process.stderr.write(`[shadowlap mcp] ${line}\n`);
  const headers = parseHeaderFlags(flags.header);
  const url = flags.url ? mcpServerUrl(flags.url, Object.keys(headers).length > 0) : null;
  const target = discoverSidecar(process.env, process.cwd(), log);
  if (!target) log('no active run (SHADOWLAP_URL unset and no .shadowlap/active.json): passing everything through');
  if (url) return startMcpHttpProxy({ clientIn: process.stdin, clientOut: process.stdout, url: url.href, headers, sidecar: target, effects, log }).done;
  const { child, done } = startMcpProxy({ clientIn: process.stdin, clientOut: process.stdout, server: { command: argv[0]!, args: argv.slice(1) }, sidecar: target, effects, log });
  const onSignal = (sig: NodeJS.Signals) => child.kill(sig);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return done;
}
