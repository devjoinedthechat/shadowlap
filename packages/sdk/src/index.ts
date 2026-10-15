import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/**
 * The Shadowlap SDK for TypeScript: an effect-typed tool wrapper and clock/random helpers.
 * Everything here is a thin client of the sidecar's call resolution API; no hashing or matching
 * logic lives in the SDK. When Shadowlap is not active (no SHADOWLAP_URL), every function is a
 * direct passthrough, so wrapped tools ship to production unchanged.
 */

export type Effect = 'pure' | 'read' | 'write';

export interface ToolOptions<A, R> {
  /** Required: what the tool does to the world outside its arguments. */
  effect: Effect;
  /** For `write` tools under `--writes stub`: the value returned instead of executing. */
  onFork?: (args: A) => R | Promise<R>;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  data?: unknown;
}

/** Thrown into the agent when a `write` tool is reached after divergence under the default `--writes block`. */
export class ShadowlapWriteBlocked extends Error {
  override readonly name = 'ShadowlapWriteBlocked';
  constructor(
    readonly tool: string,
    readonly args: unknown,
    message?: string,
  ) {
    super(message ?? `write tool ${tool} blocked after divergence`);
  }
}

/** A recorded error, replayed. The original class is not preserved; name, message and code are. */
export class ReplayedError extends Error {
  readonly code: string | undefined;
  readonly data: unknown;
  constructor(e: SerializedError) {
    super(e.message);
    this.name = e.name;
    this.code = e.code;
    this.data = e.data;
  }
}

/** How `shadowlap replay --fail-at <call>=timeout|error[:message]|<status>` fails a tool call. */
export type InjectedFailure = { kind: 'timeout' } | { kind: 'error'; message?: string } | { kind: 'status'; status: number };

/**
 * Thrown instead of running a tool that `shadowlap replay --fail-at` fails: the tool does not run,
 * and the agent's error path does. It looks like the failure it stands for, because the agent's
 * handling is what is being tested: a timeout is named `TimeoutError` with code `ETIMEDOUT`, an HTTP
 * failure carries `status` (and `statusCode`), an error carries the message given. `injected` is
 * always true, for code (and tests) that need to tell it from a real one.
 */
export class ShadowlapInjectedFailure extends Error {
  readonly injected = true;
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly statusCode: number | undefined;
  constructor(
    readonly tool: string,
    readonly args: unknown,
    readonly failure: InjectedFailure,
    error: SerializedError,
  ) {
    super(error.message);
    this.name = error.name;
    this.code = error.code;
    this.status = failure.kind === 'status' ? failure.status : undefined;
    this.statusCode = this.status;
  }
}

interface Config {
  url: string;
  runId: string | undefined;
}

function config(): Config | null {
  const url = process.env.SHADOWLAP_URL;
  if (!url) return null;
  return { url: url.replace(/\/$/, ''), runId: process.env.SHADOWLAP_RUN_ID };
}

export function isActive(): boolean {
  return config() !== null;
}

// One store per process, shared with Shadowlap's capture preload, which may load before this module or
// in another copy of it.
const SCOPES = Symbol.for('shadowlap.scope');
function scopes(): AsyncLocalStorage<string> {
  const g = globalThis as { [SCOPES]?: AsyncLocalStorage<string> };
  return (g[SCOPES] ??= new AsyncLocalStorage<string>());
}

/**
 * Runs `fn` as a named branch of the agent, such as one sub-agent of several that run at once. Every
 * call made inside it, however deep in awaited code, carries the scope: model calls, tools and
 * captured HTTP calls. Repeats are counted per scope, so two branches that send the same request at
 * the same time each get their own recorded answer on replay, whatever order they arrive in; and the
 * dashboard groups calls by scope. Scopes nest: `researcher/search`. Outside Shadowlap it just runs `fn`.
 */
export function scope<T>(name: string, fn: () => T): T {
  const parent = currentScope();
  return scopes().run(parent ? `${parent}/${name}` : name, fn);
}

/**
 * The scope a process starts in, from `SHADOWLAP_SCOPE`. A scope is normally entered in code, but
 * an agent whose branches are separate processes — a worker pool, a subprocess per sub-agent — has
 * no in-process place to do that, and without a scope those branches can be served each other's
 * recorded answers. Setting the variable when spawning the child names its branch instead; scopes
 * entered inside it nest underneath. Limits match what the sidecar accepts.
 */
function baseScope(): string | undefined {
  const raw = process.env.SHADOWLAP_SCOPE?.trim();
  if (!raw || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  return raw;
}

/** The scope the caller runs in, if any. */
export function currentScope(): string | undefined {
  return scopes().getStore() ?? baseScope();
}

type ResolveResponse =
  | { origin: 'replayed'; callNo: number; outcome: 'ok'; result: unknown }
  | { origin: 'replayed'; callNo: number; outcome: 'error'; error: SerializedError; injected?: InjectedFailure }
  | { origin: 'live'; callNo: number; outcome?: 'ok'; result?: unknown }
  | { origin: 'blocked'; callNo: number; outcome: 'error'; error: SerializedError }
  | { origin: 'stubbed'; callNo: number };

async function post<T>(cfg: Config, path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.runId) headers['x-shadowlap-run'] = cfg.runId;
  const scoped = currentScope();
  if (scoped) headers['x-shadowlap-scope'] = scoped;
  const res = await fetch(`${cfg.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      // keep raw text
    }
    throw new Error(`shadowlap sidecar ${path} failed (${res.status}): ${message}`);
  }
  return JSON.parse(text) as T;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') out.code = code;
    return out;
  }
  return { name: 'Error', message: String(err) };
}

/**
 * Wraps a tool implementation. The returned function has the same signature; results and errors
 * must be JSON-serializable. `effect` is required by design: the only safe default would be
 * `write`, and making that implicit would hide a decision the developer must make.
 */
export function tool<A, R>(name: string, options: ToolOptions<A, R>, impl: (args: A) => R | Promise<R>): (args: A) => Promise<R> {
  if (!name) throw new TypeError('tool name is required');
  if (options.effect !== 'pure' && options.effect !== 'read' && options.effect !== 'write') {
    throw new TypeError(`tool ${name}: effect must be "pure", "read" or "write"`);
  }
  const implHash = createHash('sha256').update(String(impl)).digest('hex');

  return async (args: A): Promise<R> => {
    const cfg = config();
    if (!cfg) return impl(args);

    const r = await post<ResolveResponse>(cfg, '/v1/calls/resolve', { kind: 'tool', name, effect: options.effect, args, implHash });
    switch (r.origin) {
      case 'replayed':
        if (r.outcome === 'ok') return r.result as R;
        if (r.injected) throw new ShadowlapInjectedFailure(name, args, r.injected, r.error);
        throw new ReplayedError(r.error);
      case 'blocked':
        throw new ShadowlapWriteBlocked(name, args, r.error.message);
      case 'stubbed': {
        const stub = options.onFork ? await options.onFork(args) : (undefined as R);
        await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result: stub ?? null, latencyMs: 0 });
        return stub;
      }
      case 'live': {
        const started = Date.now();
        try {
          const result = await impl(args);
          await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result: result ?? null, latencyMs: Date.now() - started });
          return result;
        } catch (err) {
          await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'error', error: serializeError(err), latencyMs: Date.now() - started });
          throw err;
        }
      }
      default:
        // Never guess: running the tool on an answer this SDK doesn't know could repeat a side effect.
        throw new Error(`shadowlap sidecar answered ${name} with an unknown origin "${String((r as { origin?: unknown }).origin)}"; update @shadowlap/sdk`);
    }
  };
}

async function misc<T>(kind: 'clock' | 'random', name: string, label: string | undefined, fallback: () => T): Promise<T> {
  const cfg = config();
  if (!cfg) return fallback();
  const r = await post<ResolveResponse>(cfg, '/v1/calls/resolve', { kind, name, label: label ?? '' });
  if (r.origin === 'replayed' || r.origin === 'live') {
    if ('outcome' in r && r.outcome === 'error') throw new ReplayedError(r.error);
    return r.result as T;
  }
  throw new Error(`unexpected origin ${r.origin} for ${kind}`);
}

/** Current time in ms since the epoch; recorded, so a replay sees the recorded value. `label` disambiguates concurrent reads. */
export const now = (label?: string): Promise<number> => misc('clock', 'now', label, () => Date.now());
/** A number in [0, 1), recorded. */
export const random = (label?: string): Promise<number> => misc('random', 'random', label, () => Math.random());
/** A UUID v4, recorded. */
export const uuid = (label?: string): Promise<string> => misc('random', 'uuid', label, () => globalThis.crypto.randomUUID());
