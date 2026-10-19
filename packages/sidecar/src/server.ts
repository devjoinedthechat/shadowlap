import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
  matchedAs,
  configuredTrust,
  plantInToolResult,
  refused,
  storeApiRequest,
  normalizersHash,
  isRawNumber,
  parseJsonExact,
  reportable,
  storedModelResolver,
  summarizeRun,
  toolFailureError,
  unmaskedHints,
  type CallKind,
  type JudgeSummary,
  type CallMeta,
  type CallRecord,
  type ClockMode,
  type CallStartRow,
  type Decision,
  type DivergenceReport,
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
  type ToolFailure,
  type ToolTrust,
} from '@shadowlap/engine';
// The run page: what a run did that was never recorded, kept on the run (engine run-facts.ts).
import { recordNotRecorded, type OverrideSources } from '@shadowlap/engine';
// Judge checks: calls in the reserved scope, which only this process can make (judge.ts in the engine).
import { isJudgeCall, JUDGE_SCOPE, judgeRules, RESERVED_SCOPE_PREFIX, summarizeJudge } from '@shadowlap/engine';
import { decodeBody, encodeBody, keptResponseHeaders, matchHttpRule, storedRequestBody, storedResponseBytes, storedResult, withoutCredentials, withoutStoredCredentials, type HttpResult, type HttpRule } from './http.js';
import { describeInterventions, RequestInterventions, type CallPlace, type Interventions } from './interventions.js';
import { providers as defaultProviders, sdkBasesFromEnvironment, type Provider } from './providers.js';
import { credentialsFromEnvironment, resignSigV4, signingKeyId, type CredentialsFor } from './sigv4.js';
import { SseTimer } from './sse.js';

export type { Interventions } from './interventions.js';

/** Query parameters that carry a credential (a Gemini API key, a token, a presigned URL's signature): never kept. */
const SECRET_QUERY = /^(key|api[-_]?key|apikey|access[-_]?token|id[-_]?token|token|code|sig|signature|x-amz-.+|x-goog-.+)$/i;

/** A model call's query string as its recording keeps it: without `?` and without credentials; undefined when nothing is left. */
export function recordedQuery(search: string): string | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const name of [...new Set(params.keys())]) if (SECRET_QUERY.test(name)) params.delete(name);
  return params.toString() || undefined;
}

export interface SidecarOptions {
  store: Store;
  host?: string;
  port?: number;
  providers?: Provider[];
  normalizers?: Normalizer[];
  /** Per-provider upstream overrides, e.g. `{ anthropic: 'http://127.0.0.1:9999' }` for a mock. */
  upstreams?: Record<string, string>;
  /**
   * A provider's SDK base URL from before Shadowlap that is no root with the provider's SDK path
   * under it (`OPENAI_BASE_URL=https://models.github.ai/inference`). While it is also that provider's
   * upstream, a request is forwarded under it without the SDK path the agent's base URL adds:
   * `/v1/chat/completions` goes to `<base>/chat/completions`. Calls keep their names (`POST
   * /v1/chat/completions`), so a recording replays the same wherever its server was. Defaults to the
   * environment's (`sdkBasesFromEnvironment`).
   */
  sdkBases?: Record<string, string>;
  /** Cost estimates in summaries: USD per million tokens by model prefix, on top of the built-in table. */
  prices?: Record<string, Price>;
  /** `auto` (default): dates and timestamps near each run's start match whatever day the run happens on. `exact`: they must be equal. */
  clock?: ClockMode;
  /** HTTP hosts recorded as tools (see http.ts). The sidecar forwards captured HTTP calls only to these. */
  http?: HttpRule[];
  /**
   * The config's `tools`: each tool's trust, by its name or a captured HTTP call's host. Stamped on
   * every call of such a tool as it is made (`meta.trust`, `meta.trustFrom: 'config'`), so the run
   * keeps it wherever it is opened later; it never enters a fingerprint.
   */
  trust?: ToolTrust;
  log?: (line: string) => void;
  /**
   * More routes under `/v1/`, behind the same session token: a host that manages runs for other
   * processes (the test-suite recordings API) adds its endpoints here. Return undefined to fall
   * through to "unknown route".
   */
  api?: (route: ApiRoute) => Promise<{ status: number; body: unknown } | undefined>;
  /**
   * Credentials for signing a Bedrock request again after an intervention changed it, by the access
   * key the agent signed with. Defaults to the environment and the shared AWS files (sigv4.ts).
   */
  awsCredentials?: CredentialsFor;
}

export interface ApiRoute {
  method: string;
  /** The path after the token, e.g. `v1/recordings/start`. */
  path: string;
  body: () => Promise<unknown>;
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
  /** Where each `--override` result was read from, as typed (`{ 16: '@policy.json' }`): the run keeps the file's name, never the result. */
  overrideSources?: OverrideSources;
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

class RunContext {
  nextCallNo = 1;
  readonly calls = new Map<number, TrackedCall>();
  readonly lastByFingerprint = new Map<string, number>();
  /** With request interventions: the last model call by scope and the fingerprint of its request before any rewrite, so a retry keeps its call's place. */
  readonly lastByRequest = new Map<string, { callNo: number; place: CallPlace }>();
  readonly warnings: string[] = [];
  readonly providersUsed = new Set<string>();
  readonly sdksSeen = new Set<string>();
  readonly unguarded = new Map<string, { count: number; action: 'warned' | 'blocked' }>();
  private readonly warnedTools = new Set<string>();
  /**
   * An ended run opened again for its judge's calls alone (openForJudge): it takes nothing else, and
   * closing it leaves the run's status and end as they were. The first call number it gave out.
   */
  judgeOnly: { from: number } | null = null;

  constructor(
    readonly run: RunRecord,
    readonly session: Session,
    readonly interventions: RequestInterventions | null,
    /** The sidecar's normalizers plus the rules that redacted the parent, if any. */
    readonly normalizers: Normalizer[],
    readonly offline = false,
    readonly slot: string | null = null,
    /**
     * The reference times dates are masked against, or undefined to match them exactly: the run's
     * start, and for a replay its recording's too, since what the replay serves back from the
     * recording carries the recording's dates.
     */
    readonly clockRef: readonly number[] | undefined = undefined,
    /** `--prompt-from`: model calls are matched without their system prompt and tool definitions. */
    readonly withoutPrompt = false,
    /**
     * The rules that redacted the parent, which masked its captured HTTP calls' names: a live call
     * is matched by its name masked the same way (matchedAs).
     */
    readonly redactions: Normalizer[] = [],
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
 * is decoded, as fetch did: the headers passed on say nothing of its encoding. `inFlight` holds the
 * request until it has ended, so whoever owns the set can end it sooner (Sidecar.close).
 */
export function requestUpstream(url: string, method: string, headers: Record<string, string>, body: Buffer | null, inFlight?: Set<ClientRequest>): Promise<Response> {
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
    if (inFlight) {
      inFlight.add(req);
      // A request closes once its response has ended, a streamed body included, or it failed.
      req.once('close', () => inFlight.delete(req));
    }
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
  private readonly sdkBases: Record<string, string>;
  private readonly prices: Record<string, Price> | undefined;
  private readonly clock: ClockMode;
  /** HTTP hosts recorded as tools. */
  readonly httpRules: readonly HttpRule[];
  /** The config's trust marks, by tool name or host. */
  private readonly trust: ToolTrust | undefined;
  private readonly log: (line: string) => void;
  private readonly runs = new Map<string, RunContext>();
  private activeRunId: string | null = null;
  /** The run each slot's traffic belongs to. */
  private readonly slots = new Map<string, string>();
  private readonly api: SidecarOptions['api'];
  private readonly awsCredentials: CredentialsFor;
  /**
   * What a judge call carries (`x-shadowlap-judge`) besides the session token: a secret this process
   * alone knows, never in an agent's environment, so no call of the agent's can claim the judge's
   * scope, which replay strictness leaves out.
   */
  readonly judgeToken = randomBytes(16).toString('hex');

  /**
   * The same API over cleartext HTTP/2, for clients that only speak HTTP/2: the AWS SDK's Bedrock
   * runtime client opens every connection with http2.connect. In-process capture redirects those here.
   */
  readonly http2Url: string;
  private readonly http2Server: Http2Server;
  private readonly http2Sessions = new Set<ServerHttp2Session>();
  /** Upstream HTTP/2 connections, one per origin, for requests that arrived over HTTP/2. */
  private readonly upstreamHttp2 = new Map<string, ClientHttp2Session>();
  /** Requests upstream over HTTP/1.1 that have not ended yet: a model call still waiting for its answer, a body still streaming. */
  private readonly upstreamRequests = new Set<ClientRequest>();

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
    this.sdkBases = opts.sdkBases ?? sdkBasesFromEnvironment(process.env);
    this.prices = opts.prices;
    this.clock = opts.clock ?? 'auto';
    this.httpRules = opts.http ?? [];
    this.trust = opts.trust;
    this.log = opts.log ?? (() => {});
    this.api = opts.api;
    this.awsCredentials = opts.awsCredentials ?? credentialsFromEnvironment();
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
    // The servers close once every agent still connected has had its answer, so a request still
    // upstream now is one whose agent left before its answer came (stopped by Ctrl-C mid-call):
    // nobody is left to read it, and a slow model would keep this process running after it is done.
    for (const req of this.upstreamRequests) req.destroy();
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
    // Known before the parent is fingerprinted, which masks dates against it.
    const startedAt = Date.now();
    let parentCalls: CallRecord[] | undefined;
    let parentStartedAt: number | undefined;
    // Whether the parent was recorded with what a person types (RunMeta.inputs); see the Session.
    let parentRecordsInput = false;
    let normalizers = this.normalizers;
    let redactions: Normalizer[] = [];
    // A replay that runs a command other than its parent's (`replay <run> -- <command>`) says so in its record.
    let ownCommand: string[] | undefined;
    if (input.mode === 'replay') {
      if (!input.parentRunId) throw new HttpError(400, 'replay needs a parentRunId');
      const parent = this.store.getRun(input.parentRunId);
      if (!parent) throw new HttpError(404, `unknown run ${input.parentRunId}`);
      const argv = input.command.argv;
      if (argv.length && (argv.length !== parent.command.argv.length || argv.some((a, i) => a !== parent.command.argv[i]))) ownCommand = argv;
      // A redacted recording matches only if the live request is masked the same way.
      if (parent.meta?.redactions?.length) {
        redactions = parent.meta.redactions;
        normalizers = [...normalizers, ...redactions];
      }
      const stored = this.store.getCalls(input.parentRunId);
      // Stored fingerprints are valid under the list they were computed with; anything else recomputes them.
      parentStartedAt = parent.startedAt;
      parentRecordsInput = parent.meta?.inputs === true;
      if (input.replay?.promptFrom !== undefined) {
        const target = stored.find((c) => c.callNo === input.replay!.promptFrom);
        if (!target || target.kind !== 'api' || isJudgeCall(target)) throw new HttpError(400, `--prompt-from: call #${input.replay.promptFrom} is not a model call of run ${input.parentRunId}${target && isJudgeCall(target) ? ' (it is a judge check\'s)' : ''}`);
      }
      // Under "clock": "auto" both sides are masked against both runs' starts, and this run's start
      // is new, so the parent's stored fingerprints (made against its own start) never apply.
      if (this.clock === 'exact' && parent.meta?.normalizersHash === normalizersHash(normalizers, this.clock, input.replay?.promptFrom !== undefined)) {
        // A captured HTTP call is matched with the credentials in its query or form body masked, which
        // a recording made by an earlier version stored as sent: those calls are fingerprinted again.
        // A judge's call is matched by its request as sent (judgeFingerprint), whatever the normalizers: those are fingerprinted again too.
        const again = (c: CallRecord) => capturedHttp(c) || isJudgeCall(c);
        const some = stored.some(again);
        parentCalls = some ? this.refingerprint(stored, normalizers, undefined, input.replay?.promptFrom !== undefined, redactions, again) : stored;
        this.log(`run ${input.parentRunId}: reusing stored fingerprints (${stored.length} calls${some ? ', captured HTTP and judge calls fingerprinted again' : ''})`);
      } else {
        this.log(`run ${input.parentRunId}: re-fingerprinting ${stored.length} call${stored.length === 1 ? '' : 's'} under the current normalizers`);
        parentCalls = this.refingerprint(stored, normalizers, this.clock === 'auto' ? [parent.startedAt, startedAt] : undefined, input.replay?.promptFrom !== undefined, redactions);
      }
    }
    // Resolved against the parent before the run exists, so a target that is not a model call is refused with nothing created.
    // Flags name the agent's model calls: a judge's is never one of them, nor counted among them.
    const requestInterventions = input.interventions && parentCalls ? new RequestInterventions(parentCalls.filter((c) => !isJudgeCall(c)), input.interventions, (message) => {
      throw new HttpError(400, message);
    }) : null;
    // Every replay keeps the list, empty when it changed nothing, so a run made before replays kept
    // their flags (no list) is never taken for one that had none.
    const described = input.mode === 'replay' ? describeInterventions(input.replay, input.interventions, ownCommand, input.overrideSources) : null;
    const run = this.store.createRun({
      mode: input.mode,
      parentRunId: input.parentRunId ?? null,
      command: input.command,
      codeVersion: input.codeVersion ?? null,
      startedAt,
      meta: {
        normalizersHash: normalizersHash(normalizers, this.clock, input.replay?.promptFrom !== undefined),
        ...(input.commandFromImport ? { commandFromImport: true } : {}),
        ...(described ? { interventions: described } : {}),
      },
    });
    const clockRef = this.clock !== 'auto' ? undefined : parentStartedAt !== undefined ? [parentStartedAt, run.startedAt] : [run.startedAt];
    const session = new Session({
      mode: input.mode,
      parentRunId: input.parentRunId ?? null,
      ...(parentCalls ? { parentCalls } : {}),
      ...(input.replay ? { replay: input.replay } : {}),
      loadRequest: (rec) => this.loadRequest(rec),
      matchName: (rec) => this.matchName(rec),
      ...(clockRef !== undefined && parentStartedAt !== undefined ? { clock: { parent: parentStartedAt, run: run.startedAt } } : {}),
      ...(parentRecordsInput ? { parentRecordsInput } : {}),
    });
    this.runs.set(run.runId, new RunContext(run, session, requestInterventions, normalizers, input.offline === true, input.slot ?? null, clockRef, input.replay?.promptFrom !== undefined, redactions));
    if (input.slot !== undefined) this.slots.set(input.slot, run.runId);
    this.activeRunId = run.runId;
    this.log(`run ${run.runId} started (${input.mode})`);
    return run;
  }

  /**
   * Opens an ended run again for its judge's calls alone, as `pack` judges a recording: a request in
   * the scope `shadowlap:judge` with this process's judge token (see judgeToken) is recorded into it
   * after its own calls, answered from its parent's judge calls when it is a replay and the same
   * request is there, else live. Anything else is refused. `closeForJudge` closes it again, leaving
   * the run's status and end as they were. A run still going takes judge calls as it is.
   */
  openForJudge(runId: string): void {
    if (this.runs.has(runId)) return;
    const run = this.store.getRun(runId);
    if (!run) throw new HttpError(404, `unknown run ${runId}`);
    const parent = run.parentRunId ? this.store.getRun(run.parentRunId) : null;
    // A judge's request is matched by its bytes as sent, under the rules that redacted the parent
    // alone (judgeFingerprint); the run's own calls are matched as its replay matched them.
    const redactions = parent?.meta?.redactions ?? [];
    const normalizers = redactions.length ? [...this.normalizers, ...redactions] : this.normalizers;
    const clockRef = this.clock !== 'auto' ? undefined : parent ? [parent.startedAt, run.startedAt] : [run.startedAt];
    const recorded = parent ? this.refingerprint(this.store.getCalls(parent.runId).filter(isJudgeCall), normalizers, clockRef, false, redactions) : [];
    const session = new Session({ mode: parent ? 'replay' : 'record', parentRunId: parent?.runId ?? null, parentCalls: recorded });
    const ctx = new RunContext(run, session, null, normalizers, false, null, clockRef, false, redactions);
    ctx.nextCallNo = this.store.getCalls(runId).reduce((n, c) => Math.max(n, c.callNo), 0) + 1;
    ctx.judgeOnly = { from: ctx.nextCallNo };
    this.runs.set(runId, ctx);
    this.log(`run ${runId} opened for its judge`);
  }

  /** Closes a run `openForJudge` opened: what the judge's calls made through it did and cost, or null when it wasn't open for its judge. */
  closeForJudge(runId: string): JudgeSummary | null {
    const ctx = this.runs.get(runId);
    if (!ctx?.judgeOnly) return null;
    this.runs.delete(runId);
    const made = this.store.getCalls(runId).filter((c) => isJudgeCall(c) && c.callNo >= ctx.judgeOnly!.from);
    // Made by this process, whatever made the run: a recording that came from a pack had its own
    // calls made somewhere else, but these went upstream, and were paid for, here.
    return summarizeJudge(ctx.run, made, { ...(this.prices ? { prices: this.prices } : {}), modelOf: storedModelResolver(this.store), imported: false });
  }

  endRun(runId: string, status: Exclude<RunStatus, 'running'>): EndRunResult {
    const ctx = this.runs.get(runId);
    if (!ctx) throw new HttpError(404, `unknown run ${runId}`);
    if (ctx.judgeOnly) throw new HttpError(409, `run ${runId} has ended; it is open for its judge's calls only`);
    // A replay that never diverged but stopped before its recording did leaves it there: kept on
    // the run, so everything that reads the store tells it from a clean replay.
    if (ctx.session.end()) this.noteDivergence(ctx);
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
    // An intervention that never took effect leaves a run that looks like an answer to a question nobody asked.
    warnings.push(...ctx.session.unapplied(), ...(ctx.interventions?.unapplied() ?? []), ...(ctx.interventions?.warnings ?? []));
    // A model call --fail-at named, by its place among the recording's model calls, that the replay never made.
    warnings.push(...ctx.session.unappliedFailures());
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
      const body = (await readJson(req)) as Partial<StartRunInput> & {
        replay?: Partial<ReplayOptions> & { liveTools?: string[]; overrides?: Record<string, unknown>; failAt?: Record<string, number>; toolFailures?: Record<string, ToolFailure>; plants?: Record<string, string> };
        interventions?: Interventions;
      };
      if (body.mode !== 'record' && body.mode !== 'replay') throw new HttpError(400, 'mode must be record or replay');
      // Maps keyed by call number arrive as JSON objects.
      const byCall = <T>(o: Record<string, T> | undefined) => (o && typeof o === 'object' ? new Map(Object.entries(o).map(([k, v]) => [Number(k), v] as const)) : undefined);
      const replay = body.replay
        ? {
            ...body.replay,
            ...(body.replay.liveTools ? { liveTools: new Set(body.replay.liveTools) } : {}),
            ...(body.replay.overrides ? { overrides: byCall(body.replay.overrides)! } : {}),
            ...(body.replay.failAt ? { failAt: byCall(body.replay.failAt)! } : {}),
            ...(body.replay.toolFailures ? { toolFailures: byCall(body.replay.toolFailures)! } : {}),
            ...(body.replay.plants ? { plants: byCall(body.replay.plants)! } : {}),
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
      // Numbers kept as the SDK wrote them: a 64-bit id or a Python 20.0 is stored and served exactly.
      const body = (await readJson(req, true)) as ResolveBody;
      const ctx = this.contextFor(req, pinned);
      const { scope } = this.callScope(req, ctx, 'tool');
      ctx.sdksSeen.add(sdkFamily(req.headers['user-agent']));
      return json(res, 200, this.resolveCall(ctx, body, scope));
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
      const body = (await readJson(req, true)) as CompleteBody;
      this.completeCall(this.contextFor(req, pinned), Number(completeMatch[1]), body);
      return json(res, 200, { ok: true });
    }

    if (this.api) {
      const handled = await this.api({ method, path: rest, body: () => readJson(req) });
      if (handled) return json(res, handled.status, handled.body);
    }
    throw new HttpError(404, `unknown API route ${method} ${url.pathname}`);
  }

  /**
   * The scope a call is made in (scopeOf), and whether it is a judge's. A scope under `shadowlap:`
   * is Shadowlap's own: only a judge's model call may have one, `shadowlap:judge`, with this
   * process's judge token, so an agent's call can never be left out of the replay's strictness. A
   * run opened for its judge alone (openForJudge) takes no other call.
   */
  private callScope(req: IncomingMessage, ctx: RunContext, kind: 'api' | 'tool'): { scope: string | undefined; judge: JudgeAccess | null } {
    const scope = scopeOf(req);
    if (!scope?.startsWith(RESERVED_SCOPE_PREFIX)) {
      if (ctx.judgeOnly) throw new HttpError(409, `run ${ctx.run.runId} has ended; it is open for its judge's calls only`);
      return { scope, judge: null };
    }
    const sent = headerValue(req, 'x-shadowlap-judge');
    const token = Buffer.from(this.judgeToken);
    const own = kind === 'api' && scope === JUDGE_SCOPE && sent !== undefined && Buffer.byteLength(sent) === token.length && timingSafeEqual(Buffer.from(sent), token);
    if (!own) throw new HttpError(400, `the scope "${scope}" is reserved for Shadowlap's own calls; give the agent's scope another name`);
    const check = decodeHeader(headerValue(req, 'x-shadowlap-judge-check'));
    const ask = headerValue(req, 'x-shadowlap-judge-ask');
    // The version of the request it sends (JUDGE_REQUEST_VERSION), kept so a later version can say an older verdict is no answer for it.
    const version = headerValue(req, 'x-shadowlap-judge-version');
    // Where the judge is asked live: its own upstream, never one this sidecar points at a model under test.
    const upstream = headerValue(req, 'x-shadowlap-judge-upstream');
    if (upstream !== undefined && !/^https?:\/\/[^/\s]+/i.test(upstream)) throw new HttpError(400, `x-shadowlap-judge-upstream is not an http(s) URL: ${upstream}`);
    return {
      scope,
      judge: {
        offline: headerValue(req, 'x-shadowlap-judge-offline') === '1',
        ...(upstream ? { upstream: upstream.replace(/\/+$/, '') } : {}),
        ...(check && ask && /^[0-9a-f]{1,64}$/.test(ask) ? { meta: { check: check.slice(0, 200), ask, ...(version && /^\d{1,6}$/.test(version) ? { v: Number(version) } : {}) } } : {}),
      },
    };
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
    // A judge's call: no flag rewrites it, and the session matches it apart from the agent's.
    const { scope, judge } = this.callScope(req, ctx, 'api');
    const requested = this.requestedUpstream(req, provider, ctx);
    // The providers the agent used: a judge's is none of them.
    if (!judge) ctx.providersUsed.add(provider.id);
    const method = (req.method ?? 'GET').toUpperCase();
    let rawBody = await readBody(req);
    let headers = lowerHeaders(req.headers);
    let body: unknown;
    if (rawBody.length === 0) body = null;
    else {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        body = rawBody.toString('base64');
      }
    }
    const retryHeader = provider.retryCountHeader ? headers[provider.retryCountHeader] : undefined;
    const retryCount = retryHeader === undefined ? 0 : Number.parseInt(retryHeader, 10) || 0;

    // Interventions rewrite the request before it is fingerprinted, stored or forwarded, so the
    // recording of the fork holds exactly what was sent.
    let path = subpath;
    let forced: { by: string; counterpart: number } | undefined;
    let changedBy: string | undefined;
    let refusal: string | undefined;
    let counted: { key: string; place: CallPlace } | undefined;
    if (ctx.interventions?.active && !judge) {
      // A flag names a model call by its place among the recording's model calls (of its scope, when
      // the recording has scopes), counted the way the recording counts them: every one, whatever it
      // sends (an embeddings call too), and a retry as the call it retries. A retry is told apart as the
      // recording tells it, by its fingerprint, here of the request before any rewrite, so it gets the
      // same rewrite as the attempt it repeats.
      const key = `${scope ?? ''}\n${fingerprintApi({ method, path: subpath, headers, body }, ctx.normalizers, provider.fingerprintHeaders, ctx.clockRef, { withoutPrompt: ctx.withoutPrompt, matchPath: provider.matchPath?.(subpath) }).fingerprint}`;
      const same = ctx.lastByRequest.get(key);
      const repeats = same !== undefined && ctx.calls.get(same.callNo)?.retryable === true && (retryCount > 0 || retryHeader === undefined);
      counted = { key, place: repeats ? same!.place : ctx.interventions.next(scope) };
      const rewrite = ctx.interventions.apply(counted.place, provider.id, subpath, body);
      if ('refused' in rewrite) refusal = rewrite.refused;
      else {
        // At the call a flag named: a changed body diverges on its own, and its diff shows the
        // change; a model switched in the path, or a setting the request already had, is forced.
        if (rewrite.target) {
          if (rewrite.changed && rewrite.path === subpath) changedBy = rewrite.target.by;
          else forced = rewrite.target;
        }
        if (rewrite.changed) {
          path = rewrite.path;
          body = rewrite.body;
          rawBody = Buffer.from(JSON.stringify(body), 'utf8');
          // AWS signs a request's exact path and body: the changed one is signed again, or refused.
          if (signingKeyId(headers.authorization)) {
            const signed = this.resign(req, headers, method, path, search, rawBody);
            if ('error' in signed) refusal = `${rewrite.target?.by ?? 'the intervention'}: ${signed.error}`;
            else headers = signed.headers;
          }
        }
      }
    }

    // A request that carries planted text (shadowlap injection's canary) forks the replay there, even
    // when a normalizer masks the text into a match: the point of the plant is a model reading it.
    if (refusal === undefined && !forced && !changedBy && ctx.session.state === 'replaying' && ctx.session.options.plantMarks && ctx.session.carriesPlant(rawBody.toString('utf8'))) changedBy = ctx.session.options.plantMarks.by;

    const name = apiCallName(method, path);
    // What identifies the call, where the provider leaves part of its path out (Vertex AI's project and region).
    const matchPath = provider.matchPath?.(path);
    const matchName = matchPath !== undefined && matchPath !== path ? apiCallName(method, matchPath) : undefined;
    const { fingerprint } = judge ? judgeFingerprint({ method, path, headers, body }, ctx.redactions, provider, matchPath) : fingerprintApi({ method, path, headers, body }, ctx.normalizers, provider.fingerprintHeaders, ctx.clockRef, { withoutPrompt: ctx.withoutPrompt, matchPath });
    const fingerprintHeaders: Record<string, string> = {};
    for (const h of provider.fingerprintHeaders) if (headers[h] !== undefined) fingerprintHeaders[h] = headers[h]!;

    // A judge that may not be asked live, whose very request the recording never answered, is
    // answered by no one: nothing is kept of it, since a call no one answered holds no verdict, and
    // a run, or a pack of it, would only carry it.
    if (judge && (judge.offline || ctx.offline) && !ctx.session.judgedFor(fingerprint)) {
      const message = `shadowlap is offline: this judge check's request is not in the recording, and the judge may not be asked live`;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_offline', message } }));
      return;
    }

    // A retry of the previous attempt of the same call, rather than a new call.
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
      // A refused intervention still makes a call, answered with the reason: forced live, so it forks there.
      const by = refusal !== undefined ? { by: `an intervention it could not take (${refusal})` } : forced;
      const decision = ctx.session.resolve({ callNo, kind: 'api', name, fingerprint, request: body, headers: fingerprintHeaders, ...(matchName ? { matchName } : {}), ...(scope ? { scope } : {}), ...(by ? { forced: by } : changedBy ? { changedBy } : {}) });
      const origin = storedOrigin('api', decision);
      tracked = { identity: { kind: 'api', name, fingerprint, occurrence: decision.occurrence }, effect: null, origin, decision, ends: 0, retryable: false, done: false };
      ctx.calls.set(callNo, tracked);
      ctx.lastByFingerprint.set(retryKey, callNo);
      this.noteDivergence(ctx);
      const requestRef = storeApiRequest(this.store, body);
      // The query too, credentials left out: asking the call again (shadowlap decisions) sends it as the agent did.
      const query = recordedQuery(search);
      this.store.appendCallStart({
        runId: ctx.run.runId,
        callNo,
        ...tracked.identity,
        origin,
        effect: null,
        requestRef,
        meta: { retryCount, provider: provider.id, fingerprintHeaders, ...(query ? { query } : {}), ...(scope ? { scope } : {}), ...(judge?.meta ? { judge: judge.meta } : {}) },
        at: Date.now(),
      });
    }
    if (counted) ctx.lastByRequest.set(counted.key, { callNo, place: counted.place });
    if (refusal !== undefined) return this.serveRefusal(ctx, res, provider, callNo, tracked, refusal);

    // Checked after the retry branch and keyed by call number, so every attempt of an injected
    // failure fails. The interesting question is what the agent does when a call cannot succeed;
    // "the retry works" is what an ordinary replay already shows.
    const injected = ctx.session.injectedFailure(callNo);
    if (injected !== undefined) return this.serveInjectedFailure(ctx, res, provider, callNo, tracked, injected.status, injected.target);

    // Overrides apply to tool results only; for a model call an override decision is served as recorded.
    if (tracked.decision.origin === 'replayed' || tracked.decision.origin === 'overridden') return this.serveReplayed(ctx, res, callNo, tracked);
    // A judge with no way to be asked live (no key, say) is answered from the recording or not at all;
    // one that may be goes to its own upstream.
    return this.forward(ctx, req, res, provider, method, path, search, headers, rawBody, callNo, tracked, body, judge?.upstream ?? requested, judge?.offline === true, judge?.upstream !== undefined);
  }

  /**
   * A Bedrock request an intervention changed, signed again for the host the agent signed it for:
   * the HTTP/2 authority it arrived with, or the host in-process capture names.
   */
  private resign(req: IncomingMessage, headers: Record<string, string>, method: string, path: string, search: string, body: Buffer): { headers: Record<string, string> } | { error: string } {
    let host = headers[':authority'];
    if (!host) {
      const raw = req.headers['x-shadowlap-upstream'];
      try {
        host = new URL(String(Array.isArray(raw) ? raw[0] : raw)).host;
      } catch {
        host = headers.host;
      }
    }
    if (!host) return { error: 'the host the request was signed for is unknown' };
    return resignSigV4({ method, path, query: search.replace(/^\?/, ''), headers, body, host }, this.awsCredentials);
  }

  /**
   * Answers a model call an intervention could not be applied to, with the reason, instead of
   * sending it as the agent wrote it: a fork that silently isn't one is worse than an error.
   */
  private serveRefusal(ctx: RunContext, res: ServerResponse, provider: Provider, callNo: number, tracked: TrackedCall, reason: string): void {
    const message = `shadowlap could not apply ${reason}`;
    // In the provider's own error shape, so its client shows the reason: AWS clients read a top-level
    // message and the error type from a header; the others read error.message.
    const aws = provider.id === 'bedrock';
    const bytes = Buffer.from(JSON.stringify(aws ? { message } : { type: 'error', error: { type: 'shadowlap_intervention_refused', message } }), 'utf8');
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'x-shadowlap-origin': 'refused', ...(aws ? { 'x-amzn-errortype': 'ValidationException' } : {}) });
    res.end(bytes);
    const error: SerializedError = { name: 'ShadowlapInterventionRefused', message };
    this.store.appendCallEnd(tracked.identity, { runId: ctx.run.runId, callNo, attempt: tracked.ends++, responseRef: this.store.putBlob(bytes), outcome: 'error', meta: { status: 400, retryable: false, refused: true, error, latencyMs: 0 }, at: Date.now() });
    tracked.done = true;
    tracked.retryable = false;
    ctx.warnOnce(`refused:${reason}`, `Not applied: ${reason}. Call ${callNo} was answered with that reason instead of being sent.`);
    this.log(`run ${ctx.run.runId} call ${callNo}: refused ${reason}`);
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
  private serveInjectedFailure(ctx: RunContext, res: ServerResponse, provider: Provider, callNo: number, tracked: TrackedCall, status: number, target: number): void {
    const message = `injected failure: HTTP ${status} (shadowlap --fail-at ${target}=${status})`;
    // In the provider's own error shape, as a real failure arrives: AWS clients read a top-level
    // message and the error's type from a header, and branch on that type (ThrottlingException).
    const aws = provider.id === 'bedrock';
    const bytes = Buffer.from(JSON.stringify(aws ? { message } : { type: 'error', error: { type: 'shadowlap_injected', message } }), 'utf8');
    const retryable = provider.isRetryableStatus(status);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'x-shadowlap-origin': 'injected', ...(aws ? { 'x-amzn-errortype': awsErrorType(status) } : {}) });
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
    /** This call is answered from the recording or not at all (a judge with no key to ask it live). */
    offline = false,
    /** `requestedUpstream` is a judge's own, which wins over the upstream configured here. */
    judging = false,
  ): Promise<void> {
    // An upstream configured here wins (shadowlap test sets "offline"), then the one a captured
    // request names, then the provider's own default. A judge names its own.
    const upstream = ctx.offline || offline ? 'offline' : ((judging ? requestedUpstream : undefined) || this.upstreams[provider.id] || requestedUpstream || provider.upstream).replace(/\/$/, '');
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
    // An upstream that is the SDK's own base URL, with no `/v1` under it: the SDK's path goes straight under it.
    const sdkBase = this.sdkBases[provider.id];
    const sdkPath = provider.sdkPath;
    const sdkRelative = sdkBase !== undefined && sdkPath !== undefined && upstream === sdkBase.replace(/\/+$/, '') && (subpath === sdkPath || subpath.startsWith(`${sdkPath}/`));
    const upstreamPath = sdkRelative ? subpath.slice(sdkPath!.length) : subpath;
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
        ? await this.fetchOverHttp2(upstream.replace(/(https?:\/\/[^/]+).*/, '$1'), `${upstream.replace(/https?:\/\/[^/]+/, '')}${upstreamPath}${search}`, method, forwardHeaders, method === 'GET' || method === 'HEAD' ? null : rawBody, authority)
        : await requestUpstream(upstream + upstreamPath + search, method, forwardHeaders, method === 'GET' || method === 'HEAD' ? null : rawBody, this.upstreamRequests);
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
    // An upstream that asks another model than the request names says which (`shadowlap tasks score`'s takeover).
    const requestedModel = responseHeaders['x-shadowlap-model'] || provider.extractModel(subpath, requestBodyForMeta);
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
   * itself when it runs live, and only to a declared host. Request headers are never stored, nor
   * the credentials in its query string or form body (an API key, a token, a signature): the
   * request is stored and matched with them masked (withoutCredentials), so a rotated key still
   * replays, and only the live forward carries them.
   */
  private async proxyHttp(req: IncomingMessage, res: ServerResponse, subpath: string, search: string, pinned?: string): Promise<void> {
    const ctx = this.contextFor(req, pinned);
    const { scope } = this.callScope(req, ctx, 'tool');
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
    const requestBody = storedRequestBody(rawBody, contentType);
    const name = `${method} ${origin.host}${subpath}`;
    const url = `${origin.origin}${subpath}${search}`;
    const args = { method, url: `${origin.origin}${subpath}${withoutCredentials(search)}`, ...requestBody };
    // A redacted parent holds this call under its name masked (an address in the path): matched so.
    const matched = matchedAs({ kind: 'tool', name, meta: { http: origin.host } }, ctx.normalizers, ctx.redactions);
    const { fingerprint } = fingerprintTool(matched.name, args, matched.normalizers, ctx.clockRef);
    const callNo = ctx.nextCallNo++;
    const effect = rule.effect;
    const decision = ctx.session.resolve({ callNo, kind: 'tool', name, fingerprint, effect, request: { args }, ...(scope ? { scope } : {}), ...(matched.name !== name ? { recordedName: matched.name } : {}) });
    const identity: CallIdentity = { kind: 'tool', name, fingerprint, occurrence: decision.occurrence };
    const stored = storedOrigin('tool', decision);
    const tracked: TrackedCall = { identity, effect, origin: stored, decision, ends: 0, retryable: false, done: false };
    ctx.calls.set(callNo, tracked);
    this.noteDivergence(ctx);
    this.store.appendCallStart({ runId: ctx.run.runId, callNo, ...identity, origin: stored, effect, requestRef: this.store.putJson({ args }), meta: { http: origin.host, ...(scope ? { scope } : {}), ...this.trustMeta(name, origin.host, null) }, at: Date.now() });

    const end = (responseRef: string | null, outcome: 'ok' | 'error', meta: CallStartRow['meta']) => {
      this.store.appendCallEnd(identity, { runId: ctx.run.runId, callNo, attempt: 0, responseRef, outcome, meta, at: Date.now() });
      tracked.done = true;
    };
    const send = (result: HttpResult, from: string, bytes = encodeBody(result)) => {
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
      // The bytes the service sent, not the body written again: an agent that reads the text, or a
      // number JSON.parse would round, gets what it got then.
      if (payload.result) return send(payload.result, 'replayed', storedResponseBytes(payload.result, recorded.responseRef ? this.store.getBlob(recorded.responseRef) : null));
      return json(res, 502, { type: 'error', error: { type: 'shadowlap_replayed_error', message: payload.error?.message ?? 'the recorded call failed' } });
    }
    if (decision.origin === 'injected') {
      // A captured HTTP call fails the way HTTP does: with that status; or, for a timeout or an error,
      // the way the agent's HTTP library reports one. The capture hooks raise the library's own error
      // (a fetch TimeoutError, httpx.ReadTimeout, requests' ReadTimeout...) from an answer that names
      // the failure, and ask for one with x-shadowlap-failures: raise. Any other client gets the
      // connection closed before a response, which it reports as a network error.
      const f = decision.failure;
      const error = toolFailureError(name, f);
      end(this.store.putJson({ error }), 'error', { injected: true, failure: f, error, latencyMs: 0, ...(f.kind === 'status' ? { status: f.status } : {}) });
      this.log(`run ${ctx.run.runId} call ${callNo}: injected ${f.kind === 'status' ? `HTTP ${f.status}` : f.kind}`);
      if (f.kind === 'status') return json(res, f.status, { error: { message: error.message } });
      if (req.headers['x-shadowlap-failures'] !== 'raise') {
        res.destroy();
        return;
      }
      const bytes = Buffer.from(JSON.stringify({ error: { message: error.message } }), 'utf8');
      res.writeHead(f.kind === 'timeout' ? 504 : 502, {
        'content-type': 'application/json',
        'content-length': String(bytes.length),
        'x-shadowlap-origin': 'injected',
        'x-shadowlap-injected': f.kind,
        // Only a message the flag gave: without one, each library's own wording stands.
        ...(f.kind === 'error' && f.message ? { 'x-shadowlap-injected-message': encodeURIComponent(f.message) } : {}),
      });
      res.end(bytes);
      return;
    }
    if (decision.origin === 'planted') {
      const recorded = decision.record.end!;
      const payload = (recorded.responseRef ? this.store.getJson<{ result?: HttpResult; error?: SerializedError }>(recorded.responseRef) : null) ?? {};
      const planted = payload.result ? plantInToolResult(payload.result, decision.text, true) : { refused: 'it failed when it was recorded, so it has no response to add to' };
      if (refused(planted)) {
        ctx.session.declined(decision.record.callNo);
        ctx.warnOnce(`plant:${decision.record.callNo}`, `--inject-result ${decision.record.callNo} changed nothing: ${planted.refused}`);
        end(recorded.responseRef, recorded.outcome, { ...recorded.meta, replayedFrom: decision.record.callNo, latencyMs: 0 });
        if (payload.result) return send(payload.result, 'replayed', storedResponseBytes(payload.result, recorded.responseRef ? this.store.getBlob(recorded.responseRef) : null));
        return json(res, 502, { type: 'error', error: { type: 'shadowlap_replayed_error', message: payload.error?.message ?? 'the recorded call failed' } });
      }
      end(this.store.putJson({ result: planted.result }), 'ok', { overriddenFrom: decision.record.callNo, planted: planted.at, latencyMs: 0 });
      return send(planted.result as HttpResult, 'overridden');
    }
    if (decision.origin === 'overridden') {
      const value = decision.result as Partial<HttpResult> | null;
      const result: HttpResult = value && typeof value === 'object' && typeof value.status === 'number' ? { status: value.status, headers: value.headers ?? {}, ...(value.body !== undefined ? { body: value.body, encoding: value.encoding ?? 'json' } : {}) } : { status: 200, headers: { 'content-type': 'application/json' }, body: value, encoding: 'json' };
      end(this.store.putJson({ result }), 'ok', { overriddenFrom: decision.record.callNo, latencyMs: 0 });
      return send(result, 'overridden');
    }
    if (decision.origin === 'blocked') {
      if (effect === 'read') return fail(409, { name: 'ShadowlapReadBlocked', message: fencedRead(name) }, 'shadowlap_read_blocked');
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
      upstream = await requestUpstream(url, method, headers, rawBody.length && method !== 'GET' && method !== 'HEAD' ? rawBody : null, this.upstreamRequests);
      bytes = Buffer.from(await upstream.arrayBuffer());
    } catch (err) {
      return fail(502, { name: 'ShadowlapUpstreamError', message: `${name}: ${err instanceof Error ? err.message : String(err)}` }, 'shadowlap_upstream_error');
    }
    const result: HttpResult = { status: upstream.status, headers: keptResponseHeaders(upstream.headers), ...decodeBody(bytes, upstream.headers.get('content-type') ?? undefined) };
    end(this.store.putBlob(storedResult(result, bytes)), 'ok', { status: upstream.status, latencyMs: Date.now() - started, bytes: bytes.length });
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
    // A person's answer (`user_input`): after a fork it is served from the recording in order.
    const input = kind === 'tool' && body.input === true;
    // The session diffs requests as plain JSON, with an integer past 2^53 as its digits, as loadRequest reads the recorded side.
    const decision = ctx.session.resolve({ callNo, kind, name: body.name, fingerprint, effect, request: reportable(request), ...(scope ? { scope } : {}), ...(input ? { input } : {}) });
    const identity: CallIdentity = { kind, name: body.name, fingerprint, occurrence: decision.occurrence };
    const stored = storedOrigin(kind, decision);
    const tracked: TrackedCall = { identity, effect, origin: stored, decision, ends: 0, retryable: false, done: false };
    ctx.calls.set(callNo, tracked);
    this.noteDivergence(ctx);

    const meta: CallStartRow['meta'] = {};
    if (body.implHash) meta.implHash = body.implHash;
    if (scope) meta.scope = scope;
    if (input) meta.input = true;
    const mcp = kind === 'tool' ? mcpCallMeta(body.mcp) : undefined;
    if (mcp) meta.mcp = mcp;
    // A tool that brings outside text in, as the config's `tools`, the SDK's `trust` or an MCP
    // server's openWorldHint says. Kept on the call, never in its fingerprint: marking a tool changes no replay.
    if (kind === 'tool') Object.assign(meta, this.trustMeta(body.name, null, body.trust === 'untrusted' ? (mcp ? 'mcp' : 'sdk') : null));
    this.store.appendCallStart({ runId: ctx.run.runId, callNo, ...identity, origin: stored, effect, requestRef: this.store.putJson(request), meta, at: Date.now() });

    if (decision.origin === 'injected') {
      // The tool does not run. Its error is stored as Shadowlap's, and the SDK raises it as the kind
      // of failure asked for; a client that predates this raises it as a replayed error.
      const error = toolFailureError(body.name, decision.failure);
      this.store.appendCallEnd(identity, { runId: ctx.run.runId, callNo, attempt: 0, responseRef: this.store.putJson({ error }), outcome: 'error', meta: { injected: true, failure: decision.failure, error, latencyMs: 0 }, at: Date.now() });
      tracked.done = true;
      this.log(`run ${ctx.run.runId} call ${callNo}: injected ${decision.failure.kind} into ${body.name}`);
      return { origin: 'replayed', callNo, outcome: 'error', error, injected: decision.failure };
    }

    if (decision.origin === 'planted') {
      const record = decision.record;
      const end = record.end!;
      const payload = (end.responseRef ? this.store.getJson<{ result?: unknown; error?: SerializedError }>(end.responseRef) : null) ?? {};
      const planted = end.outcome === 'ok' ? plantInToolResult(payload.result, decision.text, false) : { refused: 'it failed when it was recorded, so it has no result to add to' };
      if (!refused(planted)) {
        this.store.appendCallEnd(identity, { runId: ctx.run.runId, callNo, attempt: 0, responseRef: this.store.putJson({ result: planted.result }), outcome: 'ok', meta: { overriddenFrom: record.callNo, planted: planted.at, latencyMs: 0 }, at: Date.now() });
        tracked.done = true;
        return { origin: 'replayed', callNo, outcome: 'ok', result: planted.result };
      }
      // Served as recorded, and said: the run is a clean replay, not the attack it was asked for.
      ctx.session.declined(record.callNo);
      ctx.warnOnce(`plant:${record.callNo}`, `--inject-result ${record.callNo} changed nothing: ${planted.refused}`);
      this.store.appendCallEnd(identity, { runId: ctx.run.runId, callNo, attempt: 0, responseRef: end.responseRef, outcome: end.outcome, meta: { ...end.meta, replayedFrom: record.callNo, latencyMs: 0 }, at: Date.now() });
      tracked.done = true;
      if (end.outcome === 'ok') return { origin: 'replayed', callNo, outcome: 'ok', result: (end.responseRef ? this.getJsonExact<{ result?: unknown }>(end.responseRef) : null)?.result };
      return { origin: 'replayed', callNo, outcome: 'error', error: payload.error ?? { name: 'Error', message: 'recorded error' } };
    }

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
      // Read with each number as it was recorded, so the SDK gets back exactly what the tool returned.
      const payload = (end.responseRef ? this.getJsonExact<{ result?: unknown; error?: SerializedError }>(end.responseRef) : null) ?? {};
      if (kind === 'tool' && body.implHash && record.meta.implHash && record.meta.implHash !== body.implHash && !ctx.session.options.liveTools.has(body.name)) {
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
      const error: SerializedError = effect === 'read' ? { name: 'ShadowlapReadBlocked', message: fencedRead(`read tool ${body.name}`) } : { name: 'ShadowlapWriteBlocked', message: `write tool ${body.name} blocked after divergence (use --writes stub|allow to change this)` };
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
    const latency = isRawNumber(body.latencyMs) ? Number(body.latencyMs.rawJSON) : body.latencyMs;
    if (typeof latency === 'number') meta.latencyMs = latency;
    if (outcome === 'error' && body.error) meta.error = body.error;
    this.store.appendCallEnd(tracked.identity, { runId: ctx.run.runId, callNo, attempt: 0, responseRef: this.store.putJson(payload), outcome, meta, at: Date.now() });
    tracked.done = true;
  }

  /**
   * A tool call's trust, as its start row keeps it: the config's word for its name or host, either
   * way, else `untrusted` from `declared` (the SDK's `trust`, an MCP server's openWorldHint), else nothing.
   */
  private trustMeta(name: string, host: string | null, declared: 'sdk' | 'mcp' | null): Pick<CallMeta, 'trust' | 'trustFrom'> {
    const configured = configuredTrust(this.trust, name, host);
    if (configured) return { trust: configured, trustFrom: 'config' };
    return declared ? { trust: 'untrusted', trustFrom: declared } : {};
  }

  /** A divergence with these hints in place of its own, none kept as no list. */
  private static withHints(d: DivergenceReport, hints: NonNullable<DivergenceReport['hints']>): DivergenceReport {
    const { hints: _dropped, ...rest } = d;
    return hints.length ? { ...rest, hints } : rest;
  }

  private noteDivergence(ctx: RunContext): void {
    const found = ctx.session.divergence;
    if (found && !ctx.run.divergence) {
      // A hint for a change the run's rules mask would ask for a rule the config has: the report
      // still lists the change, as the request carried it, but it didn't make the replay diverge.
      const hints = found.hints?.length ? unmaskedHints(found, ctx.normalizers) : null;
      const d = hints && hints.length !== found.hints!.length ? Sidecar.withHints(found, hints) : found;
      ctx.run.divergence = d;
      this.store.setDivergence(ctx.run.runId, d);
      this.log(`run ${ctx.run.runId} diverged at call ${d.callNo} (${d.type})`);
    }
  }

  /** A stored JSON blob with each number as it was written (parseJsonExact): for what is served back and fingerprinted. */
  private getJsonExact<T>(ref: string): T | null {
    const bytes = this.store.getBlob(ref);
    return bytes ? (parseJsonExact(bytes.toString('utf8')) as T) : null;
  }

  /** A recorded model call's name as matching reads it (`Provider.matchPath`): a Vertex AI call without its project and region. */
  private matchName(rec: CallRecord): string {
    const provider = rec.kind === 'api' && typeof rec.meta.provider === 'string' ? this.providers.get(rec.meta.provider) : undefined;
    if (!provider?.matchPath) return rec.name;
    const [method = 'POST', ...pathParts] = rec.name.split(' ');
    return apiCallName(method, provider.matchPath(pathParts.join(' ')));
  }

  private loadRequest(rec: CallRecord): unknown {
    if (!rec.requestRef) return undefined;
    if (rec.kind === 'api') return loadApiRequest(this.store, rec.requestRef);
    const req = reportable(this.getJsonExact<{ args?: unknown }>(rec.requestRef)) as { args?: unknown } | null;
    // A captured HTTP call is diffed as it is matched: no credential as sent from an older recording.
    return capturedHttp(rec) && req ? { ...req, args: withoutStoredCredentials(req.args) } : req;
  }

  /**
   * Normalizers are a matching-time concern: a recording made before a normalizer was added must
   * still match under it. So a parent's fingerprints (and, since fingerprints partition occurrences,
   * its occurrence numbers) are recomputed from the stored requests under the current normalizers.
   * A captured HTTP call is fingerprinted under its name masked by the rules that redacted the
   * parent (`redactions`, matchedAs), as proxyHttp fingerprints a live one; a redacted copy already
   * holds it so. Its arguments are read with their credentials masked (withoutStoredCredentials),
   * as proxyHttp stores a live call's. `only` limits the calls fingerprinted again; the others keep
   * their stored fingerprints, and every call's occurrence is counted again.
   */
  private refingerprint(calls: CallRecord[], normalizers: Normalizer[], clockRef: readonly number[] | undefined, withoutPromptMask = false, redactions: Normalizer[] = [], only?: (rec: CallRecord) => boolean): CallRecord[] {
    const counts = new Map<string, number>();
    return calls.map((rec) => {
      let fingerprint = rec.fingerprint;
      try {
        if (only && !only(rec)) {
          // Valid as stored.
        } else if (isJudgeCall(rec) && rec.kind === 'api' && rec.requestRef) {
          // A judge's call is matched by its request as sent, not as the agent's calls are.
          const provider = this.providers.get(String(rec.meta.provider ?? ''));
          const [method = 'POST', ...pathParts] = rec.name.split(' ');
          const headers = (rec.meta.fingerprintHeaders as Record<string, string> | undefined) ?? {};
          if (provider) {
            const path = pathParts.join(' ');
            fingerprint = judgeFingerprint({ method, path, headers, body: loadApiRequest(this.store, rec.requestRef) }, redactions, provider, provider.matchPath?.(path)).fingerprint;
          }
        } else if (rec.kind === 'api' && rec.requestRef) {
          const provider = this.providers.get(String(rec.meta.provider ?? ''));
          const [method = 'POST', ...pathParts] = rec.name.split(' ');
          const headers = (rec.meta.fingerprintHeaders as Record<string, string> | undefined) ?? {};
          if (provider) {
            const path = pathParts.join(' ');
            fingerprint = fingerprintApi({ method, path, headers, body: loadApiRequest(this.store, rec.requestRef) }, normalizers, provider.fingerprintHeaders, clockRef, { withoutPrompt: withoutPromptMask, matchPath: provider.matchPath?.(path) }).fingerprint;
          }
        } else if (rec.kind === 'tool' && rec.requestRef) {
          const req = this.getJsonExact<{ args?: unknown }>(rec.requestRef);
          const matched = matchedAs(rec, normalizers, redactions);
          const args = capturedHttp(rec) ? withoutStoredCredentials(req?.args) : req?.args;
          fingerprint = fingerprintTool(matched.name, args ?? null, matched.normalizers, clockRef).fingerprint;
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
  /** The call is a person's input, recorded as the `user_input` tool (see docs/protocol.md). */
  input?: boolean;
  /** The call came through `shadowlap mcp`: from which server, and the tools it offers (see docs/protocol.md). */
  mcp?: unknown;
  /** `untrusted`: the tool brings outside text in, where `shadowlap injection` plants (see docs/protocol.md). */
  trust?: 'trusted' | 'untrusted';
}

/** `mcp` from a resolve body, checked and bounded, as call meta; undefined when it isn't one. */
function mcpCallMeta(raw: unknown): CallMeta['mcp'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { transport, server, tools } = raw as Record<string, unknown>;
  if ((transport !== 'stdio' && transport !== 'http') || typeof server !== 'string' || !server) return undefined;
  const text = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  const listed = Array.isArray(tools)
    ? tools
        .slice(0, 1000)
        .filter((t): t is { name: string; effect: Effect; trust?: unknown } => typeof t === 'object' && t !== null && typeof t.name === 'string' && (t.effect === 'pure' || t.effect === 'read' || t.effect === 'write'))
        .map((t) => ({ name: text(t.name), effect: t.effect, ...(t.trust === 'untrusted' ? { trust: 'untrusted' as const } : {}) }))
    : undefined;
  return { transport, server: text(server), ...(listed ? { tools: listed } : {}) };
}

export type ResolveResponse =
  | { origin: 'replayed'; callNo: number; outcome: 'ok'; result: unknown }
  /**
   * A recorded error, or (with `injected`) a failure `--fail-at` asked for: the tool doesn't run and
   * the SDK raises a timeout, the given error, or an HTTP-shaped error with the status. A client that
   * doesn't know `injected` raises its replayed-error type with the same name and message.
   */
  | { origin: 'replayed'; callNo: number; outcome: 'error'; error: SerializedError; injected?: ToolFailure }
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

/** The error type Bedrock answers a status with, as its clients name the exception they raise. */
function awsErrorType(status: number): string {
  const named: Record<number, string> = {
    400: 'ValidationException',
    401: 'UnrecognizedClientException',
    403: 'AccessDeniedException',
    404: 'ResourceNotFoundException',
    408: 'ModelTimeoutException',
    409: 'ConflictException',
    424: 'ModelErrorException',
    429: 'ThrottlingException',
    500: 'InternalServerException',
    503: 'ServiceUnavailableException',
  };
  return named[status] ?? (status >= 500 ? 'InternalServerException' : 'ValidationException');
}

/**
 * What the agent gets for a read the replay fenced (`unrecordedReads: 'fence'`, or one carrying
 * planted text): an error, as for a blocked write, so the model hears the read failed and carries on.
 */
const fencedRead = (what: string) => `${what} was not run: this replay answers only the reads its recording holds`;

/** How a decision is stored: a planted result as overridden, a failure Shadowlap answered as live (with `injected` on its end). */
function storedOrigin(kind: CallKind, decision: Decision): Origin {
  if (decision.origin === 'planted') return 'overridden';
  if (decision.origin === 'injected') return 'live';
  // Overrides apply to tool results; a model call matched under one is a plain replay.
  if (decision.origin === 'overridden' && kind === 'api') return 'replayed';
  return decision.origin;
}

/** A call to a host under `http` in the config, recorded as a tool (proxyHttp). */
function capturedHttp(rec: Pick<CallRecord, 'kind' | 'meta'>): boolean {
  return rec.kind === 'tool' && typeof rec.meta.http === 'string';
}

/**
 * The SDKs' `scope()`, from x-shadowlap-scope: printable, at most 200 characters, or none. Clients
 * percent-encode `%` and what isn't printable ASCII, so a name in any language fits a header; a value
 * that doesn't decode is taken as it was sent.
 */
function scopeOf(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-shadowlap-scope'];
  let value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value?.includes('%')) {
    try {
      value = decodeURIComponent(value).trim();
    } catch {
      // not percent-encoded: a client from before scopes were encoded
    }
  }
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/**
 * What a judge's call asked for, besides its scope: `offline`, to be answered from the recording or
 * not at all, when there is no way to ask the judge live; and the check it answers, kept on the call
 * (`CallMeta.judge`).
 */
interface JudgeAccess {
  offline: boolean;
  /** Where to ask the judge live, when it may be: its provider's upstream as the environment names it, or the provider's own. */
  upstream?: string;
  meta?: { check: string; ask: string; v?: number };
}

/**
 * How a judge's request is matched against the recording: by its bytes as sent, with none of the
 * project's normalizers and no masking of dates or prompts, since the judge read all of it and its
 * verdict answers those bytes alone. The rules that redacted the recording, those that reach a
 * judge's request (judgeRules), apply as a copy applied them, so a pack's masked request still
 * matches the one a replay sends. Nothing is matched fuzzily because of a judge.
 */
function judgeFingerprint(req: { method: string; path: string; headers: Record<string, string>; body: unknown }, redactions: readonly Normalizer[], provider: Provider, matchPath: string | undefined): { fingerprint: string } {
  return fingerprintApi(req, judgeRules(redactions), provider.fingerprintHeaders, undefined, { matchPath });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value : undefined;
}

/** A percent-encoded header value as text, printable and at most 200 characters, or undefined. */
function decodeHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let text = value;
  try {
    text = decodeURIComponent(value);
  } catch {
    // sent as it is
  }
  return text && !/[\u0000-\u001f\u007f]/.test(text) ? text.slice(0, 200) : undefined;
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

/** A request's JSON body; `exact` keeps each number as written (parseJsonExact), for what is stored and served back. */
async function readJson(req: IncomingMessage, exact = false): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return exact ? parseJsonExact(raw.toString('utf8')) : JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length) });
  res.end(bytes);
}
