import type { Agent as HttpAgent, ClientRequest, IncomingMessage } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import { sharedStore, useContextStore, type ContextStore, type ContextStoreClass } from './context.js';
import { VERSION } from './version.js';

/**
 * The Shadowlap SDK for TypeScript: an effect-typed tool wrapper, clock/random helpers, and
 * recorded user input.
 * Everything here is a thin client of the sidecar's call resolution API; no hashing or matching
 * logic lives in the SDK. When Shadowlap is not active (no SHADOWLAP_URL), every function is a
 * direct passthrough, so wrapped tools ship to production unchanged.
 *
 * Nothing here loads a Node module until a call goes to the sidecar, so the SDK loads where Node's
 * modules don't exist (an Edge runtime, a browser bundle), and its wrappers just call through there.
 * Under Shadowlap the agent runs on Node, or on a runtime with Node's modules.
 */

export { VERSION } from './version.js';

/** The `x-shadowlap-sdk` header every call to the sidecar carries: which SDK made the call, and its release. */
const SDK_HEADER = `node/${VERSION}`;

export type Effect = 'pure' | 'read' | 'write';

/** Whether a tool's results can carry text an attacker wrote: a web page, an email, a ticket. */
export type Trust = 'trusted' | 'untrusted';

export interface ToolOptions<A, R> {
  /** Required: what the tool does to the world outside its arguments. */
  effect: Effect;
  /** For `write` tools under `--writes stub`: the value returned instead of executing. */
  onFork?: (args: A) => R | Promise<R>;
  /**
   * `untrusted` for a read that brings outside text in (a page, an email, a document): it is
   * recorded on each call, and `shadowlap injection` plants payloads in what it returns. Default
   * `trusted`. It never changes how a call is matched, so marking a tool keeps its recordings.
   */
  trust?: Trust;
  /**
   * The code a replay compares with the recording's to warn that the tool changed (`… changed since
   * the recording`): a function, or its source text. Default: `impl`. Give it when `impl` only calls
   * the real implementation, as the framework adapters' wrappers do.
   */
  source?: ((...args: never[]) => unknown) | string;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  data?: unknown;
  /**
   * The error's own fields that JSON keeps as they are, rebuilt on replay: a file system error's
   * `errno`, `syscall`, `path` and `dest`, an HTTP client error's `status` (Octokit's RequestError,
   * the OpenAI and Anthropic SDKs' APIError). Strings, finite numbers, booleans and null only:
   * nothing nested, which can hold a request and its headers.
   */
  fields?: Record<string, ErrorField>;
  /**
   * The HTTP response an HTTP client's error carries, as Axios's does (`err.response.status`): its
   * `status` and `statusText` alone, never its headers, data or config, rebuilt on replay as a
   * `response` holding just those.
   */
  response?: { status?: number; statusText?: string };
}

/** A value of an error's own field a recording keeps. */
export type ErrorField = string | number | boolean | null;

/** What an error is rebuilt from, or holds of its own: never one of its fields. */
const NOT_FIELDS = new Set(['name', 'message', 'stack', 'code', 'cause', 'data', 'fields', 'response']);

/** Of a response an error carries, its status and status text alone (SerializedError's `response`); null when it holds neither. */
function responseStatus(response: unknown): { status?: number; statusText?: string } | null {
  if (typeof response !== 'object' || response === null) return null;
  let status: unknown;
  let statusText: unknown;
  try {
    ({ status, statusText } = response as { status?: unknown; statusText?: unknown });
  } catch {
    return null; // a getter that throws keeps nothing
  }
  const kept = { ...(typeof status === 'number' && Number.isFinite(status) ? { status } : {}), ...(typeof statusText === 'string' ? { statusText } : {}) };
  return Object.keys(kept).length ? kept : null;
}

const isField = (v: unknown): v is ErrorField => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

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

/**
 * A recorded error, replayed. The original class is not preserved; name, message and code are, its
 * own fields JSON keeps (`errno`, `syscall`, `path`, `status`), and its response's status and status
 * text (Axios's `response.status`). A replayed tool error is an instance of a subclass named after
 * the recorded error, so it reads as that error did: `String(err)`, `util.inspect(err)` and the
 * stack's first line are the same.
 */
export class ReplayedError extends Error {
  readonly code: string | undefined;
  readonly data: unknown;
  constructor(e: SerializedError) {
    super(e.message);
    this.name = e.name;
    this.code = e.code;
    this.data = e.data;
    // Its own fields as the original had them, where they shadow nothing an error has.
    for (const [key, value] of Object.entries(e.fields ?? {})) {
      if (NOT_FIELDS.has(key) || key in this || !isField(value)) continue;
      Object.defineProperty(this, key, { value, enumerable: true, writable: true, configurable: true });
    }
    // The response's status, where the agent reads it (`err.response.status`), and nothing else of it.
    const response = responseStatus(e.response);
    if (response) Object.defineProperty(this, 'response', { value: response, enumerable: true, writable: true, configurable: true });
  }
}

const REPLAYED_CLASSES = new Map<string, typeof ReplayedError>();

/** The replayed error for a recorded one, of the ReplayedError subclass for its name (one per name). */
function replayedError(e: SerializedError): ReplayedError {
  let cls = REPLAYED_CLASSES.get(e.name);
  if (!cls) {
    cls = class extends ReplayedError {};
    Object.defineProperty(cls, 'name', { value: e.name });
    REPLAYED_CLASSES.set(e.name, cls);
  }
  return new cls(e);
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

/** The environment, where there is one: an Edge runtime may have no `process` at all. */
function env(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function config(): Config | null {
  const url = env().SHADOWLAP_URL;
  if (!url) return null;
  return { url: url.replace(/\/$/, ''), runId: env().SHADOWLAP_RUN_ID };
}

export function isActive(): boolean {
  return config() !== null;
}

// One store per process, shared with Shadowlap's capture preload, which may load before this module or
// in another copy of it.
const SCOPES = Symbol.for('shadowlap.scope');
const scopes = () => sharedStore<string>(SCOPES);

/**
 * Runs `fn` as a named branch of the agent, such as one sub-agent of several that run at once. Every
 * call made inside it, however deep in awaited code, carries the scope: model calls, tools and
 * captured HTTP calls. Repeats are counted per scope, so two branches that send the same request at
 * the same time each get their own recorded answer on replay, whatever order they arrive in; and the
 * dashboard groups calls by scope. Scopes nest: `researcher/search`. Outside Shadowlap it just runs `fn`.
 */
export function scope<T>(name: string, fn: () => T): T {
  const parent = currentScope();
  const store = scopes();
  return store ? store.run(parent ? `${parent}/${name}` : name, fn) : fn();
}

/**
 * The scope a process starts in, from `SHADOWLAP_SCOPE`. A scope is normally entered in code, but
 * an agent whose branches are separate processes — a worker pool, a subprocess per sub-agent — has
 * no in-process place to do that, and without a scope those branches can be served each other's
 * recorded answers. Setting the variable when spawning the child names its branch instead; scopes
 * entered inside it nest underneath. Limits match what the sidecar accepts.
 */
function baseScope(): string | undefined {
  const raw = env().SHADOWLAP_SCOPE?.trim();
  if (!raw || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  return raw;
}

/** The scope the caller runs in, if any. */
export function currentScope(): string | undefined {
  return scopes()?.getStore() ?? baseScope();
}

/**
 * A scope as `x-shadowlap-scope` carries it. A header holds Latin-1 at most, and a scope can have any
 * name, so `%` and every character outside printable ASCII is percent-encoded (UTF-8); `/` stays the
 * separator, and an ASCII name without `%` is sent as it is. The sidecar decodes it.
 */
function encodeScope(scope: string): string {
  return scope.replace(/[^\x20-\x24\x26-\x7e]/gu, (c) => {
    try {
      return encodeURIComponent(c);
    } catch {
      return '%EF%BF%BD'; // a lone surrogate: U+FFFD, as a UTF-8 encoder writes it
    }
  });
}

type ResolveResponse =
  | { origin: 'replayed'; callNo: number; outcome: 'ok'; result: unknown }
  | { origin: 'replayed'; callNo: number; outcome: 'error'; error: SerializedError; injected?: InjectedFailure }
  | { origin: 'live'; callNo: number; outcome?: 'ok'; result?: unknown }
  | { origin: 'blocked'; callNo: number; outcome: 'error'; error: SerializedError }
  | { origin: 'stubbed'; callNo: number };

/** Node's modules the calls to the sidecar take, loaded the first time one is made. */
interface NodeModules {
  http: typeof import('node:http');
  https: typeof import('node:https');
  crypto: typeof import('node:crypto');
}

/**
 * Loads a Node module when a call first needs it. The name is held in a variable, and marked for
 * the bundlers that read such marks, so a bundle for an Edge runtime leaves the import alone: it only
 * runs under Shadowlap, which runs the agent on Node.
 */
const load = (name: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ name);

let nodeModules: Promise<NodeModules> | undefined;
function node(): Promise<NodeModules> {
  return (nodeModules ??= Promise.all([load('node:http'), load('node:https'), load('node:crypto')]).then(([http, https, crypto]) => ({
    http: http as NodeModules['http'],
    https: https as NodeModules['https'],
    crypto: crypto as NodeModules['crypto'],
  })));
}

/**
 * Agents of the SDK's own for the sidecar, which is on the machine's loopback and is reached
 * directly, never through a proxy: not with fetch, whose dispatcher an agent may route through one
 * (undici's ProxyAgent set with setGlobalDispatcher ignores NO_PROXY), nor with http.globalAgent,
 * which a proxy package may replace. Kept alive, as fetch keeps them; an idle socket doesn't hold
 * the process open.
 */
const direct: { http?: HttpAgent; https?: HttpsAgent } = {};

/** POSTs to the sidecar and reads the whole answer. A kept-alive socket the sidecar closed while it was idle is retried once on a new one. */
async function send(url: string, headers: Record<string, string>, body: string, retried = false): Promise<{ status: number; text: string }> {
  const { http, https } = await node();
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const agent = secure ? (direct.https ??= new https.Agent({ keepAlive: true })) : (direct.http ??= new http.Agent({ keepAlive: true }));
    const options = { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, agent };
    const answered = (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    };
    const req: ClientRequest = secure ? https.request(target, options, answered) : http.request(target, options, answered);
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (req.reusedSocket && !retried && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) send(url, headers, body, true).then(resolve, reject);
      else reject(err);
    });
    req.end(body);
  });
}

async function post<T>(cfg: Config, path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-shadowlap-sdk': SDK_HEADER };
  if (cfg.runId) headers['x-shadowlap-run'] = cfg.runId;
  const scoped = currentScope();
  if (scoped) headers['x-shadowlap-scope'] = encodeScope(scoped);
  const res = await send(`${cfg.url}${path}`, headers, JSON.stringify(body));
  const text = res.text;
  if (res.status < 200 || res.status >= 300) {
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

/** What the sidecar answers about a tool call: replay it, run it, refuse it (a write after a fork) or stub it. */
export type Resolution = ResolveResponse;

/** How a tool call ended, as an integration records it. */
export type CallEnd = { outcome: 'ok'; result: unknown; latencyMs?: number } | { outcome: 'error'; error: SerializedError; latencyMs?: number };

/** A tool call an integration asks the sidecar about. */
export interface ToolCallRequest {
  name: string;
  effect: Effect;
  /** The call's input, as JSON: what a replay matches it by. */
  args: unknown;
  /** The implementation's hash, for the warning that a tool changed since the recording. */
  implHash?: string;
  trust?: Trust;
}

/**
 * For an integration whose tools run where `tool()` can't wrap them, such as an agent runtime's
 * built-in tools run between two hooks: asks the sidecar what to do about one call, before it runs.
 * Null outside Shadowlap. A `live` or `stubbed` answer is ended with `completeToolCall` once the
 * call has run, or been stubbed; a `replayed` answer carries the recorded result or error, and a
 * `blocked` one the refusal's message.
 */
export async function resolveToolCall(call: ToolCallRequest): Promise<Resolution | null> {
  const cfg = config();
  if (!cfg) return null;
  if (call.effect !== 'pure' && call.effect !== 'read' && call.effect !== 'write') throw new TypeError(`tool ${call.name}: effect must be "pure", "read" or "write"`);
  return post<ResolveResponse>(cfg, '/v1/calls/resolve', {
    kind: 'tool',
    name: call.name,
    effect: call.effect,
    args: call.args ?? null,
    ...(call.implHash ? { implHash: call.implHash } : {}),
    ...(call.trust === 'untrusted' ? { trust: 'untrusted' } : {}),
  });
}

/** A process of the agent's, as a hello names it to the sidecar: its runtime, ids, guard and capture. */
export interface ProcessHello {
  runtime: string;
  runtimeVersion?: string;
  pid: number;
  ppid?: number;
  guard: 'warn' | 'block' | 'off';
  capture: boolean;
  /**
   * For a process with no guard: what it can still connect to that bypasses Shadowlap, a few words
   * each (at most 20 are kept). Empty: nothing, and the run passes `--guard block`. Absent: nobody
   * knows, and it fails.
   */
  reach?: readonly string[];
}

/**
 * Tells the sidecar about a process of the agent's that Shadowlap's preloads can't load into, as
 * they tell it about their own (`POST /v1/hello`): the Claude Code CLI the Claude Agent SDK runs,
 * whose fence says it runs with no guard and what it can still reach, so the run's summary names
 * that and `--guard block` fails the run unless it is nothing. Does nothing outside Shadowlap.
 */
export async function sayHello(hello: ProcessHello): Promise<void> {
  const cfg = config();
  if (!cfg) return;
  await post(cfg, '/v1/hello', { runtimeVersion: '', ppid: 0, ...hello });
}

/** Records how a call `resolveToolCall` answered `live` or `stubbed` ended. Does nothing outside Shadowlap. */
export async function completeToolCall(callNo: number, end: CallEnd): Promise<void> {
  const cfg = config();
  if (!cfg) return;
  await post(cfg, `/v1/calls/${callNo}/complete`, end.outcome === 'ok' ? { outcome: 'ok', result: end.result ?? null, latencyMs: end.latencyMs ?? 0 } : { outcome: 'error', error: end.error, latencyMs: end.latencyMs ?? 0 });
}

/**
 * An error as it is recorded: its name, message and string `code`, its own fields that JSON keeps as
 * they are (SerializedError's `fields`), and the status of the response it carries (`response`), so
 * a replay can hand the agent what it reads off the error: a file system error's `path`, an HTTP
 * client error's `status`, Axios's `response.status`.
 */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') out.code = code;
    const fields: Record<string, ErrorField> = {};
    for (const key of Object.keys(err)) {
      if (NOT_FIELDS.has(key)) continue;
      let value: unknown;
      try {
        value = (err as unknown as Record<string, unknown>)[key];
      } catch {
        continue; // a getter that throws keeps nothing
      }
      if (isField(value)) fields[key] = value;
    }
    if (Object.keys(fields).length) out.fields = fields;
    let response: ReturnType<typeof responseStatus> = null;
    try {
      response = responseStatus((err as { response?: unknown }).response);
    } catch {
      // a getter that throws keeps nothing
    }
    if (response) out.response = response;
    return out;
  }
  return { name: 'Error', message: String(err) };
}

const isAsyncGeneratorFunction = (fn: unknown): boolean => Object.prototype.toString.call(fn) === '[object AsyncGeneratorFunction]';
const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
const isThenable = (v: unknown): v is PromiseLike<unknown> => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';

async function lastOf(stream: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown = null;
  for await (const value of stream) last = value;
  return last;
}

/**
 * How a streaming tool's call is recorded: every value it handed the caller, in order, under a key no
 * tool's own result has, with what the generator returned as `returned` and `closed` when the caller
 * stopped reading before the stream ended. The Python SDK records its streams the same way.
 */
const STREAM = 'shadowlap_stream';
/** The argument that makes a stream's reading on past a recording a call of its own: the values the replay already handed the caller. */
const STREAM_AFTER = 'shadowlap_stream_after';

/** A streaming call's recorded values, return value, and whether its caller closed it early; null for a result recorded as one value, which a replay yields alone. */
function recordedStream(result: unknown): { items: unknown[]; returned: unknown; closed: boolean } | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r[STREAM]) || Object.keys(r).some((k) => k !== STREAM && k !== 'returned' && k !== 'closed')) return null;
  return { items: r[STREAM] as unknown[], returned: r.returned ?? null, closed: r.closed === true };
}

/** The values a streaming call handed its caller before it failed, as its error keeps them. */
function streamedOf(error: unknown): unknown[] {
  const values = typeof error === 'object' && error !== null ? (error as { streamed?: unknown }).streamed : undefined;
  return Array.isArray(values) ? values : [];
}

/**
 * A streaming tool's live call: each value is pulled from the tool when the caller asks for the
 * next, so the tool runs at the caller's pace, as it does outside Shadowlap. Every value is
 * recorded, in order, once the stream ends, with what the generator returned. A caller that stops
 * early (a break, an aborted AI SDK stream) stops the tool too, through its return(), and what it was
 * handed is recorded closed, so a replay that reads on knows the recording ends there; an error the
 * caller throws in is handed to the tool, as yield* does. A failure of the tool is recorded as its
 * error, with the values that came before it.
 */
async function* liveStream(cfg: Config, callNo: number, iterator: AsyncGenerator<unknown, unknown, undefined>): AsyncGenerator<unknown, void, undefined> {
  const started = Date.now();
  const complete = (body: object) => post(cfg, `/v1/calls/${callNo}/complete`, { ...body, latencyMs: Date.now() - started });
  const items: unknown[] = [];
  let completed = false;
  const fail = async (err: unknown): Promise<never> => {
    completed = true;
    await complete({ outcome: 'error', error: { ...serializeError(err), ...(items.length ? { streamed: items } : {}) } });
    throw err;
  };
  const succeed = async (returned: unknown, closed: boolean) => {
    completed = true;
    try {
      await complete({ outcome: 'ok', result: { [STREAM]: items, ...(returned !== undefined && returned !== null ? { returned } : {}), ...(closed ? { closed: true } : {}) } });
    } catch (err) {
      // A result the sidecar can't take (not JSON) still completes the call, as an error.
      await complete({ outcome: 'error', error: serializeError(err) });
      throw err;
    }
  };
  const advance = async (step: () => Promise<IteratorResult<unknown, unknown>>) => {
    try {
      return await step();
    } catch (err) {
      return fail(err);
    }
  };
  try {
    let step = await advance(() => iterator.next());
    while (!step.done) {
      items.push(step.value);
      let thrown: { error: unknown } | null = null;
      try {
        yield step.value;
      } catch (error) {
        thrown = { error };
      }
      step = await advance(() => (thrown ? iterator.throw(thrown.error) : iterator.next()));
    }
    await succeed(step.value, false);
  } finally {
    if (!completed) {
      // The caller stopped reading: stop the tool as well, and record what the caller saw, closed.
      await advance(() => iterator.return(undefined));
      await succeed(undefined, true);
    }
  }
}

/**
 * Wraps a tool implementation. The returned function has the same signature; results and errors
 * must be JSON-serializable. `effect` is required by design: the only safe default would be
 * `write`, and making that implicit would hide a decision the developer must make.
 *
 * An async generator function (`async function*`, the AI SDK's streaming `async *execute`) stays
 * one: what it yields is passed on as the caller reads it, every value is recorded, and a replay
 * yields them again, in order (see liveStream); one that reads past what a closed recording holds
 * forks there, as a call of its own. Outside Shadowlap every call goes straight to `impl`, and its
 * stream or promise comes back as `impl` made it.
 *
 * An implementation that only throws returns `never`, which every overload would take: the first
 * one is for it, as its calls return a promise (of a fork's stub, when `onFork` gives one).
 */
export function tool<A, R = never>(name: string, options: ToolOptions<A, R>, impl: (args: A) => never): (args: A) => Promise<R>;
export function tool<A, Y>(name: string, options: ToolOptions<A, Y>, impl: (args: A) => AsyncGenerator<Y, unknown, undefined>): (args: A) => AsyncGenerator<Y, void, undefined>;
export function tool<A, R>(name: string, options: ToolOptions<A, R>, impl: (args: A) => R | Promise<R>): (args: A) => Promise<R>;
export function tool<A, R>(name: string, options: ToolOptions<A, R>, impl: (args: A) => unknown): (args: A) => unknown {
  if (!name) throw new TypeError('tool name is required');
  if (options.effect !== 'pure' && options.effect !== 'read' && options.effect !== 'write') {
    throw new TypeError(`tool ${name}: effect must be "pure", "read" or "write"`);
  }
  if (options.trust !== undefined && options.trust !== 'trusted' && options.trust !== 'untrusted') {
    throw new TypeError(`tool ${name}: trust must be "trusted" or "untrusted"`);
  }
  // Hashed the first time the tool is called under Shadowlap, which is when Node's crypto is at hand.
  let implHash: string | undefined;
  const hashed = async () => (implHash ??= (await node()).crypto.createHash('sha256').update(String(options.source ?? impl)).digest('hex'));
  // What the sidecar is asked for every call: `trust` only when the tool brings outside text in.
  const resolveBody = async (args: A) => ({ kind: 'tool', name, effect: options.effect, args, implHash: await hashed(), ...(options.trust === 'untrusted' ? { trust: 'untrusted' } : {}) });

  /** One call under Shadowlap; `run` executes the implementation and gives the result to record. */
  async function call(cfg: Config, args: A, run: (args: A) => Promise<unknown>, decided?: ResolveResponse): Promise<{ value: unknown; ran: boolean }> {
    const r = decided ?? (await post<ResolveResponse>(cfg, '/v1/calls/resolve', await resolveBody(args)));
    switch (r.origin) {
      case 'replayed':
        if (r.outcome === 'ok') return { value: r.result, ran: false };
        if (r.injected) throw new ShadowlapInjectedFailure(name, args, r.injected, r.error);
        throw replayedError(r.error);
      case 'blocked':
        throw new ShadowlapWriteBlocked(name, args, r.error.message);
      case 'stubbed': {
        // What is recorded is what the agent gets: null without a stub, as a replay of this call
        // returns it (JSON has no undefined), so a run with stubbed writes replays as it went.
        const stub = (options.onFork ? await options.onFork(args) : null) ?? null;
        await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result: stub, latencyMs: 0 });
        return { value: stub, ran: false };
      }
      case 'live': {
        const started = Date.now();
        try {
          const result = await run(args);
          await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result: result ?? null, latencyMs: Date.now() - started });
          return { value: result, ran: true };
        } catch (err) {
          await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'error', error: serializeError(err), latencyMs: Date.now() - started });
          throw err;
        }
      }
      default:
        // Never guess: running the tool on an answer this SDK doesn't know could repeat a side effect.
        throw new Error(`shadowlap sidecar answered ${name} with an unknown origin "${String((r as { origin?: unknown }).origin)}"; update @shadowlap/sdk`);
    }
  }

  if (isAsyncGeneratorFunction(impl)) {
    const stream = impl as (args: A) => AsyncGenerator<unknown, unknown, undefined>;
    return async function* (args: A): AsyncGenerator<unknown, void, undefined> {
      const cfg = config();
      if (!cfg) {
        yield* stream(args);
        return;
      }
      let asked: unknown = args;
      let after = 0;
      let r = await post<ResolveResponse>(cfg, '/v1/calls/resolve', await resolveBody(asked as A));
      while (r.origin === 'replayed') {
        // The implementation doesn't run: the recorded values are the stream, in order, and a
        // failure comes after the values it followed.
        if (r.outcome !== 'ok') {
          if (!r.injected) yield* streamedOf(r.error);
          await call(cfg, asked as A, () => Promise.resolve(null), r);
          return;
        }
        const recorded = recordedStream(r.result);
        if (!recorded) {
          yield r.result;
          return;
        }
        yield* recorded.items;
        if (!recorded.closed) return;
        // The caller closed it there when it was recorded, and reads on now: past the recording, a
        // call of its own that no recording holds, so the replay forks here.
        after += recorded.items.length;
        asked = typeof args === 'object' && args !== null && !Array.isArray(args) ? { ...args, [STREAM_AFTER]: after } : { args, [STREAM_AFTER]: after };
        r = await post<ResolveResponse>(cfg, '/v1/calls/resolve', await resolveBody(asked as A));
      }
      if (r.origin !== 'live') {
        // Blocked or stubbed: the implementation doesn't run; a stub is the stream.
        yield (await call(cfg, args, () => Promise.resolve(null), r)).value;
        return;
      }
      // Live from the start, past the values the recording already handed the caller.
      const iterator = stream(args);
      for (let i = 0; i < after; i++) {
        let skipped: IteratorResult<unknown, unknown>;
        try {
          skipped = await iterator.next();
        } catch (err) {
          await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'error', error: serializeError(err), latencyMs: 0 });
          throw err;
        }
        if (skipped.done) {
          await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result: { [STREAM]: [] }, latencyMs: 0 });
          return;
        }
      }
      yield* liveStream(cfg, r.callNo, iterator);
    };
  }

  return (args: A): Promise<R> => {
    const cfg = config();
    if (!cfg) {
      // A direct passthrough: a stream impl returns (an async iterable) comes back as it is, where
      // a promise around it would hide it from a framework that looks for one.
      try {
        const out = impl(args);
        return (isAsyncIterable(out) && !isThenable(out) ? out : Promise.resolve(out)) as Promise<R>;
      } catch (err) {
        return Promise.reject(err);
      }
    }
    // A stream from a function that isn't a generator is only seen once it is returned, after the
    // caller already has this promise: it is read to its end, and its last value is the result.
    return call(cfg, args, async (a) => {
      const out = await impl(a);
      return isAsyncIterable(out) ? lastOf(out) : out;
    }).then(({ value }) => value as R);
  };
}

// While the SDK reads an answer for userInput(), Shadowlap's readline preload leaves that read
// alone, so an answer typed at the terminal is recorded once. Shared through a global symbol, as the
// scope store is.
const DIRECT_INPUT = Symbol.for('shadowlap.input.direct');
async function directInput(): Promise<ContextStore<boolean>> {
  const store = sharedStore<boolean>(DIRECT_INPUT);
  if (store) return store;
  // A Node before 20.16 without the Node entry point: the class comes with an import, once.
  useContextStore(((await load('node:async_hooks')) as { AsyncLocalStorage: ContextStoreClass }).AsyncLocalStorage);
  return sharedStore<boolean>(DIRECT_INPUT)!;
}

/** The text of a recorded answer: `{ text }`, or a bare string from an override. */
function answerText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && result !== null && typeof (result as { text?: unknown }).text === 'string') return (result as { text: string }).text;
  return result === null || result === undefined ? '' : JSON.stringify(result);
}

/**
 * Asks the person running the agent, and records the answer as a `user_input` call (effect read,
 * the prompt as its argument, `{ text }` as its result). A replay serves the answer from the
 * recording, and after a fork the recorded answers are served in order, so `shadowlap test`,
 * `blame` and `verify` run the agent with no one there to type. `read` gets the answer however the
 * agent does — a chat window, a message from a queue, the terminal — and returns its text.
 *
 * What an agent reads through Node's readline (`rl.question()`, `for await (const line of rl)`) is
 * recorded without this, by the preload `shadowlap run` adds. Outside Shadowlap this calls `read`.
 */
export async function userInput(prompt: string, read: (prompt: string) => string | Promise<string>): Promise<string> {
  const cfg = config();
  if (!cfg) return read(prompt);
  const r = await post<ResolveResponse>(cfg, '/v1/calls/resolve', { kind: 'tool', name: 'user_input', effect: 'read', args: { prompt }, input: true });
  if (r.origin === 'replayed') {
    if (r.outcome === 'ok') return answerText(r.result);
    throw replayedError(r.error);
  }
  if (r.origin !== 'live') throw new Error(`unexpected origin ${r.origin} for user input`);
  const started = Date.now();
  try {
    const direct = await directInput();
    const text = await direct.run(true, () => read(prompt));
    await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result: { text }, latencyMs: Date.now() - started });
    return text;
  } catch (err) {
    await post(cfg, `/v1/calls/${r.callNo}/complete`, { outcome: 'error', error: serializeError(err), latencyMs: Date.now() - started });
    throw err;
  }
}

async function misc<T>(kind: 'clock' | 'random', name: string, label: string | undefined, fallback: () => T | Promise<T>): Promise<T> {
  const cfg = config();
  if (!cfg) return fallback();
  const r = await post<ResolveResponse>(cfg, '/v1/calls/resolve', { kind, name, label: label ?? '' });
  if (r.origin === 'replayed' || r.origin === 'live') {
    if ('outcome' in r && r.outcome === 'error') throw replayedError(r.error);
    return r.result as T;
  }
  throw new Error(`unexpected origin ${r.origin} for ${kind}`);
}

/** Current time in ms since the epoch; recorded, so a replay sees the recorded value. `label` disambiguates concurrent reads. */
export const now = (label?: string): Promise<number> => misc('clock', 'now', label, () => Date.now());
/** A number in [0, 1), recorded. */
export const random = (label?: string): Promise<number> => misc('random', 'random', label, () => Math.random());
/** A UUID v4, recorded. */
export const uuid = (label?: string): Promise<string> => misc('random', 'uuid', label, randomUUID);

/** A UUID v4 from the Web Crypto API where the runtime has it (Node 19 and later, Edge runtimes), else from Node's crypto (Node 18). */
async function randomUUID(): Promise<string> {
  const web = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof web?.randomUUID === 'function') return web.randomUUID();
  return ((await load('node:crypto')) as typeof import('node:crypto')).randomUUID();
}
