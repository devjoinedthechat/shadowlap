import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Effect, SerializedError } from '@shadowlap/engine';
import { isObject, messageOf } from '@shadowlap/engine';
import type { SidecarTarget } from './agent-registry.js';

/**
 * What the proxies of `shadowlap mcp` share, whatever the server's transport: the JSON-RPC messages,
 * the client's newline-delimited messages over stdio, and the tool calls they route through the
 * sidecar (ToolCalls), which records, replays, blocks or stubs each `tools/call`.
 */

export type JsonRpcId = string | number;
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
export interface JsonRpcMessage {
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
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } & Record<string, unknown>;
}

export function effectFromAnnotations(annotations: McpTool['annotations']): Effect {
  return annotations?.readOnlyHint === true ? 'read' : 'write';
}

/**
 * Whether a tool reaches outside entities (a web search, a mailbox), as MCP's `openWorldHint` says:
 * a read of one brings outside text in, so it is recorded as untrusted, where `shadowlap injection`
 * plants. Only a hint the server sets counts (MCP reads a missing one as true, which would mark every
 * read of a server that annotates nothing); the config's `tools` marks any tool either way.
 */
export function openWorld(annotations: McpTool['annotations']): boolean {
  return annotations?.openWorldHint === true;
}

export const idKey = (id: JsonRpcId) => `${typeof id}:${String(id)}`;
export const isRequest = (m: unknown): m is JsonRpcMessage & { id: JsonRpcId; method: string } => isObject(m) && m.id !== undefined && m.id !== null && typeof m.method === 'string';
export const isToolCall = (m: unknown) => isRequest(m) && m.method === 'tools/call';

/** The answers to a client's batch that carries `tools/call`, which can't be recorded: an error for each request in it. */
export function refuseBatch(batch: unknown[]): unknown[] {
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
export function lines(stream: Readable, handler: (msg: unknown, raw: string) => Promise<void> | void, onEnd: () => void): void {
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
export interface LiveCall {
  callNo: number;
  name: string;
  started: number;
}

/** Which server a recorded call came from: its transport, and its host or command (never its arguments or path, which can hold secrets). */
export interface McpOrigin {
  transport: 'stdio' | 'http';
  server: string;
}

/**
 * The name a call's error is recorded under when the client's answer was broken off with the
 * server's (`--listen`), so a replay breaks it off the same way rather than answer with the error.
 */
const CUT_SHORT = 'McpAnswerCutShort';

/**
 * The name a call's error is recorded under when the client's answer was no JSON-RPC message
 * (`--listen`): an HTTP error such as a 503, or the 502 the proxy gives when the server can't be
 * reached. The answer is kept with it (HttpAnswer), so a replay gives the client the same.
 */
const HTTP_ANSWER = 'McpHttpAnswer';

/** The headers of an HTTP answer kept for a replay: what it is, and how to retry or sign in. Never the session's own. */
export const REPLAYED_HEADERS = ['content-type', 'cache-control', 'www-authenticate', 'retry-after'];

/** An HTTP answer as the client got it: its status, the REPLAYED_HEADERS it had, and its body, in base64 when it isn't UTF-8. */
export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
  base64?: true;
}

/** A recorded HttpAnswer, as a replay may serve it: null for anything else, and only REPLAYED_HEADERS are kept. */
function httpAnswer(data: unknown): HttpAnswer | null {
  if (!isObject(data) || !Number.isInteger(data.status) || (data.status as number) < 100 || (data.status as number) > 599 || typeof data.body !== 'string' || !isObject(data.headers)) return null;
  const headers: Record<string, string> = {};
  for (const name of REPLAYED_HEADERS) if (typeof data.headers[name] === 'string') headers[name] = data.headers[name];
  return { status: data.status as number, headers, body: data.body, ...(data.base64 === true ? { base64: true as const } : {}) };
}

/** A text bound for the sidecar: control characters as spaces, cut to `max`. */
const bounded = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/**
 * What every proxy does with tool calls: learn each tool's effect from `tools/list`, ask the sidecar
 * about each `tools/call`, answer the ones the recording or the fork policy answers, and record the
 * server's answer to the rest. A call that can't be recorded (no sidecar to ask, though there should
 * be one) is a refusal for a write and an unrecorded pass for anything else.
 */
export class ToolCalls {
  private readonly tools = new Map<string, { effect: Effect; implHash: string; openWorld: boolean }>();
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
      if (isObject(t) && typeof t.name === 'string') this.tools.set(t.name, { effect: effectFromAnnotations(t.annotations), implHash: createHash('sha256').update(JSON.stringify(t.inputSchema ?? null)).digest('hex'), openWorld: openWorld(t.annotations) });
    }
  }

  private effectOf(name: string): Effect {
    return this.effects?.[name] ?? this.tools.get(name)?.effect ?? 'write';
  }

  /** An open-world tool that only reads brings outside text in: its calls are recorded untrusted. */
  private untrusted(name: string): boolean {
    return this.tools.get(name)?.openWorld === true && this.effectOf(name) !== 'write';
  }

  /**
   * Where the call came from, and the server's tools with their effects when they changed since
   * the sidecar last got them; `sent` marks them as got, once the sidecar has answered.
   */
  private mcpMeta(): { meta: Record<string, unknown>; sent: () => void } {
    const tools = [...this.tools.keys()]
      .sort()
      .slice(0, 1000)
      .map((name) => ({ name: bounded(name, 200), effect: this.effectOf(name), ...(this.untrusted(name) ? { trust: 'untrusted' as const } : {}) }));
    const json = JSON.stringify(tools);
    const fresh = tools.length > 0 && json !== this.sentTools;
    return { meta: { transport: this.origin.transport, server: bounded(this.origin.server, 200), ...(fresh ? { tools } : {}) }, sent: () => void (this.sentTools = json) };
  }

  /**
   * Routes a `tools/call`: `answer` is the response to give the client here, and `cut` and `http`
   * say the recording broke the client's answer off, or gave it an HTTP answer, which a transport
   * that can does again; otherwise the request goes to the server, and `live` is set when its answer
   * is to be recorded.
   */
  async route(m: JsonRpcMessage & { id: JsonRpcId }): Promise<{ answer: unknown; cut?: true; http?: HttpAnswer } | { forward: true; live?: LiveCall }> {
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
      r = await post<ResolveResponse>(sidecar, '/v1/calls/resolve', { kind: 'tool', name, effect, args, ...(known ? { implHash: known.implHash } : {}), ...(this.untrusted(name) ? { trust: 'untrusted' } : {}), mcp: mcp.meta });
      mcp.sent();
    } catch (err) {
      return this.unrecorded(m, name, effect, `shadowlap's sidecar could not be asked (${messageOf(err)})`);
    }
    switch (r.origin) {
      case 'replayed':
        // A tool failed with --fail-at answers as an MCP server does when a tool's handler fails: a
        // result with isError, which the client hands to the model. A recorded error stays as recorded.
        if (r.outcome === 'error' && r.injected) return { answer: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.error.message }], isError: true } } };
        return r.outcome === 'ok' ? { answer: { jsonrpc: '2.0', id: m.id, result: r.result } } : recordedError(m.id, r.error);
      case 'blocked':
        // The model sees the refusal as a tool error and can carry on, as an SDK agent would after ShadowlapWriteBlocked.
        return { answer: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.error.message }], isError: true } } };
      case 'stubbed': {
        const result = { content: [{ type: 'text', text: `${name} was not executed: write tools are stubbed after the fork (shadowlap replay --writes stub).` }], isError: false };
        await post(sidecar, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result, latencyMs: 0 }).catch((err: unknown) => this.log?.(`could not record the stub for ${name}: ${messageOf(err)}`));
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
      return { answer: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `shadowlap: ${name} was not sent. It is a write, and it can't be recorded: ${why}. A write is never sent unrecorded under shadowlap, since this may be a replay.` }], isError: true } } };
    }
    if (!this.warned.has(why)) {
      this.warned.add(why);
      this.log?.(`${why}: passing ${effect} tools through unrecorded`);
    }
    return { forward: true };
  }

  /**
   * Records the server's answer to a call sent on; with `cut`, an error for an answer the client got
   * broken off, and with `http`, one for the HTTP answer it got instead of a JSON-RPC message.
   */
  async complete(call: LiveCall, m: JsonRpcMessage, o: { cut?: boolean; http?: HttpAnswer } = {}): Promise<void> {
    if (this.sidecar === null || 'unusable' in this.sidecar) return;
    const latencyMs = Date.now() - call.started;
    const name = o.cut ? CUT_SHORT : o.http ? HTTP_ANSWER : 'JsonRpcError';
    const data = o.http ?? m.error?.data;
    const body = m.error ? { outcome: 'error', error: { name, message: m.error.message, code: String(m.error.code), ...(data !== undefined ? { data } : {}) }, latencyMs } : { outcome: 'ok', result: m.result ?? null, latencyMs };
    try {
      await post(this.sidecar, `/v1/calls/${call.callNo}/complete`, body);
    } catch (err) {
      this.log?.(`could not record the result of ${call.name}: ${messageOf(err)}`);
    }
  }
}

/**
 * A recorded error as the client gets it again: a JSON-RPC error, and with it `cut` where the
 * client's answer was broken off, or `http` where the client got an HTTP answer (HTTP_ANSWER).
 */
function recordedError(id: JsonRpcId, error: SerializedError): { answer: unknown; cut?: true; http?: HttpAnswer } {
  const http = error.name === HTTP_ANSWER ? httpAnswer(error.data) : null;
  if (http) return { answer: { jsonrpc: '2.0', id, error: { code: -32000, message: error.message } }, http };
  return { answer: { jsonrpc: '2.0', id, error: rpcError(error) }, ...(error.name === CUT_SHORT ? { cut: true as const } : {}) };
}

function rpcError(e: SerializedError): JsonRpcError {
  const code = e.code !== undefined ? Number(e.code) : NaN;
  return { code: Number.isFinite(code) ? code : -32000, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) };
}

/**
 * What a proxy records with: a sidecar; null, when nothing says shadowlap is there (the proxy is
 * transparent); or the reason it can't record although it was started under shadowlap (writes are
 * refused, everything else passes unrecorded).
 */
export type ProxySidecar = SidecarTarget | { unusable: string } | null;
