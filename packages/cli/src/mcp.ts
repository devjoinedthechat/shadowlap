import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Effect, SerializedError } from '@shadowlap/engine';
import { isLoopbackUrl, lookupRegistration, parentRegistration, processAncestors, type SidecarLookup, type SidecarTarget } from './agent-registry.js';
import { isLoopbackHost } from './loopback.js';
import { startCommand } from './start-command.js';

export { isLoopbackUrl, type SidecarTarget } from './agent-registry.js';

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
 * after a fork is refused or stubbed here, so a remote write never runs again on replay. When the
 * proxy was started under Shadowlap but can't record (its sidecar can't be found or asked), it
 * refuses writes rather than send them unrecorded: this could be a replay.
 */

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
 * The sidecar named by the environment (set by `shadowlap run` and the commands that replay), else
 * by the file `shadowlap run` leaves in the working directory while it is active. The file lives
 * in a directory a cloned repository could have committed, so it is trusted only when it points at
 * loopback, belongs to this user, is not a symbolic link, and names a process that is still running
 * (one of this process's ancestors, when `ancestors` is known).
 */
export function discoverSidecar(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), skip: DiscoverySkip = () => {}, ancestors?: readonly number[]): SidecarTarget | null {
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
    if (ancestors && !ancestors.includes(j.pid)) return (skip(`${file} belongs to a run this process was not started by; ignoring it`), null);
    return { url: j.url.replace(/\/$/, ''), runId: j.runId };
  } catch {
    return (skip(`${file} is unreadable; ignoring it`), null);
  }
}

/**
 * The run this proxy records into. The environment, when the client passed it on; else the
 * registration of the nearest ancestor Shadowlap started (see agent-registry.ts), which is how a
 * proxy started with a minimal environment under `shadowlap test`, `blame`, `verify` or
 * `replay --repeat` finds its run; else, where the process tree can't be read, the active run's
 * file in the working directory. On Windows, where the tree takes PowerShell (seconds on a busy
 * machine), the parent's registration is looked for first: an agent whose own MCP client started
 * the proxy is found without the tree.
 */
export async function findSidecar(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), skip: DiscoverySkip = () => {}, o: { home?: string | null; waitMs?: number; platform?: NodeJS.Platform } = {}): Promise<SidecarLookup> {
  if (env.SHADOWLAP_URL) {
    // Without a run id, as a test runner's host sets it (a slot's URL), the URL itself picks the run, as for the SDKs.
    if (isLoopbackUrl(env.SHADOWLAP_URL)) return { kind: 'sidecar', target: { url: env.SHADOWLAP_URL.replace(/\/$/, ''), runId: env.SHADOWLAP_RUN_ID ?? '' }, from: 'SHADOWLAP_URL' };
    skip(`SHADOWLAP_URL ${env.SHADOWLAP_URL} is not a loopback address; ignoring it`);
  }
  if ((o.platform ?? process.platform) === 'win32') {
    const direct = parentRegistration({ cwd, skip, ...(o.home !== undefined ? { home: o.home } : {}) });
    if (direct) return direct;
  }
  const chain = processAncestors(skip);
  const registered = await lookupRegistration({ cwd, chain, skip, ...(o.home !== undefined ? { home: o.home } : {}), ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}) });
  if (registered.kind !== 'none' || chain) return registered;
  const active = discoverSidecar({}, cwd, skip);
  return active ? { kind: 'sidecar', target: active, from: join(cwd, '.shadowlap', 'active.json') } : { kind: 'none' };
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
  /** `injected`: a failure `replay --fail-at <call>=timeout|error|<status>` asked for, not a recorded error. */
  | { origin: 'replayed'; callNo: number; outcome: 'error'; error: SerializedError; injected?: { kind: string } }
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
const isRequest = (m: unknown): m is JsonRpcMessage & { id: JsonRpcId; method: string } => isObject(m) && m.id !== undefined && m.id !== null && typeof m.method === 'string';
const isToolCall = (m: unknown) => isRequest(m) && m.method === 'tools/call';

/** The answers to a client's batch that carries `tools/call`, which can't be recorded: an error for each request in it. */
function refuseBatch(batch: unknown[]): unknown[] {
  return batch.filter(isRequest).map((m) => ({
    jsonrpc: '2.0',
    id: m.id,
    error: { code: -32600, message: 'shadowlap: a JSON-RPC batch that carries tools/call can\'t be recorded or fenced; send each tools/call on its own (MCP 2025-06-18 removed batching)' },
  }));
}

async function post<T>(target: SidecarTarget, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${target.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(target.runId ? { 'x-shadowlap-run': target.runId } : {}), 'user-agent': 'shadowlap-mcp' },
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

/** Which server a recorded call came from: its transport, and its host or command (never its arguments or path, which can hold secrets). */
export interface McpOrigin {
  transport: 'stdio' | 'http';
  server: string;
}

/** Package runners whose first argument names the server, when only flags without values come before it. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);
const RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet']);
const PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~-]+)?$/i;

/** A local server's name for the recording: its command, and the package a runner like npx starts. */
export function stdioServerName(command: string, args: readonly string[]): string {
  const name = (command.split(/[\\/]/).pop() ?? command).replace(/\.(?:cmd|exe|bat)$/i, '');
  if (!RUNNERS.has(name)) return name;
  for (const a of args) {
    if (RUNNER_FLAGS.has(a)) continue;
    return PACKAGE.test(a) ? `${name} ${a}` : name;
  }
  return name;
}

/** A text bound for the sidecar: control characters as spaces, cut to `max`. */
const bounded = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/**
 * What both proxies do with tool calls: learn each tool's effect from `tools/list`, ask the sidecar
 * about each `tools/call`, answer the ones the recording or the fork policy answers, and record the
 * server's answer to the rest. A call that can't be recorded (no sidecar to ask, though there should
 * be one) is a refusal for a write and an unrecorded pass for anything else.
 */
class ToolCalls {
  private readonly tools = new Map<string, { effect: Effect; implHash: string }>();
  private readonly warned = new Set<string>();
  /** The tool list last sent to the sidecar, so it is sent again only when it changes. */
  private sentTools = '';

  constructor(
    private readonly sidecar: ProxySidecar,
    private readonly effects: Record<string, Effect> | undefined,
    private readonly log: ((line: string) => void) | undefined,
    private readonly origin: McpOrigin,
  ) {}

  /** Without a sidecar, and with nothing saying there should be one, the proxy only passes messages on. */
  get transparent(): boolean {
    return this.sidecar === null;
  }

  /** Learns effects and schemas from a `tools/list` result (one page of it). */
  learn(result: unknown): void {
    if (!isObject(result) || !Array.isArray(result.tools)) return;
    for (const t of result.tools as McpTool[]) {
      if (isObject(t) && typeof t.name === 'string') this.tools.set(t.name, { effect: effectFromAnnotations(t.annotations), implHash: createHash('sha256').update(JSON.stringify(t.inputSchema ?? null)).digest('hex') });
    }
  }

  private effectOf(name: string): Effect {
    return this.effects?.[name] ?? this.tools.get(name)?.effect ?? 'write';
  }

  /**
   * Where the call came from, and the server's tools with their effects when they changed since
   * the sidecar last got them; `sent` marks them as got, once the sidecar has answered.
   */
  private mcpMeta(): { meta: Record<string, unknown>; sent: () => void } {
    const tools = [...this.tools.keys()]
      .sort()
      .slice(0, 1000)
      .map((name) => ({ name: bounded(name, 200), effect: this.effectOf(name) }));
    const json = JSON.stringify(tools);
    const fresh = tools.length > 0 && json !== this.sentTools;
    return { meta: { transport: this.origin.transport, server: bounded(this.origin.server, 200), ...(fresh ? { tools } : {}) }, sent: () => void (this.sentTools = json) };
  }

  /**
   * Routes a `tools/call`: `answer` is the response to give the client here; otherwise the request
   * goes to the server, and `live` is set when its answer is to be recorded.
   */
  async route(m: JsonRpcMessage & { id: JsonRpcId }): Promise<{ answer: unknown } | { forward: true; live?: LiveCall }> {
    if (this.sidecar === null) return { forward: true };
    const name = typeof m.params?.name === 'string' ? m.params.name : '';
    const args = m.params?.arguments ?? {};
    const known = this.tools.get(name);
    const effect = this.effectOf(name);
    if ('unusable' in this.sidecar) return this.unrecorded(m, name, effect, this.sidecar.unusable);
    const sidecar = this.sidecar;
    let r: ResolveResponse;
    const mcp = this.mcpMeta();
    try {
      r = await post<ResolveResponse>(sidecar, '/v1/calls/resolve', { kind: 'tool', name, effect, args, ...(known ? { implHash: known.implHash } : {}), mcp: mcp.meta });
      mcp.sent();
    } catch (err) {
      return this.unrecorded(m, name, effect, `Shadowlap's sidecar could not be asked (${err instanceof Error ? err.message : String(err)})`);
    }
    switch (r.origin) {
      case 'replayed':
        // A tool failed with --fail-at answers as an MCP server does when a tool's handler fails: a
        // result with isError, which the client hands to the model. A recorded error stays as recorded.
        if (r.outcome === 'error' && r.injected) return { answer: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.error.message }], isError: true } } };
        return { answer: r.outcome === 'ok' ? { jsonrpc: '2.0', id: m.id, result: r.result } : { jsonrpc: '2.0', id: m.id, error: rpcError(r.error) } };
      case 'blocked':
        // The model sees the refusal as a tool error and can carry on, as an SDK agent would after ShadowlapWriteBlocked.
        return { answer: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.error.message }], isError: true } } };
      case 'stubbed': {
        const result = { content: [{ type: 'text', text: `${name} was not executed: write tools are stubbed after the fork (shadowlap replay --writes stub).` }], isError: false };
        await post(sidecar, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result, latencyMs: 0 }).catch((err: unknown) => this.log?.(`could not record the stub for ${name}: ${err instanceof Error ? err.message : String(err)}`));
        return { answer: { jsonrpc: '2.0', id: m.id, result } };
      }
      case 'live':
        return { forward: true, live: { callNo: r.callNo, name, started: Date.now() } };
    }
    // An answer this proxy doesn't know is an error, as the protocol says, never a guess: guessing
    // could send a write to the server during a replay.
    const origin = (r as { origin?: unknown }).origin;
    return { answer: { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: `shadowlap: unexpected answer "${String(origin)}" from the sidecar for ${name}; the call was not sent` } } };
  }

  /** A call that can't be recorded. A write is refused, since this could be a replay's; anything else goes to the server, unrecorded. */
  private unrecorded(m: JsonRpcMessage & { id: JsonRpcId }, name: string, effect: Effect, why: string): { answer: unknown } | { forward: true } {
    if (effect === 'write') {
      this.log?.(`refused ${name}, a write: ${why}`);
      return { answer: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `shadowlap: ${name} was not sent. It is a write, and it can't be recorded: ${why}. A write is never sent unrecorded under Shadowlap, since this may be a replay.` }], isError: true } } };
    }
    if (!this.warned.has(why)) {
      this.warned.add(why);
      this.log?.(`${why}: passing ${effect} tools through unrecorded`);
    }
    return { forward: true };
  }

  /** Records the server's answer to a call sent on. */
  async complete(call: LiveCall, m: JsonRpcMessage): Promise<void> {
    if (this.sidecar === null || 'unusable' in this.sidecar) return;
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

/**
 * What a proxy records with: a sidecar; null, when nothing says Shadowlap is there (the proxy is
 * transparent); or the reason it can't record although it was started under Shadowlap (writes are
 * refused, everything else passes unrecorded).
 */
export type ProxySidecar = SidecarTarget | { unusable: string } | null;

export interface McpProxyOptions {
  /** From and to the MCP client (the agent). */
  clientIn: Readable;
  clientOut: Writable;
  server: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  sidecar: ProxySidecar;
  /** Effects by tool name; wins over the server's annotations. */
  effects?: Record<string, Effect>;
  log?: (line: string) => void;
}

export function startMcpProxy(o: McpProxyOptions): { child: ChildProcess; done: Promise<number> } {
  // `npx -y some-server` runs through cmd.exe on Windows, where npx is a batch file.
  const start = startCommand(o.server.command, o.server.args, { env: o.server.env ?? process.env });
  const child = spawn(start.command, start.args, { ...start.options, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<string, { method: string; live?: LiveCall }>();
  const calls = new ToolCalls(o.sidecar, o.effects, o.log, { transport: 'stdio', server: stdioServerName(o.server.command, o.server.args) });
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
      if (Array.isArray(msg) && !calls.transparent && msg.some(isToolCall)) {
        // The rest of the batch still reaches the server, one message at a time.
        for (const item of msg) if (!isRequest(item)) toServer(JSON.stringify(item));
        const errors = refuseBatch(msg);
        if (errors.length) toClient(JSON.stringify(errors));
        return;
      }
      if (!isRequest(msg)) return toServer(raw);
      if (msg.method !== 'tools/call') {
        pending.set(idKey(msg.id), { method: msg.method });
        return toServer(raw);
      }
      const route = await calls.route(msg);
      if ('answer' in route) return toClient(JSON.stringify(route.answer));
      pending.set(idKey(msg.id), { method: msg.method, ...(route.live ? { live: route.live } : {}) });
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
    child.on('exit', (code, signal) => {
      // A call the server never answered still ends in the recording, as the agent saw it end.
      const unanswered = [...pending.values()].filter((p) => p.live);
      pending.clear();
      void Promise.all(unanswered.map((p) => calls.complete(p.live!, { error: { code: -32000, message: 'the MCP server exited before answering' } }))).then(() => resolve(code ?? (signal ? 128 : 1)));
    });
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
  sidecar: ProxySidecar;
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
  const allowGuard = (globalThis as Record<symbol, unknown>)[Symbol.for('shadowlap.guard.allow')];
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
        const events = new EventStream((data) => (chain = chain.then(() => fromServer(data))));
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
        for (const item of msg) if (!isRequest(item)) await forward(JSON.stringify(item), isObject(item) ? (item as JsonRpcMessage) : null);
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
 * sidecar of the run it was started under, if any. Resolves with the exit code.
 */
export async function runMcp(argv: string[], flags: { url?: string; header: string[]; effect: string[]; allowHttp?: boolean }, effectsFromConfig: Record<string, Effect> | undefined): Promise<number> {
  if (flags.url && argv.length) throw new Error('give the server as a command after -- or as --url, not both');
  if (!flags.url && !argv.length) throw new Error('give the MCP server: shadowlap mcp -- <server command>, or shadowlap mcp --url <server>');
  if (!flags.url && flags.header.length) throw new Error('--header is for a server reached with --url');
  if (!flags.url && flags.allowHttp) throw new Error('--allow-http is for a server reached with --url');
  const effects = { ...effectsFromConfig, ...parseEffectFlags(flags.effect) };
  const log = (line: string) => process.stderr.write(`[shadowlap mcp] ${line}\n`);
  const headers = parseHeaderFlags(flags.header);
  const url = flags.url ? mcpServerUrl(flags.url, Object.keys(headers).length > 0, flags.allowHttp === true) : null;
  const found = await findSidecar(process.env, process.cwd(), log);
  let sidecar: ProxySidecar = null;
  if (found.kind === 'sidecar') {
    sidecar = found.target;
    // Said once, up front: a sidecar that doesn't answer means every write will be refused.
    const answers = await fetch(`${found.target.url}/v1/health`, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (!answers) log(`the Shadowlap sidecar named by ${found.from === 'SHADOWLAP_URL' ? 'SHADOWLAP_URL' : found.from} does not answer, so write tools will be refused. Outside a Shadowlap run, unset SHADOWLAP_URL`);
  } else if (found.kind === 'unusable') {
    sidecar = { unusable: found.reason };
    log(`can't record: ${found.reason}. Write tools will be refused; read tools pass through unrecorded`);
  } else log('no active run (no SHADOWLAP_URL, and no Shadowlap command started this process): passing everything through');
  if (url) return startMcpHttpProxy({ clientIn: process.stdin, clientOut: process.stdout, url: url.href, headers, sidecar, effects, log }).done;
  const { child, done } = startMcpProxy({ clientIn: process.stdin, clientOut: process.stdout, server: { command: argv[0]!, args: argv.slice(1) }, sidecar, effects, log });
  const onSignal = (sig: NodeJS.Signals) => child.kill(sig);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return done;
}
