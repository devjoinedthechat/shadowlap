import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectHttp2, createServer as createHttp2Server, type ClientHttp2Session, type Http2Server, type ServerHttp2Session } from 'node:http2';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import {
  Session,
  apiCallName,
  fingerprintApi,
  fingerprintMisc,
  fingerprintTool,
  loadApiRequest,
  matchable,
  matchedAs,
  multipartView,
  configuredTrust,
  credentialFreeQuery,
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
  type CallEndRow,
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
import { allowedHeaders, clockMarks, decodeMarks, encodeMarks, fingerprintKey, rulesId, servesClock, type ClockMark, type FingerprintRules } from './fingerprint-cache.js';
import { decodeBody, encodeBody, keptResponseHeaders, matchHttpRule, storedRequestBody, storedResponseBytes, storedResult, withoutCredentials, withoutStoredCredentials, type HttpResult, type HttpRule } from './http.js';
import { describeInterventions, RequestInterventions, type CallPlace, type Interventions } from './interventions.js';
import { identityQuery } from './query.js';
import { carriesPlaceholder, PLACEHOLDER_AWS_ACCESS_KEY_ID, placeholderRefusal } from './placeholders.js';
import { activeProviders, formatHostProvider, hostedProviders, providers as defaultProviders, sdkBasesFromEnvironment, type FormatHost, type Provider } from './providers.js';
import { credentialsFromEnvironment, resignSigV4, signingKeyId, type CredentialsFor } from './sigv4.js';
import { SseTimer } from './sse.js';
import { isTelemetry } from './telemetry.js';
import { asResponse, requestUpstream } from './upstream.js';
import { refuseUpgrade, tunnelWebSocket } from './websocket.js';
import { StoreWriter, type StoreWrites } from './writer.js';

export type { Interventions } from './interventions.js';
export { requestUpstream } from './upstream.js';

export interface SidecarOptions {
  store: Store;
  host?: string;
  port?: number;
  providers?: Provider[];
  /**
   * Hosts of another provider's wire format to serve besides the built-in providers (`providers` in
   * shadowlap.config.json). Defaults to those the config declared (declareFormatHosts).
   */
  formats?: FormatHost[];
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
  /**
   * How long the calls' writes wait for a store another process holds (writer.ts): at most `waitMs`
   * (50) at a time, on the thread the answers stream on, and `deadlineMs` (10,000) in all, retried
   * on a timer, before a write counts as failed.
   */
  storeWrites?: StoreWrites;
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
  /** WebSockets under a provider, by provider and path: tunnelled live and never recorded, or refused (an offline replay). */
  websockets: WebSocketUse[];
}

export interface WebSocketUse {
  /** The provider and path, `openai /v1/realtime`. */
  target: string;
  count: number;
  action: 'tunnelled' | 'refused';
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
  /** Attempt numbers given out: an attempt takes its number as it starts, so two at once never share one. */
  attempts: number;
  /** Attempts started and not ended yet. */
  inFlight: number;
  /** Whether the latest attempt failed in a way the agent's client retries: the call then waits for that retry (RunContext.retries). */
  retryable: boolean;
  /** Set once an attempt has ended (tool calls await `complete`). */
  done: boolean;
  /** The queue of RunContext.retries a retry of this call is looked for in. */
  retryKey?: string;
  /** Its place among the recording's model calls, as interventions count them. */
  place?: CallPlace;
}

class RunContext {
  nextCallNo = 1;
  readonly calls = new Map<number, TrackedCall>();
  /**
   * Calls whose last attempt failed in a way the agent's client retries and that have nothing in
   * flight, oldest failure first, by what identifies their request (its scope and fingerprint, or with
   * interventions its fingerprint before any rewrite). The next identical request that reads as a
   * retry is the first one's, so identical calls made at once (best-of-n sampling) each keep their
   * own answer however their retries interleave.
   */
  readonly retries = new Map<string, number[]>();
  /** WebSockets under a provider this run tunnelled or refused, by provider and path. */
  readonly websockets = new Map<string, { count: number; action: 'tunnelled' | 'refused' }>();
  /** The run's normalizers and its judge's rules as a fingerprint cache key names them, worked out once. */
  private ruleIds: { normalizers: string; judge: string } | null = null;
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
    /**
     * The providers whose calls in the parent name no API version (`Provider.apiVersion`), as a
     * trace's never do: a live call to one is matched and kept without the version it names.
     */
    readonly unversioned: ReadonlySet<string> = new Set(),
    /**
     * The providers none of whose model calls in the parent kept a query (`meta.query`), as a
     * recording made before calls kept one, or a trace's, never does: a live call to one is matched,
     * and kept, without its query.
     */
    readonly unqueried: ReadonlySet<string> = new Set(),
  ) {}

  warnOnce(tool: string, message: string): void {
    if (this.warnedTools.has(tool)) return;
    this.warnedTools.add(tool);
    this.warnings.push(message);
  }

  /** The run's rules as a fingerprint cache key names them (fingerprint-cache.ts). */
  get rules(): { normalizers: string; judge: string } {
    return (this.ruleIds ??= { normalizers: rulesId(this.normalizers), judge: rulesId(judgeRules(this.redactions)) });
  }

  /** The oldest call waiting for a retry of the request `key` identifies, now waiting no more; undefined when none is. */
  claimRetry(key: string): number | undefined {
    const waiting = this.retries.get(key);
    while (waiting?.length) {
      const callNo = waiting.shift()!;
      const call = this.calls.get(callNo);
      if (call?.retryable && call.inFlight === 0) return callNo;
    }
    return undefined;
  }

  /** Puts a call whose attempt just failed retryably at the back of its request's retry queue. */
  awaitRetry(callNo: number, key: string): void {
    const waiting = this.retries.get(key);
    if (waiting) waiting.push(callNo);
    else this.retries.set(key, [callNo]);
  }
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
// No content-encoding: requestUpstream drops it once it has decoded the body, and an encoding it
// can't decode goes on to the agent with its body as it came.
const RESPONSE_DROP = new Set([...HOP_BY_HOP, 'content-length']);

/** A call's attempt that ended without an answer because the agent's connection closed first. */
const clientLeft = (when: string): SerializedError => ({ name: 'ClientDisconnected', message: `the client closed the connection ${when}` });

/**
 * The agent's side of a request: whether it has gone, its connection closed before its answer was
 * whole, and the signal that ends whatever is still upstream for it when it does. Watched from the
 * moment the request arrives, so a client that times out before the headers is seen as well.
 */
class ClientWatch {
  gone = false;
  private readonly controller = new AbortController();
  private readonly onGone: Array<() => void> = [];

  constructor(res: ServerResponse) {
    // Over HTTP/2 a response the client reset reads as finished, but never as ended by the sidecar.
    res.once('close', () => {
      if (!res.writableEnded || !res.writableFinished) this.leave();
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Calls `f` once the agent has gone; at once when it has. */
  whenGone(f: () => void): void {
    if (this.gone) f();
    else this.onGone.push(f);
  }

  private leave(): void {
    if (this.gone) return;
    this.gone = true;
    this.controller.abort(new Error('the client closed the connection'));
    for (const f of this.onGone.splice(0)) f();
  }
}

/** A model call as the agent sent it: its run and provider, and its request as interventions leave it. */
interface ModelCall {
  ctx: RunContext;
  req: IncomingMessage;
  res: ServerResponse;
  client: ClientWatch;
  provider: Provider;
  scope: string | undefined;
  judge: JudgeAccess | null;
  /** The upstream a captured request named (`x-shadowlap-upstream`), once its provider vouched for it. */
  requested: string | undefined;
  method: string;
  /** The path as the agent sent it, and as the call is named and forwarded (an intervention may switch the model in it). */
  sent: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  rawBody: Buffer;
  body: unknown;
  retryCount: number;
  /** Whether a request identical to one that failed retryably is its retry: its client counts retries and this is one, or it counts none. */
  retrying: boolean;
}

/** What interventions made of a model request (rewriteForInterventions): its place, the call it retries if it is a retry, and how it changed. */
interface Rewritten {
  retryKey?: string;
  claimed?: number;
  place?: CallPlace;
  refusal?: string;
  forced?: { by: string; counterpart: number };
  changedBy?: string;
}

/** A model call once resolved: which call it is, and why an intervention could not be applied to it, if it couldn't. */
interface PlacedCall {
  callNo: number;
  tracked: TrackedCall;
  refusal?: string;
}

/** A live attempt under way: when it started, how it ends for the agent (once), and how its end is recorded. */
interface LiveAttempt {
  started: number;
  settle(retryable: boolean): void;
  end(row: Omit<AttemptEnd, 'attempt'>): void;
}

/** An attempt's end as it is recorded: the answer the agent got (`response`, stored when written), or one already stored. */
interface AttemptEnd {
  attempt: number;
  outcome: 'ok' | 'error';
  meta: CallStartRow['meta'];
  response?: Buffer;
  responseRef?: string | null;
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
  /** The providers calls are routed to, `/<id>/…`. */
  private readonly providers: Map<string, Provider>;
  /** Every provider by id, the hosts reached through another's route among them (hostedProviders), for reading a recorded call's `via`. */
  private readonly byId: Map<string, Provider>;
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
  /** Every write of the calls to the store, in order, never holding up an answer (writer.ts). */
  private readonly writer: StoreWriter;
  /** WebSockets tunnelled and still open: an agent's connections, ended when the sidecar closes. */
  private readonly tunnels = new Set<Duplex>();
  /**
   * Set by close() once no agent is connected. A call still being handled then is one whose agent
   * left before its answer came: it records and reports nothing more, since nobody is left to read
   * it and the store may close as soon as close() returns.
   */
  private closed = false;

  private constructor(opts: SidecarOptions, server: Server, url: string, token: string, http2Server: Http2Server, http2Url: string) {
    this.store = opts.store;
    this.server = server;
    this.http2Server = http2Server;
    this.http2Url = http2Url;
    this.url = url;
    this.token = token;
    this.providers = new Map((opts.providers ?? (opts.formats ? [...defaultProviders, ...opts.formats.map(formatHostProvider)] : activeProviders())).map((p) => [p.id, p]));
    this.byId = new Map([...hostedProviders, ...this.providers.values()].map((p) => [p.id, p]));
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
    this.writer = new StoreWriter(opts.store, opts.storeWrites ?? {}, (line) => this.log(line));
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
      sidecar
        .handle(req, res)
        .catch((err: unknown) => {
          const status = err instanceof HttpError ? err.status : 500;
          const message = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_error', message } }));
          } else {
            res.destroy();
          }
          sidecar.log(`error: ${message}`);
        })
        // The call is answered: a divergence it made is compared with the recording now, off its path.
        .finally(() => sidecar.explainWaiting());
    });
    // A WebSocket under a provider (OpenAI Realtime), tunnelled to it.
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => sidecar.upgrade(req, socket, head));
    return sidecar;
  }

  /**
   * A request forwarded over HTTP/2, as a fetch Response so recording and streaming don't care how
   * it travelled. Needed for fidelity, not speed: a client that signs over HTTP/2 (the AWS SDK)
   * signs the `:authority` pseudo-header, which an HTTP/1.1 request cannot carry. A compressed body
   * is decoded as it is over HTTP/1.1 (asResponse), and `signal` ends the request when its agent has gone.
   */
  private fetchOverHttp2(origin: string, path: string, method: string, headers: Record<string, string>, body: Buffer | null, authority: string, signal?: AbortSignal): Promise<Response> {
    let session = this.upstreamHttp2.get(origin);
    if (!session || session.closed || session.destroyed) {
      session = connectHttp2(origin);
      session.on('error', () => this.upstreamHttp2.delete(origin));
      session.on('close', () => this.upstreamHttp2.delete(origin));
      this.upstreamHttp2.set(origin, session);
    }
    const scheme = new URL(origin).protocol.replace(':', '');
    const stream = session.request({ ...headers, ':method': method, ':path': path, ':authority': authority, ':scheme': scheme }, { endStream: !body, ...(signal ? { signal } : {}) });
    if (body) stream.end(body);
    return new Promise((resolve, reject) => {
      // Every error, not just the first: a stream that fails again later must not go unheard.
      stream.on('error', reject);
      stream.once('response', (h) => {
        try {
          const status = Number(h[':status']);
          const out = new Headers();
          for (const [k, v] of Object.entries(h)) {
            if (k.startsWith(':') || v === undefined) continue;
            out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
          }
          const noBody = method === 'HEAD' || status === 204 || status === 304;
          if (noBody) stream.resume();
          resolve(asResponse(status, out, noBody ? null : stream));
        } catch (err) {
          stream.destroy();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async close(): Promise<void> {
    for (const session of this.upstreamHttp2.values()) session.destroy();
    for (const session of this.http2Sessions) session.destroy();
    for (const socket of this.tunnels) socket.destroy();
    await Promise.all([new Promise<void>((resolve) => this.server.close(() => resolve())), new Promise<void>((resolve) => this.http2Server.close(() => resolve()))]);
    this.server.closeAllConnections?.();
    // What the calls answered so far is written before the store may close.
    this.writer.stop();
    // The servers close once every agent still connected has had its answer, so a request still
    // upstream now is one whose agent left before its answer came (stopped by Ctrl-C mid-call):
    // nobody is left to read it, and a slow model would keep this process running after it is done.
    // Nothing more of it is recorded (`closed`).
    this.closed = true;
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
    // A parent this sidecar recorded is read whole.
    this.writer.flush();
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
        parentCalls = some ? this.refingerprint(stored, normalizers, undefined, input.replay?.promptFrom !== undefined, redactions, again).calls : stored;
        this.log(`run ${input.parentRunId}: reusing stored fingerprints (${stored.length} calls${some ? ', captured HTTP and judge calls fingerprinted again' : ''})`);
      } else {
        // Most come from the cache (fingerprint-cache.ts), which the recording filled.
        const { calls, cached } = this.refingerprint(stored, normalizers, this.clock === 'auto' ? [parent.startedAt, startedAt] : undefined, input.replay?.promptFrom !== undefined, redactions);
        parentCalls = calls;
        this.log(`run ${input.parentRunId}: re-fingerprinting ${stored.length} call${stored.length === 1 ? '' : 's'} under the current normalizers (${cached} from the cache)`);
      }
      // Compared as they are matched, so a divergence report never shows a sign-in beta as a change.
      parentCalls = parentCalls.map((c) => this.asMatched(c));
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
      // A divergence's diff is worked out once its call is answered (explainWaiting), never on its path.
      deferExplain: true,
      ...(input.replay ? { replay: input.replay } : {}),
      loadRequest: (rec) => this.loadRequest(rec),
      matchName: (rec) => this.matchName(rec),
      matchQuery: (rec) => identityQuery(typeof rec.meta.query === 'string' ? rec.meta.query : undefined),
      ...(clockRef !== undefined && parentStartedAt !== undefined ? { clock: { parent: parentStartedAt, run: run.startedAt } } : {}),
      ...(parentRecordsInput ? { parentRecordsInput } : {}),
    });
    this.runs.set(run.runId, new RunContext(run, session, requestInterventions, normalizers, input.offline === true, input.slot ?? null, clockRef, input.replay?.promptFrom !== undefined, redactions, parentCalls ? this.unversioned(parentCalls) : undefined, parentCalls ? this.unqueried(parentCalls) : undefined));
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
    this.writer.flush();
    const run = this.store.getRun(runId);
    if (!run) throw new HttpError(404, `unknown run ${runId}`);
    const parent = run.parentRunId ? this.store.getRun(run.parentRunId) : null;
    // A judge's request is matched by its bytes as sent, under the rules that redacted the parent
    // alone (judgeFingerprint); the run's own calls are matched as its replay matched them.
    const redactions = parent?.meta?.redactions ?? [];
    const normalizers = redactions.length ? [...this.normalizers, ...redactions] : this.normalizers;
    const clockRef = this.clock !== 'auto' ? undefined : parent ? [parent.startedAt, run.startedAt] : [run.startedAt];
    const recorded = parent ? this.refingerprint(this.store.getCalls(parent.runId).filter(isJudgeCall), normalizers, clockRef, false, redactions).calls : [];
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
    this.writer.flush();
    const made = this.store.getCalls(runId).filter((c) => isJudgeCall(c) && c.callNo >= ctx.judgeOnly!.from);
    // Made by this process, whatever made the run: a recording that came from a pack had its own
    // calls made somewhere else, but these went upstream, and were paid for, here.
    return summarizeJudge(ctx.run, made, { ...(this.prices ? { prices: this.prices } : {}), modelOf: storedModelResolver(this.store), imported: false });
  }

  endRun(runId: string, status: Exclude<RunStatus, 'running'>): EndRunResult {
    const ctx = this.runs.get(runId);
    if (!ctx) throw new HttpError(404, `unknown run ${runId}`);
    if (ctx.judgeOnly) throw new HttpError(409, `run ${runId} has ended; it is open for its judge's calls only`);
    // A divergence still waiting for its diff gets it before the run ends.
    this.explainWaiting(ctx);
    // A replay that never diverged but stopped before its recording did leaves it there: kept on
    // the run, so everything that reads the store tells it from a clean replay.
    if (ctx.session.end()) this.noteDivergence(ctx);
    // Every call written before the run is read back (and any that couldn't be, in its warnings).
    this.writer.flush();
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
    // WebSockets (OpenAI Realtime): what went over them is in no recording.
    const websockets = [...ctx.websockets.entries()].map(([target, v]): WebSocketUse => ({ target, ...v })).sort((a, b) => b.count - a.count);
    warnings.push(...webSocketWarnings(websockets, run.mode));
    if (run.mode === 'record' && !calls.some((c) => c.kind === 'api') && !websockets.some((u) => u.action === 'tunnelled')) {
      warnings.push(
        calls.length === 0
          ? 'Nothing was recorded: no model API call or SDK call reached Shadowlap. In Node and Python agents, calls to Anthropic, OpenAI, Gemini, Azure OpenAI, Vertex AI and Bedrock are captured in the process; other runtimes need their SDK to read ANTHROPIC_BASE_URL, OPENAI_BASE_URL or GOOGLE_GEMINI_BASE_URL, which shadowlap run sets. A client with a base URL on another host (set SHADOWLAP_UPSTREAM_<PROVIDER> to it), SHADOWLAP_CAPTURE=off, or an agent that failed before its first call all look like this.'
          : `${calls.length} ${calls.every((c) => c.meta.http) ? 'HTTP' : 'SDK'} call${calls.length === 1 ? '' : 's'} recorded but no model API calls. If the agent calls a model, its client is not going through Shadowlap (a client configured with its own base URL bypasses the ANTHROPIC_BASE_URL / OPENAI_BASE_URL / GOOGLE_GEMINI_BASE_URL that shadowlap run sets).`,
      );
    }
    const summary = summarizeRun(run, calls, ctx.session.notReached(), warnings, { ...(this.prices ? { prices: this.prices } : {}), modelOf: storedModelResolver(this.store) });
    this.log(`run ${runId} ended (${status})`);
    return { run, summary, providers: [...ctx.providersUsed].sort(), sdks: [...ctx.sdksSeen].sort(), unguarded, websockets };
  }

  get activeRun(): RunRecord | null {
    return this.activeRunId ? (this.runs.get(this.activeRunId)?.run ?? null) : null;
  }

  // ---- HTTP ----

  /** Where a request under the session token goes: the path after the token and any pin, and the run a pin names. */
  private routeOf(rawUrl: string | undefined): { url: URL; rest: string; pinned: string | undefined } {
    const url = new URL(rawUrl ?? '/', 'http://sidecar');
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
    return { url, rest, pinned };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { url, rest, pinned } = this.routeOf(req.url);
    const head = rest.split('/', 1)[0] ?? '';

    if (head === 'v1') return this.handleApi(req, res, rest, url, pinned);
    if (head === 'http') return this.proxyHttp(req, res, rest.slice(head.length) || '/', url.search, pinned);
    const route = head ? this.providers.get(head) : undefined;
    if (!route) throw new HttpError(404, `unknown route ${rest}`);
    const sent = rest.slice(head.length) || '/';
    // A host that serves another wire format under part of its paths (Claude on Foundry, under Azure's).
    const provider = route.forPath?.(sent) ?? route;
    return this.proxy(req, res, provider, provider.apiPath?.(sent) ?? sent, url.search, pinned);
  }

  /**
   * A WebSocket under a provider's prefix (OpenAI Realtime, `…/openai/v1/realtime`), tunnelled to the
   * provider as an HTTP call is forwarded: to the upstream configured here (a mock, through
   * SHADOWLAP_UPSTREAM_<PROVIDER>), else to the host a captured request names when its provider
   * vouches for it, else to the provider's own. Nothing that goes over it is recorded, so the run's
   * summary names it; an offline replay refuses it, saying why in one line.
   */
  private upgrade(req: IncomingMessage, socket: Duplex, early: Buffer): void {
    socket.on('error', () => {});
    try {
      const { url, rest, pinned } = this.routeOf(req.url);
      const head = rest.split('/', 1)[0] ?? '';
      const provider = head ? this.providers.get(head) : undefined;
      if (!provider) throw new HttpError(404, `unknown route ${rest}`);
      if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') throw new HttpError(400, `shadowlap tunnels WebSocket upgrades only; send this request without "Upgrade: ${String(req.headers.upgrade ?? '')}"`);
      const ctx = this.contextFor(req, pinned);
      if (ctx.judgeOnly) throw new HttpError(409, `run ${ctx.run.runId} has ended; it is open for its judge's calls only`);
      const sent = rest.slice(head.length) || '/';
      const path = provider.apiPath?.(sent) ?? sent;
      const target = `${provider.id} ${path}`;
      const note = (action: 'tunnelled' | 'refused') => {
        const seen = ctx.websockets.get(target);
        ctx.websockets.set(target, { count: (seen?.count ?? 0) + 1, action: seen?.action === 'tunnelled' ? 'tunnelled' : action });
      };
      if (ctx.offline || this.upstreams[provider.id] === 'offline') {
        note('refused');
        return refuseUpgrade(socket, 503, `shadowlap is offline: the WebSocket ${target} would need the network, and a recording holds no WebSocket to answer it from`);
      }
      const requested = this.requestedUpstream(req, provider, ctx, true);
      const upstream = (this.upstreams[provider.id] || requested || provider.upstream).replace(/\/$/, '');
      if (!upstream) throw new HttpError(400, `no upstream for ${provider.id}: set SHADOWLAP_UPSTREAM_${provider.id.toUpperCase()}, or let Shadowlap capture the connection in the agent's process`);
      const headers = lowerHeaders(req.headers);
      if (carriesPlaceholder(headers, url.search)) throw new HttpError(401, placeholderRefusal(provider.keys?.set ?? `a key for ${provider.id}`, `the WebSocket ${target}`));
      const forward = forwardedHeaders(headers, true);
      note('tunnelled');
      this.log(`run ${ctx.run.runId}: WebSocket ${target} tunnelled, not recorded`);
      this.tunnels.add(socket);
      socket.once('close', () => this.tunnels.delete(socket));
      tunnelWebSocket(socket, early, new URL(`${upstream}${this.upstreamPath(provider, upstream, path)}${url.search}`), forward);
    } catch (err) {
      refuseUpgrade(socket, err instanceof HttpError ? err.status : 500, err instanceof Error ? err.message : String(err));
    }
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

  // ---- model API proxy: route, resolve, then serve recorded or forward live, recording each attempt ----

  /**
   * Where a captured request was going. In-process capture (Bedrock signs for its host, and any
   * client may hardcode a base URL) sends the agent's own request here with the destination in a
   * header. Only hosts the provider vouches for are accepted, so this is never an open proxy.
   */
  private requestedUpstream(req: IncomingMessage, provider: Provider, ctx: RunContext, websocket = false): string | undefined {
    // A configured upstream (a mock, a local server, or "offline" in shadowlap test) takes precedence.
    if (this.upstreamOf(provider) || ctx.offline) return undefined;
    const raw = req.headers['x-shadowlap-upstream'];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!value) return undefined;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new HttpError(400, `x-shadowlap-upstream is not a URL: ${value}`);
    }
    // A WebSocket's host may be named wss:; it is reached over TLS either way. A host the config
    // declares with a port says what it takes itself, http included (Provider.accepts).
    const secure = url.protocol === 'https:' || (websocket && url.protocol === 'wss:');
    if (!(provider.accepts?.(url) ?? (secure && provider.hosts.test(url.hostname)))) {
      throw new HttpError(403, `${provider.id} cannot forward to ${url.origin}. Point it at a mock with ${upstreamVariable(provider)} instead.`);
    }
    return url.protocol === 'http:' ? url.origin : `https://${url.host}`;
  }

  /**
   * A model call, in stages. Route (`routeModelCall`): what the agent sent, for which run and
   * provider, its connection watched from then on. Resolve (`resolveModelCall`): which call it is, a
   * retry of an earlier one or a new one the session decides, whose start is recorded. Then serve it
   * from the recording (`serveRecorded`), or forward it live and stream the answer back
   * (`forwardLive`). Each attempt's end is recorded as the agent saw it (`endAttempt`, `recordEnd`),
   * through the store writer, which never holds an answer up.
   */
  private async proxy(req: IncomingMessage, res: ServerResponse, provider: Provider, sent: string, search: string, pinned?: string): Promise<void> {
    const call = await this.routeModelCall(req, res, provider, sent, search, pinned);
    if (!call) return;
    const placed = this.resolveModelCall(call);
    if (!placed) return;
    if (this.serveRecorded(call, placed)) return;
    await this.forwardLive(call, placed);
  }

  /**
   * Route: the run a model call belongs to, its scope, the upstream a captured request names, and the
   * request as the agent sent it. An SDK's own telemetry goes its own way (serveTelemetry). Null when
   * nothing more is to be done: it was answered, or its agent left before it was all here.
   */
  private async routeModelCall(req: IncomingMessage, res: ServerResponse, provider: Provider, sent: string, search: string, pinned?: string): Promise<ModelCall | null> {
    const client = new ClientWatch(res);
    res.on('error', () => {});
    const ctx = this.contextFor(req, pinned);
    if (isTelemetry(provider.id, sent)) {
      await this.serveTelemetry(ctx, req, res, provider, sent, search, client);
      return null;
    }
    // A judge's call: no flag rewrites it, and the session matches it apart from the agent's.
    const { scope, judge } = this.callScope(req, ctx, 'api');
    const requested = this.requestedUpstream(req, provider, ctx);
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      if (client.gone) return null;
      throw err;
    }
    // Gone before its request was all here: nothing was asked.
    if (client.gone) return null;
    // The providers the agent used: a judge's is none of them. A host the config declares is named by
    // its format: its name is the project's own, and this list goes into telemetry.
    if (!judge) ctx.providersUsed.add(provider.format && !hostedProviders.includes(provider) ? provider.format : provider.id);
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
    const retryHeader = provider.retryCountHeader ? headers[provider.retryCountHeader] : undefined;
    const retryCount = retryHeader === undefined ? 0 : Number.parseInt(retryHeader, 10) || 0;
    const method = (req.method ?? 'GET').toUpperCase();
    return { ctx, req, res, client, provider, scope, judge, requested, method, sent, path: sent, search, headers, rawBody, body, retryCount, retrying: retryCount > 0 || retryHeader === undefined };
  }

  /**
   * Resolve: which call a request is. One identical to a call whose last attempt failed in a way its
   * client retries, that reads as a retry, is that call's next attempt: the first such call with
   * nothing in flight, oldest failure first (RunContext.retries). Anything else is a new call the
   * session decides (replayed, live, forced live by an intervention), and its start is recorded.
   * Interventions rewrite the request first (rewriteForInterventions), and a retry gets the rewrite
   * of the attempt it repeats. Null when the call is answered here already (a judge that may not be
   * asked live).
   */
  private resolveModelCall(call: ModelCall): PlacedCall | null {
    const { ctx, provider, scope, judge } = call;
    const { place, refusal, forced, ...rewritten } = this.rewriteForInterventions(call);
    let { claimed, retryKey, changedBy } = rewritten;
    // A request that carries planted text (shadowlap injection's canary) forks the replay there, even
    // when a normalizer masks the text into a match: the point of the plant is a model reading it.
    if (refusal === undefined && !forced && !changedBy && ctx.session.state === 'replaying' && ctx.session.options.plantMarks && ctx.session.carriesPlant(call.rawBody.toString('utf8'))) changedBy = ctx.session.options.plantMarks.by;
    const { name, matchName, kept, asked, fingerprint, query, unqueried } = this.identifyModelCall(call);

    // A judge that may not be asked live, whose very request the recording never answered, is
    // answered by no one: nothing is kept of it, since a call no one answered holds no verdict, and
    // a run, or a pack of it, would only carry it.
    if (judge && (judge.offline || ctx.offline) && !ctx.session.judgedFor(fingerprint)) {
      const message = `shadowlap is offline: this judge check's request is not in the recording, and the judge may not be asked live`;
      call.res.writeHead(503, { 'content-type': 'application/json' });
      call.res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_offline', message } }));
      return null;
    }

    // Without interventions, a retry is told apart by its request as it is matched.
    if (retryKey === undefined) {
      retryKey = `api\n${scope ?? ''}\n${fingerprint}`;
      claimed = call.retrying ? ctx.claimRetry(retryKey) : undefined;
    }
    if (claimed !== undefined) return { callNo: claimed, tracked: ctx.calls.get(claimed)!, ...(refusal !== undefined ? { refusal } : {}) };

    const callNo = ctx.nextCallNo++;
    // A refused intervention still makes a call, answered with the reason: forced live, so it forks there.
    const by = refusal !== undefined ? { by: `an intervention it could not take (${refusal})` } : forced;
    const decision = ctx.session.resolve({ callNo, kind: 'api', name, fingerprint, request: call.body, headers: allowedHeaders(asked, provider.fingerprintHeaders), ...(query ? { query } : {}), ...(matchName ? { matchName } : {}), ...(scope ? { scope } : {}), ...(by ? { forced: by } : changedBy ? { changedBy } : {}) });
    const tracked: TrackedCall = { identity: { kind: 'api', name, fingerprint, occurrence: decision.occurrence }, effect: null, origin: storedOrigin('api', decision), decision, attempts: 0, inFlight: 0, retryable: false, done: false, retryKey, ...(place ? { place } : {}) };
    ctx.calls.set(callNo, tracked);
    this.noteDivergence(ctx);
    this.recordModelStart(call, callNo, tracked, kept, asked, unqueried);
    return { callNo, tracked, ...(refusal !== undefined ? { refusal } : {}) };
  }

  /**
   * Resolve, with interventions: the request rewritten as the run's flags have it, before it is
   * fingerprinted, stored or forwarded, so the recording of the fork holds exactly what was sent.
   * A flag names a model call by its place among the recording's model calls (of its scope, when the
   * recording has scopes), counted the way the recording counts them: every one, whatever it sends
   * (an embeddings call too), and a retry as the call it retries. A retry is told apart as the
   * recording tells it, by its fingerprint, here of the request before any rewrite, so it gets the
   * same rewrite as the attempt it repeats. Nothing without interventions, or for a judge's call.
   */
  private rewriteForInterventions(call: ModelCall): Rewritten {
    const { ctx, provider, scope } = call;
    if (!ctx.interventions?.active || call.judge) return {};
    const retryKey = `sent\n${scope ?? ''}\n${this.apiFingerprint(ctx, provider, { method: call.method, path: call.sent, headers: matchedHeaders(provider, call.headers), body: call.body, query: identityQuery(call.search) })}`;
    const claimed = call.retrying ? ctx.claimRetry(retryKey) : undefined;
    const place = (claimed !== undefined ? ctx.calls.get(claimed)?.place : undefined) ?? ctx.interventions.next(scope);
    const done: Rewritten = { retryKey, place, ...(claimed !== undefined ? { claimed } : {}) };
    const rewrite = ctx.interventions.apply(place, recordedId(provider), call.sent, call.body);
    if ('refused' in rewrite) return { ...done, refusal: rewrite.refused };
    // At the call a flag named: a changed body diverges on its own, and its diff shows the change; a
    // model switched in the path, or a setting the request already had, is forced.
    if (rewrite.target) {
      if (rewrite.changed && rewrite.path === call.sent) done.changedBy = rewrite.target.by;
      else done.forced = rewrite.target;
    }
    if (rewrite.changed) {
      call.path = rewrite.path;
      call.body = rewrite.body;
      call.rawBody = Buffer.from(JSON.stringify(call.body), 'utf8');
      // AWS signs a request's exact path and body: the changed one is signed again, or refused. One
      // signed with placeholder credentials is never sent, so forwardLive refuses it as it is.
      const keyId = signingKeyId(call.headers.authorization);
      if (keyId && keyId !== PLACEHOLDER_AWS_ACCESS_KEY_ID) {
        const signed = this.resign(call.req, call.headers, call.method, call.path, call.search, call.rawBody);
        if ('error' in signed) done.refusal = `${rewrite.target?.by ?? 'the intervention'}: ${signed.error}`;
        else call.headers = signed.headers;
      }
    }
    return done;
  }

  /**
   * Resolve: what identifies a model call, as its request is matched, and the headers it keeps. Its
   * query takes part, but for its credentials (identityQuery), unless the parent's calls to the
   * provider kept no query (`unqueried`), as a trace's never do: it is then matched, and kept,
   * without it.
   */
  private identifyModelCall(call: ModelCall): { name: string; matchName: string | undefined; kept: Record<string, string>; asked: Record<string, string>; fingerprint: string; query: string; unqueried: boolean } {
    const { ctx, provider, judge } = call;
    const name = apiCallName(call.method, call.path);
    // What identifies the call, where the provider leaves part of its path out (Vertex AI's project and region).
    const matchPath = provider.matchPath?.(call.path);
    const matchName = matchPath !== undefined && matchPath !== call.path ? apiCallName(call.method, matchPath) : undefined;
    // A parent that names no API version (a trace never keeps one) is matched, and this run kept,
    // without the version this request names: the run names none either, as the one it replays, so
    // the two stay the same calls (Compare, coverage) and its own replays match whatever version.
    const version = !judge && ctx.unversioned.has(provider.id) ? provider.apiVersion?.header : undefined;
    const kept = version !== undefined ? withoutHeader(call.headers, version) : call.headers;
    // Matched without what only says how the call signed in (matchHeaders); kept as it was sent.
    const asked = matchedHeaders(provider, kept);
    const unqueried = !judge && ctx.unqueried.has(provider.id);
    const query = unqueried ? '' : identityQuery(call.search);
    const request = { method: call.method, path: call.path, headers: asked, body: call.body, query };
    const fingerprint = judge ? judgeFingerprint(request, ctx.redactions, provider, matchPath).fingerprint : this.apiFingerprint(ctx, provider, request);
    return { name, matchName, kept, asked, fingerprint, query, unqueried };
  }

  /**
   * A model request's fingerprint under a run's matching rules: the one place an agent's model call
   * is fingerprinted, as it arrives and from its record (refingerprint).
   */
  private apiFingerprint(rules: { normalizers: Normalizer[]; clockRef: readonly number[] | undefined; withoutPrompt: boolean }, provider: Provider, req: { method: string; path: string; headers: Record<string, string>; body: unknown; query?: string }): string {
    return fingerprintApi(req, rules.normalizers, provider.fingerprintHeaders, rules.clockRef, { withoutPrompt: rules.withoutPrompt, matchPath: provider.matchPath?.(req.path) }).fingerprint;
  }

  /** How a model call is fingerprinted, besides its request, as its fingerprint cache key names it. */
  private modelRules(rules: { ids: { normalizers: string; judge: string }; clockRef: readonly number[] | undefined; withoutPrompt: boolean }, provider: Provider, method: string, path: string, headers: Readonly<Record<string, string>>, query: string | undefined, judge: boolean): FingerprintRules {
    const shared = { method, path, matchPath: provider.matchPath?.(path) ?? null, headers: allowedHeaders(headers, provider.fingerprintHeaders), allow: provider.fingerprintHeaders };
    return judge ? { kind: 'judge', ...shared, rules: rules.ids.judge } : { kind: 'api', ...shared, normalizers: rules.ids.normalizers, clock: rules.clockRef !== undefined, withoutPrompt: rules.withoutPrompt, query: query ?? null };
  }

  /**
   * Record: a new model call's start with its request, and its fingerprint in the cache for the next
   * replay to start from, with the dates the request holds (fingerprint-cache.ts).
   */
  private recordModelStart(call: ModelCall, callNo: number, tracked: TrackedCall, kept: Record<string, string>, asked: Record<string, string>, unqueried: boolean): void {
    const { ctx, provider, scope, judge, body } = call;
    // The query too, credentials left out: asking the call again (shadowlap decisions) sends it as the
    // agent did, and it is part of the call's identity. Kept empty when there is none, so a replay
    // tells a call that had none from one recorded before calls kept it; not kept when it was matched
    // without one (unqueried), so this run's own replays match it the same way.
    const query = unqueried ? undefined : (credentialFreeQuery(call.search.replace(/^\?/, '')) ?? '');
    // Under the format's provider when it went through a host of another's, that host kept as `via`.
    const meta: CallStartRow['meta'] = { retryCount: call.retryCount, provider: recordedId(provider), ...(provider.format ? { via: provider.id } : {}), fingerprintHeaders: allowedHeaders(kept, provider.fingerprintHeaders), ...(query !== undefined ? { query } : {}), ...(scope ? { scope } : {}), ...(judge?.meta ? { judge: judge.meta } : {}) };
    const at = Date.now();
    const start = (requestRef: string | null) => this.store.appendCallStart({ runId: ctx.run.runId, callNo, ...tracked.identity, origin: tracked.origin, effect: null, requestRef, meta, at });
    let requestRef: string | null = null;
    this.writer.write({
      what: `call ${callNo}'s start`,
      run: () => {
        requestRef = storeApiRequest(this.store, body);
        start(requestRef);
      },
      // Still matched on replay, by the fingerprint its row keeps; only its diff has no request to show.
      instead: () => start(null),
      failed: (reason, replaced) => ctx.warnOnce(`store:${callNo}:start`, `Call ${callNo}'s request could not be written to the store (${reason}): ${replaced ? 'the call is kept without it' : 'the call is missing from the recording'}.`),
    });
    const rules = this.modelRules({ ids: ctx.rules, clockRef: ctx.clockRef, withoutPrompt: ctx.withoutPrompt }, provider, call.method, call.path, asked, query, judge !== null);
    this.writer.write({
      what: `call ${callNo}'s fingerprint`,
      optional: true,
      run: () => {
        if (requestRef === null) return;
        const marks = judge ? [] : clockMarks([multipartView(body), query ?? '', ...Object.values(asked)], ctx.clockRef);
        this.store.cacheFingerprints([{ key: fingerprintKey(rules, requestRef), requestRef, fingerprint: tracked.identity.fingerprint, clock: encodeMarks(marks) }]);
      },
    });
  }

  /**
   * Serve recorded: a call answered without the network where it has to be. A refused intervention
   * is answered with its reason, a failure `--fail-at` asks for as the provider would fail, and a
   * call the session matched as it was recorded. False when it goes live.
   */
  private serveRecorded(call: ModelCall, placed: PlacedCall): boolean {
    const { ctx, res, provider } = call;
    const { callNo, tracked } = placed;
    if (placed.refusal !== undefined) {
      this.serveRefusal(ctx, res, provider, callNo, tracked, placed.refusal);
      return true;
    }
    // Checked after the retry branch and keyed by call number, so every attempt of an injected
    // failure fails. The interesting question is what the agent does when a call cannot succeed;
    // "the retry works" is what an ordinary replay already shows.
    const injected = ctx.session.injectedFailure(callNo);
    if (injected !== undefined) {
      this.serveInjectedFailure(ctx, res, provider, callNo, tracked, injected.status, injected.target);
      return true;
    }
    // Overrides apply to tool results only; for a model call an override decision is served as recorded.
    if (tracked.decision.origin === 'replayed' || tracked.decision.origin === 'overridden') {
      this.serveReplayed(ctx, res, callNo, tracked);
      return true;
    }
    return false;
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
    const attempt = this.beginAttempt(tracked);
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'x-shadowlap-origin': 'refused', ...(aws ? { 'x-amzn-errortype': 'ValidationException' } : {}) });
    res.end(bytes);
    const error: SerializedError = { name: 'ShadowlapInterventionRefused', message };
    this.endAttempt(ctx, callNo, tracked, { attempt, response: bytes, outcome: 'error', meta: { status: 400, retryable: false, refused: true, error, latencyMs: 0 } }, false);
    ctx.warnOnce(`refused:${reason}`, `Not applied: ${reason}. Call ${callNo} was answered with that reason instead of being sent.`);
    this.log(`run ${ctx.run.runId} call ${callNo}: refused ${reason}`);
  }

  /**
   * Answers a live call that carries a placeholder key instead of sending it: a placeholder only gets
   * a replay's client to send what the recording answers. In the provider's own error shape, as a
   * refused key arrives (AWS's for Bedrock), so its client shows the line; the run's summary counts
   * the call as refused, not as an upstream request, and prints the line under the fork.
   */
  private servePlaceholderRefusal(ctx: RunContext, res: ServerResponse, provider: Provider, callNo: number, tracked: TrackedCall): void {
    const message = placeholderRefusal(provider.keys?.set ?? `a key for ${provider.id}`);
    const aws = provider.id === 'bedrock';
    const bytes = Buffer.from(JSON.stringify(aws ? { message } : { type: 'error', error: { type: 'shadowlap_placeholder_key', message } }), 'utf8');
    const attempt = this.beginAttempt(tracked);
    res.writeHead(401, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'x-shadowlap-origin': 'refused', ...(aws ? { 'x-amzn-errortype': 'UnrecognizedClientException' } : {}) });
    res.end(bytes);
    const error: SerializedError = { name: 'ShadowlapPlaceholderKey', message };
    this.endAttempt(ctx, callNo, tracked, { attempt, response: bytes, outcome: 'error', meta: { status: 401, retryable: false, refused: true, error, latencyMs: 0 } }, false);
    ctx.warnOnce(`placeholder:${provider.id}`, message);
    this.log(`run ${ctx.run.runId} call ${callNo}: not sent, it carries a placeholder key`);
  }

  /**
   * Serves a call as it was recorded. An answer that was cut part way (the provider's connection
   * broke, or the agent left) is cut where it was, so the agent sees what it saw then: what arrived,
   * then a connection that breaks; with no answer at all, a connection that closes before one.
   */
  private serveReplayed(ctx: RunContext, res: ServerResponse, callNo: number, tracked: TrackedCall): void {
    if (tracked.decision.origin !== 'replayed' && tracked.decision.origin !== 'overridden') return;
    const record = tracked.decision.record;
    const end = record.end!;
    const bytes = end.responseRef ? (this.store.getBlob(end.responseRef) ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const status = end.meta.status ?? 200;
    const attempt = this.beginAttempt(tracked);
    if (!cutShort(end)) {
      res.writeHead(status, { ...(end.meta.headers ?? {}), 'content-length': String(bytes.length), 'x-shadowlap-origin': 'replayed' });
      res.end(bytes);
    } else if (end.meta.status === undefined) {
      res.destroy();
    } else {
      res.writeHead(status, { ...(end.meta.headers ?? {}), 'x-shadowlap-origin': 'replayed' });
      res.flushHeaders();
      if (bytes.length) res.write(bytes, () => res.destroy());
      else setImmediate(() => res.destroy());
    }
    // A recorded retryable failure is served as-is; the client's retry gets the same answer.
    this.endAttempt(ctx, callNo, tracked, { attempt, responseRef: end.responseRef, outcome: end.outcome, meta: { ...end.meta, replayedFrom: record.callNo, latencyMs: 0 } }, end.outcome === 'error' && end.meta.retryable === true);
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
    const attempt = this.beginAttempt(tracked);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'x-shadowlap-origin': 'injected', ...(aws ? { 'x-amzn-errortype': awsErrorType(status) } : {}) });
    res.end(bytes);
    const error = { name: 'ShadowlapInjectedFailure', message };
    // Retryable by the provider's own rule, so the client's retry logic runs — and fails again.
    this.endAttempt(ctx, callNo, tracked, { attempt, response: bytes, outcome: 'error', meta: { status, injected: true, retryable, error, provider: recordedId(provider), bytes: bytes.length, latencyMs: 0 } }, retryable);
    this.log(`run ${ctx.run.runId} call ${callNo}: injected HTTP ${status}`);
  }

  /**
   * Forward live: the call sent to its provider, or refused where it can't be (liveUpstream), and
   * the answer streamed back as it arrives (relayAnswer). When the agent leaves, the request upstream
   * ends with it, and the attempt is recorded as a retryable disconnect, so its client's retry is
   * the same call. When the provider's connection breaks part way, the agent's breaks there too, as
   * it would without Shadowlap.
   */
  private async forwardLive(call: ModelCall, placed: PlacedCall): Promise<void> {
    const upstream = this.liveUpstream(call, placed);
    if (upstream === null) return;
    const { ctx, res, provider, client } = call;
    const { callNo, tracked } = placed;
    const number = this.beginAttempt(tracked);
    let settled = false;
    const attempt: LiveAttempt = {
      started: Date.now(),
      // The attempt ends for the agent once: when it leaves (its client may retry before the request
      // upstream has ended), or when its answer has.
      settle: (retryable) => {
        if (settled) return;
        settled = true;
        this.settleAttempt(ctx, callNo, tracked, retryable);
      },
      end: (row) => this.recordEnd(ctx, callNo, tracked.identity, { attempt: number, ...row }),
    };
    client.whenGone(() => attempt.settle(true));
    if (client.gone) {
      attempt.end({ responseRef: null, outcome: 'error', meta: { latencyMs: 0, retryable: true, provider: provider.id, error: clientLeft('before its request was sent') } });
      return;
    }
    let answer: Response;
    try {
      answer = await this.sendUpstream(call, upstream);
    } catch (err) {
      // Its agent has gone and the sidecar has closed: it records and reports nothing (closed).
      if (this.closed) return;
      if (client.gone) {
        // The agent left before the provider answered (its own timeout, say): it saw no answer at all.
        attempt.end({ responseRef: null, outcome: 'error', meta: { latencyMs: Date.now() - attempt.started, retryable: true, provider: provider.id, error: clientLeft('before the response headers') } });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const error: SerializedError = { name: 'UpstreamConnectionError', message };
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_upstream_error', message } }));
      attempt.settle(true);
      attempt.end({ responseRef: null, outcome: 'error', meta: { status: 502, latencyMs: Date.now() - attempt.started, retryable: true, error } });
      return;
    }
    await this.relayAnswer(call, answer, attempt);
  }

  /**
   * Forward live: where the call goes. An upstream configured here wins (shadowlap test sets
   * "offline"), then the one a captured request names, then the provider's own default; a judge names
   * its own. Null when it can go nowhere, answered and recorded with why: offline, no upstream for its
   * provider, or a placeholder key, which is never sent to any host (a provider, a gateway, a model
   * server or a mock).
   */
  private liveUpstream(call: ModelCall, placed: PlacedCall): string | null {
    const { ctx, res, provider } = call;
    const { callNo, tracked } = placed;
    const judging = call.judge?.upstream !== undefined;
    const requested = call.judge?.upstream ?? call.requested;
    const upstream = ctx.offline || call.judge?.offline === true ? 'offline' : ((judging ? requested : undefined) || this.upstreamOf(provider) || requested || provider.upstream).replace(/\/$/, '');
    if (!upstream) {
      const message = `no upstream for ${provider.id}: set ${upstreamVariable(provider)}, or let Shadowlap capture the call in the agent's process`;
      const attempt = this.beginAttempt(tracked);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_no_upstream', message } }));
      this.endAttempt(ctx, callNo, tracked, { attempt, responseRef: null, outcome: 'error', meta: { status: 400, latencyMs: 0, retryable: false, error: { name: 'ShadowlapNoUpstream', message } } }, false);
      return null;
    }
    if (upstream === 'offline') {
      // `shadowlap test` runs offline: a live call here means the replay diverged, and the run must fail loudly, not spend tokens.
      const message = `shadowlap is offline: call #${callNo} (${tracked.identity.name}) was not served from the recording and would need the network`;
      const error: SerializedError = { name: 'ShadowlapOffline', message };
      const attempt = this.beginAttempt(tracked);
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'shadowlap_offline', message } }));
      this.endAttempt(ctx, callNo, tracked, { attempt, responseRef: null, outcome: 'error', meta: { status: 503, latencyMs: 0, retryable: false, offline: true, error } }, false);
      return null;
    }
    if (carriesPlaceholder(call.headers, call.search)) {
      this.servePlaceholderRefusal(ctx, res, provider, callNo, tracked);
      return null;
    }
    return upstream;
  }

  /**
   * Forward live: the request as the agent sent it, signed headers and all. Its own `accept-encoding`
   * goes as it sent it, since a signed request (AWS SigV4) may sign it, and a compressed answer is
   * decoded for the recording and the agent alike; with none, an uncompressed answer is asked for. A
   * request that arrived over HTTP/2 carries its signed :authority, and leaves the same way. It ends
   * when its agent has gone (ClientWatch).
   */
  private sendUpstream(call: ModelCall, upstream: string): Promise<Response> {
    const path = this.upstreamPath(call.provider, upstream, call.path);
    const headers = forwardedHeaders(call.headers);
    headers['accept-encoding'] ??= 'identity';
    const body = call.method === 'GET' || call.method === 'HEAD' ? null : call.rawBody;
    const authority = call.headers[':authority'];
    return authority
      ? this.fetchOverHttp2(upstream.replace(/(https?:\/\/[^/]+).*/, '$1'), `${upstream.replace(/https?:\/\/[^/]+/, '')}${path}${call.search}`, call.method, headers, body, authority, call.client.signal)
      : requestUpstream(upstream + path + call.search, call.method, headers, body, this.upstreamRequests, call.client.signal);
  }

  /**
   * Forward live: the provider's answer streamed to the agent as it arrives, and recorded as the agent
   * got it. What arrives after the agent left reached nobody and isn't recorded; an answer the
   * provider cut part way reaches the agent as far as it came, then the agent's connection breaks.
   */
  private async relayAnswer(call: ModelCall, answer: Response, attempt: LiveAttempt): Promise<void> {
    const { res, provider, client } = call;
    const status = answer.status;
    const responseHeaders: Record<string, string> = {};
    answer.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (RESPONSE_DROP.has(key) || provider.credentialHeaders.includes(key)) return;
      responseHeaders[key] = v;
    });
    const reader = answer.body?.getReader();
    const timer = new SseTimer(attempt.started);
    const chunks: Buffer[] = [];
    let streamError: SerializedError | undefined;
    // The last write to the agent, so a broken answer reaches it whole before its connection breaks.
    let written: Promise<void> = Promise.resolve();
    try {
      if (!client.gone) {
        res.writeHead(status, { ...responseHeaders, 'x-shadowlap-origin': 'live' });
        res.flushHeaders();
      }
    } catch (err) {
      // Headers no response can carry: the provider's answer can't be passed on, so it is none.
      streamError = { name: 'UpstreamResponseError', message: err instanceof Error ? err.message : String(err) };
    }
    if (reader && !streamError) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || client.gone) break;
          const buf = Buffer.from(value);
          chunks.push(buf);
          timer.push(buf);
          written = new Promise((resolve) => res.write(buf, () => resolve()));
        }
      } catch (err) {
        // A read that fails because the agent left is the agent leaving, not the provider failing.
        if (!client.gone) streamError = { name: 'UpstreamStreamError', message: err instanceof Error ? err.message : String(err) };
      }
    }
    if (client.gone) {
      await reader?.cancel().catch(() => {});
      res.destroy();
    } else if (streamError) {
      await reader?.cancel().catch(() => {});
      await settledWithin(written, 2_000);
      res.destroy(new Error(streamError.message));
    } else res.end();
    // Its agent has gone and the sidecar has closed: it records and reports nothing (closed).
    if (this.closed) return;

    const bytes = Buffer.concat(chunks);
    const gone = client.gone;
    const contentType = responseHeaders['content-type'];
    const retryable = gone || streamError !== undefined || provider.isRetryableStatus(status);
    const outcome = status < 400 && !streamError && !gone ? 'ok' : 'error';
    attempt.settle(outcome === 'error' && retryable);
    const meta: CallStartRow['meta'] = { status, headers: responseHeaders, latencyMs: Date.now() - attempt.started, retryable, bytes: bytes.length, provider: recordedId(provider) };
    // An upstream that asks another model than the request names says which (`shadowlap tasks score`'s takeover).
    const requestedModel = responseHeaders['x-shadowlap-model'] || provider.extractModel(call.path, call.body);
    if (requestedModel) meta.model = requestedModel;
    const usage = readQuietly(() => provider.extractUsage(bytes, contentType));
    if (usage) meta.usage = usage;
    const stopReason = outcome === 'ok' ? readQuietly(() => provider.extractStopReason(bytes, contentType)) : null;
    if (stopReason) meta.stopReason = stopReason;
    if (timer.events.length) meta.chunks = timer.events;
    if (streamError) meta.error = streamError;
    if (gone) meta.error = clientLeft('before the response completed');
    attempt.end({ response: bytes, outcome, meta });
  }

  /** The path a call goes to under `upstream`: an SDK's own base URL with no `/v1` under it (sdkBases) takes the SDK's path without that `/v1`. */
  private upstreamPath(provider: Provider, upstream: string, path: string): string {
    const sdkBase = this.sdkBases[provider.id];
    const sdkPath = provider.sdkPath;
    const sdkRelative = sdkBase !== undefined && sdkPath !== undefined && upstream === sdkBase.replace(/\/+$/, '') && (path === sdkPath || path.startsWith(`${sdkPath}/`));
    return sdkRelative ? path.slice(sdkPath!.length) : path;
  }

  // ---- record: each attempt's end, as the agent saw it ----

  /** Starts an attempt: its number taken now, before anything waits, and the call no longer waiting for a retry. */
  private beginAttempt(tracked: TrackedCall): number {
    tracked.retryable = false;
    tracked.inFlight++;
    return tracked.attempts++;
  }

  /** An attempt has ended for the agent: whether its client may retry it, and so whether the call waits for that retry. */
  private settleAttempt(ctx: RunContext, callNo: number, tracked: TrackedCall, retryable: boolean): void {
    tracked.inFlight = Math.max(0, tracked.inFlight - 1);
    tracked.done = true;
    tracked.retryable = retryable;
    if (retryable && tracked.retryKey !== undefined) ctx.awaitRetry(callNo, tracked.retryKey);
  }

  /** An attempt that ended as it was answered: settled and recorded. */
  private endAttempt(ctx: RunContext, callNo: number, tracked: TrackedCall, end: AttemptEnd, retryable: boolean): void {
    this.settleAttempt(ctx, callNo, tracked, retryable);
    this.recordEnd(ctx, callNo, tracked.identity, end);
  }

  /**
   * Record: an attempt's end, with what the agent got, through the store writer. Where it can't be
   * written, an error end in its place says why, and so do the run's warnings.
   */
  private recordEnd(ctx: RunContext, callNo: number, identity: CallIdentity, end: AttemptEnd, noun = 'answer'): void {
    const at = Date.now();
    const row = (responseRef: string | null, outcome: 'ok' | 'error', meta: CallMeta): CallEndRow => ({ runId: ctx.run.runId, callNo, attempt: end.attempt, responseRef, outcome, meta, at });
    this.writer.write({
      what: `call ${callNo}'s ${noun}`,
      run: () => this.store.appendCallEnd(identity, row(end.response !== undefined ? this.store.putBlob(end.response) : (end.responseRef ?? null), end.outcome, end.meta)),
      instead: (reason) => {
        const { chunks: _timing, ...meta } = end.meta;
        this.store.appendCallEnd(identity, row(null, 'error', { ...meta, error: { name: 'ShadowlapStoreError', message: `the ${noun} could not be written to the store: ${reason}` } }));
      },
      failed: (reason, replaced) =>
        ctx.warnOnce(`store:${callNo}:${end.attempt}`, `Call ${callNo}'s ${noun} could not be written to the store (${reason})${replaced ? ', so the call is kept as an error without it' : ''}. The agent got it; the recording doesn't hold it.`),
    });
  }

  /**
   * An SDK's own telemetry under a provider (the OpenAI Agents SDK's trace export): no model call,
   * and nothing a replay could match, since every export names new random ids and times. While
   * recording it goes on to the provider as the agent sent it, and nothing of it is recorded or
   * counted; a replay answers it with 204 itself, so a replay's traces never reach the provider.
   */
  private async serveTelemetry(ctx: RunContext, req: IncomingMessage, res: ServerResponse, provider: Provider, path: string, search: string, client: ClientWatch): Promise<void> {
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req);
    } catch {
      return;
    }
    const headers = lowerHeaders(req.headers);
    const live = ctx.run.mode === 'record' && !ctx.offline && !ctx.judgeOnly;
    const upstream = live ? (this.upstreams[provider.id] || this.requestedUpstream(req, provider, ctx) || provider.upstream).replace(/\/$/, '') : '';
    if (client.gone) return;
    if (!upstream || upstream === 'offline' || carriesPlaceholder(headers, search)) {
      res.writeHead(204, { 'x-shadowlap-origin': 'telemetry' });
      res.end();
      return;
    }
    const method = (req.method ?? 'POST').toUpperCase();
    let answer: Response;
    let bytes: Buffer;
    try {
      answer = await requestUpstream(`${upstream}${this.upstreamPath(provider, upstream, path)}${search}`, method, forwardedHeaders(headers), method === 'GET' || method === 'HEAD' ? null : rawBody, this.upstreamRequests, client.signal);
      bytes = Buffer.from(await answer.arrayBuffer());
    } catch (err) {
      if (client.gone || this.closed) return;
      return json(res, 502, { type: 'error', error: { type: 'shadowlap_upstream_error', message: err instanceof Error ? err.message : String(err) } });
    }
    const out: Record<string, string> = {};
    answer.headers.forEach((v, k) => {
      if (!RESPONSE_DROP.has(k) && !provider.credentialHeaders.includes(k)) out[k] = v;
    });
    const empty = answer.status === 204 || answer.status === 304;
    res.writeHead(answer.status, { ...out, ...(empty ? {} : { 'content-length': String(bytes.length) }), 'x-shadowlap-origin': 'telemetry' });
    res.end(empty ? undefined : bytes);
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
    // Watched from the start, as a model call's agent is: one that leaves ends the request to the host too.
    const client = new ClientWatch(res);
    res.on('error', () => {});
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
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      if (client.gone) return;
      throw err;
    }
    // Gone before its request was all here: nothing was asked.
    if (client.gone) return;
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
    const tracked: TrackedCall = { identity, effect, origin: stored, decision, attempts: 0, inFlight: 0, retryable: false, done: false };
    ctx.calls.set(callNo, tracked);
    this.noteDivergence(ctx);
    // A plain read the recording held no counterpart for, answered live while the replay goes on.
    const requestRef = this.recordToolStart(ctx, callNo, tracked, { args }, { http: origin.host, ...(scope ? { scope } : {}), ...(decision.origin === 'live' && decision.extra ? { extraRead: true } : {}), ...this.trustMeta(name, origin.host, null) });
    this.cacheToolFingerprint(ctx, callNo, matched, true, fingerprint, args, requestRef);

    /** The call's end: `response` the bytes to store, or the ref of what is stored already. */
    const end = (response: Buffer | string | null, outcome: 'ok' | 'error', meta: CallStartRow['meta']) => {
      this.recordEnd(ctx, callNo, identity, { attempt: 0, outcome, meta, ...(Buffer.isBuffer(response) ? { response } : { responseRef: response }) }, 'result');
      tracked.done = true;
    };
    const send = (result: HttpResult, from: string, bytes = encodeBody(result)) => {
      res.writeHead(result.status, { ...result.headers, 'content-length': String(bytes.length), 'x-shadowlap-origin': from });
      res.end(bytes);
    };
    const fail = (status: number, error: SerializedError, type: string) => {
      end(jsonBytes({ error }), 'error', { status, error });
      json(res, status, { type: 'error', error: { type, message: error.message } });
    };

    if (decision.origin === 'replayed') {
      const recorded = decision.record.end!;
      const payload = (recorded.responseRef ? this.store.getJson<{ result?: HttpResult; error?: SerializedError }>(recorded.responseRef) : null) ?? {};
      end(recorded.responseRef, recorded.outcome, { ...recorded.meta, replayedFrom: decision.record.callNo, latencyMs: 0 });
      // The bytes the service sent, not the body written again: an agent that reads the text, or a
      // number JSON.parse would round, gets what it got then.
      if (payload.result) return send(payload.result, 'replayed', storedResponseBytes(payload.result, recorded.responseRef ? this.store.getBlob(recorded.responseRef) : null));
      // The agent left before the host answered, when it was recorded: its connection closes again, with no answer.
      if (recorded.meta.error?.name === 'ClientDisconnected') return void res.destroy();
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
      end(jsonBytes({ error }), 'error', { injected: true, failure: f, error, latencyMs: 0, ...(f.kind === 'status' ? { status: f.status } : {}) });
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
      end(jsonBytes({ result: planted.result }), 'ok', { overriddenFrom: decision.record.callNo, planted: planted.at, latencyMs: 0 });
      return send(planted.result as HttpResult, 'overridden');
    }
    if (decision.origin === 'overridden') {
      const value = decision.result as Partial<HttpResult> | null;
      const result: HttpResult = value && typeof value === 'object' && typeof value.status === 'number' ? { status: value.status, headers: value.headers ?? {}, ...(value.body !== undefined ? { body: value.body, encoding: value.encoding ?? 'json' } : {}) } : { status: 200, headers: { 'content-type': 'application/json' }, body: value, encoding: 'json' };
      end(jsonBytes({ result }), 'ok', { overriddenFrom: decision.record.callNo, latencyMs: 0 });
      return send(result, 'overridden');
    }
    if (decision.origin === 'blocked') {
      if (effect === 'read') return fail(409, { name: 'ShadowlapReadBlocked', message: fencedRead(name) }, 'shadowlap_read_blocked');
      return fail(409, { name: 'ShadowlapWriteBlocked', message: `write ${name} blocked after divergence (use --writes stub|allow to change this)` }, 'shadowlap_write_blocked');
    }
    if (decision.origin === 'stubbed') {
      const result: HttpResult = { status: 200, headers: { 'content-type': 'application/json' }, body: { shadowlap: 'stubbed' }, encoding: 'json' };
      end(jsonBytes({ result }), 'ok', { stubbed: true, latencyMs: 0 });
      return send(result, 'stubbed');
    }
    if (ctx.offline || this.upstreams.http === 'offline') {
      return fail(503, { name: 'ShadowlapOffline', message: `shadowlap is offline: call #${callNo} (${name}) was not served from the recording and would need the network` }, 'shadowlap_offline');
    }
    // A placeholder key the agent passes on to a declared host (a vector store that embeds with the
    // caller's OpenAI key) is never sent either.
    if (carriesPlaceholder(req.headers, search)) {
      const message = placeholderRefusal('the key it sends', name);
      const error: SerializedError = { name: 'ShadowlapPlaceholderKey', message };
      end(jsonBytes({ error }), 'error', { status: 401, refused: true, retryable: false, error, latencyMs: 0 });
      ctx.warnOnce(`placeholder:${name}`, message);
      this.log(`run ${ctx.run.runId} call ${callNo}: not sent, it carries a placeholder key`);
      const bytes = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'shadowlap_placeholder_key', message } }), 'utf8');
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': String(bytes.length), 'x-shadowlap-origin': 'refused' });
      res.end(bytes);
      return;
    }

    const headers = forwardedHeaders(lowerHeaders(req.headers));
    const started = Date.now();
    let upstream: Response;
    let bytes: Buffer;
    // The agent left before the host answered (its own timeout, say): it saw no answer at all.
    const left = () => {
      const error = clientLeft('before the response');
      end(jsonBytes({ error }), 'error', { error, latencyMs: Date.now() - started });
    };
    try {
      upstream = await requestUpstream(url, method, headers, rawBody.length && method !== 'GET' && method !== 'HEAD' ? rawBody : null, this.upstreamRequests, client.signal);
      bytes = Buffer.from(await upstream.arrayBuffer());
    } catch (err) {
      // Its agent has gone and the sidecar has closed: it records and reports nothing (closed).
      if (this.closed) return;
      if (client.gone) return left();
      return fail(502, { name: 'ShadowlapUpstreamError', message: `${name}: ${err instanceof Error ? err.message : String(err)}` }, 'shadowlap_upstream_error');
    }
    if (client.gone) return left();
    const result: HttpResult = { status: upstream.status, headers: keptResponseHeaders(upstream.headers), ...decodeBody(bytes, upstream.headers.get('content-type') ?? undefined) };
    end(storedResult(result, bytes), 'ok', { status: upstream.status, latencyMs: Date.now() - started, bytes: bytes.length });
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
    const tracked: TrackedCall = { identity, effect, origin: stored, decision, attempts: 0, inFlight: 0, retryable: false, done: false };
    ctx.calls.set(callNo, tracked);
    this.noteDivergence(ctx);

    const meta: CallStartRow['meta'] = {};
    if (body.implHash) meta.implHash = body.implHash;
    if (scope) meta.scope = scope;
    if (input) meta.input = true;
    // A plain read the recording held no counterpart for, answered live while the replay goes on.
    if (decision.origin === 'live' && decision.extra) meta.extraRead = true;
    const mcp = kind === 'tool' ? mcpCallMeta(body.mcp) : undefined;
    if (mcp) meta.mcp = mcp;
    // A tool that brings outside text in, as the config's `tools`, the SDK's `trust` or an MCP
    // server's openWorldHint says. Kept on the call, never in its fingerprint: marking a tool changes no replay.
    if (kind === 'tool') Object.assign(meta, this.trustMeta(body.name, null, body.trust === 'untrusted' ? (mcp ? 'mcp' : 'sdk') : null));
    const requestRef = this.recordToolStart(ctx, callNo, tracked, request, meta);
    if (kind === 'tool') this.cacheToolFingerprint(ctx, callNo, { name: body.name, normalizers: ctx.normalizers }, false, fingerprint, request.args, requestRef);
    /** The call's end: `response` the value to store, or the ref of what is stored already. */
    const end = (response: { value: unknown } | string | null, outcome: 'ok' | 'error', endMeta: CallStartRow['meta']) => {
      this.recordEnd(ctx, callNo, identity, { attempt: 0, outcome, meta: endMeta, ...(response !== null && typeof response === 'object' ? { response: jsonBytes(response.value) } : { responseRef: response }) }, 'result');
      tracked.done = true;
    };

    if (decision.origin === 'injected') {
      // The tool does not run. Its error is stored as Shadowlap's, and the SDK raises it as the kind
      // of failure asked for; a client that predates this raises it as a replayed error.
      const error = toolFailureError(body.name, decision.failure);
      end({ value: { error } }, 'error', { injected: true, failure: decision.failure, error, latencyMs: 0 });
      this.log(`run ${ctx.run.runId} call ${callNo}: injected ${decision.failure.kind} into ${body.name}`);
      return { origin: 'replayed', callNo, outcome: 'error', error, injected: decision.failure };
    }

    if (decision.origin === 'planted') {
      const record = decision.record;
      const recorded = record.end!;
      const payload = (recorded.responseRef ? this.store.getJson<{ result?: unknown; error?: SerializedError }>(recorded.responseRef) : null) ?? {};
      const planted = recorded.outcome === 'ok' ? plantInToolResult(payload.result, decision.text, false) : { refused: 'it failed when it was recorded, so it has no result to add to' };
      if (!refused(planted)) {
        end({ value: { result: planted.result } }, 'ok', { overriddenFrom: record.callNo, planted: planted.at, latencyMs: 0 });
        return { origin: 'replayed', callNo, outcome: 'ok', result: planted.result };
      }
      // Served as recorded, and said: the run is a clean replay, not the attack it was asked for.
      ctx.session.declined(record.callNo);
      ctx.warnOnce(`plant:${record.callNo}`, `--inject-result ${record.callNo} changed nothing: ${planted.refused}`);
      end(recorded.responseRef, recorded.outcome, { ...recorded.meta, replayedFrom: record.callNo, latencyMs: 0 });
      if (recorded.outcome === 'ok') return { origin: 'replayed', callNo, outcome: 'ok', result: (recorded.responseRef ? this.getJsonExact<{ result?: unknown }>(recorded.responseRef) : null)?.result };
      return { origin: 'replayed', callNo, outcome: 'error', error: payload.error ?? { name: 'Error', message: 'recorded error' } };
    }

    if (decision.origin === 'overridden') {
      // The user's substitute result stands in for the recording; the agent builds its next request from it.
      const record = decision.record;
      end({ value: { result: decision.result } }, 'ok', { overriddenFrom: record.callNo, latencyMs: 0 });
      return { origin: 'replayed', callNo, outcome: 'ok', result: decision.result };
    }

    if (decision.origin === 'replayed') {
      const record = decision.record;
      const recorded = record.end!;
      // Read with each number as it was recorded, so the SDK gets back exactly what the tool returned.
      const payload = (recorded.responseRef ? this.getJsonExact<{ result?: unknown; error?: SerializedError }>(recorded.responseRef) : null) ?? {};
      if (kind === 'tool' && body.implHash && record.meta.implHash && record.meta.implHash !== body.implHash && !ctx.session.options.liveTools.has(body.name)) {
        ctx.warnOnce(body.name, `${body.name} changed since the recording; pass --live-tool ${body.name} to run it live`);
      }
      end(recorded.responseRef, recorded.outcome, { ...recorded.meta, replayedFrom: record.callNo, latencyMs: 0 });
      if (recorded.outcome === 'ok') return { origin: 'replayed', callNo, outcome: 'ok', result: payload.result };
      return { origin: 'replayed', callNo, outcome: 'error', error: payload.error ?? { name: 'Error', message: 'recorded error' } };
    }

    if (kind !== 'tool') {
      // Clock and random values are generated here so the SDK needs no second round-trip.
      const result = kind === 'clock' ? Date.now() : body.name === 'uuid' ? randomUUID() : Math.random();
      end({ value: { result } }, 'ok', {});
      return { origin: 'live', callNo, outcome: 'ok', result };
    }

    if (decision.origin === 'blocked') {
      const error: SerializedError = effect === 'read' ? { name: 'ShadowlapReadBlocked', message: fencedRead(`read tool ${body.name}`) } : { name: 'ShadowlapWriteBlocked', message: `write tool ${body.name} blocked after divergence (use --writes stub|allow to change this)` };
      end({ value: { error } }, 'error', { error });
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
    this.recordEnd(ctx, callNo, tracked.identity, { attempt: 0, response: jsonBytes(payload), outcome, meta }, 'result');
    tracked.done = true;
  }

  /** Record: a tool call's start with its request (`{ args }`, or a clock or random call's label); the ref its request is stored under, once it is. */
  private recordToolStart(ctx: RunContext, callNo: number, tracked: TrackedCall, request: unknown, meta: CallStartRow['meta']): () => string | null {
    const at = Date.now();
    let requestRef: string | null = null;
    this.writer.write({
      what: `call ${callNo}'s start`,
      run: () => {
        requestRef = this.store.putJson(request);
        this.store.appendCallStart({ runId: ctx.run.runId, callNo, ...tracked.identity, origin: tracked.origin, effect: tracked.effect, requestRef, meta, at });
      },
      failed: (reason) => ctx.warnOnce(`store:${callNo}:start`, `Call ${callNo} could not be written to the store (${reason}): it is missing from the recording.`),
    });
    return () => requestRef;
  }

  /**
   * Record: a tool call's fingerprint in the cache for the next replay to start from, once its
   * request is stored, with the dates its arguments hold (fingerprint-cache.ts). `matched` is the
   * name and rules it was fingerprinted under.
   */
  private cacheToolFingerprint(ctx: RunContext, callNo: number, matched: { name: string; normalizers: Normalizer[] }, captured: boolean, fingerprint: string, args: unknown, requestRef: () => string | null): void {
    this.writer.write({
      what: `call ${callNo}'s fingerprint`,
      optional: true,
      run: () => {
        const ref = requestRef();
        if (ref === null) return;
        const rules: FingerprintRules = { kind: 'tool', name: matched.name, normalizers: matched.normalizers === ctx.normalizers ? ctx.rules.normalizers : rulesId(matched.normalizers), clock: ctx.clockRef !== undefined, captured };
        this.store.cacheFingerprints([{ key: fingerprintKey(rules, ref), requestRef: ref, fingerprint, clock: encodeMarks(clockMarks([matchable(args ?? null)], ctx.clockRef)) }]);
      },
    });
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
      const d = this.keepDivergence(ctx, found);
      this.log(`run ${ctx.run.runId} diverged at call ${d.callNo} (${d.type})`);
    }
  }

  /** Keeps a run's divergence on it, in memory and in the store, through the store writer. */
  private keepDivergence(ctx: RunContext, found: DivergenceReport): DivergenceReport {
    // A hint for a change the run's rules mask would ask for a rule the config has: the report
    // still lists the change, as the request carried it, but it didn't make the replay diverge.
    const hints = found.hints?.length ? unmaskedHints(found, ctx.normalizers) : null;
    const d = hints && hints.length !== found.hints!.length ? Sidecar.withHints(found, hints) : found;
    ctx.run.divergence = d;
    this.writer.write({
      what: `run ${ctx.run.runId}'s divergence`,
      run: () => this.store.setDivergence(ctx.run.runId, d),
      failed: (reason) => ctx.warnOnce('store:divergence', `Where the run diverged (call ${d.callNo}) could not be written to the store (${reason}).`),
    });
    return d;
  }

  /**
   * Works out the diff of a divergence that waits for one (Session.explainPending), for `only` or for
   * every run: called once each request has been answered, so no agent waits on recorded requests
   * being loaded and compared, and by endRun before a run ends. A failure leaves the divergence as it
   * was first kept, compared with its nearest recorded call.
   */
  private explainWaiting(only?: RunContext): void {
    if (this.closed) return;
    for (const ctx of only ? [only] : this.runs.values()) {
      if (!ctx.session.explaining) continue;
      try {
        const d = ctx.session.explainPending();
        if (d) this.keepDivergence(ctx, d);
      } catch (err) {
        this.log(`run ${ctx.run.runId}: its divergence was kept without a diff: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** A stored JSON blob with each number as it was written (parseJsonExact): for what is served back and fingerprinted. */
  private getJsonExact<T>(ref: string): T | null {
    const bytes = this.store.getBlob(ref);
    return bytes ? (parseJsonExact(bytes.toString('utf8')) as T) : null;
  }

  /**
   * The upstream configured for a provider, by its id or by its id as SHADOWLAP_UPSTREAM_<NAME>
   * spells it (`bedrock_mantle` for bedrock-mantle, `openrouter_ai` for a declared openrouter.ai).
   */
  private upstreamOf(provider: Provider): string | undefined {
    return this.upstreams[provider.id] || this.upstreams[provider.id.toLowerCase().replace(/[^a-z0-9]/g, '_')] || undefined;
  }

  /**
   * The provider a recorded model call went through: the host of another's format it was for
   * (`meta.via`, Claude on Foundry), else the one it is recorded under.
   */
  private providerOf(rec: Pick<CallRecord, 'meta'>): Provider | undefined {
    const via = typeof rec.meta.via === 'string' ? this.byId.get(rec.meta.via) : undefined;
    return via ?? this.byId.get(String(rec.meta.provider ?? ''));
  }

  /** A recorded model call's name as matching reads it (`Provider.matchPath`): a Vertex AI call without its project and region. */
  private matchName(rec: CallRecord): string {
    const provider = rec.kind === 'api' ? this.providerOf(rec) : undefined;
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
   * The providers whose model calls in a parent all name no API version (`Provider.apiVersion`), as
   * a trace's never do: a replay matches and keeps its calls to them without the version they name.
   */
  private unversioned(calls: readonly CallRecord[]): Set<string> {
    const named = new Map<string, boolean>();
    for (const c of calls) {
      const provider = c.kind === 'api' && !isJudgeCall(c) ? this.providerOf(c) : undefined;
      if (!provider?.apiVersion) continue;
      const version = (c.meta.fingerprintHeaders as Record<string, string> | undefined)?.[provider.apiVersion.header];
      named.set(provider.id, named.get(provider.id) === true || version !== undefined);
    }
    return new Set([...named].filter(([, some]) => !some).map(([id]) => id));
  }

  /**
   * The providers none of whose model calls in a parent kept a query (`meta.query`), as a recording
   * made before calls kept one, or a trace's, never does: a replay matches its calls to them whatever
   * query they carry, as it does a version none of them named (`unversioned`), and keeps no query on
   * them, so its own replays match them the same way. A call that kept an empty query had none.
   */
  private unqueried(calls: readonly CallRecord[]): Set<string> {
    const kept = new Map<string, boolean>();
    for (const c of calls) {
      if (c.kind !== 'api' || isJudgeCall(c)) continue;
      const id = this.providerOf(c)?.id ?? String(c.meta.provider ?? '');
      kept.set(id, kept.get(id) === true || typeof c.meta.query === 'string');
    }
    return new Set([...kept].filter(([, some]) => !some).map(([id]) => id));
  }

  /** A model call with its fingerprint headers as matching reads them (Provider.matchHeaders). */
  private asMatched(rec: CallRecord): CallRecord {
    const provider = rec.kind === 'api' ? this.providerOf(rec) : undefined;
    const headers = rec.meta.fingerprintHeaders as Record<string, string> | undefined;
    if (!provider?.matchHeaders || !headers) return rec;
    return { ...rec, meta: { ...rec.meta, fingerprintHeaders: provider.matchHeaders(headers) } };
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
   *
   * Most fingerprints come from the cache (fingerprint-cache.ts), which the recording filled: one
   * read for the whole run instead of every stored request read and hashed again. A request the cache
   * can't answer under these rules and dates is fingerprinted here, and kept in the cache for the
   * next replay. `cached` counts those the cache answered.
   */
  private refingerprint(calls: CallRecord[], normalizers: Normalizer[], clockRef: readonly number[] | undefined, withoutPromptMask = false, redactions: Normalizer[] = [], only?: (rec: CallRecord) => boolean): { calls: CallRecord[]; cached: number } {
    const rules = { normalizers, clockRef, withoutPrompt: withoutPromptMask, redactions, ids: { normalizers: rulesId(normalizers), judge: rulesId(judgeRules(redactions)) } };
    const plans = calls.map((rec) => (only && !only(rec) ? null : this.fingerprintPlan(rec, rules)));
    const found = this.store.cachedFingerprints(plans.flatMap((p) => (p ? [p.key] : [])));
    const fresh: Array<{ key: string; requestRef: string; fingerprint: string; clock: string | null }> = [];
    let cached = 0;
    const counts = new Map<string, number>();
    const out = calls.map((rec, i) => {
      let fingerprint = rec.fingerprint;
      const plan = plans[i];
      if (plan) {
        const hit = found.get(plan.key);
        const marks = hit ? decodeMarks(hit.clock) : null;
        if (hit && marks && servesClock(marks, clockRef)) {
          fingerprint = hit.fingerprint;
          cached++;
        } else {
          try {
            const made = plan.compute();
            fingerprint = made.fingerprint;
            fresh.push({ key: plan.key, requestRef: plan.requestRef, fingerprint, clock: encodeMarks(made.marks) });
          } catch (err) {
            this.log(`could not re-fingerprint call #${rec.callNo}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      const k = `${rec.kind}\n${typeof rec.meta.scope === 'string' ? rec.meta.scope : ''}\n${fingerprint}`;
      const occurrence = (counts.get(k) ?? 0) + 1;
      counts.set(k, occurrence);
      return { ...rec, fingerprint, occurrence };
    });
    if (fresh.length) this.writer.write({ what: 'the fingerprint cache', optional: true, run: () => this.store.cacheFingerprints(fresh) });
    return { calls: out, cached };
  }

  /**
   * How a recorded call is fingerprinted again under `rules`: its cache key, and the work to do when
   * the cache can't answer. Null to keep its stored fingerprint (a clock or random call, a call whose
   * request or provider is unknown).
   */
  private fingerprintPlan(rec: CallRecord, rules: { normalizers: Normalizer[]; clockRef: readonly number[] | undefined; withoutPrompt: boolean; redactions: Normalizer[]; ids: { normalizers: string; judge: string } }): { key: string; requestRef: string; compute: () => { fingerprint: string; marks: ClockMark[] } } | null {
    const ref = rec.requestRef;
    if (!ref) return null;
    if (rec.kind === 'api') {
      // The host of another's format it went through (`via`), whose root it is matched under.
      const provider = this.providerOf(rec);
      if (!provider) return null;
      const [method = 'POST', ...pathParts] = rec.name.split(' ');
      const path = pathParts.join(' ');
      const headers = matchedHeaders(provider, (rec.meta.fingerprintHeaders as Record<string, string> | undefined) ?? {});
      const query = typeof rec.meta.query === 'string' ? rec.meta.query : undefined;
      // A judge's call is matched by its request as sent, not as the agent's calls are.
      const judge = isJudgeCall(rec);
      return {
        key: fingerprintKey(this.modelRules(rules, provider, method, path, headers, query, judge), ref),
        requestRef: ref,
        compute: () => {
          // From the query it kept: none for a call recorded before calls kept one.
          const request = { method, path, headers, body: loadApiRequest(this.store, ref), query: storedQuery(rec) };
          if (judge) return { fingerprint: judgeFingerprint(request, rules.redactions, provider, provider.matchPath?.(path)).fingerprint, marks: [] };
          return { fingerprint: this.apiFingerprint(rules, provider, request), marks: clockMarks([multipartView(request.body), query ?? '', ...Object.values(headers)], rules.clockRef) };
        },
      };
    }
    if (rec.kind === 'tool') {
      const matched = matchedAs(rec, rules.normalizers, rules.redactions);
      const captured = capturedHttp(rec);
      return {
        key: fingerprintKey({ kind: 'tool', name: matched.name, normalizers: matched.normalizers === rules.normalizers ? rules.ids.normalizers : rulesId(matched.normalizers), clock: rules.clockRef !== undefined, captured }, ref),
        requestRef: ref,
        compute: () => {
          const req = this.getJsonExact<{ args?: unknown }>(ref);
          const args = (captured ? withoutStoredCredentials(req?.args) : req?.args) ?? null;
          return { fingerprint: fingerprintTool(matched.name, args, matched.normalizers, rules.clockRef).fingerprint, marks: clockMarks([matchable(args)], rules.clockRef) };
        },
      };
    }
    return null;
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

/** The variable that sends a provider's calls elsewhere: SHADOWLAP_UPSTREAM_BEDROCK_MANTLE for bedrock-mantle. */
const upstreamVariable = (provider: Provider): string => `SHADOWLAP_UPSTREAM_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** The id a provider's calls are recorded under: the format's, for a host of another's (Provider.format). */
const recordedId = (provider: Provider): string => provider.format ?? provider.id;

/** A model call's query as its identity reads it, from what its recording kept: none when it kept none. */
function storedQuery(rec: Pick<CallRecord, 'meta'>): string {
  return identityQuery(typeof rec.meta.query === 'string' ? rec.meta.query : undefined);
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

/** A request's headers as matching reads them (Provider.matchHeaders): as sent, for most providers. */
function matchedHeaders(provider: Provider | undefined, headers: Readonly<Record<string, string>>): Record<string, string> {
  return provider?.matchHeaders?.(headers) ?? { ...headers };
}

/** Headers without one of them. */
function withoutHeader(headers: Readonly<Record<string, string>>, name: string): Record<string, string> {
  const { [name]: _left, ...rest } = headers;
  return rest;
}

/**
 * How a judge's request is matched against the recording: by its bytes as sent, with none of the
 * project's normalizers and no masking of dates or prompts, since the judge read all of it and its
 * verdict answers those bytes alone. The rules that redacted the recording, those that reach a
 * judge's request (judgeRules), apply as a copy applied them, so a pack's masked request still
 * matches the one a replay sends. Nothing is matched fuzzily because of a judge.
 */
function judgeFingerprint(req: { method: string; path: string; headers: Record<string, string>; body: unknown; query?: string }, redactions: readonly Normalizer[], provider: Provider, matchPath: string | undefined): { fingerprint: string } {
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

/**
 * A request's headers as they go upstream: without its hop-by-hop headers (a WebSocket handshake
 * keeps `connection` and `upgrade`), pseudo-headers, the host and length, and Shadowlap's own.
 * Everything else goes as the agent sent it: a signed request (AWS SigV4) signs what it carries.
 */
function forwardedHeaders(headers: Readonly<Record<string, string>>, handshake = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':') || k === 'host' || k === 'content-length' || k.startsWith('x-shadowlap-')) continue;
    if (HOP_BY_HOP.has(k) && !(handshake && (k === 'connection' || k === 'upgrade'))) continue;
    out[k] = v;
  }
  return out;
}

/** A value's JSON as bytes, as `Store.putJson` stores it. */
function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/** Whether a recorded answer stopped part way: its provider's connection broke, or its agent left before it was whole. */
function cutShort(end: CallEndRow): boolean {
  const name = end.meta.error?.name;
  return end.outcome === 'error' && (name === 'UpstreamStreamError' || name === 'ClientDisconnected');
}

/** Waits for `p`, or `ms` at most, without keeping the process alive for it. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

/** What reading an answer finds, or null when the answer doesn't read as the provider's (a usage, a stop reason). */
function readQuietly<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** What a run's summary says of the WebSockets it tunnelled or refused: nothing that went over one is in a recording. */
function webSocketWarnings(used: readonly WebSocketUse[], mode: RunMode): string[] {
  const out: string[] = [];
  const listed = (action: WebSocketUse['action']) => used.filter((u) => u.action === action);
  const names = (us: readonly WebSocketUse[]) => us.map((u) => `${u.target} (${u.count})`).join(', ');
  const total = (us: readonly WebSocketUse[]) => us.reduce((n, u) => n + u.count, 0);
  const live = listed('tunnelled');
  if (live.length) {
    const n = total(live);
    const one = n === 1;
    const after = mode === 'replay' ? `${one ? 'It' : 'They'} ran for real during the replay, as ${one ? 'it does' : 'they do'} on every replay` : `A replay connects again for real`;
    out.push(`${n} WebSocket connection${one ? '' : 's'} went to the provider live and ${one ? 'was' : 'were'} not recorded: ${names(live)}. ${after}; an offline replay (shadowlap test) refuses ${one ? 'it' : 'them'}.`);
  }
  const refused = listed('refused');
  if (refused.length) {
    const n = total(refused);
    out.push(`${n} WebSocket connection${n === 1 ? ' was' : 's were'} refused: the replay is offline, and a recording holds no WebSocket to answer from: ${names(refused)}.`);
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    // A client that left part way through sending: the body never ends.
    req.on('close', () => {
      if (!req.complete) reject(new Error('the client closed the connection before its request was all sent'));
    });
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
