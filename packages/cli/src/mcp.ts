import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Effect, SerializedError } from '@shadowlap/engine';

/**
 * `shadowlap mcp -- <server>`: a stdio proxy in front of an MCP server. The agent's MCP client
 * talks to the proxy exactly as it would to the server. `tools/call` requests go through the
 * sidecar like SDK tool calls (recorded, replayed, blocked or stubbed); every other message passes
 * through untouched. Effects come from the server's tool annotations (`readOnlyHint` → read,
 * otherwise write), overridden by `--effect name=read` or the `mcp.effects` config.
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

export function startMcpProxy(o: McpProxyOptions): { child: ChildProcess; done: Promise<number> } {
  const child = spawn(o.server.command, o.server.args, { stdio: ['pipe', 'pipe', 'inherit'], env: o.server.env ?? process.env });
  const pending = new Map<string, { method: string; started: number; callNo?: number; name?: string }>();
  const tools = new Map<string, { effect: Effect; implHash: string }>();
  let sidecar = o.sidecar;
  const toServer = (raw: string) => {
    child.stdin.write(raw + '\n');
  };
  const toClient = (raw: string) => {
    o.clientOut.write(raw + '\n');
  };
  const send = (write: (raw: string) => void, msg: unknown) => write(JSON.stringify(msg));
  const rpcError = (e: SerializedError): JsonRpcError => {
    const code = e.code !== undefined ? Number(e.code) : NaN;
    return { code: Number.isFinite(code) ? code : -32000, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) };
  };
  const errorResult = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

  // Client → server. tools/call is resolved through the sidecar; everything else passes through.
  lines(
    o.clientIn,
    async (msg, raw) => {
      const m = isObject(msg) ? (msg as JsonRpcMessage) : null;
      if (!m || m.id === undefined || m.id === null || typeof m.method !== 'string') return toServer(raw);
      if (m.method !== 'tools/call' || !sidecar) {
        pending.set(idKey(m.id), { method: m.method, started: Date.now() });
        return toServer(raw);
      }
      const name = typeof m.params?.name === 'string' ? m.params.name : '';
      const args = m.params?.arguments ?? {};
      const known = tools.get(name);
      const effect: Effect = o.effects?.[name] ?? known?.effect ?? 'write';
      let r: ResolveResponse;
      try {
        r = await post<ResolveResponse>(sidecar, '/v1/calls/resolve', { kind: 'tool', name, effect, args, ...(known ? { implHash: known.implHash } : {}) });
      } catch (err) {
        o.log?.(`sidecar unreachable, passing tools/call through unrecorded: ${err instanceof Error ? err.message : String(err)}`);
        sidecar = null;
        pending.set(idKey(m.id), { method: m.method, started: Date.now() });
        return toServer(raw);
      }
      switch (r.origin) {
        case 'replayed':
          // A tool failed with --fail-at answers as an MCP server does when a tool's handler fails: a
          // result with isError, which the client hands to the model. A recorded error stays as recorded.
          if (r.outcome === 'error' && r.injected) return send(toClient, { jsonrpc: '2.0', id: m.id, result: errorResult(r.error.message) });
          return send(toClient, r.outcome === 'ok' ? { jsonrpc: '2.0', id: m.id, result: r.result } : { jsonrpc: '2.0', id: m.id, error: rpcError(r.error) });
        case 'blocked':
          // The model sees the refusal as a tool error and can carry on, as an SDK agent would after ShadowlapWriteBlocked.
          return send(toClient, { jsonrpc: '2.0', id: m.id, result: errorResult(r.error.message) });
        case 'stubbed': {
          const result = { content: [{ type: 'text', text: `${name} was not executed: write tools are stubbed after the fork (shadowlap replay --writes stub).` }], isError: false };
          await post(sidecar, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result, latencyMs: 0 });
          return send(toClient, { jsonrpc: '2.0', id: m.id, result });
        }
        case 'live':
          pending.set(idKey(m.id), { method: m.method, started: Date.now(), callNo: r.callNo, name });
          return toServer(raw);
      }
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
      if (p.method === 'tools/list' && isObject(m.result) && Array.isArray(m.result.tools)) {
        for (const t of m.result.tools as McpTool[]) {
          if (isObject(t) && typeof t.name === 'string') tools.set(t.name, { effect: effectFromAnnotations(t.annotations), implHash: createHash('sha256').update(JSON.stringify(t.inputSchema ?? null)).digest('hex') });
        }
      }
      if (p.callNo !== undefined && sidecar) {
        const latencyMs = Date.now() - p.started;
        const body = m.error
          ? { outcome: 'error', error: { name: 'JsonRpcError', message: m.error.message, code: String(m.error.code), ...(m.error.data !== undefined ? { data: m.error.data } : {}) }, latencyMs }
          : { outcome: 'ok', result: m.result ?? null, latencyMs };
        try {
          await post(sidecar, `/v1/calls/${p.callNo}/complete`, body);
        } catch (err) {
          o.log?.(`could not record the result of ${p.name ?? 'a tool call'}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
