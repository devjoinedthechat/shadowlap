import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectHttp2, createServer as createHttp2Server, type ClientHttp2Session, type Http2Server, type ServerHttp2Session } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { PassThrough, pipeline, Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import {
  Session,
  apiCallName,
  fingerprintApi,
  fingerprintMisc,
  fingerprintTool,
  loadApiRequest,
  storeApiRequest,
  normalizersHash,
  storedModelResolver,
  summarizeRun,
  type CallKind,
  type CallRecord,
  type ClockMode,
  type CallStartRow,
  type Decision,
  type Effect,
  type Normalizer,
  type Origin,
  type ReplayOptions,
  type RunCommand,
  type RunMode,
  type RunRecord,
  type RunStatus,
  type Price,
  type RunSummary,
  type SerializedError,
  type Store,
} from '@shadowlap/engine';
// The run page: a replay's flags and the guard's hosts, kept on the run (engine run-facts.ts).
import { describeInterventions, recordNotRecorded } from '@shadowlap/engine';
import { decodeBody, encodeBody, keptResponseHeaders, matchHttpRule, type HttpResult, type HttpRule } from './http.js';
import { providers as defaultProviders, type Provider } from './providers.js';
import { SseTimer } from './sse.js';

export interface SidecarOptions {
  store: Store;
  host?: string;
  port?: number;
  providers?: Provider[];
  normalizers?: Normalizer[];
  /** Per-provider upstream overrides, e.g. `{ anthropic: 'http://127.0.0.1:9999' }` for a mock. */
  upstreams?: Record<string, string>;
  /** Cost estimates in summaries: USD per million tokens by model prefix, on top of the built-in table. */
  prices?: Record<string, Price>;
  /** `auto` (default): dates and timestamps near each run's start match whatever day the run happens on. `exact`: they must be equal. */
  clock?: ClockMode;
  /** HTTP hosts recorded as tools (see http.ts). The sidecar forwards captured HTTP calls only to these. */
  http?: HttpRule[];
  log?: (line: string) => void;
  /**
   * More routes under `/v1/`, behind the same session token: a host that manages runs for other
   * processes (the test-suite recordings API) adds its endpoints here. Return undefined to fall
   * through to "unknown route".
   */
  api?: (route: ApiRoute) => Promise<{ status: number; body: unknown } | undefined>;
}

export interface ApiRoute {
  method: string;
  /** The path after the token, e.g. `v1/recordings/start`. */
  path: string;
  body: () => Promise<unknown>;
}

/**
 * Request-level interventions for a replay. Both are append-only with respect to the conversation
 * prefix thinking blocks are bound to: an injected instruction is appended at call `atCall` and
 * re-inserted at that same position in every later request; parameter patches touch fields
 * outside `system` / `tools` / `messages`, which are not bound.
 */
export interface Interventions {
  inject?: {
    /** The parent run's call number of the model call to inject before. */
    atCall: number;
    text: string;
    /** `system`: a `role: "system"` message (Opus 5, Opus 4.8, Fable 5.x). `user`: a text block appended to the last user message. */
    as: 'system' | 'user';
  };
  set?: {
    /** The parent run's call number of the first model call to patch. */
    fromCall: number;
    /** Top-level request fields to set, e.g. `{ model: "claude-opus-5", max_tokens: 2048 }`. */
    fields: Record<string, unknown>;
  };
}

export interface StartRunInput {
  mode: RunMode;
  parentRunId?: string;
  command: RunCommand;
  codeVersion?: string | null;
  replay?: Partial<ReplayOptions>;
  interventions?: Interventions;
  /** The command being run came from an imported pack (recorded on the run so later replays ask again). */
  commandFromImport?: boolean;
  /**
   * A stable name the run's traffic arrives under, as `/s/<slot>/…` in the base URLs from
   * `envForSlot`. A test worker creates its model clients once, and each test's run takes the slot
   * over in turn.
   */
  slot?: string;
  /** Never call a provider: a call that isn't served from the recording fails, as in `shadowlap test`. */
  offline?: boolean;
}

export interface EndRunResult {
  run: RunRecord;
  summary: RunSummary;
  /** Provider ids that received model calls during the run. */
  providers: string[];
  /** SDK languages seen on the call resolution API, from their user agents: typescript | python | other. */
  sdks: string[];
  /** Outbound connections the network guard saw bypassing Shadowlap, by host:port. */
  unguarded: Array<{ target: string; count: number; action: 'warned' | 'blocked' }>;
}

interface CallIdentity {
  kind: CallKind;
  name: string;
  fingerprint: string;
  occurrence: number;
}

interface TrackedCall {
  identity: CallIdentity;
  effect: Effect | null;
  origin: Origin;
  decision: Decision;
  /** Number of end rows written so far. */
  ends: number;
  /** Whether the latest end row is a retryable failure, making the next identical request a retry. */
  retryable: boolean;
  /** Set once the final end row is written (tool calls await `complete`). */
  done: boolean;
}

interface ActiveInterventions {
  /** 0-based index of the model call to inject before, and the injection. */
  inject?: { apiIndex: number; text: string; as: 'system' | 'user' };
  /** 0-based index of the first model call to patch. */
  set?: { apiIndex: number; fields: Record<string, unknown> };
  /** Where the injection landed: the message index to re-insert at (system) or to extend (user). */
  injectedAt?: number;
}

class RunContext {
  nextCallNo = 1;
  apiCalls = 0;
  readonly calls = new Map<number, TrackedCall>();
  readonly lastByFingerprint = new Map<string, number>();
  readonly warnings: string[] = [];
  readonly providersUsed = new Set<string>();
  readonly sdksSeen = new Set<string>();
  readonly unguarded = new Map<string, { count: number; action: 'warned' | 'blocked' }>();
  private readonly warnedTools = new Set<string>();

  constructor(
    readonly run: RunRecord,
    readonly session: Session,
    readonly interventions: ActiveInterventions,
    /** The sidecar's normalizers plus the rules that redacted the parent, if any. */
    readonly normalizers: Normalizer[],
    readonly offline = false,
    readonly slot: string | null = null,
    /** The reference time dates are masked against, or undefined to match them exactly. */
    readonly clockRef: number | undefined = undefined,
    /** `--prompt-from`: model calls are matched without their system prompt and tool definitions. */
    readonly withoutPrompt = false,
  ) {}

  warnOnce(tool: string, message: string): void {
    if (this.warnedTools.has(tool)) return;
    this.warnedTools.add(tool);
    this.warnings.push(message);
  }
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const RESPONSE_DROP = new Set([...HOP_BY_HOP, 'content-encoding', 'content-length']);

/**
 * A request to an upstream over HTTP/1.1, with no time limit of its own. fetch() gives up on a
 * response whose headers take more than five minutes, and so does its body between two chunks: a
 * non-streaming request to a slow model does both, a local model writing a long answer or a
 * reasoning model at high effort. A proxy in the request path must not end a call sooner than its
 * client would; the client's own timeout still governs its request to Shadowlap. A compressed body
 * is decoded, as fetch did: the headers passed on say nothing of its encoding.
 */
export function requestUpstream(url: string, method: string, headers: Record<string, string>, body: Buffer | null): Promise<Response> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(target, { method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) } }, (res) => {
      const status = res.statusCode ?? 502;
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : v);
      if (method === 'HEAD' || status === 204 || status === 304) {
        res.resume();
        return resolve(new Response(null, { status, headers: out }));
      }
      const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
      const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : new PassThrough();
      // An error on either side ends the stream with it, so a reader sees a broken body as one.
      pipeline(res, decoder, () => {});
      resolve(new Response(Readable.toWeb(decoder) as ReadableStream<Uint8Array>, { status, headers: out }));
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The sidecar: a loopback HTTP server that proxies model APIs with record/replay,
 * and resolves tool, clock and random calls for the SDKs. One instance serves one session; a session
 * has one active run at a time, and a request may pin another with `x-shadowlap-run`.
 */
export class Sidecar {
  readonly url: string;
  readonly token: string;
  private readonly server: Server;
  private readonly store: Store;
  private readonly providers: Map<string, Provider>;
  private readonly normalizers: Normalizer[];
  private readonly upstreams: Record<string, string>;
  private readonly prices: Record<string, Price> | undefined;
  private readonly clock: ClockMode;
  /** HTTP hosts recorded as tools. */
  readonly httpRules: readonly HttpRule[];
  private readonly log: (line: string) => void;
  private readonly runs = new Map<string, RunContext>();
  private activeRunId: string | null = null;
  /** The run each slot's traffic belongs to. */
  private readonly slots = new Map<string, string>();
  private readonly api: SidecarOptions['api'];

  /**
   * The same API over cleartext HTTP/2, for clients that only speak HTTP/2: the AWS SDK's Bedrock
   * runtime client opens every connection with http2.connect. In-process capture redirects those here.
   */
  readonly http2Url: string;
  private readonly http2Server: Http2Server;
  private readonly http2Sessions = new Set<ServerHttp2Session>();
  /** Upstream HTTP/2 connections, one per origin, for requests that arrived over HTTP/2. */
  private readonly upstreamHttp2 = new Map<string, ClientHttp2Session>();

  private constructor(opts: SidecarOptions, server: Server, url: string, token: string, http2Server: Http2Server, http2Url: string) {
    this.store = opts.store;
    this.server = server;
    this.http2Server = http2Server;
    this.http2Url = http2Url;
    this.url = url;
    this.token = token;
    this.providers = new Map((opts.providers ?? defaultProviders).map((p) => [p.id, p]));
    this.normalizers = opts.normalizers ?? [];
    this.upstreams = opts.upstreams ?? {};
    this.prices = opts.prices;
    this.clock = opts.clock ?? 'auto';
    this.httpRules = opts.http ?? [];
    this.log = opts.log ?? (() => {});
    this.api = opts.api;
  }

  static async start(opts: SidecarOptions): Promise<Sidecar> {
    const host = opts.host ?? '127.0.0.1';
    const token = randomBytes(16).toString('hex');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port ?? 0, host, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const http2Server = createHttp2Server();
    await new Promise<void>((resolve, reject) => {
      http2Server.once('error', reject);
      http2Server.listen(0, host, () => resolve());
    });
    const http2Port = (http2Server.address() as AddressInfo).port;
    const sidecar = new Sidecar(opts, server, `http://${host}:${port}/t/${token}`, token, http2Server, `http://${host}:${http2Port}/t/${token}`);
    http2Server.on('session', (session) => {
      sidecar.http2Sessions.add(session);
      session.on('close', () => sidecar.http2Sessions.delete(session));
    });
    // The HTTP/2 compatibility API gives request and response objects the HTTP/1 handler understands.
    http2Server.on('request', (req, res) => server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse));
    server.on('request', (req, res) => {
      sidecar.handle(req, res).catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_error', message } }));
        } else {
          res.destroy();
        }
        sidecar.log(`error: ${message}`);
      });
    });
    return sidecar;
  }

  /**
   * A request forwarded over HTTP/2, as a fetch Response so recording and streaming don't care how
   * it travelled. Needed for fidelity, not speed: a client that signs over HTTP/2 (the AWS SDK)
   * signs the `:authority` pseudo-header, which an HTTP/1.1 request cannot carry.
   */
  private fetchOverHttp2(origin: string, path: string, method: string, headers: Record<string, string>, body: Buffer | null, authority: string): Promise<Response> {
    let session = this.upstreamHttp2.get(origin);
    if (!session || session.closed || session.destroyed) {
      session = connectHttp2(origin);
      session.on('error', () => this.upstreamHttp2.delete(origin));
      session.on('close', () => this.upstreamHttp2.delete(origin));
      this.upstreamHttp2.set(origin, session);
    }
    const scheme = new URL(origin).protocol.replace(':', '');
    const stream = session.request({ ...headers, ':method': method, ':path': path, ':authority': authority, ':scheme': scheme }, { endStream: !body });
    if (body) stream.end(body);
    return new Promise((resolve, reject) => {
      stream.once('error', reject);
      stream.once('response', (h) => {
        const status = Number(h[':status']);
        const out = new Headers();
        for (const [k, v] of Object.entries(h)) {
          if (k.startsWith(':') || v === undefined) continue;
          out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        }
        const noBody = method === 'HEAD' || status === 204 || status === 304;
        resolve(new Response(noBody ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>), { status, headers: out }));
      });
    });
  }

  async close(): Promise<void> {
    for (const session of this.upstreamHttp2.values()) session.destroy();
    for (const session of this.http2Sessions) session.destroy();
    await Promise.all([new Promise<void>((resolve) => this.server.close(() => resolve())), new Promise<void>((resolve) => this.http2Server.close(() => resolve()))]);
    this.server.closeAllConnections?.();
  }

  /** Environment variables that route a child process's SDK calls through this run. */
  /**
   * The environment for a process whose calls belong to `runId`. The run id is in the provider base
   * URLs because model SDKs send no Shadowlap header, and several processes can record or replay
   * through one sidecar at once (`shadowlap replay --repeat --concurrency`). Without a run id, calls
   * go to whichever run started last, for hosts that start runs after creating their clients.
   */
  envFor(runId?: string): Record<string, string> {
    const env: Record<string, string> = { SHADOWLAP_URL: this.url, SHADOWLAP_HTTP2_URL: this.http2Url, ...(runId ? { SHADOWLAP_RUN_ID: runId } : {}) };
    const base = runId ? `${this.url}/r/${encodeURIComponent(runId)}` : this.url;
    for (const p of this.providers.values()) Object.assign(env, p.env(`${base}/${p.id}`));
    return env;
  }

  /**
   * The environment for processes whose runs change over time under one slot: no run id, and base
   * URLs that stay valid while each new run takes the slot over (`startRun({ slot })`).
   */
  envForSlot(slot: string): Record<string, string> {
    if (!/^[\w.-]{1,64}$/.test(slot)) throw new HttpError(400, `a slot is 1 to 64 letters, digits, dots, dashes or underscores: ${slot}`);
    const base = `${this.url}/s/${slot}`;
    const env: Record<string, string> = { SHADOWLAP_URL: base, SHADOWLAP_HTTP2_URL: `${this.http2Url}/s/${slot}` };
    for (const p of this.providers.values()) Object.assign(env, p.env(`${base}/${p.id}`));
    return env;
  }

  startRun(input: StartRunInput): RunRecord {
    if (input.slot !== undefined) this.envForSlot(input.slot);
    let parentCalls: CallRecord[] | undefined;
    let parentStartedAt: number | undefined;
    let normalizers = this.normalizers;
    if (input.mode === 'replay') {
      if (!input.parentRunId) throw new HttpError(400, 'replay needs a parentRunId');
      const parent = this.store.getRun(input.parentRunId);
      if (!parent) throw new HttpError(404, `unknown run ${input.parentRunId}`);
      // A redacted recording matches only if the live request is masked the same way.
      if (parent.meta?.redactions?.length) normalizers = [...normalizers, ...parent.meta.redactions];
      const stored = this.store.getCalls(input.parentRunId);
      // Stored fingerprints are valid under the list they were computed with; anything else recomputes them.
      parentStartedAt = parent.startedAt;
      if (input.replay?.promptFrom !== undefined) {
        const target = stored.find((c) => c.callNo === input.replay!.promptFrom);
        if (!target || target.kind !== 'api') throw new HttpError(400, `--prompt-from: call #${input.replay.promptFrom} is not a model call of run ${input.parentRunId}`);
      }
      if (parent.meta?.normalizersHash === normalizersHash(normalizers, this.clock, input.replay?.promptFrom !== undefined)) {
        parentCalls = stored;
        this.log(`run ${input.parentRunId}: reusing stored fingerprints (${stored.length} calls)`);
      } else {
        this.log(`run ${input.parentRunId}: re-fingerprinting ${stored.length} call${stored.length === 1 ? '' : 's'} under the current normalizers`);
        parentCalls = this.refingerprint(stored, normalizers, this.clock === 'auto' ? parent.startedAt : undefined, input.replay?.promptFrom !== undefined);
      }
    }
    const run = this.store.createRun({
      mode: input.mode,
      parentRunId: input.parentRunId ?? null,
      command: input.command,
      codeVersion: input.codeVersion ?? null,
      meta: { normalizersHash: normalizersHash(normalizers, this.clock, input.replay?.promptFrom !== undefined), ...(input.commandFromImport ? { commandFromImport: true } : {}), ...interventionsMeta(input) },
    });
    const clockRef = this.clock === 'auto' ? run.startedAt : undefined;
    const session = new Session({
      mode: input.mode,
      parentRunId: input.parentRunId ?? null,
      ...(parentCalls ? { parentCalls } : {}),
      ...(input.replay ? { replay: input.replay } : {}),
      loadRequest: (rec) => this.loadRequest(rec),
      ...(clockRef !== undefined && parentStartedAt !== undefined ? { clock: { parent: parentStartedAt, run: clockRef } } : {}),
    });
    const active: ActiveInterventions = {};
    if (input.interventions && parentCalls) {
      const apiCalls = parentCalls.filter((c) => c.kind === 'api');
      const apiIndexOf = (callNo: number, what: string): number => {
        const i = apiCalls.findIndex((c) => c.callNo === callNo);
        if (i < 0) throw new HttpError(400, `${what}: call #${callNo} is not a model call of run ${input.parentRunId}`);
        return i;
      };
      const { inject, set } = input.interventions;
      if (inject) active.inject = { apiIndex: apiIndexOf(inject.atCall, '--inject'), text: inject.text, as: inject.as };
      if (set) active.set = { apiIndex: apiIndexOf(set.fromCall, '--set'), fields: set.fields };
    }
    this.runs.set(run.runId, new RunContext(run, session, active, normalizers, input.offline === true, input.slot ?? null, clockRef, input.replay?.promptFrom !== undefined));
    if (input.slot !== undefined) this.slots.set(input.slot, run.runId);
    this.activeRunId = run.runId;
    this.log(`run ${run.runId} started (${input.mode})`);
    return run;
  }

  endRun(runId: string, status: Exclude<RunStatus, 'running'>): EndRunResult {
    const ctx = this.runs.get(runId);
    if (!ctx) throw new HttpError(404, `unknown run ${runId}`);
    this.store.endRun(runId, status);
    this.runs.delete(runId);
    if (this.activeRunId === runId) this.activeRunId = null;
    if (ctx.slot !== null && this.slots.get(ctx.slot) === runId) this.slots.delete(ctx.slot);
    const run = this.store.getRun(runId)!;
    const unguarded = [...ctx.unguarded.entries()].map(([target, v]) => ({ target, ...v })).sort((a, b) => b.count - a.count);
    // Kept on the run as well as printed: its page says what a replay runs for real.
    if (unguarded.length) recordNotRecorded(this.store, runId, { hosts: unguarded });
    const warnings = [...ctx.warnings];
    if (unguarded.length) {
      const list = unguarded.map((u) => `${u.target} (${u.count})`).join(', ');
      const blocked = unguarded.some((u) => u.action === 'blocked');
      warnings.push(
        blocked
          ? `${unguarded.length} outbound connection target${unguarded.length === 1 ? '' : 's'} bypassed Shadowlap and ${unguarded.length === 1 ? 'was' : 'were'} blocked: ${list}. Wrap these calls as tools, or allow them with SHADOWLAP_GUARD_ALLOW.`
          : run.mode === 'replay'
            ? `${unguarded.length} outbound connection target${unguarded.length === 1 ? '' : 's'} bypassed Shadowlap during the replay: ${list}. They ran live and will run on every replay; wrap them as tools, or replay with --guard block.`
            : `${unguarded.length} outbound connection target${unguarded.length === 1 ? '' : 's'} bypassed Shadowlap during the recording: ${list}. They were not recorded and will run again on replay; wrap them as tools.`,
      );
    }
    const calls = this.store.getCalls(runId);
    if (run.mode === 'record' && !calls.some((c) => c.kind === 'api')) {
      warnings.push(
        calls.length === 0
          ? 'Nothing was recorded: no model API call or SDK call reached Shadowlap. In Node and Python agents, calls to Anthropic, OpenAI, Gemini, Azure OpenAI, Vertex AI and Bedrock are captured in the process; other runtimes need their SDK to read ANTHROPIC_BASE_URL, OPENAI_BASE_URL or GOOGLE_GEMINI_BASE_URL, which shadowlap run sets. A client with a base URL on another host (set SHADOWLAP_UPSTREAM_<PROVIDER> to it), SHADOWLAP_CAPTURE=off, or an agent that failed before its first call all look like this.'
          : `${calls.length} ${calls.every((c) => c.meta.http) ? 'HTTP' : 'SDK'} call${calls.length === 1 ? '' : 's'} recorded but no model API calls. If the agent calls a model, its client is not going through Shadowlap (a client configured with its own base URL bypasses the ANTHROPIC_BASE_URL / OPENAI_BASE_URL / GOOGLE_GEMINI_BASE_URL that shadowlap run sets).`,
      );
    }
    const summary = summarizeRun(run, calls, ctx.session.notReached(), warnings, { ...(this.prices ? { prices: this.prices } : {}), modelOf: storedModelResolver(this.store) });
    this.log(`run ${runId} ended (${status})`);
    return { run, summary, providers: [...ctx.providersUsed].sort(), sdks: [...ctx.sdksSeen].sort(), unguarded };
  }

  get activeRun(): RunRecord | null {
    return this.activeRunId ? (this.runs.get(this.activeRunId)?.run ?? null) : null;
  }

  // ---- HTTP ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sidecar');
    const prefix = `/t/${this.token}/`;
    if (!url.pathname.startsWith(prefix)) throw new HttpError(404, 'not found');
    let rest = url.pathname.slice(prefix.length);
    // /r/<runId>/… pins the request to a run, as the base URLs from envFor do; /s/<slot>/… to the
    // run that holds the slot now, as the base URLs from envForSlot do.
    let pinned: string | undefined;
    const pin = /^([rs])\/([^/]+)\/(.*)$/.exec(rest);
    if (pin) {
      const id = decodeURIComponent(pin[2]!);
      rest = pin[3]!;
      if (pin[1] === 'r') pinned = id;
      else {
        pinned = this.slots.get(id);
        if (!pinned) throw new HttpError(409, `no run holds slot ${id}: a call arrived outside a recorded test`);
      }
    }
    const head = rest.split('/', 1)[0] ?? '';

    if (head === 'v1') return this.handleApi(req, res, rest, url, pinned);
    if (head === 'http') return this.proxyHttp(req, res, rest.slice(head.length) || '/', url.search, pinned);
    const provider = head ? this.providers.get(head) : undefined;
    if (!provider) throw new HttpError(404, `unknown route ${rest}`);
    const subpath = rest.slice(head.length) || '/';
    return this.proxy(req, res, provider, subpath, url.search, pinned);
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, rest: string, url: URL, pinned?: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (rest === 'v1/health' && method === 'GET') return json(res, 200, { ok: true, activeRun: this.activeRunId });

    if (rest === 'v1/runs' && method === 'POST') {
      const body = (await readJson(req)) as Partial<StartRunInput> & { replay?: Partial<ReplayOptions> & { liveTools?: string[]; overrides?: Record<string, unknown> }; interventions?: Interventions };
      if (body.mode !== 'record' && body.mode !== 'replay') throw new HttpError(400, 'mode must be record or replay');
      const replay = body.replay
        ? {
            ...body.replay,
            ...(body.replay.liveTools ? { liveTools: new Set(body.replay.liveTools) } : {}),
            ...(body.replay.overrides ? { overrides: new Map(Object.entries(body.replay.overrides).map(([k, v]) => [Number(k), v])) } : {}),
          }
        : undefined;
      const run = this.startRun({
        mode: body.mode,
        ...(body.parentRunId ? { parentRunId: body.parentRunId } : {}),
        command: body.command ?? { argv: [], cwd: '' },
        codeVersion: body.codeVersion ?? null,
        ...(replay ? { replay: replay as Partial<ReplayOptions> } : {}),
        ...(body.interventions ? { interventions: body.interventions } : {}),
      });
      return json(res, 201, { run, env: this.envFor(run.runId) });
    }

    const endMatch = /^v1\/runs\/([^/]+)\/end$/.exec(rest);
    if (endMatch && method === 'POST') {
      const body = (await readJson(req)) as { status?: RunStatus };
      const status = body.status && body.status !== 'running' ? body.status : 'completed';
      return json(res, 200, this.endRun(decodeURIComponent(endMatch[1]!), status));
    }

    if (rest === 'v1/calls/resolve' && method === 'POST') {
      const body = (await readJson(req)) as ResolveBody;
      const ctx = this.contextFor(req, pinned);
      ctx.sdksSeen.add(sdkFamily(req.headers['user-agent']));
      return json(res, 200, this.resolveCall(ctx, body, scopeOf(req)));
    }

    if (rest === 'v1/guard' && method === 'POST') {
      const body = (await readJson(req)) as { target?: unknown; action?: unknown };
      const ctx = this.contextFor(req, pinned);
      const target = typeof body.target === 'string' ? body.target.slice(0, 300) : '';
      if (target) {
        const action = body.action === 'blocked' ? 'blocked' : 'warned';
        const prev = ctx.unguarded.get(target);
        ctx.unguarded.set(target, { count: (prev?.count ?? 0) + 1, action: prev?.action === 'blocked' ? 'blocked' : action });
      }
      return json(res, 202, { ok: true });
    }

    const completeMatch = /^v1\/calls\/(\d+)\/complete$/.exec(rest);
    if (completeMatch && method === 'POST') {
      const body = (await readJson(req)) as CompleteBody;
      this.completeCall(this.contextFor(req, pinned), Number(completeMatch[1]), body);
      return json(res, 200, { ok: true });
    }

    if (this.api) {
      const handled = await this.api({ method, path: rest, body: () => readJson(req) });
      if (handled) return json(res, handled.status, handled.body);
    }
    throw new HttpError(404, `unknown API route ${method} ${url.pathname}`);
  }

  private contextFor(req: IncomingMessage, pinnedByPath?: string): RunContext {
    const header = req.headers['x-shadowlap-run'];
    const runId = pinnedByPath || (Array.isArray(header) ? header[0] : header) || this.activeRunId;
    const ctx = runId ? this.runs.get(runId) : undefined;
    if (!ctx) throw new HttpError(409, runId ? `run ${runId} is not active` : 'no active run');
    return ctx;
  }

  // ---- model API proxy ----

  /**
   * Where a captured request was going. In-process capture (Bedrock signs for its host, and any
   * client may hardcode a base URL) sends the agent's own request here with the destination in a
   * header. Only hosts the provider vouches for are accepted, so this is never an open proxy.
   */
  private requestedUpstream(req: IncomingMessage, provider: Provider, ctx: RunContext): string | undefined {
    // A configured upstream (a mock, a local server, or "offline" in shadowlap test) takes precedence.
    if (this.upstreams[provider.id] || ctx.offline) return undefined;
    const raw = req.headers['x-shadowlap-upstream'];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!value) return undefined;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new HttpError(400, `x-shadowlap-upstream is not a URL: ${value}`);
    }
    if (url.protocol !== 'https:' || !provider.hosts.test(url.hostname)) {
      throw new HttpError(403, `${provider.id} cannot forward to ${url.origin}. Point it at a mock with SHADOWLAP_UPSTREAM_${provider.id.toUpperCase()} instead.`);
    }
    return url.origin;
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, provider: Provider, subpath: string, search: string, pinned?: string): Promise<void> {
    const ctx = this.contextFor(req, pinned);
    const requested = this.requestedUpstream(req, provider, ctx);
    ctx.providersUsed.add(provider.id);
    const method = (req.method ?? 'GET').toUpperCase();
    let rawBody = await readBody(req);
    const headers = lowerHeaders(req.headers);
    let body: unknown;
    if (rawBody.length === 0) body = null;
    else {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        body = rawBody.toString('base64');
      }
    }

    // Interventions rewrite the request before it is fingerprinted, stored or forwarded, so the
    // recording of the fork holds exactly what was sent.
    const retryHeaderEarly = provider.retryCountHeader ? headers[provider.retryCountHeader] : undefined;
    const isFirstAttempt = retryHeaderEarly === undefined || Number.parseInt(retryHeaderEarly, 10) === 0;
    if (isConversation(body)) {
      const apiIndex = ctx.apiCalls;
      const iv = ctx.interventions;
      if (iv.inject && apiIndex >= iv.inject.apiIndex) {
        const messages = body.messages;
        if (iv.injectedAt === undefined) iv.injectedAt = iv.inject.as === 'system' ? messages.length : messages.length - 1;
        if (iv.inject.as === 'system') {
          messages.splice(Math.min(iv.injectedAt, messages.length), 0, { role: 'system', content: iv.inject.text });
        } else {
          const target = messages[iv.injectedAt] as { role?: string; content?: unknown } | undefined;
          if (target) {
            const block = { type: 'text', text: iv.inject.text };
            target.content = typeof target.content === 'string' ? [{ type: 'text', text: target.content }, block] : Array.isArray(target.content) ? [...target.content, block] : [block];
          }
        }
      }
      if (iv.set && apiIndex >= iv.set.apiIndex) Object.assign(body, iv.set.fields);
      if ((iv.inject && apiIndex >= iv.inject.apiIndex) || (iv.set && apiIndex >= iv.set.apiIndex)) rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      if (isFirstAttempt) ctx.apiCalls++;
    }

    const name = apiCallName(method, subpath);
    const { fingerprint } = fingerprintApi({ method, path: subpath, headers, body }, ctx.normalizers, provider.fingerprintHeaders, ctx.clockRef, { withoutPrompt: ctx.withoutPrompt });
    const fingerprintHeaders: Record<string, string> = {};
    for (const h of provider.fingerprintHeaders) if (headers[h] !== undefined) fingerprintHeaders[h] = headers[h]!;
    const retryHeader = provider.retryCountHeader ? headers[provider.retryCountHeader] : undefined;
    const retryCount = retryHeader === undefined ? 0 : Number.parseInt(retryHeader, 10) || 0;

    // A retry of the previous attempt of the same call, rather than a new call.
    const scope = scopeOf(req);
    const retryKey = `api\n${scope ?? ''}\n${fingerprint}`;
    const prevNo = ctx.lastByFingerprint.get(retryKey);
    const prev = prevNo !== undefined ? ctx.calls.get(prevNo) : undefined;
    const isRetry = !!prev && prev.retryable && (retryCount > 0 || retryHeader === undefined);

    let callNo: number;
    let tracked: TrackedCall;
    if (isRetry && prev && prevNo !== undefined) {
      callNo = prevNo;
      tracked = prev;
    } else {
      callNo = ctx.nextCallNo++;
      const decision = ctx.session.resolve({ callNo, kind: 'api', name, fingerprint, request: body, ...(scope ? { scope } : {}) });
      const origin: Origin = decision.origin === 'overridden' ? 'replayed' : decision.origin;
      tracked = { identity: { kind: 'api', name, fingerprint, occurrence: decision.occurrence }, effect: null, origin, decision, ends: 0, retryable: false, done: false };
      ctx.calls.set(callNo, tracked);
      ctx.lastByFingerprint.set(retryKey, callNo);
      this.noteDivergence(ctx);
      const requestRef = storeApiRequest(this.store, body);
      this.store.appendCallStart({
        runId: ctx.run.runId,
        callNo,
        ...tracked.identity,
        origin,
        effect: null,
        requestRef,
        meta: { retryCount, provider: provider.id, fingerprintHeaders, ...(scope ? { scope } : {}) },
        at: Date.now(),
      });
    }

    // Checked after the retry branch and keyed by call number, so every attempt of an injected
    // failure fails. The interesting question is what the agent does when a call cannot succeed;
    // "the retry works" is what an ordinary replay already shows.
    const injected = ctx.session.options.failAt?.get(callNo);
    if (injected !== undefined) return this.serveInjectedFailure(ctx, res, provider, callNo, tracked, injected);

    // Overrides apply to tool results only; for a model call an override decision is served as recorded.
    if (tracked.decision.origin === 'replayed' || tracked.decision.origin === 'overridden') return this.serveReplayed(ctx, res, callNo, tracked);
    return this.forward(ctx, req, res, provider, method, subpath, search, headers, rawBody, callNo, tracked, body, requested);
  }

  private serveReplayed(ctx: RunContext, res: ServerResponse, callNo: number, tracked: TrackedCall): void {
    if (tracked.decision.origin !== 'replayed' && tracked.decision.origin !== 'overridden') return;
    const record = tracked.decision.record;
    const end = record.end!;
    const bytes = end.responseRef ? (this.store.getBlob(end.responseRef) ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const status = end.meta.status ?? 200;
    res.writeHead(status, { ...(end.meta.headers ?? {}), 'content-length': String(bytes.length), 'x-shadowlap-origin': 'replayed' });
    res.end(bytes);
    this.store.appendCallEnd(tracked.identity, {
      runId: ctx.run.runId,
      callNo,
      attempt: tracked.ends++,
      responseRef: end.responseRef,
      outcome: end.outcome,
      meta: { ...end.meta, replayedFrom: record.callNo, latencyMs: 0 },
      at: Date.now(),
    });
    tracked.done = true;
    // A recorded retryable failure is served as-is; the client's retry gets the same answer.
    tracked.retryable = end.outcome === 'error' && end.meta.retryable === true;
  }

  /**
   * Answers a model call with a failure Shadowlap produced, for `--fail-at`. Nothing leaves the
   * machine. The body names Shadowlap as the source and the call is stored with `injected`, so
   * neither the agent's error nor the recording can be mistaken for something the provider did.
   */
  private serveInjectedFailure(ctx: RunContext, res: ServerResponse, provider: Provider, callNo: number, tracked: TrackedCall, status: number): void {
    const message = `injected failure: HTTP ${status} (shadowlap --fail-at ${callNo}=${status})`;
    const bytes = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'shadowlap_injected', message } }), 'utf8');
    const retryable = provider.isRetryableStatus(status);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'x-shadowlap-origin': 'injected' });
    res.end(bytes);
    const error = { name: 'ShadowlapInjectedFailure', message };
    this.store.appendCallEnd(tracked.identity, {
      runId: ctx.run.runId,
      callNo,
      attempt: tracked.ends++,
      responseRef: this.store.putBlob(bytes),
      outcome: 'error',
      meta: { status, injected: true, retryable, error, provider: provider.id, bytes: bytes.length, latencyMs: 0 },
      at: Date.now(),
    });
    tracked.done = true;
    // Retryable by the provider's own rule, so the client's retry logic runs — and fails again.
    tracked.retryable = retryable;
    this.log(`run ${ctx.run.runId} call ${callNo}: injected HTTP ${status}`);
  }

  private async forward(
    ctx: RunContext,
    req: IncomingMessage,
    res: ServerResponse,
    provider: Provider,
    method: string,
    subpath: string,
    search: string,
    headers: Record<string, string>,
    rawBody: Buffer,
    callNo: number,
    tracked: TrackedCall,
    requestBodyForMeta: unknown = null,
    requestedUpstream?: string,
  ): Promise<void> {
    // An upstream configured here wins (shadowlap test sets "offline"), then the one a captured
    // request names, then the provider's own default.
    const upstream = ctx.offline ? 'offline' : (this.upstreams[provider.id] || requestedUpstream || provider.upstream).replace(/\/$/, '');
    if (!upstream) {
      const message = `no upstream for ${provider.id}: set SHADOWLAP_UPSTREAM_${provider.id.toUpperCase()}, or let Shadowlap capture the call in the agent's process`;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_no_upstream', message } }));
      this.store.appendCallEnd(tracked.identity, { runId: ctx.run.runId, callNo, attempt: tracked.ends, responseRef: null, outcome: 'error', meta: { status: 400, latencyMs: 0, retryable: false, error: { name: 'ShadowlapNoUpstream', message } }, at: Date.now() });
      tracked.ends++;
      tracked.done = true;
      return;
    }
    if (upstream === 'offline') {
      // `shadowlap test` runs offline: a live call here means the replay diverged, and the run must fail loudly, not spend tokens.
      const message = `shadowlap is offline: call #${callNo} (${tracked.identity.name}) was not served from the recording and would need the network`;
      const error: SerializedError = { name: 'ShadowlapOffline', message };
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_offline', message } }));
      this.store.appendCallEnd(tracked.identity, { runId: ctx.run.runId, callNo, attempt: tracked.ends, responseRef: null, outcome: 'error', meta: { status: 503, latencyMs: 0, retryable: false, offline: true, error }, at: Date.now() });
      tracked.ends++;
      tracked.done = true;
      return;
    }
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (HOP_BY_HOP.has(k) || k.startsWith(':') || k === 'host' || k === 'content-length' || k.startsWith('x-shadowlap-')) continue;
      forwardHeaders[k] = v;
    }
    forwardHeaders['accept-encoding'] = 'identity';

    const started = Date.now();
    const attempt = tracked.ends;
    let upstreamRes: Response;
    // A request that arrived over HTTP/2 carries its signed :authority; it leaves the same way.
    const authority = headers[':authority'];
    try {
      upstreamRes = authority
        ? await this.fetchOverHttp2(upstream.replace(/(https?:\/\/[^/]+).*/, '$1'), `${upstream.replace(/https?:\/\/[^/]+/, '')}${subpath}${search}`, method, forwardHeaders, method === 'GET' || method === 'HEAD' ? null : rawBody, authority)
        : await requestUpstream(upstream + subpath + search, method, forwardHeaders, method === 'GET' || method === 'HEAD' ? null : rawBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error: SerializedError = { name: 'UpstreamConnectionError', message };
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_upstream_error', message } }));
      this.store.appendCallEnd(tracked.identity, {
        runId: ctx.run.runId,
        callNo,
        attempt,
        responseRef: null,
        outcome: 'error',
        meta: { status: 502, latencyMs: Date.now() - started, retryable: true, error },
        at: Date.now(),
      });
      tracked.ends++;
      tracked.retryable = true;
      tracked.done = true;
      return;
    }

    const status = upstreamRes.status;
    const responseHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (RESPONSE_DROP.has(key) || provider.credentialHeaders.includes(key)) return;
      responseHeaders[key] = v;
    });
    res.writeHead(status, { ...responseHeaders, 'x-shadowlap-origin': 'live' });
    res.flushHeaders();

    const timer = new SseTimer(started);
    const chunks: Buffer[] = [];
    let clientGone = false;
    let streamError: SerializedError | undefined;
    res.on('close', () => {
      if (!res.writableFinished) clientGone = true;
    });
    const reader = upstreamRes.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          chunks.push(buf);
          timer.push(buf);
          if (clientGone) {
            await reader.cancel().catch(() => {});
            break;
          }
          res.write(buf);
        }
      } catch (err) {
        streamError = { name: 'UpstreamStreamError', message: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!clientGone) res.end();
    else res.destroy();

    const body = Buffer.concat(chunks);
    const contentType = responseHeaders['content-type'];
    const usage = provider.extractUsage(body, contentType);
    const retryable = provider.isRetryableStatus(status) || streamError !== undefined;
    const outcome = status < 400 && !streamError && !clientGone ? 'ok' : 'error';
    const meta: CallStartRow['meta'] = { status, headers: responseHeaders, latencyMs: Date.now() - started, retryable, bytes: body.length, provider: provider.id };
    const requestedModel = provider.extractModel(subpath, requestBodyForMeta);
    if (requestedModel) meta.model = requestedModel;
    const stopReason = outcome === 'ok' ? provider.extractStopReason(body, contentType) : null;
    if (stopReason) meta.stopReason = stopReason;
    if (usage) meta.usage = usage;
    if (timer.events.length) meta.chunks = timer.events;
    if (streamError) meta.error = streamError;
    if (clientGone) meta.error = { name: 'ClientDisconnected', message: 'the client closed the connection before the response completed' };
    this.store.appendCallEnd(tracked.identity, {
      runId: ctx.run.runId,
      callNo,
      attempt,
      responseRef: this.store.putBlob(body),
      outcome,
      meta,
      at: Date.now(),
    });
    tracked.ends++;
    tracked.retryable = outcome === 'error' && retryable;
    tracked.done = true;
  }

  // ---- HTTP hosts recorded as tools ----

  /**
   * A captured call to a host under `http` in the config, resolved like a tool call the SDK would
   * make: replayed from the recording, run live, blocked or stubbed. The sidecar makes the request
   * itself when it runs live, and only to a declared host. Request headers are never stored.
   */
  private async proxyHttp(req: IncomingMessage, res: ServerResponse, subpath: string, search: string, pinned?: string): Promise<void> {
    const ctx = this.contextFor(req, pinned);
    const raw = req.headers['x-shadowlap-upstream'];
    let origin: URL;
    try {
      origin = new URL(String(Array.isArray(raw) ? raw[0] : raw));
    } catch {
      throw new HttpError(400, 'a captured HTTP call needs x-shadowlap-upstream');
    }
    const rule = matchHttpRule(this.httpRules, origin);
    if (!rule) throw new HttpError(403, `${origin.host} is not an HTTP host Shadowlap records: add it under "http" in shadowlap.config.json`);
    const method = (req.method ?? 'GET').toUpperCase();
    const rawBody = await readBody(req);
    const contentType = req.headers['content-type'];
    const requestBody = decodeBody(rawBody, contentType);
    const name = `${method} ${origin.host}${subpath}`;
    const args = { method, url: `${origin.origin}${subpath}${search}`, ...requestBody };
    const { fingerprint } = fingerprintTool(name, args, ctx.normalizers, ctx.clockRef);
    const callNo = ctx.nextCallNo++;
    const effect = rule.effect;
    const scope = scopeOf(req);
    const decision = ctx.session.resolve({ callNo, kind: 'tool', name, fingerprint, effect, request: { args }, ...(scope ? { scope } : {}) });
    const identity: CallIdentity = { kind: 'tool', name, fingerprint, occurrence: decision.occurrence };
    const tracked: TrackedCall = { identity, effect, origin: decision.origin, decision, ends: 0, retryable: false, done: false };
    ctx.calls.set(callNo, tracked);
    this.noteDivergence(ctx);
    this.store.appendCallStart({ runId: ctx.run.runId, callNo, ...identity, origin: decision.origin, effect, requestRef: this.store.putJson({ args }), meta: { http: origin.host, ...(scope ? { scope } : {}) }, at: Date.now() });

    const end = (responseRef: string | null, outcome: 'ok' | 'error', meta: CallStartRow['meta']) => {
      this.store.appendCallEnd(identity, { runId: ctx.run.runId, callNo, attempt: 0, responseRef, outcome, meta, at: Date.now() });
      tracked.done = true;
    };
    const send = (result: HttpResult, from: string) => {
      const bytes = encodeBody(result);
      res.writeHead(result.status, { ...result.headers, 'content-length': String(bytes.length), 'x-shadowlap-origin': from });
      res.end(bytes);
    };
    const fail = (status: number, error: SerializedError, type: string) => {
      end(this.store.putJson({ error }), 'error', { status, error });
      json(res, status, { type: 'error', error: { type, message: error.message } });
    };

    if (decision.origin === 'replayed') {
      const recorded = decision.record.end!;
      const payload = (recorded.responseRef ? this.store.getJson<{ result?: HttpResult; error?: SerializedError }>(recorded.responseRef) : null) ?? {};
      end(recorded.responseRef, recorded.outcome, { ...recorded.meta, replayedFrom: decision.record.callNo, latencyMs: 0 });
      if (payload.result) return send(payload.result, 'replayed');
      return json(res, 502, { type: 'error', error: { type: 'shadowlap_replayed_error', message: payload.error?.message ?? 'the recorded call failed' } });
    }
    if (decision.origin === 'overridden') {
      const value = decision.result as Partial<HttpResult> | null;
      const result: HttpResult = value && typeof value === 'object' && typeof value.status === 'number' ? { status: value.status, headers: value.headers ?? {}, ...(value.body !== undefined ? { body: value.body, encoding: value.encoding ?? 'json' } : {}) } : { status: 200, headers: { 'content-type': 'application/json' }, body: value, encoding: 'json' };
      end(this.store.putJson({ result }), 'ok', { overriddenFrom: decision.record.callNo, latencyMs: 0 });
      return send(result, 'overridden');
    }
    if (decision.origin === 'blocked') {
      return fail(409, { name: 'ShadowlapWriteBlocked', message: `write ${name} blocked after divergence (use --writes stub|allow to change this)` }, 'shadowlap_write_blocked');
    }
    if (decision.origin === 'stubbed') {
      const result: HttpResult = { status: 200, headers: { 'content-type': 'application/json' }, body: { shadowlap: 'stubbed' }, encoding: 'json' };
      end(this.store.putJson({ result }), 'ok', { stubbed: true, latencyMs: 0 });
      return send(result, 'stubbed');
    }
    if (ctx.offline || this.upstreams.http === 'offline') {
      return fail(503, { name: 'ShadowlapOffline', message: `shadowlap is offline: call #${callNo} (${name}) was not served from the recording and would need the network` }, 'shadowlap_offline');
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(lowerHeaders(req.headers))) {
      if (HOP_BY_HOP.has(k) || k.startsWith(':') || k === 'host' || k === 'content-length' || k.startsWith('x-shadowlap-')) continue;
      headers[k] = v;
    }
    const started = Date.now();
    let upstream: Response;
    let bytes: Buffer;
    try {
      upstream = await requestUpstream(args.url, method, headers, rawBody.length && method !== 'GET' && method !== 'HEAD' ? rawBody : null);
      bytes = Buffer.from(await upstream.arrayBuffer());
    } catch (err) {
      return fail(502, { name: 'ShadowlapUpstreamError', message: `${name}: ${err instanceof Error ? err.message : String(err)}` }, 'shadowlap_upstream_error');
    }
    const result: HttpResult = { status: upstream.status, headers: keptResponseHeaders(upstream.headers), ...decodeBody(bytes, upstream.headers.get('content-type') ?? undefined) };
    end(this.store.putJson({ result }), 'ok', { status: upstream.status, latencyMs: Date.now() - started, bytes: bytes.length });
    res.writeHead(upstream.status, { ...result.headers, 'content-length': String(bytes.length), 'x-shadowlap-origin': 'live' });
    res.end(bytes);
  }

  // ---- tool / clock / random resolution ----

  private resolveCall(ctx: RunContext, body: ResolveBody, scope?: string): ResolveResponse {
    const kind = body.kind;
    if (kind !== 'tool' && kind !== 'clock' && kind !== 'random') throw new HttpError(400, `bad kind ${String(kind)}`);
    if (typeof body.name !== 'string' || !body.name) throw new HttpError(400, 'name is required');
    const effect: Effect | null = kind === 'tool' ? (body.effect ?? null) : null;
    if (kind === 'tool' && effect !== 'pure' && effect !== 'read' && effect !== 'write') throw new HttpError(400, `tool ${body.name} must declare effect pure|read|write`);

    const request = kind === 'tool' ? { args: body.args ?? null } : { label: body.label ?? '' };
    const { fingerprint } = kind === 'tool' ? fingerprintTool(body.name, request.args, ctx.normalizers, ctx.clockRef) : fingerprintMisc(kind, body.label ?? '');
    const callNo = ctx.nextCallNo++;
    const decision = ctx.session.resolve({ callNo, kind, name: body.name, fingerprint, effect, request, ...(scope ? { scope } : {}) });
    const identity: CallIdentity = { kind, name: body.name, fingerprint, occurrence: decision.occurrence };
    const tracked: TrackedCall = { identity, effect, origin: decision.origin, decision, ends: 0, retryable: false, done: false };
    ctx.calls.set(callNo, tracked);
    this.noteDivergence(ctx);

    const meta: CallStartRow['meta'] = {};
    if (body.implHash) meta.implHash = body.implHash;
    if (scope) meta.scope = scope;
    this.store.appendCallStart({ runId: ctx.run.runId, callNo, ...identity, origin: decision.origin, effect, requestRef: this.store.putJson(request), meta, at: Date.now() });

    if (decision.origin === 'overridden') {
      // The user's substitute result stands in for the recording; the agent builds its next request from it.
      const record = decision.record;
      this.store.appendCallEnd(identity, {
        runId: ctx.run.runId,
        callNo,
        attempt: 0,
        responseRef: this.store.putJson({ result: decision.result }),
        outcome: 'ok',
        meta: { overriddenFrom: record.callNo, latencyMs: 0 },
        at: Date.now(),
      });
      tracked.done = true;
      return { origin: 'replayed', callNo, outcome: 'ok', result: decision.result };
    }

    if (decision.origin === 'replayed') {
      const record = decision.record;
      const end = record.end!;
      const payload = (end.responseRef ? this.store.getJson<{ result?: unknown; error?: SerializedError }>(end.responseRef) : null) ?? {};
      if (kind === 'tool' && body.implHash && record.meta.implHash && record.meta.implHash !== body.implHash) {
        ctx.warnOnce(body.name, `${body.name} changed since the recording; pass --live-tool ${body.name} to run it live`);
      }
      this.store.appendCallEnd(identity, {
        runId: ctx.run.runId,
        callNo,
        attempt: 0,
        responseRef: end.responseRef,
        outcome: end.outcome,
        meta: { ...end.meta, replayedFrom: record.callNo, latencyMs: 0 },
        at: Date.now(),
      });
      tracked.done = true;
      if (end.outcome === 'ok') return { origin: 'replayed', callNo, outcome: 'ok', result: payload.result };
      return { origin: 'replayed', callNo, outcome: 'error', error: payload.error ?? { name: 'Error', message: 'recorded error' } };
    }

    if (kind !== 'tool') {
      // Clock and random values are generated here so the SDK needs no second round-trip.
      const result = kind === 'clock' ? Date.now() : body.name === 'uuid' ? randomUUID() : Math.random();
      this.store.appendCallEnd(identity, { runId: ctx.run.runId, callNo, attempt: 0, responseRef: this.store.putJson({ result }), outcome: 'ok', meta: {}, at: Date.now() });
      tracked.done = true;
      return { origin: 'live', callNo, outcome: 'ok', result };
    }

    if (decision.origin === 'blocked') {
      const error: SerializedError = { name: 'ShadowlapWriteBlocked', message: `write tool ${body.name} blocked after divergence (use --writes stub|allow to change this)` };
      this.store.appendCallEnd(identity, { runId: ctx.run.runId, callNo, attempt: 0, responseRef: this.store.putJson({ error }), outcome: 'error', meta: { error }, at: Date.now() });
      tracked.done = true;
      return { origin: 'blocked', callNo, outcome: 'error', error };
    }
    if (decision.origin === 'stubbed') return { origin: 'stubbed', callNo };
    return { origin: 'live', callNo };
  }

  private completeCall(ctx: RunContext, callNo: number, body: CompleteBody): void {
    const tracked = ctx.calls.get(callNo);
    if (!tracked) throw new HttpError(404, `unknown call ${callNo}`);
    if (tracked.done) throw new HttpError(409, `call ${callNo} already completed`);
    const outcome = body.outcome === 'error' ? 'error' : 'ok';
    const payload = outcome === 'ok' ? { result: body.result ?? null } : { error: body.error ?? { name: 'Error', message: 'unknown error' } };
    const meta: CallStartRow['meta'] = {};
    if (typeof body.latencyMs === 'number') meta.latencyMs = body.latencyMs;
    if (outcome === 'error' && body.error) meta.error = body.error;
    this.store.appendCallEnd(tracked.identity, { runId: ctx.run.runId, callNo, attempt: 0, responseRef: this.store.putJson(payload), outcome, meta, at: Date.now() });
    tracked.done = true;
  }

  private noteDivergence(ctx: RunContext): void {
    const d = ctx.session.divergence;
    if (d && !ctx.run.divergence) {
      ctx.run.divergence = d;
      this.store.setDivergence(ctx.run.runId, d);
      this.log(`run ${ctx.run.runId} diverged at call ${d.callNo} (${d.type})`);
    }
  }

  private loadRequest(rec: CallRecord): unknown {
    if (!rec.requestRef) return undefined;
    return rec.kind === 'api' ? loadApiRequest(this.store, rec.requestRef) : this.store.getJson<{ args?: unknown }>(rec.requestRef);
  }

  /**
   * Normalizers are a matching-time concern: a recording made before a normalizer was added must
   * still match under it. So a parent's fingerprints (and, since fingerprints partition occurrences,
   * its occurrence numbers) are recomputed from the stored requests under the current normalizers.
   */
  private refingerprint(calls: CallRecord[], normalizers: Normalizer[], clockRef: number | undefined, withoutPromptMask = false): CallRecord[] {
    const counts = new Map<string, number>();
    return calls.map((rec) => {
      let fingerprint = rec.fingerprint;
      try {
        if (rec.kind === 'api' && rec.requestRef) {
          const provider = this.providers.get(String(rec.meta.provider ?? ''));
          const [method = 'POST', ...pathParts] = rec.name.split(' ');
          const headers = (rec.meta.fingerprintHeaders as Record<string, string> | undefined) ?? {};
          if (provider) {
            fingerprint = fingerprintApi({ method, path: pathParts.join(' '), headers, body: loadApiRequest(this.store, rec.requestRef) }, normalizers, provider.fingerprintHeaders, clockRef, { withoutPrompt: withoutPromptMask }).fingerprint;
          }
        } else if (rec.kind === 'tool' && rec.requestRef) {
          const req = this.store.getJson<{ args?: unknown }>(rec.requestRef);
          fingerprint = fingerprintTool(rec.name, req?.args ?? null, normalizers, clockRef).fingerprint;
        }
      } catch (err) {
        this.log(`could not re-fingerprint call #${rec.callNo}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const k = `${rec.kind}\n${typeof rec.meta.scope === 'string' ? rec.meta.scope : ''}\n${fingerprint}`;
      const occurrence = (counts.get(k) ?? 0) + 1;
      counts.set(k, occurrence);
      return { ...rec, fingerprint, occurrence };
    });
  }
}

// ---- wire types shared with the SDKs ----

export interface ResolveBody {
  kind: CallKind;
  name: string;
  effect?: Effect;
  args?: unknown;
  label?: string;
  implHash?: string;
}

export type ResolveResponse =
  | { origin: 'replayed'; callNo: number; outcome: 'ok'; result: unknown }
  | { origin: 'replayed'; callNo: number; outcome: 'error'; error: SerializedError }
  | { origin: 'live'; callNo: number; outcome: 'ok'; result: unknown }
  | { origin: 'live'; callNo: number }
  | { origin: 'blocked'; callNo: number; outcome: 'error'; error: SerializedError }
  | { origin: 'stubbed'; callNo: number };

export interface CompleteBody {
  outcome: 'ok' | 'error';
  result?: unknown;
  error?: SerializedError;
  latencyMs?: number;
}

// ---- helpers ----

/** Coarse SDK language from a user agent; only ever used as a telemetry category. */
function sdkFamily(userAgent: string | undefined): string {
  const ua = (userAgent ?? '').toLowerCase();
  if (ua.includes('shadowlap-mcp')) return 'mcp';
  if (ua.includes('python')) return 'python';
  if (ua.includes('node') || ua.includes('undici') || ua.includes('bun') || ua.includes('deno')) return 'typescript';
  return 'other';
}

function isConversation(body: unknown): body is { messages: unknown[] } & Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && Array.isArray((body as { messages?: unknown }).messages);
}

/** The SDKs' `scope()`, from x-shadowlap-scope: printable, at most 200 characters, or none. */
function scopeOf(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-shadowlap-scope'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function lowerHeaders(h: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
  res.end(bytes);
}

/** A replay's flags, kept on the run so its page can name what made the fork (engine run-facts.ts). */
function interventionsMeta(input: StartRunInput): { interventions?: ReturnType<typeof describeInterventions> } {
  if (input.mode !== 'replay') return {};
  const list = describeInterventions(input.replay, input.interventions);
  return list.length ? { interventions: list } : {};
}
